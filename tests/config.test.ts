import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads one or more SP-API accounts in array order", () => {
    const config = loadConfig({
      SP_API_ACCOUNTS: JSON.stringify([
        {
          accountName: "hexai-na",
          sellerId: "SELLER-NA",
          clientId: "na-id",
          clientSecret: "na-secret",
          refreshToken: "na-refresh",
          region: "na",
        },
        {
          accountName: "hexai-eu",
          clientId: "eu-id",
          clientSecret: "eu-secret",
          refreshToken: "eu-refresh",
          region: "eu",
        },
      ]),
    });

    expect(config.accounts).toEqual([
      {
        accountName: "hexai-na",
        sellerId: "SELLER-NA",
        clientId: "na-id",
        clientSecret: "na-secret",
        refreshToken: "na-refresh",
        region: "na",
        endpoint: "https://sellingpartnerapi-na.amazon.com",
      },
      {
        accountName: "hexai-eu",
        clientId: "eu-id",
        clientSecret: "eu-secret",
        refreshToken: "eu-refresh",
        region: "eu",
        endpoint: "https://sellingpartnerapi-eu.amazon.com",
      },
    ]);
  });

  it("supports static access tokens, region defaults, and endpoint overrides", () => {
    const config = loadConfig({
      SP_API_ACCOUNTS: JSON.stringify([
        { accessToken: "temporary", endpoint: "https://proxy.example.test/" },
      ]),
    });

    expect(config.accounts).toEqual([
      {
        accountName: "default",
        accessToken: "temporary",
        region: "na",
        endpoint: "https://proxy.example.test",
      },
    ]);
  });

  it("allows credential-free startup for discovery", () => {
    expect(loadConfig({}).accounts).toEqual([]);
  });

  it("parses runtime controls", () => {
    expect(
      loadConfig({
        SP_API_MAX_RETRIES: "3",
        SP_API_MAX_CONCURRENCY: "8",
        MCP_ALLOWED_HOSTS: "mcp.example.com, localhost",
      }),
    ).toMatchObject({
      maxRetries: 3,
      maxConcurrency: 8,
      allowedHosts: ["mcp.example.com", "localhost"],
    });
  });

  it("rejects malformed, empty, and incomplete account arrays", () => {
    expect(() => loadConfig({ SP_API_ACCOUNTS: "not-json" })).toThrow(
      "SP_API_ACCOUNTS must be valid JSON",
    );
    expect(() => loadConfig({ SP_API_ACCOUNTS: "[]" })).toThrow(
      "SP_API_ACCOUNTS must contain one or more valid account objects",
    );
    expect(() =>
      loadConfig({ SP_API_ACCOUNTS: JSON.stringify([{ refreshToken: "refresh" }]) }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
  });

  it("requires unique stable account names only for multi-account configurations", () => {
    const credential = { accessToken: "token" };
    expect(() => loadConfig({ SP_API_ACCOUNTS: JSON.stringify([credential, credential]) })).toThrow(
      "SP_API_ACCOUNTS must contain one or more valid account objects",
    );
    expect(() =>
      loadConfig({
        SP_API_ACCOUNTS: JSON.stringify([
          { ...credential, accountName: "same" },
          { ...credential, accountName: "same" },
        ]),
      }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
    expect(() =>
      loadConfig({
        SP_API_ACCOUNTS: JSON.stringify([{ ...credential, accountName: "Not Stable" }]),
      }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
  });

  it("rejects invalid regions and weak HTTP bearer tokens", () => {
    expect(() =>
      loadConfig({ SP_API_ACCOUNTS: JSON.stringify([{ accessToken: "token", region: "us" }]) }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
    expect(() => loadConfig({ MCP_BEARER_TOKEN: "short" })).toThrow();
  });
});
