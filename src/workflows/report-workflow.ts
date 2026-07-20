import { gunzipSync } from "node:zlib";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { SpApiMcpError } from "../errors.js";
import type { SpApiExecutor } from "../execution/sp-api-executor.js";
import type { OperationRegistry } from "../registry/operation-registry.js";
import type { ArtifactReference, JsonObject, JsonValue, OperationDefinition } from "../types.js";

export interface RunReportArguments {
  reportType: string;
  accountName?: string;
  marketplaceIds?: string[];
  dataStartTime?: string;
  dataEndTime?: string;
  reportOptions?: JsonObject;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface ReportWorkflowResult {
  reportId: string;
  reportDocumentId: string;
  processingStatus: string;
  artifact: ArtifactReference;
}

export class ReportWorkflow {
  public constructor(
    private readonly registry: OperationRegistry,
    private readonly executor: SpApiExecutor,
    private readonly artifactStore: ArtifactStore,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public async run(arguments_: RunReportArguments): Promise<ReportWorkflowResult> {
    const create = this.findOperation("createReport");
    const getReport = this.findOperation("getReport");
    const getDocument = this.findOperation("getReportDocument");
    const createResult = await this.executor.invoke(
      create.id,
      {
        body: {
          reportType: arguments_.reportType,
          ...(arguments_.marketplaceIds === undefined
            ? {}
            : { marketplaceIds: arguments_.marketplaceIds }),
          ...(arguments_.dataStartTime === undefined
            ? {}
            : { dataStartTime: arguments_.dataStartTime }),
          ...(arguments_.dataEndTime === undefined ? {} : { dataEndTime: arguments_.dataEndTime }),
          ...(arguments_.reportOptions === undefined
            ? {}
            : { reportOptions: arguments_.reportOptions }),
        },
      },
      {
        confirmed: true,
        ...(arguments_.accountName === undefined ? {} : { accountName: arguments_.accountName }),
      },
    );
    const reportId = stringAt(createResult.data, ["reportId"]);
    const deadline = Date.now() + (arguments_.timeoutMs ?? 120_000);
    const pollInterval = arguments_.pollIntervalMs ?? 2_000;
    let reportDocumentId: string | undefined;
    let processingStatus = "IN_QUEUE";

    while (Date.now() < deadline) {
      const statusResult = await this.executor.invoke(
        getReport.id,
        { path: { reportId } },
        arguments_.accountName === undefined ? {} : { accountName: arguments_.accountName },
      );
      processingStatus = stringAt(statusResult.data, ["processingStatus"]);
      if (processingStatus === "DONE") {
        reportDocumentId = stringAt(statusResult.data, ["reportDocumentId"]);
        break;
      }
      if (processingStatus === "CANCELLED" || processingStatus === "FATAL") {
        throw new SpApiMcpError(
          `Report ${reportId} ended with ${processingStatus}`,
          "REPORT_FAILED",
          { reportId, processingStatus },
        );
      }
      await delay(pollInterval);
    }
    if (reportDocumentId === undefined) {
      throw new SpApiMcpError(
        `Report ${reportId} did not finish before timeout`,
        "REPORT_TIMEOUT",
        {
          reportId,
          processingStatus,
        },
      );
    }

    const documentResult = await this.executor.invoke(
      getDocument.id,
      {
        path: { reportDocumentId },
      },
      arguments_.accountName === undefined ? {} : { accountName: arguments_.accountName },
    );
    const url = stringAt(documentResult.data, ["url"]);
    const compression = optionalStringAt(documentResult.data, ["compressionAlgorithm"]);
    const download = await this.fetchImplementation(url, { signal: AbortSignal.timeout(60_000) });
    if (!download.ok) {
      throw new SpApiMcpError(
        `Report download returned HTTP ${download.status}`,
        "REPORT_DOWNLOAD_FAILED",
      );
    }
    const compressed = new Uint8Array(await download.arrayBuffer());
    const content = compression === "GZIP" ? gunzipSync(compressed) : compressed;
    const mediaType = download.headers.get("content-type")?.split(";")[0] ?? "text/plain";
    const artifact = await this.artifactStore.put(content, mediaType);
    return { reportId, reportDocumentId, processingStatus, artifact };
  }

  private findOperation(operationId: string): OperationDefinition {
    const candidates = this.registry.bundle.operations
      .filter(
        (operation) => operation.domain === "reports" && operation.operationId === operationId,
      )
      .sort((left, right) => right.apiVersion.localeCompare(left.apiVersion));
    const operation = candidates.find(({ deprecated }) => !deprecated) ?? candidates[0];
    if (operation === undefined) {
      throw new SpApiMcpError(`Reports operation not found: ${operationId}`, "INVALID_REGISTRY");
    }
    return operation;
  }
}

function stringAt(value: JsonValue | undefined, path: string[]): string {
  const result = optionalStringAt(value, path);
  if (result === undefined) {
    throw new SpApiMcpError(
      `Expected response field ${path.join(".")}`,
      "UNEXPECTED_SP_API_RESPONSE",
    );
  }
  return result;
}

function optionalStringAt(value: JsonValue | undefined, path: string[]): string | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return typeof current === "string" ? current : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
