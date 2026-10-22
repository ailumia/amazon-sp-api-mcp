import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import type { AccountRegistry } from "../src/accounts/account-registry.js";
import { SpApiExecutor } from "../src/execution/sp-api-executor.js";
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

  it.each([
    ["object", { quantity: 2 }, { quantity: 2 }],
    ["array", [{ quantity: 2 }, null, false, 0], [{ quantity: 2 }, null, false, 0]],
    ["null", null, null],
    ["zero", 0, 0],
    ["number", -1.5, -1.5],
    ["true", true, true],
    ["false", false, false],
    ["JSON object string", '{"quantity":2}', { quantity: 2 }],
    ["JSON array string", '[{"quantity":2},null,false,0]', [{ quantity: 2 }, null, false, 0]],
    ["padded JSON string", ' \n {"quantity":2} \t ', { quantity: 2 }],
    ["raw string", "raw-text", "raw-text"],
    ["empty string", "", ""],
    ["whitespace-only string", " \t\r\n ", " \t\r\n "],
    ["padded raw string", " raw-text ", " raw-text "],
    ["malformed object string", ' {"quantity": ', ' {"quantity": '],
    ["malformed array string", " [1, ", " [1, "],
    ["JSON null string", "null", "null"],
    ["JSON number string", "42", "42"],
    ["JSON boolean string", "false", "false"],
    ["JSON quoted string", '"text"', '"text"'],
  ])("preserves invoke_operation body compatibility: %s", async (_name, body, expectedBody) => {
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
      accountRegistry: { listAccounts: vi.fn() } as unknown as AccountRegistry,
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
    const invokeTool = tools.tools.find(({ name }) => name === "invoke_operation");
    const bodySchema = invokeTool?.inputSchema.properties?.body as {
      anyOf?: { type?: string }[];
    };
    expect(bodySchema.anyOf?.map(({ type }) => type)).toEqual([
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null",
    ]);
    expect(invokeTool?.inputSchema.required).not.toContain("body");

    const result = await client.callTool({
      name: "invoke_operation",
      arguments: { operationId: "orders.v0.getOrders", body },
    });
    expect(result.isError).not.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith(
      "orders.v0.getOrders",
      { body: expectedBody },
      expect.objectContaining({ confirmed: false, dryRun: false }),
    );
  });

  it("validates parsed bodies and retains write confirmation through the executor", async () => {
    const target = operation({
      method: "POST",
      access: "write",
      requestBody: {
        required: true,
        contentType: "application/json",
        schema: {
          type: "object",
          required: ["quantity"],
          properties: { quantity: { type: "integer" } },
        },
      },
    });
    const registry = new OperationRegistry(bundle([target]));
    const directory = await mkdtemp(resolve(tmpdir(), "server-test-"));
    temporaryDirectories.push(directory);
    const artifactStore = new ArtifactStore(directory);
    const getAccessToken = vi.fn();
    const fetchMock = vi.fn<typeof fetch>();
    const accountRegistry = {
      resolve: () => ({
        accountName: "default",
        endpoint: "https://example.test",
        tokenProvider: { getAccessToken },
      }),
      validateRequest: vi.fn().mockResolvedValue(undefined),
    } as unknown as AccountRegistry;
    const executor = new SpApiExecutor(
      registry,
      accountRegistry,
      artifactStore,
      pino({ level: "silent" }),
      {
        maxRetries: 0,
        maxResponseBytes: 1024,
        maxConcurrency: 1,
        requestTimeoutMs: 5_000,
        userAgent: "test/1.0.0",
      },
      fetchMock,
    );
    const server = createMcpServer({
      registry,
      accountRegistry,
      artifactStore,
      executor,
      reportWorkflow: { run: vi.fn() } as unknown as ReportWorkflow,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const denied = await client.callTool({
      name: "invoke_operation",
      arguments: { operationId: target.id, body: '{"quantity":2}' },
    });
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "CONFIRMATION_REQUIRED" } },
    });

    const preview = await client.callTool({
      name: "invoke_operation",
      arguments: { operationId: target.id, body: '{"quantity":2}', dryRun: true },
    });
    expect(preview.isError).not.toBe(true);
    expect(preview.structuredContent).toMatchObject({
      dryRun: true,
      data: { submittedBody: { quantity: 2 } },
    });

    for (const body of [null, 0, false, "", " \t\n ", "{invalid", '{"quantity":"bad"}']) {
      const invalid = await client.callTool({
        name: "invoke_operation",
        arguments: { operationId: target.id, body, dryRun: true },
      });
      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "INVALID_ARGUMENTS" } },
      });
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
