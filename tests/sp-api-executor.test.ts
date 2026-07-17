import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
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

    expect(result).toMatchObject({ status: 200, requestId: "request-1", rateLimit: "1.0" });
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
      details: { status: 400, requestId: "bad-1" },
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
});

async function createExecutor(
  operations: ReturnType<typeof operation>[],
  fetchMock: typeof fetch,
  maxResponseBytes = 1024 * 1024,
): Promise<SpApiExecutor> {
  const directory = await mkdtemp(resolve(tmpdir(), "executor-test-"));
  temporaryDirectories.push(directory);
  const registry = new OperationRegistry(bundle(operations));
  return new SpApiExecutor(
    registry,
    { getAccessToken: () => Promise.resolve("access-token") },
    new ArtifactStore(directory),
    pino({ level: "silent" }),
    {
      endpoint: "https://example.test",
      maxRetries: 2,
      maxResponseBytes,
      maxConcurrency: 2,
      requestTimeoutMs: 5_000,
      userAgent: "test/1.0.0",
    },
    fetchMock,
  );
}
