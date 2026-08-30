import { randomUUID } from "node:crypto";

import {
  Sandbox,
  SandboxNotFoundError,
  type ExecResult,
  type SandboxInfo,
  type SandboxStatus,
} from "railway";
import { Effect, Layer } from "effect";

import {
  RailwaySandboxClientError,
  RailwaySandboxNotFoundError,
} from "../Errors";
import {
  RailwaySandboxClient,
  type RailwaySandboxClientFailure,
  type RailwaySandboxClientShape,
  type RailwaySandboxCreateInput,
  type RailwaySandboxExecInput,
  type RailwaySandboxRecord,
} from "../Services/RailwaySandboxClient";
import type { RailwaySandboxRuntimeConfig } from "../railwaySandboxConfig";

export interface RailwaySdkCreateInput {
  readonly token: string;
  readonly authType: "bearer" | "project-token";
  readonly environmentId: string;
  readonly networkIsolation: "PRIVATE" | "ISOLATED";
  readonly idleTimeoutMinutes: number;
  readonly region?: string;
  readonly env: Record<string, string>;
}

export interface RailwaySdkConnectionInput {
  readonly token: string;
  readonly authType: "bearer" | "project-token";
  readonly environmentId: string;
}

export interface RailwaySdkExecInput {
  readonly cwd?: string;
  readonly timeoutSec?: number;
  readonly resumeFromLastRead?: boolean;
}

export interface RailwaySdkExecHandle extends PromiseLike<ExecResult> {
  readonly sessionName: Promise<string>;
  readonly detach: () => Promise<string>;
  readonly kill: (signal?: "TERM" | "KILL") => Promise<boolean>;
}

export interface RailwaySdkSandboxFiles {
  readonly write: (
    path: string,
    data: string | Uint8Array,
    options?: { readonly mode?: number },
  ) => PromiseLike<void>;
}

export interface RailwaySdkSandbox {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly region: string;
  readonly refresh: () => PromiseLike<RailwaySdkSandbox>;
  readonly exec: (
    target: string | { readonly sessionName: string },
    input?: RailwaySdkExecInput,
  ) => RailwaySdkExecHandle;
  readonly files: RailwaySdkSandboxFiles;
  readonly destroy: () => PromiseLike<void>;
}

export interface RailwaySdkFacade {
  readonly create: (input: RailwaySdkCreateInput) => PromiseLike<RailwaySdkSandbox>;
  readonly connect: (
    runtimeId: string,
    input: RailwaySdkConnectionInput,
  ) => PromiseLike<RailwaySdkSandbox>;
  readonly list: (input: RailwaySdkConnectionInput) => PromiseLike<ReadonlyArray<SandboxInfo>>;
  readonly isNotFoundError: (cause: unknown) => boolean;
}

export interface RailwaySandboxClientOptions {
  readonly durableSessionWaitMs?: number;
  readonly createProcessId?: () => string;
}

interface AttachedProcess {
  readonly runtimeId: string;
  readonly handle: RailwaySdkExecHandle;
}

const DEFAULT_DURABLE_SESSION_WAIT_MS = 1_500;
export const WORKSPACE_CREATE_OPERATION_ENV_KEY =
  "SYNARA_WORKSPACE_CREATE_OPERATION_ID";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const liveRailwaySdk: RailwaySdkFacade = {
  create: (input) => Sandbox.create(input),
  connect: (runtimeId, input) => Sandbox.connect(runtimeId, input),
  list: (input) => Sandbox.list(input),
  isNotFoundError: (cause) => cause instanceof SandboxNotFoundError,
};

function toRecord(sandbox: Pick<RailwaySdkSandbox, "id" | "status" | "region">) {
  return {
    id: sandbox.id,
    status: sandbox.status,
    region: sandbox.region,
  } satisfies RailwaySandboxRecord;
}

function clientFailure(
  sdk: RailwaySdkFacade,
  operation: string,
  runtimeId: string | undefined,
  cause: unknown,
): RailwaySandboxClientFailure {
  if (runtimeId !== undefined && sdk.isNotFoundError(cause)) {
    return new RailwaySandboxNotFoundError({ operation, runtimeId, cause });
  }
  return new RailwaySandboxClientError({
    operation,
    detail: `Railway Sandbox SDK ${operation} failed.`,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    cause,
  });
}

