import path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  isProviderPersistencePathSafe,
  MAX_PROVIDER_PERSISTENCE_FILE_BYTES,
  providerPersistenceSha256,
  type ProviderWorkspaceFile,
} from "../providerPersistence.ts";
import type { WorkspaceRuntimeShape } from "../workspaceRuntime/Services/WorkspaceRuntime.ts";
import { ProviderWorkerProvisioningError } from "./Errors.ts";
import type { ProviderWorkerRuntimeBinding } from "./runtimeBinding.ts";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

// Open each component relative to a directory descriptor. Checking realpath and
// then reading by name would allow a concurrent symlink swap to escape the root.
const READ_FILE = `import os, sys, stat, json, hashlib
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
    parts = sys.argv[1].split("/")[1:]
    for part in parts[:-1]:
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = child
    child = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    os.close(fd)
    fd = child
    before = os.fstat(fd)
    limit = int(sys.argv[2])
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise ValueError("not a supported regular file")
    with os.fdopen(os.dup(fd), "rb") as f:
        data = f.read(limit + 1)
    after = os.fstat(fd)
    if len(data) != before.st_size or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise ValueError("file changed while reading")
    target = os.open(sys.argv[3], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(target, "wb") as f:
        f.write(data)
    print(json.dumps({"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))
finally:
    os.close(fd)
`;

export function isWorkspaceFilePathAllowed(binding: ProviderWorkerRuntimeBinding, filePath: string): boolean {
  const companyRoot = binding.repositoryCheckout
    ? `/workspace/repository/${binding.repositoryCheckout.binding.path}/` : null;
  const root = filePath.startsWith("/workspace/repository/") ? companyRoot : "/workspace/";
  return !!root && filePath.startsWith(root) &&
    isProviderPersistencePathSafe(filePath.slice(root.length)) && filePath !== "/workspace/repository";
}

export const readProviderWorkspaceFile = Effect.fnUntraced(function* (input: {
  readonly workspaceRuntime: WorkspaceRuntimeShape;
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly filePath: string;
}) {
  const fail = (detail: string) => new ProviderWorkerProvisioningError({
    operation: "workspace.file.read", detail, sandboxId: input.binding.workspace.runtimeId,
  });
  if (!isWorkspaceFilePathAllowed(input.binding, input.filePath)) {
    return yield* fail("This path is outside the thread's permitted workspace files.");
  }
  const readFile = input.workspaceRuntime.readFile;
  if (!readFile) return yield* fail("Workspace file transfer is unavailable.");
  const snapshotPath = `/tmp/synara-workspace-preview-${randomUUID()}`;
  return yield* Effect.gen(function* () {
    const result = yield* input.workspaceRuntime.exec(input.binding.workspace, {
      command: `python3 -c ${shellQuote(READ_FILE)} ${shellQuote(input.filePath)} ${MAX_PROVIDER_PERSISTENCE_FILE_BYTES} ${shellQuote(snapshotPath)}`,
      timeoutSeconds: 60,
    }).pipe(Effect.mapError(() => fail("The thread workspace is unavailable. Resume the thread and try again.")));
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      return yield* fail("This file is missing, changed, or cannot be read safely from the thread workspace.");
    }
    const snapshot = yield* Effect.try({
      try: () => JSON.parse(result.stdout) as { size: number; sha256: string },
      catch: () => fail("Invalid workspace file snapshot."),
    });
    if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > MAX_PROVIDER_PERSISTENCE_FILE_BYTES || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) {
      return yield* fail("Invalid workspace file snapshot.");
    }
    // Transfer bytes through the file API; exec output can be shortened even
    // when its result does not set truncated. Verify the copied bytes too.
    const bytes = yield* readFile(input.binding.workspace, snapshotPath).pipe(
      Effect.mapError(() => fail("Could not transfer the workspace file.")),
    );
    if (bytes.byteLength !== snapshot.size || providerPersistenceSha256(bytes) !== snapshot.sha256) {
      return yield* fail("The workspace file changed during transfer.");
    }
    return { path: input.filePath, name: path.posix.basename(input.filePath), bytes,
      sizeBytes: bytes.byteLength, sha256: snapshot.sha256 } satisfies ProviderWorkspaceFile;
  }).pipe(Effect.ensuring(input.workspaceRuntime.exec(input.binding.workspace, {
    command: `rm -f -- ${shellQuote(snapshotPath)}`, timeoutSeconds: 10,
  }).pipe(Effect.catch(() => Effect.void))));
});
