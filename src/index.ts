#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import pino from "pino";
import type { Request, Response } from "express";
import { AccountRegistry } from "./accounts/account-registry.js";
import { ArtifactStore } from "./artifacts/artifact-store.js";
import { LwaTokenProvider } from "./auth/lwa-token-provider.js";
import { loadConfig } from "./config.js";
import { SpApiExecutor } from "./execution/sp-api-executor.js";
import { loadRegistryBundle } from "./registry/load-bundle.js";
import { OperationRegistry } from "./registry/operation-registry.js";
import { createMcpServer, type ServerDependencies } from "./server.js";
import { ReportWorkflow } from "./workflows/report-workflow.js";

const config = loadConfig();
const logger = pino({ level: config.logLevel }, pino.destination(2));
const bundle = await loadRegistryBundle();
const registry = new OperationRegistry(bundle);
const artifactStore = new ArtifactStore(config.artifactDir);
const userAgent = "ailumia-amazon-sp-api-mcp/1.0.0";
const accountRegistry = new AccountRegistry(
  config.accounts.map((account) => ({
    accountName: account.accountName,
    region: account.region,
    endpoint: account.endpoint,
    tokenProvider: new LwaTokenProvider({
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      refreshToken: account.refreshToken,
    }),
  })),
  logger,
  userAgent,
  config.requestTimeoutMs,
);
const executor = new SpApiExecutor(registry, accountRegistry, artifactStore, logger, {
  maxRetries: config.maxRetries,
  maxResponseBytes: config.maxResponseBytes,
  maxConcurrency: config.maxConcurrency,
  requestTimeoutMs: config.requestTimeoutMs,
  userAgent,
});
const dependencies: ServerDependencies = {
  registry,
  accountRegistry,
  executor,
  artifactStore,
  reportWorkflow: new ReportWorkflow(registry, executor, artifactStore),
};
accountRegistry.warmUp();

const transport = argumentValue("--transport") ?? "stdio";
if (transport === "stdio") {
  const server = createMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
  logger.info(
    {
      operations: bundle.stats.operations,
      sourceCommit: bundle.source.commit,
      accounts: accountRegistry.size,
      defaultAccountName: accountRegistry.defaultAccountName,
    },
    "MCP server started",
  );
} else if (transport === "http") {
  startHttpServer(dependencies);
} else {
  throw new Error(`Unsupported transport: ${transport}`);
}

function startHttpServer(serverDependencies: ServerDependencies): void {
  if (!isLoopback(config.host) && config.allowedHosts === undefined) {
    throw new Error("MCP_ALLOWED_HOSTS is required when HOST is not a loopback address");
  }
  const app = createMcpExpressApp({
    host: config.host,
    ...(config.allowedHosts === undefined ? {} : { allowedHosts: config.allowedHosts }),
  });
  app.get("/health", (_request: Request, response: Response) => {
    response.json({ status: "ok", registry: bundle.stats, sourceCommit: bundle.source.commit });
  });
  app.post("/mcp", async (request: Request, response: Response) => {
    if (!authorized(request.headers.authorization, config.bearerToken)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const server = createMcpServer(serverDependencies);
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as never);
    try {
      await server.connect(httpTransport as never);
      await httpTransport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error({ error }, "MCP HTTP request failed");
      if (!response.headersSent) response.status(500).json({ error: "internal_error" });
    } finally {
      await httpTransport.close();
      await server.close();
    }
  });
  app.get("/mcp", (_request: Request, response: Response) =>
    response.status(405).json({ error: "method_not_allowed" }),
  );
  app.delete("/mcp", (_request: Request, response: Response) =>
    response.status(405).json({ error: "method_not_allowed" }),
  );
  app.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        operations: bundle.stats.operations,
        accounts: accountRegistry.size,
        defaultAccountName: accountRegistry.defaultAccountName,
      },
      "Streamable HTTP MCP server started",
    );
  });
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function authorized(header: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  if (header?.startsWith("Bearer ") !== true) return false;
  const actualBuffer = Buffer.from(header.slice(7));
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
