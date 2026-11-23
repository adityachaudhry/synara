/**
 * Off-volume backups of the controller's state, through Glasswing's signed backup grants
 * (`POST /internal/controller-backups/grants`). Each object lands under
 * `controller-backups/<env>/<kind>/`, where `<env>` is the controller's environment:
 *
 * - `durable-harness`: the Pi Durable Harness (VACUUM INTO in a low-priority child process, or an
 *   online backup through the controller's own connection when the Harness is open in exclusive
 *   locking mode; onto the container's own disk when it has room), 2 min after start, then every
 *   10 min (hourly on weekdays 08:00–19:00 New York time) when it changed, hourly when it did not,
 *   and at shutdown (`startHarnessBackups`, started by the engine);
 * - `state`: Synara's `state.sqlite` (SQLite online backup through its own connection, into the
 *   container's own disk when it has room), hourly;
 * - `attachments`: the chat attachments directory (tar.gz), hourly when it changed;
 * - `drafts`: the controller copies of thread Outbox files and checkout drafts (tar.gz), hourly
 *   when they changed.
 *
 * Only one of these runs at a time (`inBackupSlot`): a state backup overlapping a Harness backup
 * stalled the event loop up to 18 s in production (2026-11-22).
 *
 * A missing or corrupt Harness is restored on open from the newest environment-prefixed snapshot,
 * falling back to the pre-environment key `controller-backups/durable-harness/`.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGzip, gunzipSync } from "node:zlib";

import { controllerEnvironmentName } from "../controllerEnvironment.ts";
import { backupOverlaps, recordBackup } from "../controllerMetrics.ts";
import { artifactApiClient } from "../providerWorker/artifactPublisher.ts";
import { exclusiveHarnessConnection } from "./harnessStorage.ts";

export const DURABLE_BACKUP_NAME = "durable-harness";

export type ControllerBackupKind = typeof DURABLE_BACKUP_NAME | "state" | "attachments" | "drafts";
type Extension = "sqlite.gz" | "tar.gz";
type Grant = { key: string; upload_url: string; headers: Record<string, string> };
type Latest = { key: string; size_bytes: number; last_modified: string; download_url: string };

const PREFIX = "controller-backups";
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
const execFileAsync = promisify(execFile);

/** Error text including undici's network cause, which `fetch failed` hides. */
export const describe = (cause: unknown): string => {
  const error = cause as { message?: unknown; cause?: { message?: unknown; code?: unknown } };
  return [error?.message ?? String(cause), error?.cause?.code, error?.cause?.message].filter(Boolean).join(" | ");
};

const log = (event: string, detail: Record<string, unknown>) => console.info(JSON.stringify({ event, ...detail }));

// One backup at a time, of any kind. Each copies a database or a directory off the same NFS share
// the controller serves from; two at once (the hourly state backup inside a 134 s Harness backup)
// stalled the event loop up to 18 s in production on 2026-11-22.
let backupQueue: Promise<void> = Promise.resolve();

/**
 * Runs one backup once the previous one has finished, and logs how long it waited and ran and the
 * longest event-loop delay meanwhile (a 20 ms-resolution histogram, enabled only for the backup).
 */
async function inBackupSlot<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  const previous = backupQueue;
  let release!: () => void;
  backupQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const started = Date.now();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let outcome = "failed";
  try {
    const result = await run();
    outcome = "done";
    return result;
  } finally {
    loop.disable();
    release();
    log("controller.backup.timing", {
      kind, outcome, waitedMs: started - queuedAt, durationMs: Date.now() - started,
      maxEventLoopDelayMs: Math.round(loop.max / 1_000_000),
    });
  }
}

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
async function uploadBackup(kind: ControllerBackupKind, file: string, extension: Extension, passStarted = Date.now()): Promise<string | undefined> {
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
  recordBackup(kind, Date.now() - passStarted, size);
  log(kind === DURABLE_BACKUP_NAME ? "durable.backup.uploaded" : "controller.backup.uploaded", {
    kind, key: grant.key, bytes: size, durationMs: Date.now() - started, totalMs: Date.now() - passStarted,
  });
  return grant.key;
}

