import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRegistry, type RuntimeAccount } from "../src/accounts/account-registry.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { SpApiExecutor } from "../src/execution/sp-api-executor.js";
import { OperationRegistry } from "../src/registry/operation-registry.js";
import { bundle, operation } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("SpApiExecutor", () => {
  it("validates, authenticates, serializes, and returns structured responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ payload: { count: 1 } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-amzn-requestid": "request-1",
          "x-amzn-ratelimit-limit": "1.0",
        },
      }),
    );
    const target = operation({
      path: "/orders/{orderId}",
      parameters: [
        { name: "orderId", location: "path", required: true, schema: { type: "string" } },
        {
          name: "MarketplaceIds",
          location: "query",
          required: true,
          schema: { type: "array", items: { type: "string" } },
        },
      ],
    });
    const executor = await createExecutor([target], fetchMock);
    const result = await executor.invoke(target.id, {
      path: { orderId: "A/B" },
      query: { MarketplaceIds: ["US", "CA"] },
    });

    expect(result).toMatchObject({
      status: 200,
      accountName: "default",
      requestId: "request-1",
      rateLimit: "1.0",
    });
    expect(typeof result.auditId).toBe("string");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/orders/A%2FB?MarketplaceIds=US%2CCA");
    expect(new Headers(init?.headers).get("x-amz-access-token")).toBe("access-token");
  });

  it("requires confirmation for writes", async () => {
    const target = operation({ method: "POST", access: "write" });
    const executor = await createExecutor([target], vi.fn<typeof fetch>());
    await expect(executor.invoke(target.id, {})).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });
  });

  it("retries throttling and stores oversized responses as artifacts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("throttled", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ payload: "x".repeat(100) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const executor = await createExecutor([operation()], fetchMock, 64);
    const result = await executor.invoke("orders.v0.getOrders", {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.artifact).toMatchObject({ mediaType: "application/json" });
    expect(result.data).toBeUndefined();
  });

  it("returns structured SP-API errors without retrying client failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: "InvalidInput" }] }), {
        status: 400,
        headers: { "content-type": "application/json", "x-amzn-requestid": "bad-1" },
      }),
    );
    const executor = await createExecutor([operation()], fetchMock);
    await expect(executor.invoke("orders.v0.getOrders", {})).rejects.toMatchObject({
      code: "SP_API_ERROR",
      details: {
        status: 400,
        requestId: "bad-1",
        accountName: "default",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes terminal network failures", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed"));
    const executor = await createExecutor([operation()], fetchMock);
    await expect(executor.invoke("orders.v0.getOrders", {})).rejects.toMatchObject({
      code: "SP_API_NETWORK_ERROR",
      details: { cause: "socket closed" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    random.mockRestore();
  });

  it("routes credentials and endpoints by stable account name", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ payload: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const usTokenProvider = { getAccessToken: vi.fn().mockResolvedValue("us-token") };
    const euTokenProvider = { getAccessToken: vi.fn().mockResolvedValue("eu-token") };
    const executor = await createExecutor([operation()], fetchMock, 1024 * 1024, [
      {
        accountName: "hexai-na",
        region: "na",
        endpoint: "https://na.example.test",
        tokenProvider: usTokenProvider,
      },
      {
        accountName: "hexai-eu",
        region: "eu",
        endpoint: "https://eu.example.test",
        tokenProvider: euTokenProvider,
      },
    ]);

    await executor.invoke("orders.v0.getOrders", {}, { accountName: "hexai-eu" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://eu.example.test/orders/v0/orders");
    expect(new Headers(init?.headers).get("x-amz-access-token")).toBe("eu-token");
    expect(euTokenProvider.getAccessToken).toHaveBeenCalledTimes(1);
    expect(usTokenProvider.getAccessToken).not.toHaveBeenCalled();
  });

  it("requires a name for multiple accounts and rejects unknown names", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const accounts: RuntimeAccount[] = [
      {
        accountName: "one",
        region: "na",
        endpoint: "https://one.example.test",
        tokenProvider: { getAccessToken: () => Promise.resolve("one") },
      },
      {
        accountName: "two",
        region: "eu",
        endpoint: "https://two.example.test",
        tokenProvider: { getAccessToken: () => Promise.resolve("two") },
      },
    ];
    const executor = await createExecutor([operation()], fetchMock, 1024 * 1024, accounts);
    await expect(executor.invoke("orders.v0.getOrders", {})).rejects.toMatchObject({
      code: "ACCOUNT_NAME_REQUIRED",
    });
    await expect(
      executor.invoke("orders.v0.getOrders", {}, { accountName: "missing" }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
      details: { accountName: "missing" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports write dry runs without sending the operation", async () => {
    const target = operation({
      method: "PATCH",
      access: "write",
      path: "/listings/{sellerId}/{sku}",
      parameters: [
        { name: "sellerId", location: "path", required: true, schema: { type: "string" } },
        { name: "sku", location: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: { required: true, contentType: "application/json", schema: { type: "object" } },
    });
    const fetchMock = vi.fn<typeof fetch>();
    const executor = await createExecutor([target], fetchMock, 1024 * 1024, [
      {
        accountName: "hexai-na",
        sellerId: "SELLER",
        region: "na",
        endpoint: "https://na.example.test",
        tokenProvider: { getAccessToken: () => Promise.resolve("token") },
      },
    ]);
    const result = await executor.invoke(
      target.id,
      { path: { sellerId: "SELLER", sku: "SKU-1" }, body: { quantity: 2 } },
      { dryRun: true },
    );
    expect(result).toMatchObject({
      accountName: "hexai-na",
      dryRun: true,
      status: 0,
      data: { method: "PATCH", submittedBody: { quantity: 2 } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits structured write audit fields without logging the payload", async () => {
    const target = operation({
      method: "PATCH",
      access: "write",
      requestBody: { required: true, contentType: "application/json", schema: { type: "object" } },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json", "x-amzn-requestid": "request-write" },
      }),
    );
    const info = vi.fn();
    const logger = { info } as unknown as Logger;
    const executor = await createExecutor([target], fetchMock, 1024 * 1024, undefined, logger);
    await executor.invoke(target.id, { body: { quantity: 2 } }, { confirmed: true });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: true,
        accountName: "default",
        operationId: target.id,
        confirmed: true,
        requestId: "request-write",
      }),
      "SP-API audit event",
    );
    const event = info.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(typeof event?.payloadHash).toBe("string");
    expect(JSON.stringify(info.mock.calls)).not.toContain('"quantity":2');
  });
});

async function createExecutor(
  operations: ReturnType<typeof operation>[],
  fetchMock: typeof fetch,
  maxResponseBytes = 1024 * 1024,
  accounts?: RuntimeAccount[],
  logger: Logger = pino({ level: "silent" }),
): Promise<SpApiExecutor> {
  const resolvedAccounts: RuntimeAccount[] = accounts ?? [
    {
      accountName: "default",
      region: "na",
      endpoint: "https://example.test",
      tokenProvider: { getAccessToken: () => Promise.resolve("access-token") },
    },
  ];
  const directory = await mkdtemp(resolve(tmpdir(), "executor-test-"));
  temporaryDirectories.push(directory);
  const registry = new OperationRegistry(bundle(operations));
  const accountRegistry = new AccountRegistry(
    resolvedAccounts,
    logger,
    "test/1.0.0",
    5_000,
    vi.fn<typeof fetch>().mockResolvedValue(marketplaceResponse("US", "CA", "DE")),
  );
  return new SpApiExecutor(
    registry,
    accountRegistry,
    new ArtifactStore(directory),
    logger,
    {
      maxRetries: 2,
      maxResponseBytes,
      maxConcurrency: 2,
      requestTimeoutMs: 5_000,
      userAgent: "test/1.0.0",
    },
    fetchMock,
  );
}

function marketplaceResponse(...marketplaceIds: string[]): Response {
  return new Response(
    JSON.stringify({
      payload: marketplaceIds.map((marketplaceId) => ({
        marketplace: {
          id: marketplaceId,
          name: marketplaceId,
          countryCode: marketplaceId.slice(0, 2).padEnd(2, "X"),
        },
        participation: { isParticipating: true, hasSuspendedListings: false },
        storeName: `Store ${marketplaceId}`,
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
