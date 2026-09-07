import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  isProviderPersistencePathSafe,
  MAX_PROVIDER_PERSISTENCE_FILE_BYTES,
  PROVIDER_PERSISTENCE_OUTBOX_ROOT,
} from "../providerPersistence.ts";

export interface ArtifactUploadGrant {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Upload directly from the worker's disk. S3 enforces the signed body checksum. */
export async function uploadOutboxArtifacts(files: ReadonlyArray<ArtifactUploadGrant>) {
  if (files.length > 100) throw new Error("Too many artifact uploads.");
  const root = await realpath(PROVIDER_PERSISTENCE_OUTBOX_ROOT);
  const uploaded = [];
  for (const file of files) {
    if (!isProviderPersistencePathSafe(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error("Invalid artifact selection.");
    }
    const target = await realpath(path.join(root, file.path));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Artifact escaped the Outbox.");
    const info = await stat(target);
    if (!info.isFile() || info.size !== file.sizeBytes || info.size > MAX_PROVIDER_PERSISTENCE_FILE_BYTES) {
      throw new Error("Artifact size changed before upload.");
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(target)) digest.update(chunk);
    if (digest.digest("hex") !== file.sha256) throw new Error("Artifact changed before upload.");
    const url = new URL(file.uploadUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("Artifact upload requires a signed HTTPS URL.");
    }
    const checksum = Buffer.from(file.sha256, "hex").toString("base64");
    if (file.headers["x-amz-checksum-sha256"] !== checksum) {
      throw new Error("Artifact upload grant has the wrong checksum.");
    }
    const body = Readable.toWeb(createReadStream(target));
    const response = await fetch(url, {
      method: "PUT",
      headers: file.headers,
      body,
      duplex: "half",
      signal: AbortSignal.timeout(90_000),
    } as RequestInit);
    if (!response.ok) throw new Error(`Artifact upload failed with HTTP ${response.status}.`);
    await response.arrayBuffer();
    uploaded.push({ path: file.path, sha256: file.sha256, sizeBytes: info.size });
  }
  return { uploaded };
}
