import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("ArtifactStore", () => {
  it("stores content with integrity metadata and reads bounded chunks", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "artifact-store-test-"));
    temporaryDirectories.push(directory);
    const store = new ArtifactStore(directory);
    const artifact = await store.put(Buffer.from("hello world"), "text/plain");
    expect(artifact).toMatchObject({ bytes: 11, mediaType: "text/plain" });

    const first = await store.get(artifact.id, 0, 5);
    expect(first).toMatchObject({ content: "hello", encoding: "utf8", nextOffset: 5 });
    const last = await store.get(artifact.id, 6, 20);
    expect(last).toMatchObject({ content: "world", offset: 6 });
    expect(last.nextOffset).toBeUndefined();
  });

  it("rejects unsafe and unknown IDs", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "artifact-store-test-"));
    temporaryDirectories.push(directory);
    const store = new ArtifactStore(directory);
    await expect(store.get("../secret")).rejects.toMatchObject({ code: "INVALID_ARTIFACT_ID" });
    await expect(store.get("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });
});
