import type { Logger } from "pino";
import type { AccessTokenProvider } from "../auth/lwa-token-provider.js";
import { SpApiMcpError } from "../errors.js";
import type { InvocationArguments, JsonValue } from "../types.js";

export type SpApiRegion = "na" | "eu" | "fe";

export interface RuntimeAccount {
  accountName: string;
  region: SpApiRegion;
  endpoint: string;
  tokenProvider: AccessTokenProvider;
}

export interface MarketplaceMetadata {
  marketplaceId: string;
  name: string;
  countryCode: string;
  storeName: string;
  isParticipating: boolean;
  hasSuspendedListings: boolean;
}

export interface AccountSummary {
  accountName: string;
  isDefault: boolean;
  region: SpApiRegion;
  metadataStatus: "ready" | "error";
  marketplaces: MarketplaceMetadata[];
  metadataError?: string;
}

export interface RegisteredAccount extends RuntimeAccount {
  metadataStatus: "not_requested" | "loading" | "ready" | "error";
  marketplaces: MarketplaceMetadata[];
  metadataError?: string;
  metadataPromise?: Promise<void>;
}

interface MarketplaceParticipationsResponse {
  payload?: unknown;
}

export class AccountRegistry {
  readonly #accounts: RegisteredAccount[];
  readonly #byName: Map<string, RegisteredAccount>;

