import path from "node:path";

import { Effect } from "effect";

import {
  isProviderPersistencePathSafe,
  MAX_PROVIDER_PERSISTENCE_CANDIDATES,
  MAX_PROVIDER_PERSISTENCE_DEPTH,
  MAX_PROVIDER_PERSISTENCE_FILE_BYTES,
  MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES,
  PROVIDER_PERSISTENCE_OUTBOX_ROOT,
  providerPersistenceSelectionKey,
  providerPersistenceSha256,
  type ProviderPersistenceCandidate,
  type ProviderPersistenceCandidateList,
  type ProviderPersistenceCandidateSelection,
  type ProviderPersistenceFile,
} from "../providerPersistence.ts";
import type { WorkspaceRuntimeShape } from "../workspaceRuntime/Services/WorkspaceRuntime.ts";
import { ProviderWorkerProvisioningError } from "./Errors.ts";
import { REPOSITORY_CHECKOUT_ROOT } from "./repositoryCheckout.ts";
import type { ProviderWorkerRuntimeBinding } from "./runtimeBinding.ts";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function persistenceError(
  operation: string,
  detail: string,
  binding: ProviderWorkerRuntimeBinding,
  cause?: unknown,
) {
  return new ProviderWorkerProvisioningError({
    operation,
    detail,
    sandboxId: binding.workspace.runtimeId,
    cause,
  });
}

function requireFileAccess(
  workspaceRuntime: WorkspaceRuntimeShape,
  binding: ProviderWorkerRuntimeBinding,
) {
  if (!workspaceRuntime.readFile || !workspaceRuntime.listFiles || !workspaceRuntime.statFile) {
    throw persistenceError(
      "persistence.filesystem",
      "Railway sandbox file access is unavailable.",
      binding,
    );
  }
  return {
    readFile: workspaceRuntime.readFile,
    listFiles: workspaceRuntime.listFiles,
    statFile: workspaceRuntime.statFile,
  };
}

function splitNulPaths(stdout: string): string[] {
  return stdout.split("\0").filter((value) => value.length > 0);
}

const listCheckoutChangedPaths = Effect.fnUntraced(function* (input: {
  readonly workspaceRuntime: WorkspaceRuntimeShape;
  readonly binding: ProviderWorkerRuntimeBinding;
}) {
  const repositoryBinding = input.binding.repositoryCheckout?.binding;
  if (!repositoryBinding) return [];
  const root = REPOSITORY_CHECKOUT_ROOT;
  const scopedPath = repositoryBinding.path;
  const command = [
    `git -C ${shellQuote(root)} diff --name-only -z --diff-filter=ACMRTUXB HEAD -- ${shellQuote(scopedPath)}`,
    `git -C ${shellQuote(root)} ls-files --others --exclude-standard -z -- ${shellQuote(scopedPath)}`,
  ].join(" && ");
  const result = yield* input.workspaceRuntime.exec(input.binding.workspace, {
    command,
    timeoutSeconds: 20,
  });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    return yield* persistenceError(
      "persistence.checkout.list",
      "The sandbox checkout changes could not be listed safely.",
      input.binding,
      new Error(result.stderr || result.stdout || "git listing failed"),
    );
  }
  const prefix = `${scopedPath}/`;
  return Array.from(
    new Set(
      splitNulPaths(result.stdout)
        .filter((candidate) => candidate.startsWith(prefix))
        .map((candidate) => candidate.slice(prefix.length))
        .filter(isProviderPersistencePathSafe),
    ),
  ).slice(0, MAX_PROVIDER_PERSISTENCE_CANDIDATES);
});

