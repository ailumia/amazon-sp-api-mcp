import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RegistryBundle } from "../src/types.js";

const path = resolve(process.argv[2] ?? "registry/operations.json");
const bundle = JSON.parse(await readFile(path, "utf8")) as RegistryBundle;
const uniqueIds = new Set(bundle.operations.map(({ id }) => id));
const domains = new Set(bundle.operations.map(({ domain }) => domain));

if (bundle.operations.length < 100)
  throw new Error("Registry unexpectedly contains fewer than 100 operations");
if (uniqueIds.size !== bundle.operations.length)
  throw new Error("Registry contains duplicate operation IDs");
if (bundle.stats.operations !== bundle.operations.length)
  throw new Error("Operation count is stale");
if (bundle.stats.domains !== domains.size) throw new Error("Domain count is stale");
if (!/^[a-f0-9]{40}$/u.test(bundle.source.commit))
  throw new Error("Registry source commit is invalid");

process.stdout.write(
  `Registry OK: ${bundle.stats.operations} operations, ${bundle.stats.domains} domains, source ${bundle.source.commit.slice(0, 12)}.\n`,
);
