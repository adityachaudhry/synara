/**
 * Off-volume backups of the durable Harness database.
 *
 * The Harness SQLite file holds every durable conversation. A consistent snapshot
 * (VACUUM INTO) is gzipped and uploaded through a Glasswing artifact-API grant, so a
 * lost controller volume can be restored from the newest snapshot.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

import { artifactApiClient } from "../providerWorker/artifactPublisher.ts";

export const DURABLE_BACKUP_NAME = "durable-harness";

type Grant = { key: string; upload_url: string; headers: Record<string, string> };
type Latest = { key: string; size_bytes: number; last_modified: string; download_url: string };

/** Error text including undici's network cause, which `fetch failed` hides. */
export const describe = (cause: unknown): string => {
  const error = cause as { message?: unknown; cause?: { message?: unknown; code?: unknown } };
  return [error?.message ?? String(cause), error?.cause?.code, error?.cause?.message].filter(Boolean).join(" | ");
};

const log = (event: string, detail: Record<string, unknown>) => console.info(JSON.stringify({ event, ...detail }));

/** Uploads one consistent snapshot. Returns the stored key, or undefined without a backup API. */
export async function backupHarness(storagePath: string): Promise<string | undefined> {
  const api = artifactApiClient();
  if (!api || !existsSync(storagePath)) return undefined;
  const snapshot = `${storagePath}.snapshot-${process.pid}-${Date.now()}`;
  const started = Date.now();
  try {
    const database = new DatabaseSync(storagePath);
    try {
      database.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    } finally {
      database.close();
    }
    const body = gzipSync(readFileSync(snapshot), { level: 6 });
    const sha256 = createHash("sha256").update(body).digest("hex");
    const grant = await api<Grant>("/internal/controller-backups/grants", {
      name: DURABLE_BACKUP_NAME,
      sha256,
      size_bytes: body.byteLength,
    }).catch((cause: unknown) => {
      throw new Error(`Backup grant request failed: ${describe(cause)}`);
    });
    const response = await fetch(grant.upload_url, {
      method: "PUT",
      headers: Object.fromEntries(Object.entries(grant.headers).filter(([key]) => key.toLowerCase() !== "content-length")),
      body,
      signal: AbortSignal.timeout(120_000),
    }).catch((cause: unknown) => {
      throw new Error(`Backup upload to ${new URL(grant.upload_url).host} failed: ${describe(cause)}`);
    });
    if (!response.ok) throw new Error(`Backup upload failed with HTTP ${response.status}.`);
    log("durable.backup.uploaded", { key: grant.key, bytes: body.byteLength, durationMs: Date.now() - started });
    return grant.key;
  } finally {
    rmSync(snapshot, { force: true });
  }
}

/**
 * Restores the newest snapshot when the database file is missing, or when forced.
 * A forced restore keeps the replaced file beside it; nothing is deleted.
 */
export async function restoreHarnessIfNeeded(storagePath: string, force: boolean): Promise<boolean> {
  if (!force && existsSync(storagePath)) return false;
  const api = artifactApiClient();
  if (!api) return false;
  let latest: Latest;
  try {
    latest = await api<Latest>(`/internal/controller-backups/latest?name=${DURABLE_BACKUP_NAME}`);
  } catch (cause) {
    log("durable.backup.restore-skipped", { reason: String(cause) });
    return false;
  }
  const response = await fetch(latest.download_url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Backup download failed with HTTP ${response.status}.`);
  const restored = gunzipSync(Buffer.from(await response.arrayBuffer()));
  if (existsSync(storagePath)) {
    const aside = `${storagePath}.pre-restore-${Date.now()}`;
    renameSync(storagePath, aside);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(storagePath + suffix)) renameSync(storagePath + suffix, aside + suffix);
    log("durable.backup.kept-previous", { path: aside });
  }
  writeFileSync(storagePath, restored, { mode: 0o600 });
  const verify = new DatabaseSync(storagePath, { readOnly: true });
  try {
    const result = verify.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (result?.integrity_check !== "ok") throw new Error(`Restored Harness failed integrity_check: ${String(result?.integrity_check)}`);
  } finally {
    verify.close();
  }
  log("durable.backup.restored", { key: latest.key, bytes: restored.byteLength, lastModified: latest.last_modified });
  return true;
}
