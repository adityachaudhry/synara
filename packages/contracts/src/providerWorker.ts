import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import {
  ProviderCompactThreadInput,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderSteerTurnInput,
  ProviderStopSessionInput,
} from "./provider";
import {
  ProviderListCommandsInput,
  ProviderListModelsInput,
  ProviderListSkillsInput,
} from "./providerDiscovery";
import { ProviderRuntimeEvent } from "./providerRuntime";

export const PROVIDER_WORKER_PROTOCOL_VERSION = 1 as const;

const ProviderWorkerProtocolVersion = Schema.Literal(PROVIDER_WORKER_PROTOCOL_VERSION);
const ProviderWorkerUuid = Schema.String.check(Schema.isUUID(undefined));
const ProviderWorkerBoundedString = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const ProviderWorkerCredential = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const ProviderWorkerRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const ProviderWorkerMethod = Schema.Literals([
  "session.start",
  "turn.send",
  "turn.steer",
  "turn.interrupt",
  "request.respond",
  "userInput.respond",
  "session.stop",
  "session.list",
  "session.has",
  "thread.read",
  "thread.rollback",
  "thread.compact",
  "runtime.stopAll",
  "models.list",
  "skills.list",
  "commands.list",
  "composer.get",
]);
export type ProviderWorkerMethod = typeof ProviderWorkerMethod.Type;

const FenceFields = {
  protocolVersion: ProviderWorkerProtocolVersion,
  sandboxId: ProviderWorkerUuid,
  workerId: ProviderWorkerUuid,
  lifecycleGeneration: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
};

const EmptyParams = Schema.Struct({});
const ThreadParams = Schema.Struct({ threadId: ThreadId });
const RollbackThreadParams = Schema.Struct({
  threadId: ThreadId,
  numTurns: PositiveInt,
});

const request = <Method extends ProviderWorkerMethod, Params extends Schema.Top>(
  method: Method,
  params: Params,
) =>
  Schema.Struct({
    ...FenceFields,
    type: Schema.Literal("request"),
    requestId: ProviderWorkerRequestId,
    method: Schema.Literal(method),
    params,
  });

export const ProviderWorkerRequest = Schema.Union([
  request("session.start", ProviderSessionStartInput),
  request("turn.send", ProviderSendTurnInput),
  request("turn.steer", ProviderSteerTurnInput),
  request("turn.interrupt", ProviderInterruptTurnInput),
  request("request.respond", ProviderRespondToRequestInput),
  request("userInput.respond", ProviderRespondToUserInputInput),
  request("session.stop", ProviderStopSessionInput),
  request("session.list", EmptyParams),
  request("session.has", ThreadParams),
  request("thread.read", ThreadParams),
  request("thread.rollback", RollbackThreadParams),
  request("thread.compact", ProviderCompactThreadInput),
  request("runtime.stopAll", EmptyParams),
  request("models.list", ProviderListModelsInput),
  request("skills.list", ProviderListSkillsInput),
  request("commands.list", ProviderListCommandsInput),
  request("composer.get", EmptyParams),
]);
export type ProviderWorkerRequest = typeof ProviderWorkerRequest.Type;

export const ProviderWorkerRegister = Schema.Struct({
  ...FenceFields,
  type: Schema.Literal("register"),
  bootstrapCredential: ProviderWorkerCredential,
  lastAcknowledgedSequence: Schema.optional(NonNegativeInt),
});
export type ProviderWorkerRegister = typeof ProviderWorkerRegister.Type;

const ProviderWorkerSuccessResponse = Schema.Struct({
  ...FenceFields,
  type: Schema.Literal("response"),
  requestId: ProviderWorkerRequestId,
  ok: Schema.Literal(true),
  result: Schema.Unknown,
});

export const ProviderWorkerError = Schema.Struct({
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  message: ProviderWorkerBoundedString,
  retryable: Schema.Boolean,
});
export type ProviderWorkerError = typeof ProviderWorkerError.Type;

const ProviderWorkerFailureResponse = Schema.Struct({
  ...FenceFields,
  type: Schema.Literal("response"),
  requestId: ProviderWorkerRequestId,
  ok: Schema.Literal(false),
  error: ProviderWorkerError,
});

export const ProviderWorkerResponse = Schema.Union([
  ProviderWorkerSuccessResponse,
  ProviderWorkerFailureResponse,
]);
export type ProviderWorkerResponse = typeof ProviderWorkerResponse.Type;

export const ProviderWorkerEvent = Schema.Struct({
  ...FenceFields,
  type: Schema.Literal("event"),
  sequence: PositiveInt,
  event: ProviderRuntimeEvent,
});
export type ProviderWorkerEvent = typeof ProviderWorkerEvent.Type;

export const ProviderWorkerHeartbeat = Schema.Struct({
  ...FenceFields,
  type: Schema.Literal("heartbeat"),
  sentAt: IsoDateTime,
  acknowledgedSequence: Schema.optional(NonNegativeInt),
});
export type ProviderWorkerHeartbeat = typeof ProviderWorkerHeartbeat.Type;

export const ProviderWorkerRetire = Schema.Struct({
  ...FenceFields,
  type: Schema.Literal("retire"),
  reason: Schema.optional(ProviderWorkerBoundedString),
});
export type ProviderWorkerRetire = typeof ProviderWorkerRetire.Type;

export const ProviderWorkerRegistered = Schema.Struct({
  ...FenceFields,
  type: Schema.Literal("registered"),
  acknowledgedSequence: NonNegativeInt,
});
export type ProviderWorkerRegistered = typeof ProviderWorkerRegistered.Type;

export const ProviderWorkerClientFrame = Schema.Union([
  ProviderWorkerRegister,
  ProviderWorkerResponse,
  ProviderWorkerEvent,
  ProviderWorkerHeartbeat,
]);
export type ProviderWorkerClientFrame = typeof ProviderWorkerClientFrame.Type;

export const ProviderWorkerServerFrame = Schema.Union([
  ProviderWorkerRegistered,
  ProviderWorkerRequest,
  ProviderWorkerHeartbeat,
  ProviderWorkerRetire,
]);
export type ProviderWorkerServerFrame = typeof ProviderWorkerServerFrame.Type;
