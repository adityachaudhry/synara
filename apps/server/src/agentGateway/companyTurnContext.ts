import { ThreadId, TurnId, type OrchestrationMessage } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import { glasswingCompanyIdFromExternalKey } from "../provider/glasswingAgentProfile.ts";
import { ToolInputError } from "./toolInput.ts";
import type { ToolContext } from "./toolRuntime.ts";

/**
 * The Glasswing company and the human message behind a gateway tool call.
 *
 * Company tools act for the person who asked, never for the agent: the author comes from
 * the turn's authenticated messages, not from tool arguments.
 */
export const resolveCompanyTurn = (
  input: {
    readonly snapshotQuery: ProjectionSnapshotQueryShape;
    readonly projectionTurns: ProjectionTurnRepositoryShape;
  },
  context: ToolContext,
) =>
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe(context.callerThreadId);
    const thread = Option.getOrUndefined(yield* input.snapshotQuery.getThreadDetailById(threadId));
    if (!thread || !context.callerTurnId)
      return yield* Effect.fail(
        new ToolInputError("The requesting conversation is no longer active."),
      );
    const project = Option.getOrUndefined(
      yield* input.snapshotQuery.getProjectShellById(thread.projectId),
    );
    const companyId = glasswingCompanyIdFromExternalKey(project?.externalKey);
    const repository = project?.repositoryBinding;
    const companySlug = repository?.path.match(/^companies\/([a-z0-9][a-z0-9-]*)$/u)?.[1];
    if (!companyId || !companySlug || !repository)
      return yield* Effect.fail(
        new ToolInputError("This tool requires a Glasswing company conversation."),
      );
    const turnId = TurnId.makeUnsafe(context.callerTurnId);
    const turn = Option.getOrUndefined(
      yield* input.projectionTurns.getByTurnId({ threadId, turnId }),
    );
    /** The message that started the turn. */
    const requestMessage: OrchestrationMessage | undefined = thread.messages.find(
      (message) => message.id === turn?.pendingMessageId,
    );
    /** The latest authenticated person's message in this turn (a steer counts), else the one that started it. */
    const latestHumanMessage =
      thread.messages
        .filter(
          (message) =>
            message.role === "user" &&
            message.author !== undefined &&
            (message.id === turn?.pendingMessageId || message.turnId === turnId),
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
        .at(-1) ?? requestMessage;
    return {
      threadId,
      turnId,
      companyId,
      companySlug,
      repository,
      requestMessage,
      latestHumanMessage,
    };
  });