const listOutboxPaths = Effect.fnUntraced(function* (input: {
  readonly workspaceRuntime: WorkspaceRuntimeShape;
  readonly binding: ProviderWorkerRuntimeBinding;
}) {
  const files = requireFileAccess(input.workspaceRuntime, input.binding);
  const exists = yield* input.workspaceRuntime.exec(input.binding.workspace, {
    command: `test -d ${shellQuote(PROVIDER_PERSISTENCE_OUTBOX_ROOT)}`,
    timeoutSeconds: 10,
  });
  if (exists.exitCode !== 0) return [];

  const paths: string[] = [];
  const pending = [{ absolutePath: PROVIDER_PERSISTENCE_OUTBOX_ROOT, segments: [] as string[] }];
  while (pending.length > 0 && paths.length < MAX_PROVIDER_PERSISTENCE_CANDIDATES) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = yield* files.listFiles(input.binding.workspace, directory.absolutePath);
    for (const entry of entries) {
      if (paths.length >= MAX_PROVIDER_PERSISTENCE_CANDIDATES) break;
      if (
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        entry.name.includes("\0") ||
        entry.name === "." ||
        entry.name === ".."
      ) {
        continue;
      }
      const segments = [...directory.segments, entry.name];
      const relativePath = segments.join("/");
      if (!isProviderPersistencePathSafe(relativePath)) continue;
      const absolutePath = path.posix.join(directory.absolutePath, entry.name);
      if (entry.isDir) {
        if (segments.length < MAX_PROVIDER_PERSISTENCE_DEPTH) {
          pending.push({ absolutePath, segments });
        }
      } else {
        paths.push(relativePath);
      }
    }
  }
  return paths;
});

function absoluteCandidatePath(
  binding: ProviderWorkerRuntimeBinding,
  selection: Pick<ProviderPersistenceCandidateSelection, "source" | "path">,
): string | null {
  if (!isProviderPersistencePathSafe(selection.path)) return null;
  if (selection.source === "outbox") {
    return path.posix.join(PROVIDER_PERSISTENCE_OUTBOX_ROOT, selection.path);
  }
  const repositoryBinding = binding.repositoryCheckout?.binding;
  if (!repositoryBinding) return null;
  return path.posix.join(REPOSITORY_CHECKOUT_ROOT, repositoryBinding.path, selection.path);
}

const readCandidateBytes = Effect.fnUntraced(function* (input: {
  readonly workspaceRuntime: WorkspaceRuntimeShape;
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly source: "outbox" | "checkout";
  readonly relativePath: string;
}) {
  const files = requireFileAccess(input.workspaceRuntime, input.binding);
  const absolutePath = absoluteCandidatePath(input.binding, {
    source: input.source,
    path: input.relativePath,
  });
  if (!absolutePath) {
    return yield* persistenceError(
      "persistence.path",
      "The selected sandbox path is invalid.",
      input.binding,
    );
  }
  const ordinaryFile = yield* input.workspaceRuntime.exec(input.binding.workspace, {
    command: `test -f ${shellQuote(absolutePath)} && test ! -L ${shellQuote(absolutePath)}`,
    timeoutSeconds: 10,
  });
  if (ordinaryFile.exitCode !== 0 || ordinaryFile.timedOut) {
    return yield* persistenceError(
      "persistence.file-type",
      "Only complete regular files can be saved from the sandbox.",
      input.binding,
    );
  }
  const stat = yield* files.statFile(input.binding.workspace, absolutePath);
  if (stat.isDir || stat.size > MAX_PROVIDER_PERSISTENCE_FILE_BYTES) {
    return yield* persistenceError(
      "persistence.file-size",
      `Sandbox files must be no larger than ${String(MAX_PROVIDER_PERSISTENCE_FILE_BYTES)} bytes.`,
      input.binding,
    );
  }
  const bytes = yield* files.readFile(input.binding.workspace, absolutePath);
  if (bytes.byteLength !== stat.size || bytes.byteLength > MAX_PROVIDER_PERSISTENCE_FILE_BYTES) {
    return yield* persistenceError(
      "persistence.file-changed",
      "The selected sandbox file changed while it was being read.",
      input.binding,
    );
  }
  return { bytes, stat };
});

