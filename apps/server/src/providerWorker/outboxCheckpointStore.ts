import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isProviderPersistencePathSafe,
  MAX_PROVIDER_PERSISTENCE_CANDIDATES,
  MAX_PROVIDER_PERSISTENCE_FILE_BYTES,
  MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES,
  providerPersistenceSha256,
  type ProviderPersistenceCandidate,
  type ProviderPersistenceCandidateSelection,
  type ProviderPersistenceFile,
} from "../providerPersistence.ts";

export interface StoredOutboxEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly promotedSha256?: string;
}

export interface OutboxCheckpointManifest {
  readonly schemaVersion: 1;
  readonly threadId: string;
  readonly lifecycleGeneration: string;
  readonly updatedAt: string;
  readonly entries: ReadonlyArray<StoredOutboxEntry>;
}

export interface OutboxCheckpointStore {
  readonly checkpoint: (input: {
    readonly threadId: string;
    readonly lifecycleGeneration: string;
    readonly files: ReadonlyArray<ProviderPersistenceFile>;
  }) => Promise<OutboxCheckpointManifest>;
  readonly list: (threadId: string) => Promise<OutboxCheckpointManifest | null>;
  readonly read: (
    threadId: string,
    selection: ProviderPersistenceCandidateSelection,
  ) => Promise<ProviderPersistenceFile>;
  readonly readPath: (threadId: string, path: string) => Promise<ProviderPersistenceFile>;
  readonly restore: (
    threadId: string,
  ) => Promise<ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>>;
  readonly markPromoted: (
    threadId: string,
    selections: ReadonlyArray<ProviderPersistenceCandidateSelection>,
  ) => Promise<void>;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function manifestKey(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex");
}

function assertStoredEntry(value: unknown): asserts value is StoredOutboxEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outbox checkpoint entry is invalid.");
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.path !== "string" ||
    !isProviderPersistencePathSafe(entry.path) ||
    typeof entry.sha256 !== "string" ||
    !HASH_PATTERN.test(entry.sha256) ||
    typeof entry.sizeBytes !== "number" ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes < 0 ||
    entry.sizeBytes > MAX_PROVIDER_PERSISTENCE_FILE_BYTES ||
    typeof entry.modifiedAt !== "string" ||
    (entry.promotedSha256 !== undefined &&
      (typeof entry.promotedSha256 !== "string" || !HASH_PATTERN.test(entry.promotedSha256)))
  ) {
    throw new Error("Outbox checkpoint entry is invalid.");
  }
}

