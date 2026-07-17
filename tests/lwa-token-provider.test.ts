import { describe, expect, it, vi } from "vitest";
import { LwaTokenProvider } from "../src/auth/lwa-token-provider.js";

describe("LwaTokenProvider", () => {
  it("returns a configured static token without a network request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider = new LwaTokenProvider({ accessToken: "token" }, fetchMock);
    await expect(provider.getAccessToken()).resolves.toBe("token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges and caches a refresh token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new LwaTokenProvider(
      { clientId: "id", clientSecret: "secret", refreshToken: "refresh" },
      fetchMock,
    );
    await expect(
      Promise.all([provider.getAccessToken(), provider.getAccessToken()]),
    ).resolves.toEqual(["fresh", "fresh"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports missing credentials and sanitized LWA failures", async () => {
    await expect(new LwaTokenProvider({}).getAccessToken()).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_client", error_description: "bad client" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      new LwaTokenProvider(
        { clientId: "id", clientSecret: "secret", refreshToken: "refresh" },
        fetchMock,
      ).getAccessToken(),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("handles non-JSON LWA failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("upstream unavailable", { status: 503 }));
    await expect(
      new LwaTokenProvider(
        { clientId: "id", clientSecret: "secret", refreshToken: "refresh" },
        fetchMock,
      ).getAccessToken(),
    ).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      details: { description: "upstream unavailable" },
    });
  });
});
