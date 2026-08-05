import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../privatePathPermissions.ts";

const OWNER_FILE_NAME = "owner.json";
const PROCESS_INCARNATION_ID = randomUUID();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type DatabaseLifecycleLockOwner = {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
  readonly runtimeId?: string;
  readonly incarnationId?: string;
};

export interface DatabaseLifecycleLockOptions {
  readonly runtimeId?: string;
  readonly incarnationId?: string;
}

type DatabaseLifecycleLockIdentity = {
  readonly runtimeId?: string;
  readonly incarnationId: string;
};

export type DatabaseLifecycleLock = {
  readonly dbPath: string;
  readonly lockPath: string;
  readonly owner: DatabaseLifecycleLockOwner;
};

export class DatabaseLifecycleLockedError extends Error {
  readonly _tag = "DatabaseLifecycleLockedError";

  constructor(
    readonly dbPath: string,
    readonly lockPath: string,
    detail: string,
  ) {
    super(`Database lifecycle is locked for ${dbPath}: ${detail} (${lockPath})`);
    this.name = "DatabaseLifecycleLockedError";
  }
}

function errnoCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync().catch((cause) => {
      const code = errnoCode(cause);
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw cause;
    });
  } finally {
    await handle.close();
  }
}

async function canonicalDatabasePath(dbPath: string): Promise<string> {
  const directoryPath = path.dirname(dbPath);
  await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const directoryStat = await fs.lstat(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Database parent path is not a real directory: ${directoryPath}`);
  }
  if (process.platform !== "win32" && (directoryStat.mode & 0o022) !== 0) {
    throw new Error(`Database parent directory is group/other writable: ${directoryPath}`);
  }
  return path.join(await fs.realpath(directoryPath), path.basename(dbPath));
}

async function readOwner(lockPath: string): Promise<DatabaseLifecycleLockOwner> {
  const lockStat = await fs.lstat(lockPath);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw new Error("lock path is not a real directory");
  }
  const ownerPath = path.join(lockPath, OWNER_FILE_NAME);
  const ownerPathStat = await fs.lstat(ownerPath);
  if (!ownerPathStat.isFile() || ownerPathStat.isSymbolicLink()) {
    throw new Error("lock owner is not a real regular file");
  }
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(ownerPath, flags);
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("lock owner is not a regular file");
    if (
      process.platform !== "win32" &&
      (stat.dev !== ownerPathStat.dev || stat.ino !== ownerPathStat.ino)
    ) {
      throw new Error("lock owner identity changed while it was opened");
    }
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const owner = JSON.parse(text) as Partial<DatabaseLifecycleLockOwner>;
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid! <= 0 ||
    typeof owner.token !== "string" ||
    !UUID_PATTERN.test(owner.token) ||
    typeof owner.createdAt !== "string" ||
    (owner.runtimeId !== undefined &&
      (typeof owner.runtimeId !== "string" ||
        owner.runtimeId.trim() !== owner.runtimeId ||
        owner.runtimeId.length === 0 ||
        owner.runtimeId.length > 256)) ||
    (owner.incarnationId !== undefined &&
      (typeof owner.incarnationId !== "string" ||
        !UUID_PATTERN.test(owner.incarnationId)))
  ) {
    throw new Error("lock owner metadata is invalid");
  }
  return owner as DatabaseLifecycleLockOwner;
}

function ownerProcessState(
  owner: DatabaseLifecycleLockOwner,
  identity: DatabaseLifecycleLockIdentity,
): "live" | "dead" | "unknown" {
  // Railway mounts a volume to only one deployment at a time. A different
  // replica id therefore identifies a stopped container even when the new
  // container reused the same PID in its own namespace.
  if (identity.runtimeId && owner.runtimeId) {
    if (identity.runtimeId !== owner.runtimeId) return "dead";
    if (identity.incarnationId !== owner.incarnationId) return "dead";
  }
  if (
    owner.pid === process.pid &&
    owner.incarnationId &&
    identity.incarnationId !== owner.incarnationId
  ) {
    return "dead";
  }
  try {
    process.kill(owner.pid, 0);
    return "live";
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

function normalizeRuntimeId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

function lockIdentity(options?: DatabaseLifecycleLockOptions): DatabaseLifecycleLockIdentity {
  const runtimeId = normalizeRuntimeId(
    options?.runtimeId ?? process.env.RAILWAY_REPLICA_ID,
  );
  return {
    ...(runtimeId === undefined ? {} : { runtimeId }),
    incarnationId:
      options?.incarnationId && UUID_PATTERN.test(options.incarnationId)
        ? options.incarnationId
        : PROCESS_INCARNATION_ID,
  };
}

function lockOwner(identity: DatabaseLifecycleLockIdentity): DatabaseLifecycleLockOwner {
  return {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
    ...(identity.runtimeId === undefined ? {} : { runtimeId: identity.runtimeId }),
    incarnationId: identity.incarnationId,
  };
}

async function writeOwner(lockPath: string, owner: DatabaseLifecycleLockOwner): Promise<void> {
  if (process.platform !== "win32") await fs.chmod(lockPath, PRIVATE_DIRECTORY_MODE);
  const ownerPath = path.join(lockPath, OWNER_FILE_NAME);
  const handle = await fs.open(ownerPath, "wx", PRIVATE_FILE_MODE);
  try {
    if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(lockPath);
}

async function prepareOwnedDirectory(
  lockPath: string,
  owner: DatabaseLifecycleLockOwner,
): Promise<string> {
  const stagingPath = `${lockPath}.acquiring.${owner.pid}.${owner.token}`;
  await fs.mkdir(stagingPath, { mode: PRIVATE_DIRECTORY_MODE });
  try {
    await writeOwner(stagingPath, owner);
    await syncDirectory(path.dirname(lockPath));
    return stagingPath;
  } catch (cause) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") return false;
    throw cause;
  }
}

async function tryPublishOwnedDirectory(
  targetPath: string,
  owner: DatabaseLifecycleLockOwner,
): Promise<boolean> {
  const stagingPath = await prepareOwnedDirectory(targetPath, owner);
  let published = false;
  try {
    await fs.rename(stagingPath, targetPath);
    published = true;
  } catch (cause) {
    if (!(await pathExists(targetPath))) throw cause;
  } finally {
    if (!published) {
      await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (!published) return false;
  try {
    await syncDirectory(path.dirname(targetPath));
    return true;
  } catch (cause) {
    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

type ReaperGuard = {
  readonly path: string;
  readonly owner: DatabaseLifecycleLockOwner;
  readonly retiredPaths: ReadonlyArray<string>;
};

async function acquireReaperGuard(
  dbPath: string,
  lockPath: string,
  identity: DatabaseLifecycleLockIdentity,
): Promise<ReaperGuard> {
  const reaperPath = `${lockPath}.reaper`;
  const retiredPaths: string[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = lockOwner(identity);
    if (await tryPublishOwnedDirectory(reaperPath, owner)) {
      return { path: reaperPath, owner, retiredPaths };
    }

    let existingOwner: DatabaseLifecycleLockOwner;
    try {
      existingOwner = await readOwner(reaperPath);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        `stale-lock recovery owner is unknown: ${detail}`,
      );
    }
    const state = ownerProcessState(existingOwner, identity);
    if (state !== "dead") {
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        `stale-lock recovery owner pid ${existingOwner.pid} is ${state}`,
      );
    }
    if (attempt > 0) {
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        "dead stale-lock recovery owner could not be replaced safely",
      );
    }

    const retiredPath = `${reaperPath}.retired.${existingOwner.token}`;
    try {
      const currentOwner = await readOwner(reaperPath);
      if (
        currentOwner.token !== existingOwner.token ||
        ownerProcessState(currentOwner, identity) !== "dead"
      ) {
        throw new DatabaseLifecycleLockedError(
          dbPath,
          lockPath,
          "stale-lock recovery ownership changed during takeover",
        );
      }
      await fs.rename(reaperPath, retiredPath);
      await syncDirectory(path.dirname(reaperPath));
      retiredPaths.push(retiredPath);
    } catch (cause) {
      if (cause instanceof DatabaseLifecycleLockedError) throw cause;
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        "dead stale-lock recovery owner could not be retired safely",
      );
    }
  }

  throw new DatabaseLifecycleLockedError(dbPath, lockPath, "stale-lock recovery failed");
}

async function releaseReaperGuard(dbPath: string, lockPath: string, guard: ReaperGuard) {
  const owner = await readOwner(guard.path);
  if (owner.token !== guard.owner.token || owner.pid !== guard.owner.pid) {
    throw new DatabaseLifecycleLockedError(
      dbPath,
      lockPath,
      "refusing to release stale-lock recovery owned by another process or token",
    );
  }
  const releasedPath = `${guard.path}.released.${guard.owner.token}.${randomUUID()}`;
  await fs.rename(guard.path, releasedPath);
  await syncDirectory(path.dirname(guard.path));
  await fs.rm(releasedPath, { recursive: true, force: true });
  for (const retiredPath of guard.retiredPaths) {
    await fs.rm(retiredPath, { recursive: true, force: true });
  }
  await syncDirectory(path.dirname(guard.path));
}

async function reapDeadOwner(
  dbPath: string,
  lockPath: string,
  observedOwner: DatabaseLifecycleLockOwner,
  identity: DatabaseLifecycleLockIdentity,
): Promise<void> {
  const guard = await acquireReaperGuard(dbPath, lockPath, identity);

  try {
    const currentOwner = await readOwner(lockPath);
    if (
      currentOwner.token !== observedOwner.token ||
      ownerProcessState(currentOwner, identity) !== "dead"
    ) {
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        "lock ownership changed while stale recovery was starting",
      );
    }
    const stalePath = `${lockPath}.stale.${observedOwner.token}.${randomUUID()}`;
    await fs.rename(lockPath, stalePath);
    await syncDirectory(path.dirname(lockPath));
    await fs.rm(stalePath, { recursive: true, force: true });
    await syncDirectory(path.dirname(lockPath));
  } finally {
    await releaseReaperGuard(dbPath, lockPath, guard);
  }
}

async function acquire(
  dbPath: string,
  options?: DatabaseLifecycleLockOptions,
): Promise<DatabaseLifecycleLock> {
  const canonicalDbPath = await canonicalDatabasePath(dbPath);
  const lockPath = `${canonicalDbPath}.lifecycle-lock`;
  const identity = lockIdentity(options);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = lockOwner(identity);
    const published = await tryPublishOwnedDirectory(lockPath, owner);

    if (!published) {
      let existingOwner: DatabaseLifecycleLockOwner;
      try {
        existingOwner = await readOwner(lockPath);
      } catch (ownerCause) {
        const detail = ownerCause instanceof Error ? ownerCause.message : String(ownerCause);
        throw new DatabaseLifecycleLockedError(
          canonicalDbPath,
          lockPath,
          `owner is live or unknown: ${detail}`,
        );
      }
      const state = ownerProcessState(existingOwner, identity);
      if (state !== "dead") {
        throw new DatabaseLifecycleLockedError(
          canonicalDbPath,
          lockPath,
          `owner pid ${existingOwner.pid} is ${state}`,
        );
      }
      if (attempt > 0) {
        throw new DatabaseLifecycleLockedError(
          canonicalDbPath,
          lockPath,
          "dead owner could not be recovered safely",
        );
      }
      await reapDeadOwner(canonicalDbPath, lockPath, existingOwner, identity);
      continue;
    }

    return { dbPath: canonicalDbPath, lockPath, owner };
  }
  throw new DatabaseLifecycleLockedError(canonicalDbPath, lockPath, "acquisition failed");
}

async function release(lock: DatabaseLifecycleLock): Promise<void> {
  let owner: DatabaseLifecycleLockOwner;
  try {
    owner = await readOwner(lock.lockPath);
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") return;
    throw cause;
  }
  if (owner.token !== lock.owner.token || owner.pid !== lock.owner.pid) {
    throw new DatabaseLifecycleLockedError(
      lock.dbPath,
      lock.lockPath,
      "refusing to release a lock owned by another process or token",
    );
  }
  const releasedPath = `${lock.lockPath}.released.${lock.owner.token}.${randomUUID()}`;
  await fs.rename(lock.lockPath, releasedPath);
  await syncDirectory(path.dirname(lock.lockPath));
  await fs.rm(releasedPath, { recursive: true, force: true });
  await syncDirectory(path.dirname(lock.lockPath));
}

const attemptPromise = <A>(action: () => Promise<A>) =>
  Effect.tryPromise({ try: action, catch: (cause) => cause });

export const acquireDatabaseLifecycleLock = (
  dbPath: string,
  options?: DatabaseLifecycleLockOptions,
) => attemptPromise(() => acquire(dbPath, options));

export const releaseDatabaseLifecycleLock = (lock: DatabaseLifecycleLock) =>
  attemptPromise(() => release(lock));

export const withDatabaseLifecycleLock = <A, E, R>(dbPath: string, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    acquireDatabaseLifecycleLock(dbPath),
    () => use,
    releaseDatabaseLifecycleLock,
  );
