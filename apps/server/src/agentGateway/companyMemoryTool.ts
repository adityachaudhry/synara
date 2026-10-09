import { Effect } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import { glasswingAuthorEmail } from "../provider/glasswingAgentProfile.ts";
import { ArtifactApiError, artifactApiClient } from "../providerWorker/artifactPublisher.ts";
import { resolveCompanyTurn } from "./companyTurnContext.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import type { ToolEntry } from "./toolRuntime.ts";

const KINDS = ["remember", "correction", "forget"] as const;
const MAX_TEXT = 1000;
const MAX_QUOTE = 2000;
const UNAVAILABLE =
  "Company memory is unavailable right now, so this was not recorded. Continue the conversation; do not retry and do not tell the person unless they ask.";

type ActResult = {
  readonly act_id?: unknown;
  readonly applied?: unknown;
  readonly summary?: unknown;
};

/**
 * `glasswing_remember`: records what a person in a company chat states as durable (a fact about
 * the deal, how they want work done, a correction, or something to drop) as an act in the
 * company's Glasswing record. Memory has no UI; this is how chat feeds it. The author is the
 * authenticated person of the current turn, never an argument.
 */
export function makeCompanyMemoryTools(input: {
  snapshotQuery: ProjectionSnapshotQueryShape;
  projectionTurns: ProjectionTurnRepositoryShape;
}): ToolEntry[] {
  return [
    {
      requiredCapability: "company:memory",
      requiresActiveTurn: true,
      definition: {
        name: "glasswing_remember",
        description:
          "Record something a person in this conversation stated as durable about this company or about how they want work done, " +
          "so Glasswing remembers it in later conversations and diligence. " +
          "kind: remember (a fact or preference, e.g. 'the founders are full-time', 'we don't care about TAM at seed'), " +
          "correction (they correct something, e.g. 'that's wrong, the round is $8M'), forget (they ask to drop something remembered). " +
          "text: the point in their words, one or two sentences. quote: their exact words from the message, when short. " +
          "Do not use it for transient requests or for your own conclusions. Returns {act_id, applied, summary}.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...KINDS] },
            text: { type: "string", minLength: 1, maxLength: MAX_TEXT },
            quote: { type: "string", maxLength: MAX_QUOTE },
          },
          required: ["kind", "text"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const kind = args.kind;
          const text = typeof args.text === "string" ? args.text.trim() : "";
          const quote =
            typeof args.quote === "string" && args.quote.trim() ? args.quote.trim() : null;
          if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind))
            return yield* Effect.fail(
              new ToolInputError("kind must be remember, correction, or forget."),
            );
          if (!text || text.length > MAX_TEXT)
            return yield* Effect.fail(
              new ToolInputError(`text must be 1 to ${MAX_TEXT} characters.`),
            );
          if (quote && quote.length > MAX_QUOTE)
            return yield* Effect.fail(
              new ToolInputError(`quote must be at most ${MAX_QUOTE} characters.`),
            );
          const company = yield* resolveCompanyTurn(input, context);
          const message = company.latestHumanMessage;
          const authorEmail = glasswingAuthorEmail(message?.author);
          if (!message || !authorEmail)
            return yield* Effect.fail(
              new ToolInputError("Only a signed-in person's message can be remembered."),
            );
          let api: ReturnType<typeof artifactApiClient>;
          try {
            api = artifactApiClient();
          } catch {
            api = undefined;
          }
          if (!api)
            return mcpToolResultJson({ act_id: null, applied: false, summary: UNAVAILABLE });
          yield* context.assertCallerTurnActive();
          const result = yield* Effect.tryPromise({
            try: () =>
              api<ActResult>(`/internal/companies/${company.companyId}/acts`, {
                author_email: authorEmail,
                kind,
                text,
                quote,
                thread_id: company.threadId,
                message_id: message.id,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.map((act): unknown => ({
              act_id: typeof act?.act_id === "string" ? act.act_id : null,
              applied: act?.applied === true,
              summary: typeof act?.summary === "string" ? act.summary : "Recorded.",
            })),
            Effect.catch((cause) => {
              // Glasswing rejected the input: let the agent correct it. Anything else is an outage.
              if (
                cause instanceof ArtifactApiError &&
                (cause.status === 400 || cause.status === 422)
              )
                return Effect.fail(
                  new ToolInputError(
                    "Glasswing rejected this memory as invalid; restate it as one short point.",
                  ),
                );
              console.warn(
                JSON.stringify({
                  event: "gateway.remember.unavailable",
                  threadId: company.threadId,
                  message: errorText(cause).slice(0, 300),
                }),
              );
              return Effect.succeed<unknown>({
                act_id: null,
                applied: false,
                summary: UNAVAILABLE,
              });
            }),
          );
          return mcpToolResultJson(result);
        }).pipe(Effect.catch((cause) => Effect.succeed(mcpToolResultError(errorText(cause))))),
    },
  ];
}
