// FILE: pi-link/diff.ts
// Purpose: Turns two consecutive derived threads into the small events Synara's store applies
// (message text deltas, activity upserts, session changes, title changes). Anything events
// cannot express (a removed message, changed marks) asks for a snapshot instead.
// Layer: Pi Link worker.

import type {
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@synara/contracts";

export type ThreadEventDraft = { type: OrchestrationEvent["type"]; payload: Record<string, unknown>; occurredAt: string };

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

type TextSegment = NonNullable<OrchestrationMessage["textSegments"]>[number];

function messageEvent(threadId: string, message: OrchestrationMessage, text: string, streaming: boolean, segment?: TextSegment): ThreadEventDraft {
  return {
    type: "thread.message-sent",
    occurredAt: message.updatedAt,
    payload: {
      threadId,
      messageId: message.id,
      role: message.role,
      text,
      // A delta that opens a new segment (a note between tool rows) says so, as the server's do.
      ...(segment ? { segmentStartedAt: segment.startedAt, segmentSequence: segment.sequence } : {}),
      ...(message.author ? { author: message.author } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      turnId: message.turnId,
      streaming,
      source: "native",
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    },
  };
}

/** Events that take `prev` to `next`, or "snapshot" when only a snapshot can. */
export function diffThread(prev: OrchestrationThread, next: OrchestrationThread): ThreadEventDraft[] | "snapshot" {
  const events: ThreadEventDraft[] = [];
  const threadId = next.id;

  const prevMessages = new Map(prev.messages.map((message) => [message.id, message] as const));
  const nextIds = new Set(next.messages.map((message) => message.id));
  for (const id of prevMessages.keys()) if (!nextIds.has(id)) return "snapshot";
  for (const message of next.messages) {
    const before = prevMessages.get(message.id);
    const segments = message.textSegments ?? [];
    if (!before) {
      if (message.streaming && segments.length) {
        // A streaming answer arrives segment by segment, so the store keeps its notes apart.
        segments.forEach((segment, index) => events.push(messageEvent(threadId, message, index === 0 ? segment.text : `\n\n${segment.text}`, true, segment)));
      } else {
        events.push(messageEvent(threadId, message, message.text, message.streaming));
      }
      continue;
    }
    if (message.streaming) {
      if (message.text === before.text) continue;
      // Text only grows while it streams; anything else is replaced at the end of the turn.
      if (!message.text.startsWith(before.text)) return "snapshot";
      const earlier = before.textSegments ?? [];
      if (!segments.length && !earlier.length) {
        events.push(messageEvent(threadId, message, message.text.slice(before.text.length), true));
        continue;
      }
      // Earlier segments are settled; only the newest may grow, and new ones follow it.
      if (segments.length < earlier.length || earlier.slice(0, -1).some((segment, index) => segment.text !== segments[index]!.text)) return "snapshot";
      const last = earlier.at(-1);
      if (last) {
        const grown = segments[earlier.length - 1]!.text;
        if (!grown.startsWith(last.text)) return "snapshot";
        if (grown.length > last.text.length) events.push(messageEvent(threadId, message, grown.slice(last.text.length), true));
      }
      for (let index = earlier.length; index < segments.length; index += 1) {
        const segment = segments[index]!;
        events.push(messageEvent(threadId, message, index === 0 ? segment.text : `\n\n${segment.text}`, true, segment));
      }
    } else if (before.streaming || before.text !== message.text || !same(before.author, message.author)) {
      events.push(messageEvent(threadId, message, message.text, false));
    }
  }

  const prevActivities = new Map(prev.activities.map((activity) => [activity.id, activity] as const));
  // Events cannot remove an activity: a reasoning row that became a note (Claude) needs a snapshot.
  const nextActivityIds = new Set(next.activities.map((activity) => activity.id));
  for (const id of prevActivities.keys()) if (id.startsWith("reasoning:") && !nextActivityIds.has(id)) return "snapshot";
  for (const activity of next.activities) {
    const before = prevActivities.get(activity.id);
    if (before && before.kind === activity.kind && before.summary === activity.summary && before.turnId === activity.turnId && before.sequence === activity.sequence && same(before.payload, activity.payload)) continue;
    events.push({ type: "thread.activity-appended", occurredAt: activity.createdAt, payload: { threadId, activity: activity as OrchestrationThreadActivity } });
  }

  if (!same(prev.session, next.session)) {
    events.push({ type: "thread.session-set", occurredAt: next.session?.updatedAt ?? next.updatedAt, payload: { threadId, session: next.session } });
  }

  const meta: Record<string, unknown> = {};
  if (prev.title !== next.title) meta.title = next.title;
  if (!same(prev.modelSelection, next.modelSelection)) meta.modelSelection = next.modelSelection;
  if (prev.isPinned !== next.isPinned) meta.isPinned = next.isPinned;
  if (Object.keys(meta).length) events.push({ type: "thread.meta-updated", occurredAt: next.updatedAt, payload: { threadId, ...meta, updatedAt: next.updatedAt } });

  if ((prev.archivedAt ?? null) !== (next.archivedAt ?? null)) {
    events.push(next.archivedAt
      ? { type: "thread.archived", occurredAt: next.archivedAt, payload: { threadId, archivedAt: next.archivedAt, updatedAt: next.updatedAt } }
      : { type: "thread.unarchived", occurredAt: next.updatedAt, payload: { threadId, updatedAt: next.updatedAt } });
  }

  if (!same(prev.threadMarkers ?? [], next.threadMarkers ?? [])) return "snapshot";
  if (!same(prev.latestTurn?.turnId, next.latestTurn?.turnId) && !next.session) return "snapshot";
  return events;
}

/** Shell rows that changed, were added, or left. */
export function diffShell(
  prev: ReadonlyMap<string, OrchestrationThreadShell>,
  next: ReadonlyMap<string, OrchestrationThreadShell>,
): Array<{ kind: "thread-upserted"; thread: OrchestrationThreadShell } | { kind: "thread-removed"; threadId: string }> {
  const out: Array<{ kind: "thread-upserted"; thread: OrchestrationThreadShell } | { kind: "thread-removed"; threadId: string }> = [];
  for (const [id, thread] of next) {
    const before = prev.get(id);
    if (!before || !same(before, thread)) out.push({ kind: "thread-upserted", thread });
  }
  for (const id of prev.keys()) if (!next.has(id)) out.push({ kind: "thread-removed", threadId: id });
  return out;
}
