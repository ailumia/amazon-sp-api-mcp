import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("maps regions and parses runtime controls", () => {
    expect(
      loadConfig({
        SP_API_REGION: "eu",
        SP_API_MAX_RETRIES: "3",
        SP_API_MAX_CONCURRENCY: "8",
        MCP_ALLOWED_HOSTS: "mcp.example.com, localhost",
      }),
    ).toMatchObject({
      endpoint: "https://sellingpartnerapi-eu.amazon.com",
      maxRetries: 3,
      maxConcurrency: 8,
      allowedHosts: ["mcp.example.com", "localhost"],
    });
  });

  it("rejects invalid regions and weak HTTP bearer tokens", () => {
    expect(() => loadConfig({ SP_API_REGION: "us" })).toThrow();
    expect(() => loadConfig({ MCP_BEARER_TOKEN: "short" })).toThrow();
  });
});
