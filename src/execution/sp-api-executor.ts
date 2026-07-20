import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AccountRegistry, RegisteredAccount } from "../accounts/account-registry.js";
import { marketplaceIdsFromArguments } from "../accounts/account-registry.js";
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
import { RateLimitManager } from "./rate-limit-manager.js";

export interface ExecutorOptions {
  maxRetries: number;
  maxResponseBytes: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  userAgent: string;
}

export interface InvocationOptions {
  accountName?: string;
  confirmed?: boolean;
  dryRun?: boolean;
}

interface AuditContext {
  auditId: string;
  accountName: string;
  sellerId?: string;
  marketplaceIds: string[];
  operationId: string;
  method: string;
  access: string;
  confirmed: boolean;
  dryRun: boolean;
  resource?: Record<string, string>;
  payloadHash?: string;
}

export class SpApiExecutor {
  readonly #semaphore: Semaphore;
  readonly #rateLimits = new RateLimitManager();

  public constructor(
    private readonly registry: OperationRegistry,
    private readonly accounts: AccountRegistry,
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
    options: InvocationOptions = {},
  ): Promise<InvocationResult> {
    const operation = this.registry.get(operationId);
    const account = this.accounts.resolve(options.accountName);
    const marketplaceIds = marketplaceIdsFromArguments(arguments_);
    const audit = auditContext(operation, arguments_, account, marketplaceIds, options);
    if (operation.access !== "read" && options.confirmed !== true && options.dryRun !== true) {
      const error = new SpApiMcpError(
        `${operation.method} ${operation.path} changes remote state; repeat with confirm=true`,
        "CONFIRMATION_REQUIRED",
        { operationId: operation.id, access: operation.access },
      );
      this.logAudit(audit, {
        status: 0,
        durationMs: 0,
        attempts: 0,
        errorCode: error.code,
      });
      throw withAuditDetails(error, audit);
    }
    try {
      this.registry.validate(operation, arguments_);
      await this.accounts.validateRequest(account, arguments_);
    } catch (error) {
      if (error instanceof SpApiMcpError) {
        this.logAudit(audit, {
          status: 0,
          durationMs: 0,
          attempts: 0,
          errorCode: error.code,
        });
      }
      throw error instanceof SpApiMcpError ? withAuditDetails(error, audit) : error;
    }
    if (options.dryRun === true) {
      const request = this.buildRequest(operation, arguments_, account.endpoint);
      this.logAudit(audit, { status: 0, attempts: 0, durationMs: 0 });
      return {
        operationId: operation.id,
        accountName: account.accountName,
        auditId: audit.auditId,
        dryRun: true,
        status: 0,
        data: {
          method: operation.method,
          url: request.url,
          ...(arguments_.body === undefined ? {} : { submittedBody: arguments_.body }),
        },
      };
    }
    let accessToken: string;
    try {
      accessToken = await account.tokenProvider.getAccessToken();
    } catch (error) {
      this.logAudit(audit, {
        status: 0,
        durationMs: 0,
        attempts: 0,
        errorCode: error instanceof SpApiMcpError ? error.code : "AUTHENTICATION_FAILED",
      });
      throw error instanceof SpApiMcpError ? withAuditDetails(error, audit) : error;
    }
    const request = this.buildRequest(operation, arguments_, account.endpoint, accessToken);
    return this.executeWithRetry(operation, request, account, audit);
  }

