import { resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  SP_API_CLIENT_ID: z.string().min(1).optional(),
  SP_API_CLIENT_SECRET: z.string().min(1).optional(),
  SP_API_REFRESH_TOKEN: z.string().min(1).optional(),
  SP_API_ACCESS_TOKEN: z.string().min(1).optional(),
  SP_API_REGION: z.enum(["na", "eu", "fe"]).default("na"),
  SP_API_ENDPOINT: z.url().optional(),
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

export interface AppConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  region: "na" | "eu" | "fe";
  endpoint: string;
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
    ...(parsed.SP_API_CLIENT_ID === undefined ? {} : { clientId: parsed.SP_API_CLIENT_ID }),
    ...(parsed.SP_API_CLIENT_SECRET === undefined
      ? {}
      : { clientSecret: parsed.SP_API_CLIENT_SECRET }),
    ...(parsed.SP_API_REFRESH_TOKEN === undefined
      ? {}
      : { refreshToken: parsed.SP_API_REFRESH_TOKEN }),
    ...(parsed.SP_API_ACCESS_TOKEN === undefined
      ? {}
      : { accessToken: parsed.SP_API_ACCESS_TOKEN }),
    region: parsed.SP_API_REGION,
    endpoint: (parsed.SP_API_ENDPOINT ?? REGION_ENDPOINTS[parsed.SP_API_REGION]).replace(/\/$/, ""),
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