export function makeRailwaySandboxClient(
  config: Extract<RailwaySandboxRuntimeConfig, { readonly enabled: true }>,
  sdk: RailwaySdkFacade = liveRailwaySdk,
  options: RailwaySandboxClientOptions = {},
): RailwaySandboxClientShape {
  const handles = new Map<string, RailwaySdkSandbox>();
  const attachedProcesses = new Map<string, AttachedProcess>();
  const durableSessionWaitMs =
    options.durableSessionWaitMs ?? DEFAULT_DURABLE_SESSION_WAIT_MS;
  const createProcessId = options.createProcessId ?? randomUUID;
  const connectionInput: RailwaySdkConnectionInput = {
    token: config.token,
    authType: config.authType,
    environmentId: config.environmentId,
  };

  const load = (runtimeId: string) =>
    Effect.tryPromise({
      try: async () => {
        const existing = handles.get(runtimeId);
        if (existing) return existing;
        const connected = await sdk.connect(runtimeId, connectionInput);
        handles.set(runtimeId, connected);
        return connected;
      },
      catch: (cause) => clientFailure(sdk, "connect", runtimeId, cause),
    });

  const loadFresh = (runtimeId: string) =>
    Effect.tryPromise({
      try: async () => {
        const connected = await sdk.connect(runtimeId, connectionInput);
        handles.set(runtimeId, connected);
        return connected;
      },
      catch: (cause) => clientFailure(sdk, "connect", runtimeId, cause),
    });

  const destroyByCreateOperationId: RailwaySandboxClientShape["destroyByCreateOperationId"] =
    (operationId) =>
      Effect.tryPromise({
        try: async () => {
          const records = await sdk.list(connectionInput);
          let found = false;
          for (const record of records) {
            const sandbox = await sdk.connect(record.id, connectionInput);
            const probe = await sandbox.exec(
              `test "$${WORKSPACE_CREATE_OPERATION_ENV_KEY}" = ${shellQuote(operationId)}`,
              { timeoutSec: 10 },
            );
            if (probe.exitCode !== 0) continue;
            found = true;
            await sandbox.destroy();
            handles.delete(record.id);
          }
          return found;
        },
        catch: (cause) =>
          clientFailure(sdk, "create.reconcile", undefined, cause) as RailwaySandboxClientError,
      });

  const create: RailwaySandboxClientShape["create"] = (input: RailwaySandboxCreateInput) =>
    Effect.tryPromise({
      try: async () => {
        const sandbox = await sdk.create({
          ...connectionInput,
          networkIsolation: input.networkIsolation,
          idleTimeoutMinutes: input.idleTimeoutMinutes,
          ...(input.region === undefined ? {} : { region: input.region }),
          env: {
            ...input.environment,
            [WORKSPACE_CREATE_OPERATION_ENV_KEY]: input.operationId,
          },
        });
        handles.set(sandbox.id, sandbox);
        return toRecord(sandbox);
      },
      catch: (cause) =>
        clientFailure(sdk, "create", undefined, cause) as RailwaySandboxClientError,
    });

  const connect: RailwaySandboxClientShape["connect"] = (runtimeId) =>
    Effect.tryPromise({
      try: async () => {
        const sandbox = await sdk.connect(runtimeId, connectionInput);
        await sandbox.refresh();
        handles.set(runtimeId, sandbox);
        return toRecord(sandbox);
      },
      catch: (cause) => clientFailure(sdk, "connect", runtimeId, cause),
    });

  const exec: RailwaySandboxClientShape["exec"] = (
    runtimeId,
    input: RailwaySandboxExecInput,
  ) =>
    load(runtimeId).pipe(
      Effect.flatMap((sandbox) =>
        Effect.tryPromise({
          try: () =>
            sandbox.exec(input.command, {
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
              ...(input.timeoutSeconds === undefined
                ? {}
                : { timeoutSec: input.timeoutSeconds }),
            }),
          catch: (cause) => clientFailure(sdk, "exec", runtimeId, cause),
        }),
      ),
    );

  const destroy: RailwaySandboxClientShape["destroy"] = (runtimeId) =>
    load(runtimeId).pipe(
      Effect.flatMap((sandbox) =>
        Effect.tryPromise({
          try: async () => {
            const processes = Array.from(attachedProcesses.entries()).filter(
              ([, process]) => process.runtimeId === runtimeId,
            );
            for (const [sessionName, process] of processes) {
              try {
                await process.handle.kill("TERM");
              } catch {
                // Destroying the sandbox is the authoritative cleanup path.
              } finally {
                attachedProcesses.delete(sessionName);
              }
            }
            await sandbox.destroy();
          },
          catch: (cause) => clientFailure(sdk, "destroy", runtimeId, cause),
        }),
      ),
      Effect.tap(() => Effect.sync(() => handles.delete(runtimeId))),
    );

  const writeFile: RailwaySandboxClientShape["writeFile"] = (runtimeId, input) =>
    loadFresh(runtimeId).pipe(
      Effect.flatMap((sandbox) =>
        Effect.tryPromise({
          try: () =>
            sandbox.files.write(input.path, input.data, {
              ...(input.mode === undefined ? {} : { mode: input.mode }),
            }),
          catch: (cause) => clientFailure(sdk, "writeFile", runtimeId, cause),
        }),
      ),
    );

  const startDurableProcess: RailwaySandboxClientShape["startDurableProcess"] = (
    runtimeId,
    input,
  ) =>
    loadFresh(runtimeId).pipe(
      Effect.flatMap((sandbox) =>
        Effect.tryPromise({
          try: async () => {
            const handle = sandbox.exec(input.command, {
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            });
            if (config.authType === "project-token") {
              const sessionName = await handle.sessionName;
              await handle.detach();
              return { sessionName, supervision: "durable" };
            }
            const sessionName = await new Promise<string | undefined>((resolve, reject) => {
              let settled = false;
              const timer = setTimeout(() => {
                settled = true;
                resolve(undefined);
              }, durableSessionWaitMs);
              void handle.sessionName.then(
                (name) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  resolve(name);
                },
                (cause) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  reject(cause);
                },
              );
            });

            if (sessionName !== undefined) {
              await handle.detach();
              return { sessionName, supervision: "durable" };
            }

            const attachedSessionName = `attached:${createProcessId()}`;
            attachedProcesses.set(attachedSessionName, { runtimeId, handle });
            void Promise.resolve(handle)
              .catch(() => undefined)
              .finally(() => {
                const current = attachedProcesses.get(attachedSessionName);
                if (current?.handle === handle) {
                  attachedProcesses.delete(attachedSessionName);
                }
              });
            return {
              sessionName: attachedSessionName,
              supervision: "attached",
            };
          },
          catch: (cause) => clientFailure(sdk, "startDurableProcess", runtimeId, cause),
        }),
      ),
    );

  const stopDurableProcess: RailwaySandboxClientShape["stopDurableProcess"] = (
    runtimeId,
    sessionName,
  ) =>
    load(runtimeId).pipe(
      Effect.flatMap((sandbox) =>
        Effect.tryPromise({
          try: async () => {
            const attached = attachedProcesses.get(sessionName);
            if (attached !== undefined) {
              if (attached.runtimeId !== runtimeId) {
                throw new Error("Attached process belongs to a different sandbox.");
              }
              const terminated = await attached.handle.kill("TERM");
              if (!terminated) throw new Error("Railway attached process was not running.");
              attachedProcesses.delete(sessionName);
              return;
            }
            const handle = sandbox.exec(
              { sessionName },
              { resumeFromLastRead: true },
            );
            const terminated = await handle.kill("TERM");
            if (!terminated) throw new Error("Railway durable process was not running.");
          },
          catch: (cause) => clientFailure(sdk, "stopDurableProcess", runtimeId, cause),
        }),
      ),
    );

  const list: RailwaySandboxClientShape["list"] = Effect.tryPromise({
    try: async () => (await sdk.list(connectionInput)).map(toRecord),
    catch: (cause) =>
      clientFailure(sdk, "list", undefined, cause) as RailwaySandboxClientError,
  });

  return {
    create,
    connect,
    exec,
    writeFile,
    startDurableProcess,
    stopDurableProcess,
      destroy,
      destroyByCreateOperationId,
    list,
  };
}

export function makeRailwaySandboxClientLive(
  config: Extract<RailwaySandboxRuntimeConfig, { readonly enabled: true }>,
) {
  return Layer.succeed(RailwaySandboxClient, makeRailwaySandboxClient(config));
}
