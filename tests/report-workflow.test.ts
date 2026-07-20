import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import type { SpApiExecutor } from "../src/execution/sp-api-executor.js";
import { OperationRegistry } from "../src/registry/operation-registry.js";
import { ReportWorkflow } from "../src/workflows/report-workflow.js";
import { bundle, operation } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("ReportWorkflow", () => {
  it("creates, polls, downloads, decompresses, and stores reports", async () => {
    const operations = [
      operation({
        id: "reports.2021-06-30.createReport",
        domain: "reports",
        apiVersion: "2021-06-30",
        operationId: "createReport",
        method: "POST",
        access: "write",
        requestBody: {
          required: true,
          contentType: "application/json",
          schema: { type: "object" },
        },
      }),
      operation({
        id: "reports.2021-06-30.getReport",
        domain: "reports",
        apiVersion: "2021-06-30",
        operationId: "getReport",
        path: "/reports/{reportId}",
        parameters: [
          { name: "reportId", location: "path", required: true, schema: { type: "string" } },
        ],
      }),
      operation({
        id: "reports.2021-06-30.getReportDocument",
        domain: "reports",
        apiVersion: "2021-06-30",
        operationId: "getReportDocument",
        path: "/documents/{reportDocumentId}",
        parameters: [
          {
            name: "reportDocumentId",
            location: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
      }),
    ];
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ data: { reportId: "report-1" } })
      .mockResolvedValueOnce({ data: { processingStatus: "IN_PROGRESS" } })
      .mockResolvedValueOnce({ data: { processingStatus: "DONE", reportDocumentId: "doc-1" } })
      .mockResolvedValueOnce({
        data: { url: "https://download.test/report", compressionAlgorithm: "GZIP" },
      });
    const executor = { invoke } as unknown as SpApiExecutor;
    const directory = await mkdtemp(resolve(tmpdir(), "report-workflow-test-"));
    temporaryDirectories.push(directory);
    const store = new ArtifactStore(directory);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(gzipSync("sku\tquantity\nABC\t2\n"), {
        status: 200,
        headers: { "content-type": "text/tab-separated-values" },
      }),
    );
    const workflow = new ReportWorkflow(
      new OperationRegistry(bundle(operations)),
      executor,
      store,
      fetchMock,
    );

    const result = await workflow.run({
      reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
      accountName: "hexai-na",
      marketplaceIds: ["ATVPDKIKX0DER"],
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      reportId: "report-1",
      reportDocumentId: "doc-1",
      processingStatus: "DONE",
    });
    await expect(store.get(result.artifact.id)).resolves.toMatchObject({
      content: "sku\tquantity\nABC\t2\n",
    });
    expect(invoke).toHaveBeenCalledTimes(4);
    const calls = invoke.mock.calls as unknown as [string, unknown, { accountName?: string }][];
    expect(calls.every((call) => call[2].accountName === "hexai-na")).toBe(true);
  });

  it("fails fast for terminal report statuses", async () => {
    const operations = ["createReport", "getReport", "getReportDocument"].map((operationId) =>
      operation({
        id: `reports.2021-06-30.${operationId}`,
        domain: "reports",
        apiVersion: "2021-06-30",
        operationId,
        method: operationId === "createReport" ? "POST" : "GET",
        access: operationId === "createReport" ? "write" : "read",
      }),
    );
    const executor = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce({ data: { reportId: "report-1" } })
        .mockResolvedValueOnce({ data: { processingStatus: "FATAL" } }),
    } as unknown as SpApiExecutor;
    const directory = await mkdtemp(resolve(tmpdir(), "report-workflow-test-"));
    temporaryDirectories.push(directory);
    const workflow = new ReportWorkflow(
      new OperationRegistry(bundle(operations)),
      executor,
      new ArtifactStore(directory),
    );
    await expect(workflow.run({ reportType: "TYPE", timeoutMs: 100 })).rejects.toMatchObject({
      code: "REPORT_FAILED",
    });
  });
});