// A consistent copy of a SQLite database (VACUUM INTO, a read transaction on its own
// connection), made in a child process at the lowest CPU and I/O priority. On the main thread
// the Harness copy froze the controller for ~3.5 s every ten minutes. On a worker thread it
// still did, for 35-50 s once the Harness reached 3.4 GB (production, 2026-11-20): Node's
// `process.report.getReport()`, which the Claude Agent SDK calls synchronously to detect libc,
// waits for every worker thread to answer, and a worker inside the native copy cannot answer
// until the copy ends. A child process is not part of the report.
const VACUUM_INTO_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const [source, target] = process.argv.slice(-2);
const database = new DatabaseSync(source);
try {
  database.exec("VACUUM INTO '" + target.replaceAll("'", "''") + "'");
} finally {
  database.close();
}
`;

const IONICE = "/usr/bin/ionice";
const NICE = "/usr/bin/nice";

async function vacuumInto(source: string, target: string): Promise<void> {
  const node = [process.execPath, "--no-warnings", "-e", VACUUM_INTO_SCRIPT, source, target];
  const command = [
    ...(existsSync(IONICE) ? [IONICE, "-c2", "-n7"] : []),
    ...(existsSync(NICE) ? [NICE, "-n", "10"] : []),
    ...node,
  ];
  await execFileAsync(command[0]!, command.slice(1), { timeout: UPLOAD_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
}

// SYNARA_HARNESS_LOCKING_MODE=exclusive (harnessStorage.ts): no other process can open the
// Harness while the controller holds it, so the VACUUM INTO child cannot run. The copy goes
// through the controller's own connection instead, with node:sqlite's online backup: each step
// copies a few pages on the libuv thread pool (not a worker thread, so the report hazard above
// does not apply) and hands the connection back to the event loop between steps; writes made
// meanwhile on the same connection are carried into the copy. state.sqlite is backed up the same
// way (backupOpenDatabase). The copy is then switched to rollback-journal mode, so the uploaded
// file has the same shape as a VACUUM INTO copy for restore.
//
// A step holds the connection, so a statement on the event loop waits for the step in progress:
// 64 pages (256 KiB at 4 KiB pages) keeps that wait short on NFS, where 256 did not (stall profiles
// showed the main thread in pi-durable's SQLite `exec`, 2026-11-22). Node already runs the event
// loop between steps (each step is a thread-pool job; setImmediate callbacks run between them), so
// no explicit yield is needed.
const ONLINE_BACKUP_PAGES_PER_STEP = 64;

async function onlineBackup(database: DatabaseSync, target: string): Promise<void> {
  await sqliteBackup(database, target, { rate: ONLINE_BACKUP_PAGES_PER_STEP });
  const copy = new DatabaseSync(target);
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
  } finally {
    copy.close();
  }
}

// Snapshot scratch for the Harness. Writing the multi-GB copy and its gzip onto the volume
// also stalled the controller's own `state.sqlite` commits behind the volume's flushes, so the
// container's disk takes them when it has room; the volume otherwise.
const LOCAL_HARNESS_SNAPSHOT_DIR = path.join(os.tmpdir(), "synara-harness-backup");

async function harnessSnapshotPath(storagePath: string): Promise<string> {
  const name = `${path.basename(storagePath)}.snapshot-${process.pid}-${Date.now()}`;
  const { size } = await stat(storagePath);
  // The copy plus its compressed copy, with headroom.
  const needed = size * 2 + 256 * 1024 * 1024;
  try {
    await mkdir(LOCAL_HARNESS_SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
    if (await enoughSpace(LOCAL_HARNESS_SNAPSHOT_DIR, needed)) return path.join(LOCAL_HARNESS_SNAPSHOT_DIR, name);
  } catch {
    // No usable local disk: the volume below.
  }
  return path.join(path.dirname(storagePath), name);
}

// The Harness files as of the last successful backup (size and modification time of the
// database and its WAL). An unchanged Harness is not copied and uploaded again (on a quiet
// controller the ten-minute backup rewrote and re-sent the same ~95 MB) until an hour has
// passed: Glasswing's maintenance check expects a Harness backup under two hours old.
let lastHarnessFingerprint: string | null = null;
let lastHarnessBackupAt = 0;
// One Harness backup at a time: at ~1.7 GB compressed a copy and upload took up to 8 minutes, so the
// ten-minute timer started a second copy while the first was still uploading (2026-11-19).
let harnessBackupRunning = false;
const UNCHANGED_HARNESS_BACKUP_INTERVAL_MS = 60 * 60_000;

async function harnessFingerprint(storagePath: string): Promise<string> {
  const parts = await Promise.all(
    ["", "-wal"].map((suffix) =>
      stat(storagePath + suffix).then(
        (file) => `${file.size}:${file.mtimeMs}`,
        () => "-",
      ),
    ),
  );
  return parts.join("|");
}

/**
 * Uploads one consistent Harness snapshot when the Harness changed since the last one, or
 * always with `force` (the restore drill). Returns the stored key, or undefined without a
 * backup API or when nothing changed.
 */
export async function backupHarness(
  storagePath: string,
  options: { readonly force?: boolean } = {},
): Promise<string | undefined> {
  if (!artifactApiClient() || !existsSync(storagePath)) return undefined;
  if (harnessBackupRunning) {
    backupOverlaps.inc({ kind: DURABLE_BACKUP_NAME });
    log("durable.backup.skipped", { reason: "the previous Harness backup is still running", forced: options.force === true });
    return undefined;
  }
  harnessBackupRunning = true;
  try {
    // Taken before the copy (and before waiting for another backup): a write meanwhile changes the
    // files, so the next pass copies again.
    const fingerprint = await harnessFingerprint(storagePath);
    if (
      !options.force &&
      fingerprint === lastHarnessFingerprint &&
      Date.now() - lastHarnessBackupAt < UNCHANGED_HARNESS_BACKUP_INTERVAL_MS
    ) {
      return undefined;
    }
    return await inBackupSlot(DURABLE_BACKUP_NAME, () => backupHarnessOnce(storagePath, fingerprint));
  } finally {
    harnessBackupRunning = false;
  }
}

const minutesFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]?.trim());
  return (Number.isFinite(value) && value > 0 ? value : fallback) * 60_000;
};

const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23",
});

/** Weekdays 08:00–19:00 in New York, when the team chats and runs diligence. */
function businessHours(now: Date) {
  const parts = Object.fromEntries(NEW_YORK_CLOCK.formatToParts(now).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  return parts.weekday !== "Sat" && parts.weekday !== "Sun" && hour >= 8 && hour < 19;
}

/**
 * Schedules Harness backups: the first 2 min after start, then every
 * `SYNARA_HARNESS_BACKUP_INTERVAL_MINUTES` (default 10), but at most every
 * `SYNARA_HARNESS_BACKUP_BUSINESS_INTERVAL_MINUTES` (default 60) on weekdays 08:00–19:00 New York
 * time: a multi-GB copy competes with chat and diligence for the share and the Harness connection.
 * Returns a stop function; the engine takes the shutdown backup itself.
 */
export function startHarnessBackups(storagePath: string): () => void {
  const quietInterval = minutesFromEnv("SYNARA_HARNESS_BACKUP_INTERVAL_MINUTES", 10);
  const busyInterval = minutesFromEnv("SYNARA_HARNESS_BACKUP_BUSINESS_INTERVAL_MINUTES", 60);
  let lastPassAt = 0;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Checked every minute, so the cadence follows the clock across 08:00 and 19:00.
  const tick = () => {
    const now = new Date();
    if (running || now.getTime() - lastPassAt < (businessHours(now) ? busyInterval : quietInterval)) return;
    lastPassAt = now.getTime();
    running = true;
    void backupHarness(storagePath)
      .catch((cause) => console.warn(JSON.stringify({ event: "durable.backup.failed", message: describe(cause) })))
      .finally(() => { running = false; });
  };
  const first = setTimeout(() => {
    tick();
    timer = setInterval(tick, 60_000);
    timer.unref();
  }, 2 * 60_000);
  first.unref();
  log("durable.backup.schedule", { intervalMinutes: quietInterval / 60_000, businessHoursIntervalMinutes: busyInterval / 60_000 });
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

async function backupHarnessOnce(storagePath: string, fingerprint: string): Promise<string | undefined> {
  const started = Date.now();
  const snapshot = await harnessSnapshotPath(storagePath);
  try {
    const copyStarted = Date.now();
    // After close (the shutdown backup) the lock is released, and VACUUM INTO serves again.
    const exclusive = exclusiveHarnessConnection(storagePath);
    if (exclusive) await onlineBackup(exclusive, snapshot);
    else await vacuumInto(storagePath, snapshot);
    log("durable.backup.snapshot", {
      kind: DURABLE_BACKUP_NAME, durationMs: Date.now() - copyStarted,
      disk: snapshot.startsWith(LOCAL_HARNESS_SNAPSHOT_DIR) ? "local" : "volume",
      ...(exclusive ? { method: "online-backup" } : {}),
    });
    await gzipFile(snapshot, `${snapshot}.gz`);
    await rm(snapshot, { force: true });
    const key = await uploadBackup(DURABLE_BACKUP_NAME, `${snapshot}.gz`, "sqlite.gz", started);
    if (key) {
      lastHarnessFingerprint = fingerprint;
      lastHarnessBackupAt = Date.now();
    }
    return key;
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

/**
 * Paths, sizes and modification times: unchanged means the last archive is still current.
 *
 * Walks one directory at a time with names-only `readdir` and an awaited `lstat` per entry. On NFS
 * the entries carry no type, and `readdir({ recursive: true, withFileTypes: true })` filled it in
 * with a synchronous lstat per entry on the event loop (stall profiles, 2026-11-22).
 */
async function directoryFingerprint(dir: string): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const files: string[] = [];
  const pending = [dir];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    // A directory removed during the walk is skipped, as a removed file is.
    const names = await readdir(current).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" && current !== dir) return [];
      throw cause;
    });
    for (const name of names) {
      const file = path.join(current, name);
      const info = await lstat(file).catch(() => undefined);
      if (info?.isDirectory()) pending.push(file);
      else if (info?.isFile()) files.push(`${path.relative(dir, file)}\u0000${info.size}\u0000${info.mtimeMs}`);
    }
  }
  if (files.length === 0) return undefined;
  return createHash("sha256").update(files.toSorted().join("\n")).digest("hex");
}

async function enoughSpace(dir: string, needed: number) {
  const info = await statfs(dir);
  return info.bavail * info.bsize > needed;
}

// The state snapshot goes where committing it is cheap. SQLite's online backup holds the
// controller's connection through each step, and its last step commits (fsyncs) the whole
// copy: on the volume that took about 2.3 s on dev (2026-10-10), and every request that read
// `state.sqlite` meanwhile stalled the event loop. The copy is scratch, gzipped and uploaded
// at once, so the container's own disk serves when it has room; the volume otherwise.
const LOCAL_SNAPSHOT_DIR = path.join(os.tmpdir(), "synara-controller-backup");

async function stateSnapshotDir(volumeDir: string, needed: number): Promise<string> {
  try {
    await mkdir(LOCAL_SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
    if (await enoughSpace(LOCAL_SNAPSHOT_DIR, needed)) return LOCAL_SNAPSHOT_DIR;
  } catch {
    // No usable local disk: the volume below.
  }
  return volumeDir;
}

/**
 * Exports `state.sqlite`, the attachments directory and the drafts store off-volume, hourly
 * (directories only when they changed). Returns a stop function. Failures are logged and retried
 * on the next pass; nothing here blocks the controller.
 */
export function startControllerBackups(paths: ControllerBackupPaths, options: { readonly firstDelayMs?: number } = {}): () => void {
  try {
    if (!artifactApiClient()) return () => undefined;
  } catch (cause) {
    console.warn(JSON.stringify({ event: "controller.backup.disabled", message: describe(cause) }));
    return () => undefined;
  }
  const uploaded = new Map<string, string>();
  let running = false;
  let stopped = false;

  const backupState = async () => {
    // Deployed controllers run on Node; Bun dev servers use another SQLite client.
    if (process.versions.bun !== undefined || !existsSync(paths.stateDbPath)) return;
    const { size } = await stat(paths.stateDbPath);
    // Snapshot plus its compressed copy, with headroom.
    const needed = size * 2 + 256 * 1024 * 1024;
    const dir = await stateSnapshotDir(paths.workDir, needed);
    if (!(await enoughSpace(dir, needed))) {
      log("controller.backup.skipped", { kind: "state", reason: "not enough free space for a snapshot", bytes: size });
      return;
    }
    const snapshot = path.join(dir, `state-${Date.now()}.sqlite`);
    const passStarted = Date.now();
    try {
      // The same module the persistence layer loads under Node, so it sees the open connection.
      const { backupOpenDatabase } = await import("../persistence/NodeSqliteClient.ts");
      const started = Date.now();
      await backupOpenDatabase(paths.stateDbPath, snapshot, ONLINE_BACKUP_PAGES_PER_STEP);
      log("controller.backup.snapshot", {
        kind: "state", bytes: size, durationMs: Date.now() - started, disk: dir === paths.workDir ? "volume" : "local",
      });
      await gzipFile(snapshot, `${snapshot}.gz`);
      await rm(snapshot, { force: true });
      await uploadBackup("state", `${snapshot}.gz`, "sqlite.gz", passStarted);
    } finally {
      await rm(snapshot, { force: true });
      await rm(`${snapshot}.gz`, { force: true });
    }
  };

  const backupDirectory = async (kind: "attachments" | "drafts", dir: string) => {
    const fingerprint = await directoryFingerprint(dir);
    if (!fingerprint || uploaded.get(kind) === fingerprint) return;
    const archive = path.join(paths.workDir, `${kind}-${Date.now()}.tar.gz`);
    const passStarted = Date.now();
    try {
      await execFileAsync("tar", ["-czf", archive, "-C", path.dirname(dir), path.basename(dir)], { timeout: 15 * 60_000 });
      if (await uploadBackup(kind, archive, "tar.gz", passStarted)) uploaded.set(kind, fingerprint);
    } finally {
      await rm(archive, { force: true });
    }
  };

  const pass = async () => {
    if (stopped) return;
    if (running) {
      backupOverlaps.inc({ kind: "controller-state" });
      return;
    }
    running = true;
    try {
      await mkdir(paths.workDir, { recursive: true, mode: 0o700 });
      for (const [kind, run] of [
        ["state", backupState],
        ["attachments", () => backupDirectory("attachments", paths.attachmentsDir)],
        ["drafts", () => backupDirectory("drafts", paths.draftsDir)],
      ] as const) {
        if (stopped) break;
        await inBackupSlot(kind, run)
          .catch((cause: unknown) => console.warn(JSON.stringify({ event: "controller.backup.failed", kind, message: describe(cause) })));
      }
    } finally {
      running = false;
    }
  };

  // Scratch files of an interrupted pass are never resumed.
  void rm(paths.workDir, { recursive: true, force: true }).catch(() => undefined);
  void rm(LOCAL_SNAPSHOT_DIR, { recursive: true, force: true }).catch(() => undefined);
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
