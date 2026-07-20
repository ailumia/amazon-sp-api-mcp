import { resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  SP_API_ACCOUNTS: z.string().min(1).optional(),
  SP_API_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
  SP_API_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(100 * 1024 * 1024)
    .default(1024 * 1024),
  SP_API_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  SP_API_ARTIFACT_DIR: z.string().default("./artifacts"),
  SP_API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_BEARER_TOKEN: z.string().min(16).optional(),
});

const accountInputSchema = z
  .object({
    accountName: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
      .optional(),
    sellerId: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    region: z.enum(["na", "eu", "fe"]).default("na"),
    endpoint: z.url().optional(),
  })
  .strict()
  .superRefine((account, context) => {
    if (account.accessToken !== undefined) return;
    for (const field of ["clientId", "clientSecret", "refreshToken"] as const) {
      if (account[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required when accessToken is not configured`,
        });
      }
    }
  });
const accountsInputSchema = z
  .array(accountInputSchema)
  .min(1)
  .superRefine((accounts, context) => {
    if (accounts.length > 1) {
      for (const [index, account] of accounts.entries()) {
        if (account.accountName === undefined) {
          context.addIssue({
            code: "custom",
            path: [index, "accountName"],
            message: "accountName is required when multiple accounts are configured",
          });
        }
      }
    }
    const names = new Set<string>();
    for (const [index, account] of accounts.entries()) {
      if (account.accountName === undefined) continue;
      if (names.has(account.accountName)) {
        context.addIssue({
          code: "custom",
          path: [index, "accountName"],
          message: "accountName must be unique",
        });
      }
      names.add(account.accountName);
    }
  });
type AccountInput = z.infer<typeof accountInputSchema>;

export interface SpApiAccountConfig {
  accountName: string;
  sellerId?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  region: "na" | "eu" | "fe";
  endpoint: string;
}

export interface AppConfig {
  accounts: SpApiAccountConfig[];
  maxRetries: number;
  maxResponseBytes: number;
  maxConcurrency: number;
  artifactDir: string;
  requestTimeoutMs: number;
  logLevel: string;
  port: number;
  host: string;
  allowedHosts?: string[];
  bearerToken?: string;
}

const REGION_ENDPOINTS = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    accounts: parseAccounts(parsed.SP_API_ACCOUNTS),
    maxRetries: parsed.SP_API_MAX_RETRIES,
    maxResponseBytes: parsed.SP_API_MAX_RESPONSE_BYTES,
    maxConcurrency: parsed.SP_API_MAX_CONCURRENCY,
    artifactDir: resolve(parsed.SP_API_ARTIFACT_DIR),
    requestTimeoutMs: parsed.SP_API_REQUEST_TIMEOUT_MS,
    logLevel: parsed.LOG_LEVEL,
    port: parsed.PORT,
    host: parsed.HOST,
    ...(parsed.MCP_ALLOWED_HOSTS === undefined
      ? {}
      : {
          allowedHosts: parsed.MCP_ALLOWED_HOSTS.split(",")
            .map((host) => host.trim())
            .filter(Boolean),
        }),
    ...(parsed.MCP_BEARER_TOKEN === undefined ? {} : { bearerToken: parsed.MCP_BEARER_TOKEN }),
  };
}

function parseAccounts(value: string | undefined): SpApiAccountConfig[] {
  if (value === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new Error("SP_API_ACCOUNTS must be valid JSON");
  }
  const result = accountsInputSchema.safeParse(json);
  if (!result.success) {
    throw new Error("SP_API_ACCOUNTS must contain one or more valid account objects");
  }
  return result.data.map(resolveAccount);
}

function resolveAccount(account: AccountInput): SpApiAccountConfig {
  return {
    accountName: account.accountName ?? "default",
    ...(account.sellerId === undefined ? {} : { sellerId: account.sellerId }),
    ...(account.clientId === undefined ? {} : { clientId: account.clientId }),
    ...(account.clientSecret === undefined ? {} : { clientSecret: account.clientSecret }),
    ...(account.refreshToken === undefined ? {} : { refreshToken: account.refreshToken }),
    ...(account.accessToken === undefined ? {} : { accessToken: account.accessToken }),
    region: account.region,
    endpoint: (account.endpoint ?? REGION_ENDPOINTS[account.region]).replace(/\/$/, ""),
  };
}