  public constructor(
    accounts: readonly RuntimeAccount[],
    private readonly logger: Logger,
    private readonly userAgent: string,
    private readonly requestTimeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.#accounts = accounts.map((account) => ({
      ...account,
      metadataStatus: "not_requested",
      marketplaces: [],
    }));
    this.#byName = new Map(this.#accounts.map((account) => [account.accountName, account]));
  }

  public get size(): number {
    return this.#accounts.length;
  }

  public get defaultAccountName(): string | undefined {
    return this.#accounts.length === 1 ? this.#accounts[0]?.accountName : undefined;
  }

  public resolve(accountName?: string): RegisteredAccount {
    const defaultAccount = this.#accounts[0];
    if (defaultAccount === undefined) {
      throw new SpApiMcpError("No SP-API accounts are configured", "ACCOUNT_NOT_FOUND");
    }
    if (accountName === undefined) {
      if (this.#accounts.length > 1) {
        throw new SpApiMcpError(
          "accountName is required when multiple SP-API accounts are configured",
          "ACCOUNT_NAME_REQUIRED",
          { availableAccountNames: this.#accounts.map((account) => account.accountName) },
        );
      }
      return defaultAccount;
    }
    const account = this.#byName.get(accountName);
    if (account === undefined) {
      throw new SpApiMcpError(`SP-API account not found: ${accountName}`, "ACCOUNT_NOT_FOUND", {
        accountName,
      });
    }
    return account;
  }

  public warmUp(): void {
    for (const account of this.#accounts) {
      void this.ensureMarketplaceMetadata(account).catch(() => undefined);
    }
  }

  public async listAccounts(): Promise<AccountSummary[]> {
    await Promise.allSettled(
      this.#accounts.map(async (account) => this.ensureMarketplaceMetadata(account)),
    );
    return this.#accounts.map((account, index) => ({
      accountName: account.accountName,
      isDefault: this.#accounts.length === 1 && index === 0,
      region: account.region,
      metadataStatus: account.metadataStatus === "ready" ? "ready" : "error",
      marketplaces: account.marketplaces,
      ...(account.metadataError === undefined ? {} : { metadataError: account.metadataError }),
    }));
  }

  public async validateRequest(
    account: RegisteredAccount,
    arguments_: InvocationArguments,
  ): Promise<string[]> {
    const marketplaceIds = marketplaceIdsFromArguments(arguments_);
    if (marketplaceIds.length === 0) return marketplaceIds;
    await this.ensureMarketplaceMetadata(account);
    const enabled = new Set(
      account.marketplaces
        .filter(({ isParticipating }) => isParticipating)
        .map(({ marketplaceId }) => marketplaceId),
    );
    const unavailable = marketplaceIds.filter((marketplaceId) => !enabled.has(marketplaceId));
    if (unavailable.length > 0) {
      throw new SpApiMcpError(
        `accountName=${account.accountName} does not have access to marketplaceId=${unavailable.join(",")}`,
        "ACCOUNT_MARKETPLACE_MISMATCH",
        {
          accountName: account.accountName,
          marketplaceIds: unavailable,
          enabledMarketplaceIds: [...enabled],
        },
      );
    }
    return marketplaceIds;
  }

  private async ensureMarketplaceMetadata(account: RegisteredAccount): Promise<void> {
    if (account.metadataStatus === "ready") return;
    account.metadataPromise ??= this.loadMarketplaceMetadata(account).finally(() => {
      delete account.metadataPromise;
    });
    await account.metadataPromise;
  }

  private async loadMarketplaceMetadata(account: RegisteredAccount): Promise<void> {
    account.metadataStatus = "loading";
    delete account.metadataError;
    try {
      const accessToken = await account.tokenProvider.getAccessToken();
      const response = await this.fetchImplementation(
        `${account.endpoint}/sellers/v1/marketplaceParticipations`,
        {
          headers: {
            accept: "application/json",
            "user-agent": this.userAgent,
            "x-amz-access-token": accessToken,
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
      const body = (await response.json()) as MarketplaceParticipationsResponse;
      if (!response.ok) {
        throw new SpApiMcpError(
          `Marketplace discovery returned HTTP ${response.status}`,
          "ACCOUNT_METADATA_UNAVAILABLE",
          { accountName: account.accountName, status: response.status },
        );
      }
      account.marketplaces = parseParticipations(body.payload);
      account.metadataStatus = "ready";
      this.logger.info(
        {
          accountName: account.accountName,
          region: account.region,
          marketplaces: account.marketplaces.map(({ marketplaceId }) => marketplaceId),
        },
        "SP-API account metadata loaded",
      );
    } catch (error) {
      account.metadataStatus = "error";
      account.metadataError =
        error instanceof Error ? error.message : "Amazon marketplace discovery failed";
      this.logger.warn(
        { accountName: account.accountName, region: account.region, error: account.metadataError },
        "SP-API account metadata unavailable",
      );
      if (error instanceof SpApiMcpError) throw error;
      throw new SpApiMcpError(
        `Marketplace metadata unavailable for accountName=${account.accountName}`,
        "ACCOUNT_METADATA_UNAVAILABLE",
        { accountName: account.accountName },
      );
    }
  }
}

export function marketplaceIdsFromArguments(arguments_: InvocationArguments): string[] {
  const values = new Set<string>();
  for (const container of [arguments_.path, arguments_.query, arguments_.body]) {
    collectNamedValues(container, /^marketplaceIds?$/iu, values);
  }
  return [...values];
}

function collectNamedValues(
  value: JsonValue | Record<string, JsonValue> | undefined,
  pattern: RegExp,
  output: Set<string>,
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectNamedValues(item, pattern, output);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (pattern.test(key)) {
      if (typeof child === "string") output.add(child);
      if (Array.isArray(child)) {
        for (const item of child) if (typeof item === "string") output.add(item);
      }
    }
    collectNamedValues(child, pattern, output);
  }
}

function parseParticipations(value: unknown): MarketplaceMetadata[] {
  if (!Array.isArray(value)) {
    throw new SpApiMcpError(
      "Marketplace discovery returned an invalid payload",
      "UNEXPECTED_SP_API_RESPONSE",
    );
  }
  return value.map((item) => {
    const object = asObject(item);
    const marketplace = asObject(object.marketplace);
    const participation = asObject(object.participation);
    return {
      marketplaceId: requiredString(marketplace.id, "marketplace.id"),
      name: requiredString(marketplace.name, "marketplace.name"),
      countryCode: requiredString(marketplace.countryCode, "marketplace.countryCode"),
      storeName: requiredString(object.storeName, "storeName"),
      isParticipating: requiredBoolean(participation.isParticipating, "isParticipating"),
      hasSuspendedListings: requiredBoolean(
        participation.hasSuspendedListings,
        "hasSuspendedListings",
      ),
    };
  });
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpApiMcpError(
      "Marketplace discovery returned an invalid payload",
      "UNEXPECTED_SP_API_RESPONSE",
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SpApiMcpError(`Expected marketplace field ${field}`, "UNEXPECTED_SP_API_RESPONSE");
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new SpApiMcpError(`Expected marketplace field ${field}`, "UNEXPECTED_SP_API_RESPONSE");
  }
  return value;
}
