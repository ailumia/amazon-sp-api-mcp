import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import type { AccountRegistry } from "../src/accounts/account-registry.js";
import type { SpApiExecutor } from "../src/execution/sp-api-executor.js";
import { OperationRegistry } from "../src/registry/operation-registry.js";
import { createMcpServer } from "../src/server.js";
import type { ReportWorkflow } from "../src/workflows/report-workflow.js";
import { bundle, operation } from "./helpers.js";

const closeables: { close(): Promise<void> }[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map(async (item) => item.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("MCP server", () => {
  it("exposes a stable tool surface and serves registry discovery", async () => {
    const registry = new OperationRegistry(bundle([operation()]));
    const directory = await mkdtemp(resolve(tmpdir(), "server-test-"));
    temporaryDirectories.push(directory);
    const invoke = vi.fn().mockResolvedValue({
      operationId: "orders.v0.getOrders",
      status: 200,
      data: { payload: {} },
    });
    const server = createMcpServer({
      registry,
      accountRegistry: {
        listAccounts: vi.fn().mockResolvedValue([
          {
            accountName: "hexai-eu",
            isDefault: true,
            region: "eu",
            metadataStatus: "ready",
            marketplaces: [],
          },
        ]),
      } as unknown as AccountRegistry,
      artifactStore: new ArtifactStore(directory),
      executor: { invoke } as unknown as SpApiExecutor,
      reportWorkflow: { run: vi.fn() } as unknown as ReportWorkflow,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      "list_accounts",
      "discover_operations",
      "describe_operation",
      "invoke_operation",
      "get_artifact",
      "run_report",
    ]);
    const result = await client.callTool({
      name: "discover_operations",
      arguments: { query: "orders" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      registry: { operations: 1 },
      operations: [{ id: "orders.v0.getOrders" }],
    });

    const accounts = await client.callTool({ name: "list_accounts", arguments: {} });
    expect(accounts.structuredContent).toMatchObject({
      accounts: [{ accountName: "hexai-eu", region: "eu" }],
    });

    await client.callTool({
      name: "invoke_operation",
      arguments: { operationId: "orders.v0.getOrders", accountName: "hexai-eu" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "orders.v0.getOrders",
      {},
      {
        accountName: "hexai-eu",
        confirmed: false,
        dryRun: false,
      },
    );
  });

  it("returns structured tool errors", async () => {
    const registry = new OperationRegistry(bundle([operation()]));
    const directory = await mkdtemp(resolve(tmpdir(), "server-test-"));
    temporaryDirectories.push(directory);
    const server = createMcpServer({
      registry,
      accountRegistry: { listAccounts: vi.fn() } as unknown as AccountRegistry,
      artifactStore: new ArtifactStore(directory),
      executor: { invoke: vi.fn() } as unknown as SpApiExecutor,
      reportWorkflow: { run: vi.fn() } as unknown as ReportWorkflow,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "describe_operation",
      arguments: { operationId: "missing" },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_NOT_FOUND" } },
    });
  });
});
