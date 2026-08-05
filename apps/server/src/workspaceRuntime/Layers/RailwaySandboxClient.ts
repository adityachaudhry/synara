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
  readonly environmentId: string;
  readonly networkIsolation: "PRIVATE" | "ISOLATED";
  readonly idleTimeoutMinutes: number;
  readonly region?: string;
  readonly env: Record<string, string>;
}

export interface RailwaySdkConnectionInput {
  readonly token: string;
  readonly environmentId: string;
}

export interface RailwaySdkExecInput {
  readonly cwd?: string;
  readonly timeoutSec?: number;
}

export interface RailwaySdkSandbox {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly region: string;
  readonly refresh: () => PromiseLike<RailwaySdkSandbox>;
  readonly exec: (command: string, input?: RailwaySdkExecInput) => PromiseLike<ExecResult>;
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
): RailwaySandboxClientShape {
  const handles = new Map<string, RailwaySdkSandbox>();
  const connectionInput: RailwaySdkConnectionInput = {
    token: config.token,
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

  const create: RailwaySandboxClientShape["create"] = (input: RailwaySandboxCreateInput) =>
    Effect.tryPromise({
      try: async () => {
        const sandbox = await sdk.create({
          ...connectionInput,
          networkIsolation: input.networkIsolation,
          idleTimeoutMinutes: input.idleTimeoutMinutes,
          ...(input.region === undefined ? {} : { region: input.region }),
          env: { ...input.environment },
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
          try: () => sandbox.destroy(),
          catch: (cause) => clientFailure(sdk, "destroy", runtimeId, cause),
        }),
      ),
      Effect.tap(() => Effect.sync(() => handles.delete(runtimeId))),
    );

  const list: RailwaySandboxClientShape["list"] = Effect.tryPromise({
    try: async () => (await sdk.list(connectionInput)).map(toRecord),
    catch: (cause) =>
      clientFailure(sdk, "list", undefined, cause) as RailwaySandboxClientError,
  });

  return { create, connect, exec, destroy, list };
}

export function makeRailwaySandboxClientLive(
  config: Extract<RailwaySandboxRuntimeConfig, { readonly enabled: true }>,
) {
  return Layer.succeed(RailwaySandboxClient, makeRailwaySandboxClient(config));
}
