import { randomUUID } from "node:crypto";

import { Effect, Layer } from "effect";

import { WorkspaceRuntimeError } from "../Errors";
import { RailwaySandboxClient } from "../Services/RailwaySandboxClient";
import {
  WorkspaceRuntime,
  type WorkspaceRuntimeBinding,
  type WorkspaceRuntimeInventoryRecord,
  type WorkspaceRuntimeShape,
} from "../Services/WorkspaceRuntime";
import type { RailwaySandboxRuntimeConfig } from "../railwaySandboxConfig";

function runtimeStatus(
  status: "CREATING" | "DESTROYING" | "RUNNING" | "STOPPED" | "DESTROYED" | "FAILED",
): WorkspaceRuntimeBinding["status"] {
  switch (status) {
    case "CREATING":
      return "creating";
    case "RUNNING":
      return "running";
    case "DESTROYING":
      return "destroying";
    case "STOPPED":
      return "stopped";
    case "DESTROYED":
      return "destroyed";
    case "FAILED":
      return "failed";
  }
}

function toRuntimeError(operation: string, runtimeId?: string) {
  return (cause: unknown) =>
    new WorkspaceRuntimeError({
      operation,
      detail: `Railway workspace runtime ${operation} failed.`,
      ...(runtimeId === undefined ? {} : { runtimeId }),
      cause,
    });
}

function requireEnabled(
  config: RailwaySandboxRuntimeConfig,
  operation: string,
): Effect.Effect<Extract<RailwaySandboxRuntimeConfig, { readonly enabled: true }>, WorkspaceRuntimeError> {
  return config.enabled
    ? Effect.succeed(config)
    : Effect.fail(
        new WorkspaceRuntimeError({
          operation,
          detail: "Railway Sandbox runtime is not configured.",
        }),
      );
}

export interface WorkspaceRuntimeOptions {
  readonly createOperationId?: () => string;
}

export function makeWorkspaceRuntimeLive(
  config: RailwaySandboxRuntimeConfig,
  options: WorkspaceRuntimeOptions = {},
) {
  return Layer.effect(
    WorkspaceRuntime,
    Effect.gen(function* () {
      const client = yield* RailwaySandboxClient;

      const create: WorkspaceRuntimeShape["create"] = (input) =>
        Effect.gen(function* () {
          const enabled = yield* requireEnabled(config, "create");
          const record = yield* client
            .create({
              operationId: (options.createOperationId ?? randomUUID)(),
              networkIsolation: input.networkIsolation ?? "ISOLATED",
              idleTimeoutMinutes: enabled.idleTimeoutMinutes,
              ...(enabled.region === undefined ? {} : { region: enabled.region }),
              environment: input.environment,
            })
            .pipe(Effect.mapError(toRuntimeError("create")));

          if (record.status !== "RUNNING") {
            yield* client.destroy(record.id).pipe(
              Effect.catchTag("RailwaySandboxNotFoundError", () => Effect.void),
              Effect.mapError(toRuntimeError("cleanup", record.id)),
            );
            return yield* new WorkspaceRuntimeError({
              operation: "create",
              detail: `Created Railway Sandbox entered unexpected status ${record.status}.`,
              runtimeId: record.id,
            });
          }

          return {
            runtimeKind: "railway-sandbox",
            runtimeId: record.id,
            lifecycleGeneration: input.lifecycleGeneration,
            status: "running",
            region: record.region,
          } satisfies WorkspaceRuntimeBinding;
        });

      const connect: WorkspaceRuntimeShape["connect"] = (binding) =>
        Effect.gen(function* () {
          yield* requireEnabled(config, "connect");
          const record = yield* client
            .connect(binding.runtimeId)
            .pipe(Effect.mapError(toRuntimeError("connect", binding.runtimeId)));
          if (record.status !== "RUNNING") {
            return yield* new WorkspaceRuntimeError({
              operation: "connect",
              detail: `Railway Sandbox is ${record.status}, not RUNNING.`,
              runtimeId: binding.runtimeId,
            });
          }
          return {
            ...binding,
            status: "running",
            region: record.region,
          };
        });

      const exec: WorkspaceRuntimeShape["exec"] = (binding, input) =>
        requireEnabled(config, "exec").pipe(
          Effect.flatMap(() => client.exec(binding.runtimeId, input)),
          Effect.mapError(toRuntimeError("exec", binding.runtimeId)),
        );

      const keepAlive: WorkspaceRuntimeShape["keepAlive"] = (binding) =>
        exec(binding, { command: "true", timeoutSeconds: 10 }).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(
                  new WorkspaceRuntimeError({
                    operation: "keepAlive",
                    detail: `Railway Sandbox keepalive exited with ${String(result.exitCode)}.`,
                    runtimeId: binding.runtimeId,
                  }),
                ),
          ),
        );

      const writeFile: WorkspaceRuntimeShape["writeFile"] = (binding, input) =>
        requireEnabled(config, "writeFile").pipe(
          Effect.flatMap(() => client.writeFile(binding.runtimeId, input)),
          Effect.mapError(toRuntimeError("writeFile", binding.runtimeId)),
        );

      const startDurableProcess: WorkspaceRuntimeShape["startDurableProcess"] = (
        binding,
        input,
      ) =>
        requireEnabled(config, "startDurableProcess").pipe(
          Effect.flatMap(() => client.startDurableProcess(binding.runtimeId, input)),
          Effect.mapError(toRuntimeError("startDurableProcess", binding.runtimeId)),
        );

      const stopDurableProcess: WorkspaceRuntimeShape["stopDurableProcess"] = (
        binding,
        sessionName,
      ) =>
        requireEnabled(config, "stopDurableProcess").pipe(
          Effect.flatMap(() => client.stopDurableProcess(binding.runtimeId, sessionName)),
          Effect.mapError(toRuntimeError("stopDurableProcess", binding.runtimeId)),
        );

      const destroy: WorkspaceRuntimeShape["destroy"] = (binding) =>
        requireEnabled(config, "destroy").pipe(
          Effect.flatMap(() => client.destroy(binding.runtimeId)),
          Effect.catchTag("RailwaySandboxNotFoundError", () => Effect.void),
          Effect.mapError(toRuntimeError("destroy", binding.runtimeId)),
        );

      const list: WorkspaceRuntimeShape["list"] = requireEnabled(config, "list").pipe(
        Effect.flatMap(() => client.list),
        Effect.map((records) =>
          records.map(
            (record): WorkspaceRuntimeInventoryRecord => ({
              runtimeKind: "railway-sandbox",
              runtimeId: record.id,
              status: runtimeStatus(record.status),
              region: record.region,
            }),
          ),
        ),
        Effect.mapError(toRuntimeError("list")),
      );

      return {
        create,
        connect,
        exec,
        writeFile,
        startDurableProcess,
        stopDurableProcess,
        keepAlive,
        destroy,
        list,
      } satisfies WorkspaceRuntimeShape;
    }),
  );
}
