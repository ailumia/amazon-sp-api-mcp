import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AccountRegistry, type RuntimeAccount } from "../src/accounts/account-registry.js";

describe("AccountRegistry", () => {
  it("loads safe marketplace metadata and validates account combinations", async () => {
    const tokenProvider = { getAccessToken: vi.fn().mockResolvedValue("access-token") };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          payload: [
            {
              marketplace: { id: "US", name: "United States", countryCode: "US" },
              participation: { isParticipating: true, hasSuspendedListings: false },
              storeName: "Hexai Store",
            },
            {
              marketplace: { id: "CA", name: "Canada", countryCode: "CA" },
              participation: { isParticipating: false, hasSuspendedListings: true },
              storeName: "Hexai Store",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const registry = createRegistry(
      [
        {
          accountName: "hexai-na",
          sellerId: "SELLER",
          region: "na",
          endpoint: "https://na.example.test",
          tokenProvider,
        },
      ],
      fetchMock,
    );

    const summaries = await registry.listAccounts();
    expect(summaries[0]).toMatchObject({
      accountName: "hexai-na",
      sellerId: "SELLER",
      isDefault: true,
      region: "na",
      metadataStatus: "ready",
    });
    expect(summaries[0]?.marketplaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ marketplaceId: "US", storeName: "Hexai Store" }),
      ]),
    );
    await expect(
      registry.validateRequest(registry.resolve(), {
        path: { sellerId: "SELLER" },
        query: { marketplaceIds: ["US"] },
      }),
    ).resolves.toEqual(["US"]);
    await expect(
      registry.validateRequest(registry.resolve(), { query: { marketplaceId: "CA" } }),
    ).rejects.toMatchObject({ code: "ACCOUNT_MARKETPLACE_MISMATCH" });
    await expect(
      registry.validateRequest(registry.resolve(), { path: { sellerId: "OTHER" } }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SELLER_MISMATCH" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("requires explicit names for multiple accounts", () => {
    const registry = createRegistry([account("one"), account("two")], vi.fn<typeof fetch>());
    expect(() => registry.resolve()).toThrow("accountName is required");
    expect(registry.resolve("two").accountName).toBe("two");
    expect(() => registry.resolve("missing")).toThrow("SP-API account not found");
    expect(() => createRegistry([], vi.fn<typeof fetch>()).resolve()).toThrow(
      "No SP-API accounts are configured",
    );
  });

  it("reports metadata failures without exposing credentials", async () => {
    const registry = createRegistry(
      [account("broken")],
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ errors: [] }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(registry.listAccounts()).resolves.toMatchObject([
      {
        accountName: "broken",
        metadataStatus: "error",
        metadataError: "Marketplace discovery returned HTTP 403",
      },
    ]);
  });
});

function createRegistry(accounts: RuntimeAccount[], fetchMock: typeof fetch): AccountRegistry {
  return new AccountRegistry(accounts, pino({ level: "silent" }), "test/1.0.0", 5_000, fetchMock);
}

function account(accountName: string): RuntimeAccount {
  return {
    accountName,
    region: "na",
    endpoint: "https://na.example.test",
    tokenProvider: { getAccessToken: () => Promise.resolve("token") },
  };
}
