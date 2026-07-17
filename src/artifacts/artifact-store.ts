import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SpApiMcpError } from "../errors.js";
import type { ArtifactReference } from "../types.js";

interface ArtifactMetadata extends ArtifactReference {
  createdAt: string;
}

export interface ArtifactChunk {
  artifact: ArtifactReference;
  offset: number;
  nextOffset?: number;
  encoding: "utf8" | "base64";
  content: string;
}

const SAFE_ID = /^[a-f0-9-]{36}$/u;

export class ArtifactStore {
  public constructor(private readonly directory: string) {}

  public async put(content: Uint8Array, mediaType: string): Promise<ArtifactReference> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const artifact: ArtifactMetadata = {
      id,
      mediaType,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      createdAt: new Date().toISOString(),
    };
    await Promise.all([
      writeFile(this.dataPath(id), content, { mode: 0o600 }),
      writeFile(this.metadataPath(id), JSON.stringify(artifact), { mode: 0o600 }),
    ]);
    return toReference(artifact);
  }

  public async get(id: string, offset = 0, length = 256 * 1024): Promise<ArtifactChunk> {
    if (!SAFE_ID.test(id)) {
      throw new SpApiMcpError("Invalid artifact ID", "INVALID_ARTIFACT_ID");
    }
    const metadata = await this.readMetadata(id);
    if (offset < 0 || offset > metadata.bytes) {
      throw new SpApiMcpError("Artifact offset is out of range", "INVALID_ARTIFACT_OFFSET");
    }
    const boundedLength = Math.min(Math.max(length, 1), 1024 * 1024);
    const data = await readFile(this.dataPath(id));
    const chunk = data.subarray(offset, Math.min(offset + boundedLength, data.byteLength));
    const isText = isTextMediaType(metadata.mediaType);
    const nextOffset = offset + chunk.byteLength;
    return {
      artifact: toReference(metadata),
      offset,
      ...(nextOffset >= metadata.bytes ? {} : { nextOffset }),
      encoding: isText ? "utf8" : "base64",
      content: isText ? chunk.toString("utf8") : chunk.toString("base64"),
    };
  }

  private async readMetadata(id: string): Promise<ArtifactMetadata> {
    try {
      return JSON.parse(await readFile(this.metadataPath(id), "utf8")) as ArtifactMetadata;
    } catch {
      throw new SpApiMcpError(`Artifact not found: ${id}`, "ARTIFACT_NOT_FOUND");
    }
  }

  private dataPath(id: string): string {
    return resolve(this.directory, `${id}.bin`);
  }

  private metadataPath(id: string): string {
    return resolve(this.directory, `${id}.json`);
  }
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("xml");
}

function toReference(metadata: ArtifactMetadata): ArtifactReference {
  return {
    id: metadata.id,
    mediaType: metadata.mediaType,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
  };
}
