import path from "node:path";
import { ThreadId, TurnId } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderWorkerProvisionerShape } from "../providerWorker/Services/ProviderWorkerProvisioner.ts";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry.ts";
import { decodeProviderWorkerRuntimeBinding } from "../providerWorker/runtimeBinding.ts";
import { artifactApiClient } from "../providerWorker/artifactPublisher.ts";
import {
  isProviderPersistencePathSafe,
  MAX_PROVIDER_PERSISTENCE_CANDIDATES,
  MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES,
} from "../providerPersistence.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

export function makeCompanyDiligenceTools(input: {
  snapshotQuery: ProjectionSnapshotQueryShape;
  projectionTurns: ProjectionTurnRepositoryShape;
  directory: ProviderSessionDirectoryShape | undefined;
  provisioner: ProviderWorkerProvisionerShape | undefined;
  adapters: ProviderAdapterRegistryShape | undefined;
}): ToolEntry[] {
  const api = artifactApiClient();
  const { directory, provisioner, adapters } = input;
  if (!api || !directory || !provisioner?.readWorkspaceFile || !adapters) return [];
  const readFile = provisioner.readWorkspaceFile;
  return [{
    requiredCapability: "company:diligence",
    requiresActiveTurn: true,
    definition: {
      name: "glasswing_run_diligence",
      description:
        "Start diligence for the company in this conversation, only when the user asks. " +
        "If the user asks for updates first, finish editing the requested files in the company checkout, then include their relative paths in savePaths. " +
        "Those files are saved to the shared company repository before the run is queued. " +
        "Omit savePaths when no files need saving. Do not include unrelated changes or Outbox files. " +
        "Returns a run ID and its current status, not completed diligence. An existing run is returned without starting a duplicate or saving additional changes.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["full", "quick", "memo"], default: "full" },
          savePaths: {
            type: "array", items: { type: "string" }, uniqueItems: true,
            maxItems: MAX_PROVIDER_PERSISTENCE_CANDIDATES,
            description: "Only user-requested company-checkout files to save before starting; paths are relative to the company directory.",
          },
        },
        additionalProperties: false,
      },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false, idempotentHint: true },
    },
    handler: (args, context) => Effect.gen(function* () {
      const mode = args.mode ?? "full";
      const paths = args.savePaths ?? [];
      if (!["full", "quick", "memo"].includes(String(mode)) || typeof mode !== "string")
        return yield* Effect.fail(new ToolInputError("mode must be full, quick, or memo."));
      if (!Array.isArray(paths) || paths.length > MAX_PROVIDER_PERSISTENCE_CANDIDATES ||
          paths.some((p) => typeof p !== "string" || !isProviderPersistencePathSafe(p)) ||
          new Set(paths).size !== paths.length)
        return yield* Effect.fail(new ToolInputError("savePaths must contain unique, safe relative company-file paths."));
      const threadId = ThreadId.makeUnsafe(context.callerThreadId);
      const thread = Option.getOrUndefined(yield* input.snapshotQuery.getThreadDetailById(threadId));
      if (!thread || !context.callerTurnId)
        return yield* Effect.fail(new ToolInputError("The requesting conversation is no longer active."));
      const project = Option.getOrUndefined(yield* input.snapshotQuery.getProjectShellById(thread.projectId));
      const companyId = project?.externalKey?.match(/^glasswing-company:([a-f0-9-]{36})$/u)?.[1];
      const repository = project?.repositoryBinding;
      const companySlug = repository?.path.match(/^companies\/([a-z0-9][a-z0-9-]*)$/u)?.[1];
      if (!companyId || !companySlug || !repository)
        return yield* Effect.fail(new ToolInputError("This tool requires a Glasswing company conversation."));
      const turn = Option.getOrUndefined(yield* input.projectionTurns.getByTurnId({
        threadId, turnId: TurnId.makeUnsafe(context.callerTurnId),
      }));
      const author = thread.messages.find((m) => m.id === turn?.pendingMessageId)?.author;
      if (!author)
        return yield* Effect.fail(new ToolInputError("Diligence requires an authenticated user request."));
      const runtime = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const payload = runtime?.runtimePayload;
      const binding = decodeProviderWorkerRuntimeBinding(
        payload && typeof payload === "object" && "distributedPiRuntime" in payload
          ? payload.distributedPiRuntime : undefined,
      );
      const checkout = binding?.repositoryCheckout?.binding;
      if (!binding || binding.threadId !== threadId ||
          binding.fence.lifecycleGeneration !== runtime?.lifecycleGeneration ||
          !checkout || checkout.kind !== repository.kind || checkout.origin !== repository.origin ||
          checkout.owner !== repository.owner || checkout.repository !== repository.repository ||
          checkout.ref !== repository.ref || checkout.path !== repository.path)
        return yield* Effect.fail(new ToolInputError("The active workspace does not match this company. Retry after it reconnects."));
      const files: Array<{ path: string; sha256: string; content_base64: string }> = [];
      let bytes = 0;
      for (const relativePath of paths as string[]) {
        yield* context.assertCallerTurnActive();
        const file = yield* readFile(binding, path.posix.join(binding.cwd, relativePath));
        if (file.workspaceSource === "checkpoint")
          return yield* Effect.fail(new ToolInputError("The live workspace is unavailable; saved checkpoints cannot replace the requested current edits."));
        bytes += file.sizeBytes;
        if (bytes > MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES)
          return yield* Effect.fail(new ToolInputError("The selected files exceed the company-file save limit."));
        files.push({ path: relativePath, sha256: file.sha256, content_base64: Buffer.from(file.bytes).toString("base64") });
      }
      yield* context.assertCallerTurnActive();
      const result = yield* Effect.tryPromise({
        try: () => api<{ run_id: string; status: string; commit_sha?: string | null; saved_paths: string[] }>(`/internal/companies/${companyId}/diligence`, {
          company_slug: companySlug, thread_id: threadId, turn_id: context.callerTurnId,
          requested_by: author.label ?? author.subject, mode, files,
        }),
        catch: (cause) => cause,
      });
      let synchronized = files.length === 0;
      if (result.commit_sha && result.saved_paths.length) {
        yield* context.assertCallerTurnActive();
        const adapter = yield* adapters.getByProvider("pi");
        if (adapter.reconcileRepository) {
          synchronized = yield* adapter.reconcileRepository(
            threadId, result.commit_sha,
            files.map((file) => ({ source: "checkout" as const, path: file.path, sha256: file.sha256 })),
            TurnId.makeUnsafe(context.callerTurnId),
          ).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
        }
      }
      return mcpToolResultJson({ ...result, workspace_synchronized: synchronized });
    }).pipe(Effect.catch((cause) => Effect.succeed(mcpToolResultError(errorText(cause))))),
  }];
}
