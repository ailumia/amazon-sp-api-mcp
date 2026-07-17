import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseApiModel } from "../src/registry/model-parser.js";
import type { RegistryBundle } from "../src/types.js";

const execFileAsync = promisify(execFile);

export async function generateRegistry(
  modelsDirectory: string,
  outputFile: string,
  repositoryRoot = modelsDirectory,
): Promise<RegistryBundle> {
  const files = (await listJsonFiles(modelsDirectory)).sort();
  const operations = [];
  const modelSchemas: RegistryBundle["modelSchemas"] = {};

  for (const absolutePath of files) {
    const sourceFile = relative(modelsDirectory, absolutePath).split(sep).join("/");
    const parsed = parseApiModel(
      JSON.parse(await readFile(absolutePath, "utf8")) as unknown,
      sourceFile,
    );
    operations.push(...parsed.operations);
    modelSchemas[sourceFile] = parsed.schemas;
  }
  operations.sort((left, right) => left.id.localeCompare(right.id));
  const uniqueIds = new Set(operations.map(({ id }) => id));
  if (uniqueIds.size !== operations.length) {
    const duplicates = operations
      .map(({ id }) => id)
      .filter((id, index, all) => all.indexOf(id) !== index);
    throw new Error(`Duplicate operation IDs: ${[...new Set(duplicates)].join(", ")}`);
  }

  const { commit, generatedAt } = await gitMetadata(repositoryRoot);
  const bundle: RegistryBundle = {
    schemaVersion: 1,
    generatedAt,
    source: {
      repository: "https://github.com/amzn/selling-partner-api-models",
      commit,
    },
    stats: {
      models: files.length,
      domains: new Set(operations.map(({ domain }) => domain)).size,
      operations: operations.length,
    },
    operations,
    modelSchemas,
  };
  await writeFile(resolve(outputFile), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return bundle;
}

async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return listJsonFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function gitMetadata(
  repositoryRoot: string,
): Promise<{ commit: string; generatedAt: string }> {
  try {
    const root = (await stat(resolve(repositoryRoot, ".git"))).isDirectory();
    if (!root) throw new Error("not a git repository");
    const [{ stdout: commit }, { stdout: date }] = await Promise.all([
      execFileAsync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", repositoryRoot, "show", "-s", "--format=%cI", "HEAD"]),
    ]);
    return { commit: commit.trim(), generatedAt: date.trim() };
  } catch {
    return {
      commit: process.env.SP_API_MODELS_COMMIT ?? "local",
      generatedAt:
        process.env.SOURCE_DATE_EPOCH === undefined
          ? new Date().toISOString()
          : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString(),
    };
  }
}
