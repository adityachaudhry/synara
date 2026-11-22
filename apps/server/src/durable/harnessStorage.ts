/**
 * Opens the Pi Durable Harness database (`<home>/durable/harness.sqlite`).
 *
 * Default (`SYNARA_HARNESS_LOCKING_MODE` unset): pi-durable's own `openNodeSqliteStorage`, exactly as
 * before. WAL in normal locking mode, so the WAL index is a shared-memory `-shm` file and other
 * processes may read the database (the backup's VACUUM INTO child does).
 *
 * `SYNARA_HARNESS_LOCKING_MODE=exclusive` (opt-in, for a data volume on NFS such as Azure Files): the
 * same connection settings, with `PRAGMA locking_mode = EXCLUSIVE` first, before SQLite first touches
 * the WAL. SQLite then keeps the WAL index in this process's heap and never maps `-shm`; on NFS that
 * mapping cost every commit ~60 ms (p50) against ~4 ms without it, and node:sqlite commits block the
 * event loop. The price: no other process can open the file while the controller runs, so the
 * Harness backup copies through this connection (`exclusiveHarnessConnection`, backup.ts). The one
 * controller per volume is guaranteed by the writer lock in docker-entrypoint.sh.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  NodeSqliteDatabase,
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";

export type HarnessLockingMode = "normal" | "exclusive";

/** An unknown value fails startup: this is the controller's most important data path. */
export function harnessLockingMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HarnessLockingMode {
  const raw = environment.SYNARA_HARNESS_LOCKING_MODE?.trim().toLowerCase();
  if (!raw) return "normal";
  if (raw === "exclusive") return "exclusive";
  throw new Error(`SYNARA_HARNESS_LOCKING_MODE must be "exclusive" or unset, not "${raw}".`);
}

// pi-durable's openNodeSqliteDatabase settings (1.0.4), repeated for the exclusive open, except the
// two below. On NFS every page read that misses SQLite's cache and every checkpoint's fsync goes over
// the network while the event loop waits: on Azure Files a 2 MB default cache and a checkpoint every
// 1,000 pages stalled the controller's loop 1.4 s (p50) during diligence runs, against none on local
// disk. A 256 MiB cache (the persistence database's ceiling) keeps the hot Harness pages in memory, and
// checkpointing every 10,000 pages coalesces rewrites of the same pages into far fewer fsyncs.
// Durability is unchanged: WAL with synchronous=NORMAL either way.
const BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTO_CHECKPOINT_PAGES = 10_000;
const CACHE_SIZE_KIB = 262_144;

/** The open exclusive connections by database path; normal mode registers none. */
const exclusiveConnections = new Map<string, DatabaseSync>();

/** The connection that holds this Harness file exclusively, if the controller opened it so. */
export function exclusiveHarnessConnection(storagePath: string): DatabaseSync | undefined {
  const database = exclusiveConnections.get(path.resolve(storagePath));
  return database?.isOpen ? database : undefined;
}

function pragmaValue(database: DatabaseSync, pragma: string, column: string): string {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  return String(row?.[column] ?? "").toLowerCase();
}

export async function openHarnessStorage(storagePath: string): Promise<SqliteStorage> {
  if (harnessLockingMode() === "normal") return openNodeSqliteStorage(storagePath);

  await mkdir(path.dirname(storagePath), { recursive: true });
  const database = new DatabaseSync(storagePath, { timeout: BUSY_TIMEOUT_MS });
  try {
    // First statement on the connection: nothing has read the file or its WAL yet.
    const lockingMode = pragmaValue(database, "locking_mode = EXCLUSIVE", "locking_mode");
    if (lockingMode !== "exclusive") {
      throw new Error(
        `Harness exclusive locking mode could not be set (result: ${lockingMode || "unknown"}).`,
      );
    }
    const journalMode = pragmaValue(database, "journal_mode = WAL", "journal_mode");
    if (journalMode !== "wal") {
      throw new Error(
        `Harness WAL journal mode could not be set (result: ${journalMode || "unknown"}).`,
      );
    }
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTO_CHECKPOINT_PAGES}`);
    // Negative: KiB, an on-demand ceiling for this one connection, not an upfront allocation.
    database.exec(`PRAGMA cache_size = -${CACHE_SIZE_KIB}`);
    // Take and keep the lock now, so a process that still holds the file fails startup here
    // (after the busy timeout) instead of failing a turn later.
    database.exec("BEGIN EXCLUSIVE");
    database.exec("COMMIT");
  } catch (cause) {
    database.close();
    throw cause;
  }
  const storage = await SqliteStorage.open(new NodeSqliteDatabase(database));
  exclusiveConnections.set(path.resolve(storagePath), database);
  console.info(
    JSON.stringify({
      event: "durable.harness.opened",
      lockingMode: "exclusive",
      walIndex: "heap",
      cacheKiB: CACHE_SIZE_KIB,
      walAutoCheckpointPages: WAL_AUTO_CHECKPOINT_PAGES,
    }),
  );
  return storage;
}
