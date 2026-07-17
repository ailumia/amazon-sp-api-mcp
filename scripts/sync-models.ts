import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { generateRegistry } from "./registry-lib.js";

const execFileAsync = promisify(execFile);
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "ailumia-sp-api-models-"));
const output = resolve(process.argv[2] ?? "registry/operations.json");

try {
  await execFileAsync("git", [
    "clone",
    "--depth",
    "1",
    "https://github.com/amzn/selling-partner-api-models.git",
    temporaryDirectory,
  ]);
  await mkdir(dirname(output), { recursive: true });
  const bundle = await generateRegistry(
    resolve(temporaryDirectory, "models"),
    output,
    temporaryDirectory,
  );
  process.stdout.write(
    `Synced ${bundle.stats.operations} operations at ${bundle.source.commit.slice(0, 12)}.\n`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
