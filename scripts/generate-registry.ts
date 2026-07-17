import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateRegistry } from "./registry-lib.js";

const source = resolve(process.argv[2] ?? ".cache/selling-partner-api-models/models");
const repositoryRoot = resolve(source, "..");
const output = resolve(process.argv[3] ?? "registry/operations.json");
await mkdir(dirname(output), { recursive: true });
const bundle = await generateRegistry(source, output, repositoryRoot);
process.stdout.write(
  `Generated ${bundle.stats.operations} operations from ${bundle.stats.models} models across ${bundle.stats.domains} domains.\n`,
);
