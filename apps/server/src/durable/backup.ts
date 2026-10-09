/**
 * Off-volume backups of the controller's state, through Glasswing's signed backup grants
 * (`POST /internal/controller-backups/grants`). Each object lands under
 * `controller-backups/<env>/<kind>/`, where `<env>` is the controller's environment:
 *
 * - `durable-harness`: the Pi Durable Harness (VACUUM INTO), 2 min after start, every 10 min and
 *   at shutdown (scheduled by the engine);
 * - `state`: Synara's `state.sqlite` (SQLite online backup through its own connection), hourly;
 * - `attachments`: the chat attachments directory (tar.gz), hourly when it changed;
 * - `drafts`: the controller copies of thread Outbox files and checkout drafts (tar.gz), hourly
 *   when they changed.
 *
 * A missing or corrupt Harness is restored on open from the newest environment-prefixed snapshot,
 * falling back to the pre-environment key `controller-backups/durable-harness/`.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGzip, gunzipSync } from "node:zlib";

import { controllerEnvironmentName } from "../controllerEnvironment.ts";
import { artifactApiClient } from "../providerWorker/artifactPublisher.ts";

export const DURABLE_BACKUP_NAME = "durable-harness";

export type ControllerBackupKind = typeof DURABLE_BACKUP_NAME | "state" | "attachments" | "drafts";
type Extension = "sqlite.gz" | "tar.gz";
type Grant = { key: string; upload_url: string; headers: Record<string, string> };
type Latest = { key: string; size_bytes: number; last_modified: string; download_url: string };

const PREFIX = "controller-backups";
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

/** Error text including undici's network cause, which `fetch failed` hides. */
export const describe = (cause: unknown): string => {
  const error = cause as { message?: unknown; cause?: { message?: unknown; code?: unknown } };
  return [error?.message ?? String(cause), error?.cause?.code, error?.cause?.message].filter(Boolean).join(" | ");
};

const log = (event: string, detail: Record<string, unknown>) => console.info(JSON.stringify({ event, ...detail }));

async function sha256File(file: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function gzipFile(source: string, target: string) {
  await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(target, { mode: 0o600 }));
}

/** Streams a file to a signed PUT URL with its exact length (the grant signs size and checksum). */
function putFile(url: string, headers: Readonly<Record<string, string>>, file: string, size: number): Promise<void> {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : target.protocol === "http:" ? http : undefined;
  if (!transport) return Promise.reject(new Error("Backup upload requires an HTTP(S) URL."));
  return new Promise<void>((resolve, reject) => {
    const request = transport.request(target, {
      method: "PUT",
      headers: {
        ...Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-length")),
        "Content-Length": String(size),
      },
      timeout: UPLOAD_TIMEOUT_MS,
    }, (response) => {
      response.resume();
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`Backup upload to ${target.host} failed with HTTP ${status}.`));
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`Backup upload to ${target.host} timed out.`)));
    request.on("error", reject);
    const body = createReadStream(file);
    body.on("error", (cause) => request.destroy(cause));
    body.pipe(request);
  });
}

/**
 * Uploads one prepared file under `controller-backups/<env>/<kind>/`. Returns the stored key, or
 * undefined when there is no backup API or Glasswing does not yet grant environment-prefixed keys
 * (the Harness alone still uses the old key then, as before).
 */
async function uploadBackup(kind: ControllerBackupKind, file: string, extension: Extension): Promise<string | undefined> {
  const api = artifactApiClient();
  if (!api) return undefined;
  const started = Date.now();
  const env = controllerEnvironmentName();
  const { size } = await stat(file);
  const sha256 = await sha256File(file);
  const grant = await api<Grant>("/internal/controller-backups/grants", {
    name: kind, env, extension, sha256, size_bytes: size,
  }).catch((cause: unknown) => {
    throw new Error(`Backup grant request failed: ${describe(cause)}`);
  });
  if (!grant.key.startsWith(`${PREFIX}/${env}/${kind}/`) && kind !== DURABLE_BACKUP_NAME) {
    log("controller.backup.skipped", { kind, reason: "Glasswing granted a key without the environment prefix", key: grant.key });
    return undefined;
  }
  await putFile(grant.upload_url, grant.headers, file, size);
  log(kind === DURABLE_BACKUP_NAME ? "durable.backup.uploaded" : "controller.backup.uploaded", {
    kind, key: grant.key, bytes: size, durationMs: Date.now() - started,
  });
  return grant.key;
}

/** Uploads one consistent Harness snapshot. Returns the stored key, or undefined without a backup API. */
export async function backupHarness(storagePath: string): Promise<string | undefined> {
  if (!artifactApiClient() || !existsSync(storagePath)) return undefined;
  const snapshot = `${storagePath}.snapshot-${process.pid}-${Date.now()}`;
  try {
    const database = new DatabaseSync(storagePath);
    try {
      database.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    } finally {
      database.close();
    }
    await gzipFile(snapshot, `${snapshot}.gz`);
    await rm(snapshot, { force: true });
    return await uploadBackup(DURABLE_BACKUP_NAME, `${snapshot}.gz`, "sqlite.gz");
  } finally {
    await rm(snapshot, { force: true });
    await rm(`${snapshot}.gz`, { force: true });
  }
}

