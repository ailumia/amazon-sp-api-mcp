import { SpApiMcpError } from "../errors.js";

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface LwaCredentials {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class LwaTokenProvider implements AccessTokenProvider {
  #cached?: { token: string; expiresAt: number };
  #refreshPromise: Promise<string> | undefined;

  public constructor(
    private readonly credentials: LwaCredentials,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public async getAccessToken(): Promise<string> {
    if (this.credentials.accessToken !== undefined) return this.credentials.accessToken;
    if (this.#cached !== undefined && this.#cached.expiresAt - Date.now() > 60_000) {
      return this.#cached.token;
    }
    this.#refreshPromise ??= this.refresh().finally(() => {
      this.#refreshPromise = undefined;
    });
    return this.#refreshPromise;
  }

  private async refresh(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.credentials;
    if (clientId === undefined || clientSecret === undefined || refreshToken === undefined) {
      throw new SpApiMcpError(
        "Live calls require SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, and SP_API_REFRESH_TOKEN",
        "CREDENTIALS_MISSING",
      );
    }
    const response = await this.fetchImplementation("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const responseText = await response.text();
    let body: TokenResponse;
    try {
      body = JSON.parse(responseText) as TokenResponse;
    } catch {
      body = { error_description: responseText.slice(0, 1_000) };
    }
    if (!response.ok || body.access_token === undefined) {
      throw new SpApiMcpError("Amazon LWA token exchange failed", "AUTHENTICATION_FAILED", {
        status: response.status,
        error: body.error,
        description: body.error_description,
      });
    }
    this.#cached = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }
}
