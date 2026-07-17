import type { Logger } from "pino";
import type { AccessTokenProvider } from "../auth/lwa-token-provider.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { SpApiMcpError } from "../errors.js";
import type { OperationRegistry } from "../registry/operation-registry.js";
import type {
  InvocationArguments,
  InvocationResult,
  JsonValue,
  OperationDefinition,
  OperationParameter,
} from "../types.js";
import { Semaphore } from "./semaphore.js";

export interface ExecutorOptions {
  endpoint: string;
  maxRetries: number;
  maxResponseBytes: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  userAgent: string;
}

export class SpApiExecutor {
  readonly #semaphore: Semaphore;

  public constructor(
    private readonly registry: OperationRegistry,
    private readonly tokenProvider: AccessTokenProvider,
    private readonly artifactStore: ArtifactStore,
    private readonly logger: Logger,
    private readonly options: ExecutorOptions,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.#semaphore = new Semaphore(options.maxConcurrency);
  }

  public async invoke(
    operationId: string,
    arguments_: InvocationArguments,
    confirmed = false,
  ): Promise<InvocationResult> {
    const operation = this.registry.get(operationId);
    if (operation.access !== "read" && !confirmed) {
      throw new SpApiMcpError(
        `${operation.method} ${operation.path} changes remote state; repeat with confirm=true`,
        "CONFIRMATION_REQUIRED",
        { operationId: operation.id, access: operation.access },
      );
    }
    this.registry.validate(operation, arguments_);
    const accessToken = await this.tokenProvider.getAccessToken();
    const request = this.buildRequest(operation, arguments_, accessToken);
    return this.#semaphore.run(async () => this.executeWithRetry(operation, request));
  }

  private buildRequest(
    operation: OperationDefinition,
    arguments_: InvocationArguments,
    accessToken: string,
  ): { url: string; init: RequestInit } {
    let path = operation.path;
    for (const parameter of operation.parameters.filter(({ location }) => location === "path")) {
      const value = arguments_.path?.[parameter.name];
      if (value !== undefined) {
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(parameterValue(value)));
      }
    }
    if (/\{[^}]+\}/u.test(path)) {
      throw new SpApiMcpError("Not all path parameters were supplied", "INVALID_ARGUMENTS");
    }
    const url = new URL(`${this.options.endpoint}${path}`);
    for (const parameter of operation.parameters.filter(({ location }) => location === "query")) {
      const value = arguments_.query?.[parameter.name];
      if (value !== undefined) appendQuery(url, parameter, value);
    }

    const headers = new Headers({
      accept: "application/json",
      "user-agent": this.options.userAgent,
      "x-amz-access-token": accessToken,
    });
    for (const parameter of operation.parameters.filter(({ location }) => location === "header")) {
      const value = arguments_.headers?.[parameter.name];
      if (value !== undefined) headers.set(parameter.name, formatScalarOrArray(value));
    }
    let body: string | undefined;
    if (arguments_.body !== undefined) {
      headers.set("content-type", operation.requestBody?.contentType ?? "application/json");
      body =
        headers.get("content-type")?.includes("json") === true
          ? JSON.stringify(arguments_.body)
          : parameterValue(arguments_.body);
    }
    return {
      url: url.toString(),
      init: {
        method: operation.method,
        headers,
        ...(body === undefined ? {} : { body }),
      },
    };
  }

  private async executeWithRetry(
    operation: OperationDefinition,
    request: { url: string; init: RequestInit },
  ): Promise<InvocationResult> {
    const startedAt = Date.now();
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImplementation(request.url, {
          ...request.init,
          signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        });
        if (isRetryable(response.status) && attempt < this.options.maxRetries) {
          await delay(retryDelay(response, attempt));
          continue;
        }
        const result = await this.parseResponse(operation, response);
        this.logger.info(
          {
            operationId: operation.id,
            method: operation.method,
            status: response.status,
            durationMs: Date.now() - startedAt,
            attempts: attempt + 1,
            requestId: result.requestId,
          },
          "SP-API request completed",
        );
        return result;
      } catch (error) {
        if (error instanceof SpApiMcpError) throw error;
        if (attempt >= this.options.maxRetries) {
          throw new SpApiMcpError(
            "SP-API request failed before receiving a response",
            "SP_API_NETWORK_ERROR",
            {
              operationId: operation.id,
              cause: error instanceof Error ? error.message : String(error),
            },
          );
        }
        await delay(backoff(attempt));
      }
    }
    throw new SpApiMcpError("SP-API retry loop ended unexpectedly", "INTERNAL_ERROR");
  }

  private async parseResponse(
    operation: OperationDefinition,
    response: Response,
  ): Promise<InvocationResult> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mediaType =
      response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    const requestId = response.headers.get("x-amzn-requestid") ?? undefined;
    const rateLimit = response.headers.get("x-amzn-ratelimit-limit") ?? undefined;
    const base = {
      operationId: operation.id,
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
      ...(rateLimit === undefined ? {} : { rateLimit }),
    };
    if (
      response.ok &&
      (bytes.byteLength > this.options.maxResponseBytes || !isInlineMediaType(mediaType))
    ) {
      return { ...base, artifact: await this.artifactStore.put(bytes, mediaType) };
    }
    const parsed = parseBody(bytes, mediaType);
    if (!response.ok) {
      throw new SpApiMcpError(`SP-API returned HTTP ${response.status}`, "SP_API_ERROR", {
        operationId: operation.id,
        status: response.status,
        requestId,
        response: parsed,
      });
    }
    return { ...base, data: parsed };
  }
}

function appendQuery(url: URL, parameter: OperationParameter, value: JsonValue): void {
  if (Array.isArray(value)) {
    if (parameter.collectionFormat === "multi" || parameter.explode === true) {
      for (const item of value) url.searchParams.append(parameter.name, parameterValue(item));
      return;
    }
    const separator =
      parameter.collectionFormat === "ssv"
        ? " "
        : parameter.collectionFormat === "pipes"
          ? "|"
          : "";
    url.searchParams.set(
      parameter.name,
      value.map(parameterValue).join(separator === "" ? "," : separator),
    );
    return;
  }
  url.searchParams.set(parameter.name, parameterValue(value));
}

function formatScalarOrArray(value: JsonValue): string {
  return Array.isArray(value) ? value.map(parameterValue).join(",") : parameterValue(value);
}

function parameterValue(value: JsonValue): string {
  if (value === null) return "";
  if (typeof value === "object") {
    throw new SpApiMcpError(
      "Path, query, and header values must be scalars or scalar arrays",
      "INVALID_ARGUMENTS",
    );
  }
  return String(value);
}

function parseBody(bytes: Uint8Array, mediaType: string): JsonValue {
  if (bytes.byteLength === 0) return null;
  const text = Buffer.from(bytes).toString("utf8");
  if (mediaType.includes("json")) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

function isInlineMediaType(mediaType: string): boolean {
  return mediaType.includes("json") || mediaType.startsWith("text/") || mediaType.includes("xml");
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  }
  return backoff(attempt);
}

function backoff(attempt: number): number {
  return Math.random() * Math.min(500 * 2 ** attempt, 30_000);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