async function latestBackup(name: string, env: string | undefined): Promise<Latest | undefined> {
  const api = artifactApiClient();
  if (!api) return undefined;
  const query = new URLSearchParams({ name, ...(env ? { env } : {}) });
  try {
    return await api<Latest>(`/internal/controller-backups/latest?${query}`);
  } catch (cause) {
    if (String(cause).includes("HTTP 404")) return undefined;
    throw cause;
  }
}

/**
 * Restores the newest snapshot when the database file is missing, or when forced.
 * A forced restore keeps the replaced file beside it; nothing is deleted.
 */
export async function restoreHarnessIfNeeded(storagePath: string, force: boolean): Promise<boolean> {
  if (!force && existsSync(storagePath)) return false;
  if (!artifactApiClient()) return false;
  let latest: Latest | undefined;
  try {
    // The environment's own backups first; then the key used before backups were per environment.
    latest = await latestBackup(DURABLE_BACKUP_NAME, controllerEnvironmentName()) ?? await latestBackup(DURABLE_BACKUP_NAME, undefined);
  } catch (cause) {
    log("durable.backup.restore-skipped", { reason: String(cause) });
    return false;
  }
  if (!latest) {
    log("durable.backup.restore-skipped", { reason: "no backup" });
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

// ----------------------------------------------------------- controller state

export interface ControllerBackupPaths {
  /** Synara's `state.sqlite`, open in this process. */
  readonly stateDbPath: string;
  readonly attachmentsDir: string;
  /** The Outbox checkpoint store (its `drafts/` holds checkout drafts). */
  readonly draftsDir: string;
  /** Scratch space for snapshots and archives, on the same volume; emptied at start. */
  readonly workDir: string;
}

const STATE_FIRST_DELAY_MS = 5 * 60_000;
const STATE_INTERVAL_MS = 60 * 60_000;
const execFileAsync = promisify(execFile);

/** Paths, sizes and modification times: unchanged means the last archive is still current. */
async function directoryFingerprint(dir: string): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const info = await stat(file).catch(() => undefined);
    if (info) files.push(`${path.relative(dir, file)}\u0000${info.size}\u0000${info.mtimeMs}`);
  }
  if (files.length === 0) return undefined;
  return createHash("sha256").update(files.sort().join("\n")).digest("hex");
}

async function enoughSpace(dir: string, needed: number) {
  const info = await statfs(dir);
  return info.bavail * info.bsize > needed;
}

/**
 * Exports `state.sqlite`, the attachments directory and the drafts store off-volume, hourly
 * (directories only when they changed). Returns a stop function. Failures are logged and retried
 * on the next pass; nothing here blocks the controller.
 */
export function startControllerBackups(paths: ControllerBackupPaths, options: { readonly firstDelayMs?: number } = {}): () => void {
  if (!artifactApiClient()) return () => undefined;
  const uploaded = new Map<string, string>();
  let running = false;
  let stopped = false;

  const backupState = async () => {
    // Deployed controllers run on Node; Bun dev servers use another SQLite client.
    if (process.versions.bun !== undefined || !existsSync(paths.stateDbPath)) return;
    const { size } = await stat(paths.stateDbPath);
    // Snapshot plus its compressed copy, with headroom.
    if (!(await enoughSpace(paths.workDir, size * 2 + 256 * 1024 * 1024))) {
      log("controller.backup.skipped", { kind: "state", reason: "not enough free space for a snapshot", bytes: size });
      return;
    }
    const snapshot = path.join(paths.workDir, `state-${Date.now()}.sqlite`);
    try {
      // The same module the persistence layer loads under Node, so it sees the open connection.
      const { backupOpenDatabase } = await import("../persistence/NodeSqliteClient.ts");
      await backupOpenDatabase(paths.stateDbPath, snapshot);
      await gzipFile(snapshot, `${snapshot}.gz`);
      await rm(snapshot, { force: true });
      await uploadBackup("state", `${snapshot}.gz`, "sqlite.gz");
    } finally {
      await rm(snapshot, { force: true });
      await rm(`${snapshot}.gz`, { force: true });
    }
  };

  const backupDirectory = async (kind: "attachments" | "drafts", dir: string) => {
    const fingerprint = await directoryFingerprint(dir);
    if (!fingerprint || uploaded.get(kind) === fingerprint) return;
    const archive = path.join(paths.workDir, `${kind}-${Date.now()}.tar.gz`);
    try {
      await execFileAsync("tar", ["-czf", archive, "-C", path.dirname(dir), path.basename(dir)], { timeout: 15 * 60_000 });
      if (await uploadBackup(kind, archive, "tar.gz")) uploaded.set(kind, fingerprint);
    } finally {
      await rm(archive, { force: true });
    }
  };

  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await mkdir(paths.workDir, { recursive: true, mode: 0o700 });
      for (const [kind, run] of [
        ["state", backupState],
        ["attachments", () => backupDirectory("attachments", paths.attachmentsDir)],
        ["drafts", () => backupDirectory("drafts", paths.draftsDir)],
      ] as const) {
        if (stopped) break;
        await run().catch((cause: unknown) => console.warn(JSON.stringify({ event: "controller.backup.failed", kind, message: describe(cause) })));
      }
    } finally {
      running = false;
    }
  };

  // Scratch files of an interrupted pass are never resumed.
  void rm(paths.workDir, { recursive: true, force: true }).catch(() => undefined);
  const first = setTimeout(() => void pass(), options.firstDelayMs ?? STATE_FIRST_DELAY_MS);
  first.unref();
  const timer = setInterval(() => void pass(), STATE_INTERVAL_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