function parseManifest(raw: string, expectedThreadId: string): OutboxCheckpointManifest {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outbox checkpoint manifest is invalid.");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.threadId !== expectedThreadId ||
    typeof manifest.lifecycleGeneration !== "string" ||
    manifest.lifecycleGeneration.length === 0 ||
    typeof manifest.updatedAt !== "string" ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > MAX_PROVIDER_PERSISTENCE_CANDIDATES
  ) {
    throw new Error("Outbox checkpoint manifest is invalid.");
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    assertStoredEntry(entry);
    if (seen.has(entry.path)) throw new Error("Outbox checkpoint paths are duplicated.");
    seen.add(entry.path);
    totalBytes += entry.sizeBytes;
  }
  if (totalBytes > MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES) {
    throw new Error("Outbox checkpoint exceeds its storage limit.");
  }
  return manifest as unknown as OutboxCheckpointManifest;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.part`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function candidate(entry: StoredOutboxEntry): ProviderPersistenceCandidate {
  return {
    source: "outbox",
    path: entry.path,
    destinationPath: entry.path,
    name: path.posix.basename(entry.path),
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
    sha256: entry.sha256,
  };
}

export function listUnpromotedOutboxCandidates(
  manifest: OutboxCheckpointManifest,
): ReadonlyArray<ProviderPersistenceCandidate> {
  return manifest.entries.filter((entry) => entry.promotedSha256 !== entry.sha256).map(candidate);
}

export function makeOutboxCheckpointStore(root: string): OutboxCheckpointStore {
  const blobsRoot = path.join(root, "blobs");
  const threadsRoot = path.join(root, "threads");
  const manifestPath = (threadId: string) =>
    path.join(threadsRoot, `${manifestKey(threadId)}.json`);
  const blobPath = (sha256: string) => path.join(blobsRoot, sha256.slice(0, 2), sha256);

  const list = async (threadId: string): Promise<OutboxCheckpointManifest | null> => {
    try {
      return parseManifest(await fs.readFile(manifestPath(threadId), "utf8"), threadId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const writeManifest = async (manifest: OutboxCheckpointManifest): Promise<void> => {
    await writeAtomic(
      manifestPath(manifest.threadId),
      Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"),
    );
  };

  const readBlob = async (entry: StoredOutboxEntry): Promise<Uint8Array> => {
    const bytes = await fs.readFile(blobPath(entry.sha256));
    if (bytes.byteLength !== entry.sizeBytes || providerPersistenceSha256(bytes) !== entry.sha256) {
      throw new Error(`Outbox checkpoint blob '${entry.path}' failed verification.`);
    }
    return bytes;
  };

  return {
    list,
    checkpoint: async (input) => {
      const previous = await list(input.threadId);
      const promotedByPath = new Map(
        previous?.entries.map((entry) => [entry.path, entry] as const) ?? [],
      );
      const unique = new Map<string, ProviderPersistenceFile>();
      for (const file of input.files) {
        if (file.source !== "outbox" || !isProviderPersistencePathSafe(file.path)) {
          throw new Error("Outbox checkpoint received an invalid file.");
        }
        if (
          !HASH_PATTERN.test(file.sha256) ||
          file.bytes.byteLength !== file.sizeBytes ||
          file.sizeBytes > MAX_PROVIDER_PERSISTENCE_FILE_BYTES ||
          providerPersistenceSha256(file.bytes) !== file.sha256
        ) {
          throw new Error(`Outbox checkpoint file '${file.path}' failed verification.`);
        }
        unique.set(file.path, file);
      }
      if (unique.size > MAX_PROVIDER_PERSISTENCE_CANDIDATES) {
        throw new Error("Outbox checkpoint contains too many files.");
      }
      const files = Array.from(unique.values()).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      );
      const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
      if (totalBytes > MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES) {
        throw new Error("Outbox checkpoint exceeds its storage limit.");
      }
      for (const file of files) {
        const target = blobPath(file.sha256);
        try {
          await fs.access(target);
        } catch {
          await writeAtomic(target, file.bytes);
        }
      }
      const manifest: OutboxCheckpointManifest = {
        schemaVersion: 1,
        threadId: input.threadId,
        lifecycleGeneration: input.lifecycleGeneration,
        updatedAt: new Date().toISOString(),
        entries: files.map((file) => {
          const previousEntry = promotedByPath.get(file.path);
          return {
            path: file.path,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            modifiedAt: file.modifiedAt,
            ...(previousEntry?.promotedSha256 === file.sha256
              ? { promotedSha256: file.sha256 }
              : {}),
          };
        }),
      };
      await writeManifest(manifest);
      return manifest;
    },
    read: async (threadId, selection) => {
      if (selection.source !== "outbox" || !isProviderPersistencePathSafe(selection.path)) {
        throw new Error("Outbox checkpoint selection is invalid.");
      }
      const manifest = await list(threadId);
      const entry = manifest?.entries.find((candidate) => candidate.path === selection.path);
      if (!entry || entry.sha256 !== selection.sha256) {
        throw new Error("Outbox checkpoint changed after it was reviewed.");
      }
      const bytes = await readBlob(entry);
      return { ...candidate(entry), bytes };
    },
    readPath: async (threadId, candidatePath) => {
      if (!isProviderPersistencePathSafe(candidatePath)) {
        throw new Error("Outbox checkpoint path is invalid.");
      }
      const manifest = await list(threadId);
      const entry = manifest?.entries.find((candidate) => candidate.path === candidatePath);
      if (!entry) {
        throw new Error("Outbox checkpoint file was not found.");
      }
      return { ...candidate(entry), bytes: await readBlob(entry) };
    },
    restore: async (threadId) => {
      const manifest = await list(threadId);
      if (!manifest) return [];
      return Promise.all(
        manifest.entries.map(async (entry) => ({ path: entry.path, bytes: await readBlob(entry) })),
      );
    },
    markPromoted: async (threadId, selections) => {
      const manifest = await list(threadId);
      if (!manifest) return;
      const promoted = new Map(
        selections
          .filter((selection) => selection.source === "outbox")
          .map((selection) => [selection.path, selection.sha256] as const),
      );
      if (promoted.size === 0) return;
      await writeManifest({
        ...manifest,
        updatedAt: new Date().toISOString(),
        entries: manifest.entries.map((entry) =>
          promoted.get(entry.path) === entry.sha256
            ? { ...entry, promotedSha256: entry.sha256 }
            : entry,
        ),
      });
    },
  };
}
