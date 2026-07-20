import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AccountRegistry } from "./accounts/account-registry.js";
import type { ArtifactStore } from "./artifacts/artifact-store.js";
import { errorPayload } from "./errors.js";
import type { SpApiExecutor } from "./execution/sp-api-executor.js";
import type { OperationRegistry } from "./registry/operation-registry.js";
import type { JsonObject } from "./types.js";
import type { ReportWorkflow } from "./workflows/report-workflow.js";

export interface ServerDependencies {
  registry: OperationRegistry;
  accountRegistry: AccountRegistry;
  executor: SpApiExecutor;
  artifactStore: ArtifactStore;
  reportWorkflow: ReportWorkflow;
}

export function createMcpServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: "amazon-sp-api-mcp", version: "1.0.0" },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List configured Amazon SP-API accounts",
      description:
        "List safe account metadata, including account names, regions, and marketplace participations. Credentials are never returned.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      safely(async () => ({ accounts: await dependencies.accountRegistry.listAccounts() })),
  );

  server.registerTool(
    "discover_operations",
    {
      title: "Discover Amazon SP-API operations",
      description:
        "Search the version-aware Amazon SP-API registry. Use this before describe_operation or invoke_operation.",
      inputSchema: {
        query: z.string().max(500).optional(),
        domain: z.string().max(100).optional(),
        version: z.string().max(40).optional(),
        access: z.enum(["read", "write", "delete"]).optional(),
        includeDeprecated: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (arguments_) =>
      safely(() => {
        const operations = dependencies.registry
          .discover({
            ...(arguments_.query === undefined ? {} : { query: arguments_.query }),
            ...(arguments_.domain === undefined ? {} : { domain: arguments_.domain }),
            ...(arguments_.version === undefined ? {} : { version: arguments_.version }),
            ...(arguments_.access === undefined ? {} : { access: arguments_.access }),
            includeDeprecated: arguments_.includeDeprecated,
            limit: arguments_.limit,
          })
          .map((operation) => ({
            id: operation.id,
            domain: operation.domain,
            version: operation.apiVersion,
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
            access: operation.access,
            deprecated: operation.deprecated,
            summary: operation.summary,
          }));
        return {
          registry: {
            ...dependencies.registry.bundle.stats,
            sourceCommit: dependencies.registry.bundle.source.commit,
          },
          operations,
        };
      }),
  );

  server.registerTool(
    "describe_operation",
    {
      title: "Describe an Amazon SP-API operation",
      description:
        "Return the exact method, path, parameters, request body, and validation schema for an operation ID.",
      inputSchema: { operationId: z.string().min(1) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operationId }) =>
      safely(() => {
        const operation = dependencies.registry.get(operationId);
        return {
          operation,
          inputSchema: dependencies.registry.inputSchema(operation),
          source: dependencies.registry.bundle.source,
        };
      }),
  );

  server.registerTool(
    "invoke_operation",
    {
      title: "Invoke an Amazon SP-API operation",
      description:
        "Execute an operation using a stable account name. Multiple-account configurations require accountName. Writes require confirm=true unless dryRun=true.",
      inputSchema: {
        operationId: z.string().min(1),
        accountName: z
          .string()
          .min(1)
          .optional()
          .describe("Stable configured account name; optional only when one account is configured"),
        path: z.record(z.string(), z.unknown()).optional(),
        query: z.record(z.string(), z.unknown()).optional(),
        headers: z.record(z.string(), z.unknown()).optional(),
        body: z.unknown().optional(),
        confirm: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, accountName, path, query, headers, body, confirm, dryRun }) =>
      safely(async () =>
        dependencies.executor.invoke(
          operationId,
          {
            ...(path === undefined ? {} : { path: path as never }),
            ...(query === undefined ? {} : { query: query as never }),
            ...(headers === undefined ? {} : { headers: headers as never }),
            ...(body === undefined ? {} : { body: body as never }),
          },
          {
            confirmed: confirm,
            ...(accountName === undefined ? {} : { accountName }),
            dryRun,
          },
        ),
      ),
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Read an SP-API artifact",
      description:
        "Read a chunk from a large or binary result saved by invoke_operation or run_report.",
      inputSchema: {
        id: z.uuid(),
        offset: z.number().int().min(0).default(0),
        length: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024)
          .default(256 * 1024),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, offset, length }) =>
      safely(async () => dependencies.artifactStore.get(id, offset, length)),
  );

  server.registerTool(
    "run_report",
    {
      title: "Run and download an Amazon SP-API report",
      description:
        "Create a report for a stable account name, poll until completion, download and decompress it, then return an artifact reference.",
      inputSchema: {
        reportType: z.string().min(1),
        accountName: z
          .string()
          .min(1)
          .optional()
          .describe("Stable configured account name; optional only when one account is configured"),
        marketplaceIds: z.array(z.string()).min(1).optional(),
        dataStartTime: z.iso.datetime().optional(),
        dataEndTime: z.iso.datetime().optional(),
        reportOptions: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional(),
        pollIntervalMs: z.number().int().min(500).max(30_000).default(2_000),
        timeoutMs: z.number().int().min(5_000).max(300_000).default(120_000),
        confirm: z.literal(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ confirm, ...arguments_ }) => {
      void confirm;
      return safely(async () => dependencies.reportWorkflow.run(arguments_ as never));
    },
  );

  return server;
}

async function safely(action: () => unknown): Promise<{
  content: { type: "text"; text: string }[];
  structuredContent: JsonObject;
  isError?: boolean;
}> {
  try {
    const value = await action();
    const structuredContent = toJsonObject(value);
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error) {
    const payload = errorPayload(error);
    const structuredContent = toJsonObject({ error: payload });
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
      isError: true,
    };
  }
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