  private buildRequest(
    operation: OperationDefinition,
    arguments_: InvocationArguments,
    endpoint: string,
    accessToken?: string,
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
    const url = new URL(`${endpoint}${path}`);
    for (const parameter of operation.parameters.filter(({ location }) => location === "query")) {
      const value = arguments_.query?.[parameter.name];
      if (value !== undefined) appendQuery(url, parameter, value);
    }

    const headers = new Headers({
      accept: "application/json",
      "user-agent": this.options.userAgent,
    });
    if (accessToken !== undefined) headers.set("x-amz-access-token", accessToken);
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
    account: RegisteredAccount,
    audit: AuditContext,
  ): Promise<InvocationResult> {
    const startedAt = Date.now();
    const rateLimitKey = `${account.accountName}:${account.region}:${operation.id}`;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        await this.#rateLimits.acquire(rateLimitKey, operation);
        const response = await this.#semaphore.run(async () =>
          this.fetchImplementation(request.url, {
            ...request.init,
            signal: AbortSignal.timeout(this.options.requestTimeoutMs),
          }),
        );
        this.#rateLimits.observe(rateLimitKey, operation, response);
        if (isRetryable(response.status) && attempt < this.options.maxRetries) {
          await delay(retryDelay(response, attempt));
          continue;
        }
        const result = await this.parseResponse(operation, response);
        this.logAudit(audit, {
          status: response.status,
          durationMs: Date.now() - startedAt,
          attempts: attempt + 1,
          ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
          ...(result.rateLimit === undefined ? {} : { rateLimit: result.rateLimit }),
        });
        return {
          ...result,
          accountName: account.accountName,
          auditId: audit.auditId,
        };
      } catch (error) {
        if (error instanceof SpApiMcpError) {
          const requestId = errorRequestId(error);
          this.logAudit(audit, {
            status: errorStatus(error),
            durationMs: Date.now() - startedAt,
            attempts: attempt + 1,
            errorCode: error.code,
            ...(requestId === undefined ? {} : { requestId }),
          });
          throw withAuditDetails(error, audit);
        }
        if (attempt >= this.options.maxRetries) {
          const normalized = new SpApiMcpError(
            "SP-API request failed before receiving a response",
            "SP_API_NETWORK_ERROR",
            {
              operationId: operation.id,
              cause: error instanceof Error ? error.message : String(error),
            },
          );
          this.logAudit(audit, {
            status: 0,
            durationMs: Date.now() - startedAt,
            attempts: attempt + 1,
            errorCode: normalized.code,
          });
          throw withAuditDetails(normalized, audit);
        }
        await delay(backoff(attempt));
      }
    }
    throw new SpApiMcpError("SP-API retry loop ended unexpectedly", "INTERNAL_ERROR");
  }

  private logAudit(
    audit: AuditContext,
    result: {
      status: number;
      durationMs: number;
      attempts: number;
      requestId?: string;
      rateLimit?: string;
      errorCode?: string;
    },
  ): void {
    this.logger.info({ audit: true, ...audit, ...result }, "SP-API audit event");
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

function auditContext(
  operation: OperationDefinition,
  arguments_: InvocationArguments,
  account: RegisteredAccount,
  marketplaceIds: string[],
  options: InvocationOptions,
): AuditContext {
  const resource = auditResource(arguments_);
  return {
    auditId: randomUUID(),
    accountName: account.accountName,
    ...(account.sellerId === undefined ? {} : { sellerId: account.sellerId }),
    marketplaceIds,
    operationId: operation.id,
    method: operation.method,
    access: operation.access,
    confirmed: options.confirmed === true,
    dryRun: options.dryRun === true,
    ...(Object.keys(resource).length === 0 ? {} : { resource }),
    ...(operation.access === "read" || arguments_.body === undefined
      ? {}
      : {
          payloadHash: createHash("sha256").update(JSON.stringify(arguments_.body)).digest("hex"),
        }),
  };
}

function auditResource(arguments_: InvocationArguments): Record<string, string> {
  const resource: Record<string, string> = {};
  for (const name of ["sellerId", "sku", "sellerSku", "asin", "reportId", "reportDocumentId"]) {
    const value = firstNamedScalar(arguments_, name);
    if (value !== undefined) resource[name] = value;
  }
  return resource;
}

function firstNamedScalar(arguments_: InvocationArguments, name: string): string | undefined {
  for (const container of [arguments_.path, arguments_.query, arguments_.body]) {
    const result = findNamedScalar(container, name);
    if (result !== undefined) return result;
  }
  return undefined;
}

function findNamedScalar(
  value: JsonValue | Record<string, JsonValue> | undefined,
  name: string,
): string | undefined {
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findNamedScalar(item, name);
      if (result !== undefined) return result;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key.toLowerCase() === name.toLowerCase() &&
      (typeof child === "string" || typeof child === "number")
    ) {
      return String(child);
    }
    const result = findNamedScalar(child, name);
    if (result !== undefined) return result;
  }
  return undefined;
}

function errorStatus(error: SpApiMcpError): number {
  if (typeof error.details !== "object" || error.details === null) return 0;
  const status = (error.details as Record<string, unknown>).status;
  return typeof status === "number" ? status : 0;
}

function errorRequestId(error: SpApiMcpError): string | undefined {
  if (typeof error.details !== "object" || error.details === null) return undefined;
  const requestId = (error.details as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function withAuditDetails(error: SpApiMcpError, audit: AuditContext): SpApiMcpError {
  const existingDetails =
    typeof error.details === "object" && error.details !== null && !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : {};
  return new SpApiMcpError(error.message, error.code, {
    ...existingDetails,
    auditId: audit.auditId,
    accountName: audit.accountName,
    marketplaceIds: audit.marketplaceIds,
  });
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
