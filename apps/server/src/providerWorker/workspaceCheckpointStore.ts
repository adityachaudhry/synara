import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeProviderWorkerRuntimeBinding, type ProviderWorkerRuntimeBinding } from "./runtimeBinding.ts";
import type { WorkspaceArchive } from "./workspaceArchive.ts";

type RailwayCheckpoint = { readonly id: string; readonly key: string };
export interface ProviderWorkspaceCheckpoint {
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly checkpoint?: RailwayCheckpoint;
  readonly archive?: WorkspaceArchive;
  /** Retain deletion work across controller restarts. */
  readonly retiredCheckpoints?: readonly RailwayCheckpoint[];
}

export interface WorkspaceCaptureIntent {
  readonly threadId: string;
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly key: string;
  readonly createdAt: number;
}

export const workspaceCheckpointRevision = (saved: ProviderWorkspaceCheckpoint) =>
  saved.checkpoint?.key ?? saved.archive!.revision;

/** Atomic pointer replacement keeps the last verified disk until a new location is durable. */
export function makeWorkspaceCheckpointStore(root: string) {
  const hashName = (key: string) => `${createHash("sha256").update(key).digest("hex")}.json`;
  const filename = (threadId: string) => path.join(root, hashName(threadId));
  const pendingRoot = path.join(root, "pending");
  const syncDirectory = async (directory: string) => {
    const handle = await open(directory, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
  };
  const atomicWrite = async (target: string, value: unknown) => {
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
    await rename(temporary, target);
    await syncDirectory(directory);
    if (directory !== root) await syncDirectory(root);
    await syncDirectory(path.dirname(root));
  };
  const read = async (threadId: string): Promise<ProviderWorkspaceCheckpoint | undefined> => {
    let raw: string;
    try {
      raw = await readFile(filename(threadId), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
    const value = JSON.parse(raw);
    const binding = decodeProviderWorkerRuntimeBinding(value.binding);
    const checkpoint = value.checkpoint;
    const archive = value.archive;
    if (binding?.threadId !== threadId || (!checkpoint && !archive)) {
      throw new Error("Provider workspace checkpoint does not belong to this thread.");
    }
    if (value.retiredCheckpoints !== undefined && (!Array.isArray(value.retiredCheckpoints) ||
        value.retiredCheckpoints.some((item: RailwayCheckpoint) => typeof item?.id !== "string" || typeof item?.key !== "string"))) {
      throw new Error("Invalid retired checkpoint references.");
    }
    if (checkpoint !== undefined && (!checkpoint || typeof checkpoint.id !== "string" ||
        !checkpoint.id || typeof checkpoint.key !== "string" || !checkpoint.key)) {
      throw new Error("Invalid Railway checkpoint reference.");
    }
    if (checkpoint && archive && checkpoint.key !== archive.revision) {
      throw new Error("Workspace checkpoint locations have different revisions.");
    }
    if (checkpoint) {
      if (archive === undefined) return { binding, checkpoint, ...(value.retiredCheckpoints ? { retiredCheckpoints: value.retiredCheckpoints } : {}) };
    }
    if (archive && typeof archive.archiveId === "string" && typeof archive.revision === "string" &&
        /^[a-f0-9]{64}$/.test(archive.sha256) && Number.isSafeInteger(archive.sizeBytes) &&
        archive.sizeBytes > 0 && archive.sizeBytes <= 2 * 1024 ** 3 && archive.format === "tar-gzip-v1" &&
        Array.isArray(archive.roots) && archive.roots.length === 2 &&
        archive.roots[0] === "workspace" && archive.roots[1] === "root/.pi/agent/sessions") {
      return { binding, archive, ...(checkpoint ? { checkpoint } : {}), ...(value.retiredCheckpoints ? { retiredCheckpoints: value.retiredCheckpoints } : {}) };
    }
    throw new Error("Invalid provider workspace checkpoint location.");
  };
  return {
    read,
    async beginCapture(threadId: string, binding: ProviderWorkerRuntimeBinding, key: string): Promise<void> {
      if (binding.threadId !== threadId || !key || key.length > 256) {
        throw new Error("Invalid workspace capture owner or key.");
      }
      const target = path.join(pendingRoot, hashName(key));
      try {
        const existing = JSON.parse(await readFile(target, "utf8"));
        if (existing.key !== key || existing.threadId !== threadId ||
            existing.binding?.workspace?.runtimeId !== binding.workspace.runtimeId ||
            existing.binding?.workspace?.lifecycleGeneration !== binding.workspace.lifecycleGeneration) {
          throw new Error("Workspace capture key already belongs to another capture.");
        }
        return;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      await atomicWrite(target, { threadId, binding, key, createdAt: Date.now() });
    },
    async listCaptures(): Promise<WorkspaceCaptureIntent[]> {
      let names: string[];
      try { names = await readdir(pendingRoot); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw cause;
      }
      return Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => {
        const value = JSON.parse(await readFile(path.join(pendingRoot, name), "utf8"));
        const binding = decodeProviderWorkerRuntimeBinding(value.binding);
        if (!binding || typeof value.threadId !== "string" || binding.threadId !== value.threadId ||
            typeof value.key !== "string" || !value.key || value.key.length > 256 || hashName(value.key) !== name ||
            !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
          throw new Error("Invalid pending workspace capture.");
        }
        return { threadId: value.threadId, binding, key: value.key, createdAt: value.createdAt };
      }));
    },
    async finishCapture(key: string): Promise<void> {
      const target = path.join(pendingRoot, hashName(key));
      try {
        const value = JSON.parse(await readFile(target, "utf8"));
        if (value.key !== key) throw new Error("Pending workspace capture key does not match.");
        await unlink(target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
        throw cause;
      }
      await syncDirectory(pendingRoot);
    },
    async list() {
      let names: string[];
      try { names = await readdir(root); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw cause;
      }
      const entries = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => {
        const target = path.join(root, name);
        const value = JSON.parse(await readFile(target, "utf8"));
        const threadId = value.binding?.threadId;
        if (typeof threadId !== "string" || filename(threadId) !== target) throw new Error("Invalid checkpoint owner.");
        const saved = await read(threadId);
        if (!saved) return undefined;
        return { threadId, saved, updatedAt: (await stat(target)).mtimeMs };
      }));
      return entries.filter((entry) => entry !== undefined).sort((a, b) => a.updatedAt - b.updatedAt);
    },
    async write(threadId: string, value: ProviderWorkspaceCheckpoint): Promise<void> {
      if (value.binding.threadId !== threadId) throw new Error("Cannot checkpoint another thread's workspace.");
      await atomicWrite(filename(threadId), value);
    },
  };
}
