/** Actual filesystem pointer round-trip; no provider calls or shared state. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeWorkspaceCheckpointStore, workspaceArchiveIsCurrent, type ProviderWorkspaceCheckpoint } from "../../apps/server/src/providerWorker/workspaceCheckpointStore.ts";

assert(process.argv.includes("--run-local"), "Pass --run-local for the disposable filesystem check");
const root = await mkdtemp(path.join(tmpdir(), "synara-backup-coverage-"));
try {
  const threadId = randomUUID(), sandboxId = randomUUID();
  const store = makeWorkspaceCheckpointStore(path.join(root, "workspaces"));
  const saved: ProviderWorkspaceCheckpoint = {
    binding: { schemaVersion: 1, runtimeKind: "daytona-pi", threadId,
      workspace: { runtimeKind: "daytona-sandbox", runtimeId: sandboxId, lifecycleGeneration: "generation-1", status: "stopped", region: "us" },
      fence: { sandboxId, workerId: randomUUID(), lifecycleGeneration: "generation-1" },
      durableSessionName: "qa-session", cwd: "/workspace", homeDir: "/workspace/.synara-provider-worker" },
    nativeRevision: "backup-1",
    archive: { archiveId: randomUUID(), revision: "backup-1", sha256: "a".repeat(64), sizeBytes: 100,
      format: "tar-gzip-v1", roots: ["workspace", "root/.pi/agent/sessions"] },
  };
  await store.write(threadId, saved);
  assert.equal(workspaceArchiveIsCurrent(await store.read(threadId)), false, "Legacy coverage must remain unknown");
  const current = { ...saved, mutationRevision: randomUUID() };
  await store.write(threadId, { ...current, archiveMutationRevision: current.mutationRevision });
  assert.equal(workspaceArchiveIsCurrent(await store.read(threadId)), false, "An idle-session archive cannot prove detached writers stopped");
  await store.write(threadId, { ...current, archiveMutationRevision: current.mutationRevision, archiveWritersStopped: true });
  assert.equal(workspaceArchiveIsCurrent(await store.read(threadId)), true);
  const dirty = { ...current, mutationRevision: randomUUID(), archiveMutationRevision: current.mutationRevision, archiveWritersStopped: true as const };
  await store.write(threadId, dirty);
  assert.equal(workspaceArchiveIsCurrent(await store.read(threadId)), false, "A newer mutation must block archive recovery");
  assert.equal((await store.read(threadId))?.binding.workspace.runtimeId, sandboxId, "Dirtying must retain the native disk");
  await assert.rejects(store.write(randomUUID(), dirty), /another thread/);
  await store.write(threadId, { ...dirty, archiveMutationRevision: "bad revision" });
  await assert.rejects(store.read(threadId), /backup coverage/);
  console.log("PASS: legacy unknown, verified current, newer mutation, native identity, owner and malformed coverage checks");
} finally {
  await rm(root, { recursive: true, force: true });
}
