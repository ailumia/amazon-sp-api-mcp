import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads one or more SP-API accounts in array order", () => {
    const config = loadConfig({
      SP_API_ACCOUNTS: JSON.stringify([
        {
          ACCOUNT_NAME: "hexai-na",
          SP_API_CLIENT_ID: "na-id",
          SP_API_CLIENT_SECRET: "na-secret",
          SP_API_REFRESH_TOKEN: "na-refresh",
          SP_API_REGION: "na",
        },
        {
          ACCOUNT_NAME: "hexai-eu",
          SP_API_CLIENT_ID: "eu-id",
          SP_API_CLIENT_SECRET: "eu-secret",
          SP_API_REFRESH_TOKEN: "eu-refresh",
          SP_API_REGION: "eu",
        },
      ]),
    });

    expect(config.accounts).toEqual([
      {
        accountName: "hexai-na",
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

  it("assigns single-account and region defaults", () => {
    const config = loadConfig({
      SP_API_ACCOUNTS: JSON.stringify([
        {
          SP_API_CLIENT_ID: "id",
          SP_API_CLIENT_SECRET: "secret",
          SP_API_REFRESH_TOKEN: "refresh",
        },
      ]),
    });

    expect(config.accounts).toEqual([
      {
        accountName: "default",
        clientId: "id",
        clientSecret: "secret",
        refreshToken: "refresh",
        region: "na",
        endpoint: "https://sellingpartnerapi-na.amazon.com",
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
      loadConfig({ SP_API_ACCOUNTS: JSON.stringify([{ SP_API_REFRESH_TOKEN: "refresh" }]) }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
    expect(() =>
      loadConfig({
        SP_API_ACCOUNTS: JSON.stringify([
          { clientId: "legacy", clientSecret: "legacy", refreshToken: "legacy" },
        ]),
      }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
  });

  it("requires unique stable account names only for multi-account configurations", () => {
    const credential = {
      SP_API_CLIENT_ID: "id",
      SP_API_CLIENT_SECRET: "secret",
      SP_API_REFRESH_TOKEN: "refresh",
    };
    expect(() => loadConfig({ SP_API_ACCOUNTS: JSON.stringify([credential, credential]) })).toThrow(
      "SP_API_ACCOUNTS must contain one or more valid account objects",
    );
    expect(() =>
      loadConfig({
        SP_API_ACCOUNTS: JSON.stringify([
          { ...credential, ACCOUNT_NAME: "same" },
          { ...credential, ACCOUNT_NAME: "same" },
        ]),
      }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
    expect(() =>
      loadConfig({
        SP_API_ACCOUNTS: JSON.stringify([{ ...credential, ACCOUNT_NAME: "Not Stable" }]),
      }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
  });

  it("rejects invalid regions and weak HTTP bearer tokens", () => {
    const credential = {
      SP_API_CLIENT_ID: "id",
      SP_API_CLIENT_SECRET: "secret",
      SP_API_REFRESH_TOKEN: "refresh",
    };
    expect(() =>
      loadConfig({
        SP_API_ACCOUNTS: JSON.stringify([{ ...credential, SP_API_REGION: "us" }]),
      }),
    ).toThrow("SP_API_ACCOUNTS must contain one or more valid account objects");
    expect(() => loadConfig({ MCP_BEARER_TOKEN: "short" })).toThrow();
  });
});
