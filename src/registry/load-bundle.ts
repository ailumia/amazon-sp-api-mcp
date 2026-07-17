import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SpApiMcpError } from "../errors.js";
import type { RegistryBundle } from "../types.js";

export async function loadRegistryBundle(
  path = process.env.SP_API_REGISTRY_PATH,
): Promise<RegistryBundle> {
  const registryPath =
    path === undefined
      ? fileURLToPath(new URL("../../registry/operations.json", import.meta.url))
      : resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
  } catch (error) {
    throw new SpApiMcpError(`Unable to load registry at ${registryPath}`, "REGISTRY_LOAD_FAILED", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRegistryBundle(parsed)) {
    throw new SpApiMcpError(`Invalid registry at ${registryPath}`, "INVALID_REGISTRY");
  }
  return parsed;
}

function isRegistryBundle(value: unknown): value is RegistryBundle {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const source = candidate.source;
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.operations) &&
    typeof candidate.modelSchemas === "object" &&
    candidate.modelSchemas !== null &&
    typeof source === "object" &&
    source !== null &&
    typeof (source as Record<string, unknown>).commit === "string"
  );
}