export const listProviderPersistenceCandidates = Effect.fnUntraced(function* (input: {
  readonly workspaceRuntime: WorkspaceRuntimeShape;
  readonly binding: ProviderWorkerRuntimeBinding;
}) {
  requireFileAccess(input.workspaceRuntime, input.binding);
  const [outboxPaths, checkoutPaths] = yield* Effect.all(
    [listOutboxPaths(input), listCheckoutChangedPaths(input)],
    { concurrency: 2 },
  );
  const sources = [
    ...outboxPaths.map((relativePath) => ({ source: "outbox" as const, relativePath })),
    ...checkoutPaths.map((relativePath) => ({ source: "checkout" as const, relativePath })),
  ];
  const entries: ProviderPersistenceCandidate[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const uniqueSources = sources.filter((source) => {
    const key = providerPersistenceSelectionKey({
      source: source.source,
      path: source.relativePath,
      sha256: "",
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (let index = 0; index < uniqueSources.length; index += 4) {
    const batch = uniqueSources.slice(index, index + 4);
    const loadedBatch = yield* Effect.forEach(
      batch,
      (source) =>
        readCandidateBytes({
          workspaceRuntime: input.workspaceRuntime,
          binding: input.binding,
          ...source,
        }).pipe(Effect.option),
      { concurrency: 4 },
    );
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      if (entries.length >= MAX_PROVIDER_PERSISTENCE_CANDIDATES) break;
      const source = batch[batchIndex];
      const loaded = loadedBatch[batchIndex];
      if (!source || !loaded || loaded._tag === "None") continue;
      totalBytes += loaded.value.bytes.byteLength;
      if (totalBytes > MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES) break;
      entries.push({
        source: source.source,
        path: source.relativePath,
        destinationPath: source.relativePath,
        name: path.posix.basename(source.relativePath),
        sizeBytes: loaded.value.bytes.byteLength,
        modifiedAt: loaded.value.stat.modTime,
        sha256: providerPersistenceSha256(loaded.value.bytes),
      });
    }
    if (
      totalBytes > MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES ||
      entries.length >= MAX_PROVIDER_PERSISTENCE_CANDIDATES
    ) {
      break;
    }
  }
  return {
    runtimeId: input.binding.workspace.runtimeId,
    lifecycleGeneration: input.binding.fence.lifecycleGeneration,
    entries: entries.toSorted((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)),
  } satisfies ProviderPersistenceCandidateList;
});

export const readProviderPersistenceCandidate = Effect.fnUntraced(function* (input: {
  readonly workspaceRuntime: WorkspaceRuntimeShape;
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly selection: ProviderPersistenceCandidateSelection;
}) {
  if (!/^[0-9a-f]{64}$/u.test(input.selection.sha256)) {
    return yield* persistenceError(
      "persistence.hash",
      "The selected sandbox file hash is invalid.",
      input.binding,
    );
  }
  if (input.selection.source === "checkout") {
    const changedPaths = yield* listCheckoutChangedPaths(input);
    if (!changedPaths.includes(input.selection.path)) {
      return yield* persistenceError(
        "persistence.checkout.stale",
        "The selected checkout file is no longer an unsaved change.",
        input.binding,
      );
    }
  }
  const loaded = yield* readCandidateBytes({
    workspaceRuntime: input.workspaceRuntime,
    binding: input.binding,
    source: input.selection.source,
    relativePath: input.selection.path,
  });
  const sha256 = providerPersistenceSha256(loaded.bytes);
  if (sha256 !== input.selection.sha256) {
    return yield* persistenceError(
      "persistence.hash-mismatch",
      "The selected sandbox file changed after review. Refresh and select it again.",
      input.binding,
    );
  }
  return {
    ...input.selection,
    destinationPath: input.selection.path,
    name: path.posix.basename(input.selection.path),
    sizeBytes: loaded.bytes.byteLength,
    modifiedAt: loaded.stat.modTime,
    bytes: loaded.bytes,
  } satisfies ProviderPersistenceFile;
});
