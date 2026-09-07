import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeProviderWorkerRuntimeBinding, type ProviderWorkerRuntimeBinding } from "./runtimeBinding.ts";

export interface ProviderWorkspaceCheckpoint {
  readonly checkpoint: { readonly id: string; readonly key: string };
  readonly binding: ProviderWorkerRuntimeBinding;
}

/** A durable pointer to Railway's disk, scoped to one thread. Atomic rename preserves the old pointer on failure. */
export function makeWorkspaceCheckpointStore(root: string) {
  const filename = (threadId: string) => path.join(root, `${createHash("sha256").update(threadId).digest("hex")}.json`);
  return {
    async read(threadId: string): Promise<ProviderWorkspaceCheckpoint | undefined> {
      let raw: string;
      try {
        raw = await readFile(filename(threadId), "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      }
      const value = JSON.parse(raw);
      const binding = decodeProviderWorkerRuntimeBinding(value.binding);
      if (binding?.threadId !== threadId || typeof value.checkpoint?.id !== "string" || typeof value.checkpoint?.key !== "string") {
        throw new Error("Provider workspace checkpoint does not belong to this thread.");
      }
      return { binding, checkpoint: value.checkpoint };
    },
    async write(threadId: string, value: ProviderWorkspaceCheckpoint): Promise<void> {
      if (value.binding.threadId !== threadId) throw new Error("Cannot checkpoint another thread's workspace.");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const target = filename(threadId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
      await rename(temporary, target);
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
  };
}
