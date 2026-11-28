// FILE: pi-link/derive.ts
// Purpose: Pure translation of Pi state (entries, pi.live, our glasswing.* documents and thread
// rows) into the shapes Synara's client renders: thread details and shell rows.
// Layer: Pi Link worker. No DOM, no network; the worker calls it on every change.

import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@synara/contracts";

import { textFromToolResult, toolDescription, toolItemType, toolLifecycleData, toolResultForDisplay, toolTitle } from "./toolDisplay";

// ------------------------------------------------------------ Pi shapes (the parts we read)

export type Author = { subject: string; label?: string };
export type AttachmentRef = { id: string; type: "image" | "file"; name: string; mimeType: string; sizeBytes: number };

export type PiEntry = {
  readonly id: number;
  readonly kind: string;
  readonly model?: ReadonlyArray<{ role?: string; content?: unknown; timestamp?: number; durationMs?: number; provider?: string; model?: string; toolCallId?: string; toolName?: string; isError?: boolean; stopReason?: string; errorMessage?: string }>;
  readonly data?: unknown;
  readonly byTaskId?: string;
};

export type ToolSlot = { callId: string; name: string; status: string; output?: string; details?: unknown; entry?: number };

export type LiveState = {
  run?: { taskId: string; inputs: string[]; turns: number; first?: number };
  generation?: { attempt: number; message?: { content?: unknown[]; timestamp?: number; provider?: string }; retry?: { at: number; error: string } };
  tools?: ToolSlot[];
  compactions?: Array<{ taskId: string }>;
  runFailure?: { reason: string; detail?: string; first?: number };
};

export type ThreadInfo = {
  threadId: string;
  companyId: string;
  slug: string;
  kind: "chat" | "run" | "step" | "note";
  title: string;
  parentThreadId?: string;
  runId?: string;
  stepId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: Author;
  archivedAt?: string;
  pinned?: boolean;
  model?: { provider: string; modelId: string; thinkingLevel?: string };
  marks: Array<Record<string, unknown> & { id: string; messageId: string; startOffset: number; endOffset: number; createdAt: string }>;
};

export type ThreadRow = {
  threadId: string;
  conversationId: number;
  kind: ThreadInfo["kind"];
  title: string;
  parentThreadId?: string;
  runId?: string;
  stepId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: Author;
  archivedAt?: string;
  pinned?: boolean;
  model?: ThreadInfo["model"];
  status: "idle" | "running" | "error";
  lastError?: string;
  latestTurn?: { turnId: string; state: "running" | "completed" | "interrupted" | "error"; requestedAt: string; completedAt?: string };
  latestUserMessageAt?: string;
  feed?: { firstMessageId: string; firstMessageText: string; author: Author | null; firstMessageAt: string; replyCount: number; latestReplyAt: string | null };
};

export type RunStep = { stepId: string; title: string; status: string; threadId?: string; model?: string; phase?: string; startedAt?: string; endedAt?: string; error?: string };
export type RunInfo = {
  runId: string;
  mode: string;
  status: "queued" | "running" | "succeeded" | "failed" | "stopped";
  title: string;
  company?: string;
  startedAt: string;
  endedAt?: string;
  steps: Record<string, RunStep>;
  order: string[];
  phases?: string[];
};

export type ConversationView = {
  readonly entries: readonly PiEntry[];
  readonly docs: Readonly<Record<string, unknown>>;
};

// ------------------------------------------------------------------------- helpers

const EPOCH = new Date(0).toISOString();
const iso = (ms: number | undefined, fallback: string) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : fallback);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const modelSelectionOf = (model: ThreadInfo["model"] | undefined) => ({
  provider: "pi" as const,
  model: `${model?.provider ?? "anthropic"}/${model?.modelId ?? "claude-opus-5-5"}`,
  ...(model?.thinkingLevel ? { options: { thinkingLevel: model.thinkingLevel } } : {}),
});

/** The text of a model message's content (string or blocks). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = record(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

/** Strips the author line Glasswing prepends to a person's message for the model. */
function stripAuthorContext(text: string): string {
  return text.replace(/^<glasswing_message_author[\s\S]*?<\/glasswing_message_author>\s*/u, "");
}

/** Activity sequences follow transcript order: 32 slots per entry (reasoning, notes and tool calls of one response). */
const SLOTS = 32;
const seqOf = (entryId: number, slot = 0) => entryId * SLOTS + Math.min(slot, SLOTS - 1);

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** When a response ended: its start plus the duration pi-ai measured; responses without one end at their start. */
function endOf(message: { timestamp?: number; durationMs?: number } | undefined, fallback: string): string {
  const start = finite(message?.timestamp);
  const duration = finite(message?.durationMs);
  return start !== undefined && duration !== undefined ? new Date(start + duration).toISOString() : fallback;
}

type ResponsePart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; index: number }
  | { kind: "tool"; id: string; name: string; args: unknown };

/**
 * A response's blocks in order, as the timeline shows them: text (a note, or the answer),
 * reasoning (a thinking block's readable summary) and tool calls.
 */
function responseParts(content: unknown, provider: string | undefined): ResponsePart[] {
  const parts: ResponsePart[] = [];
  (Array.isArray(content) ? content : []).forEach((block, index) => {
    const item = record(block);
    if (item?.type === "text" && typeof item.text === "string") {
      if (!item.text.trim()) return;
      const previous = parts.at(-1);
      if (previous?.kind === "text") previous.text += item.text;
      else parts.push({ kind: "text", text: item.text });
    } else if (item?.type === "thinking" && typeof item.thinking === "string" && item.redacted !== true) {
      const text = item.thinking.trim();
      if (text) parts.push({ kind: "reasoning", text, index });
    } else if (item?.type === "toolCall" && typeof item.id === "string") {
      parts.push({ kind: "tool", id: item.id, name: str(item.name) ?? "tool", args: item.arguments });
    }
  });
  // Claude (Opus 5.5) writes a longer note between steps as a thinking block of its own, right before
  // the tool call it introduces; the "summarized" display returns those mixed with reasoning summaries.
  // A short last thinking block before a call, or the second of two, reads as a note. (Check on Claude.)
  if (provider === "anthropic") {
    parts.forEach((part, index) => {
      if (part.kind !== "reasoning" || parts[index + 1]?.kind !== "tool") return;
      const secondOfTwo = parts[index - 1]?.kind === "reasoning";
      if (secondOfTwo || (part.text.length <= 320 && !/^\s*(\*\*|#)/u.test(part.text))) parts[index] = { kind: "text", text: part.text };
    });
  }
  return parts;
}

/** A reasoning row: Synara's item-scoped "Reasoning trace", its summary as the detail. */
function reasoningActivity(key: string, text: string, streaming: boolean, at: string, sequence: number, turnId: string | null): OrchestrationThreadActivity {
  const callId = `reasoning:${key}`;
  return {
    id: callId as never,
    tone: "tool",
    kind: "task.progress" as never,
    summary: "Reasoning trace" as never,
    payload: { status: streaming ? "inProgress" : "completed", title: "Reasoning trace", detail: text.slice(0, 8000), data: { toolCallId: callId } } as never,
    turnId: turnId as never,
    sequence,
    createdAt: at,
  };
}

// ------------------------------------------------------------------------ the thread

export interface DeriveInput {
  readonly info: ThreadInfo;
  /** Every entry the client holds for this thread, ascending (window plus loaded history). */
  readonly entries: readonly PiEntry[];
  readonly live: LiveState | undefined;
  readonly run?: RunInfo | undefined;
  readonly row?: ThreadRow | undefined;
  /** Older entries exist that the client has not loaded yet. */
  readonly hasEarlier?: boolean;
}

type Turn = {
  turnId: string;
  requestedAt: string;
  startedAt: string;
  completedAt: string | null;
  assistantId: string;
  segments: Array<{ sequence: number; startedAt: string; endedAt: string; text: string }>;
  streaming: boolean;
  firstAssistantAt?: string;
  /** When the turn's last response ended. */
  endedAt?: string;
};

export function deriveThread(input: DeriveInput): OrchestrationThread {
  const { info, entries, live, run, row } = input;
  const messages: OrchestrationMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const turns: Turn[] = [];
  const toolArgs = new Map<string, { name: string; args: unknown; at: string; entryId: number; sequence: number; turnId: string | null }>();
  let current: Turn | undefined;
  /** The model switch shown last: the notice shows once, not on every turn on the fallback. */
  let shownSwitch: { key: string; from?: string } | undefined;
  // A window that starts inside a turn (older entries not loaded yet) leaves that turn out until its
  // start arrives: named after its first loaded entry, the turn's answer would change id when history
  // loads, and Synara's store keeps a streaming or latest answer under its old id beside the new one.
  let midTurn = input.hasEarlier === true;
  let lastAt = info.createdAt;
  let lastEntryId = 0;

  const startTurn = (turnId: string, at: string) => {
    current = { turnId, requestedAt: at, startedAt: at, completedAt: null, assistantId: `assistant:${turnId}`, segments: [], streaming: false };
    turns.push(current);
  };

  for (const entry of entries) {
    lastEntryId = entry.id;
    const first = entry.model?.[0];
    const data = record(entry.data);
    const at = str(data?.at) ?? iso(first?.timestamp, lastAt);
    lastAt = at;
    if (midTurn) {
      const standalone = entry.kind === "glasswing.input" || entry.kind === "pi.user" || entry.kind === "glasswing.message" || entry.kind === "glasswing.note" || (entry.kind === "pi.assistant" && str(data?.messageId) !== undefined);
      if (!standalone) continue;
      midTurn = false;
    }
    switch (entry.kind) {
      case "glasswing.input": {
        const requestId = str(data?.requestId) ?? `entry-${entry.id}`;
        // Imported from the controller: the message keeps its id and its turn.
        const turnId = str(data?.turnId) ?? requestId;
        const author = record(data?.author) as Author | undefined;
        messages.push({
          id: requestId as never,
          role: "user",
          text: str(data?.text) ?? "",
          ...(author ? { author } : {}),
          ...(Array.isArray(data?.attachments) && data.attachments.length ? { attachments: data.attachments as never } : {}),
          turnId: turnId as never,
          streaming: false,
          source: "native",
          createdAt: at,
          updatedAt: at,
        } as OrchestrationMessage);
        startTurn(turnId, at);
        break;
      }
      case "pi.user": {
        const id = `entry-${entry.id}`;
        messages.push({
          id: id as never, role: "user", text: stripAuthorContext(messageText(first?.content)),
          turnId: id as never, streaming: false, source: "native", createdAt: at, updatedAt: at,
        } as OrchestrationMessage);
        startTurn(id, at);
        break;
      }
      case "glasswing.message": {
        const author = record(data?.author) as Author | undefined;
        messages.push({
          id: (str(data?.requestId) ?? `entry-${entry.id}`) as never, role: "user", text: str(data?.text) ?? "",
          ...(author ? { author } : {}),
          ...(Array.isArray(data?.attachments) && data.attachments.length ? { attachments: data.attachments as never } : {}),
          turnId: null, streaming: false, source: "native", createdAt: at, updatedAt: at,
        } as OrchestrationMessage);
        break;
      }
      case "glasswing.note": {
        const author = (record(data?.author) as Author | undefined) ?? { subject: "glasswing:note", label: "Glasswing" };
        messages.push({
          id: (str(data?.requestId) ?? `entry-${entry.id}`) as never, role: "assistant", text: str(data?.text) ?? "",
          author, turnId: null, streaming: false, source: "native", createdAt: at, updatedAt: at,
        } as OrchestrationMessage);
        break;
      }
      case "glasswing.event": {
        const kind = str(data?.kind) ?? "runtime.info";
        const tone = str(data?.tone);
        if (kind === "model.rerouted") {
          const detail = record(data?.data);
          const key = `${str(detail?.fromModel) ?? ""}>${str(detail?.toModel) ?? ""}`;
          if (shownSwitch?.key === key) break;
          shownSwitch = { key, ...(str(detail?.fromModel) ? { from: str(detail?.fromModel)! } : {}) };
        }
        activities.push({
          id: `event:${entry.id}` as never,
          tone: (tone === "error" ? "error" : tone === "warning" ? "info" : "info") as never,
          kind: kind as never,
          summary: (str(data?.summary) ?? kind) as never,
          payload: (record(data?.data) ?? {}) as never,
          turnId: (current?.turnId ?? null) as never,
          sequence: seqOf(entry.id),
          createdAt: at,
        });
        break;
      }
      case "pi.assistant": {
        const importedId = str(data?.messageId);
        if (importedId) {
          // An answer imported from the controller: its own message, under its original id.
          messages.push({
            id: importedId as never, role: "assistant", text: messageText(first?.content),
            turnId: (str(data?.turnId) ?? current?.turnId ?? null) as never, streaming: false, source: "native", createdAt: at, updatedAt: at,
          } as OrchestrationMessage);
          break;
        }
        if (!current) startTurn(`entry-${entry.id}`, at);
        const turn = current!;
        const endedAt = endOf(first, at);
        turn.endedAt = endedAt;
        // A reply from the model we switched away from (Claude is back): a later switch shows again.
        if (shownSwitch?.from && `${first?.provider}/${first?.model}` === shownSwitch.from) shownSwitch = undefined;
        let slot = 0;
        for (const part of responseParts(first?.content, first?.provider)) {
          const sequence = seqOf(entry.id, slot++);
          if (part.kind === "text") {
            turn.segments.push({ sequence, startedAt: at, endedAt, text: part.text });
            turn.firstAssistantAt ??= at;
          } else if (part.kind === "reasoning") {
            activities.push(reasoningActivity(`${first?.timestamp ?? entry.id}:${part.index}`, part.text, false, at, sequence, turn.turnId));
          } else {
            toolArgs.set(part.id, { name: part.name, args: part.args, at, entryId: entry.id, sequence, turnId: turn.turnId });
            activities.push(toolActivity("tool.started", part.id, part.name, part.args, at, sequence, turn.turnId));
          }
        }
        if (first?.stopReason === "error" && first.errorMessage) turn.completedAt = at;
        break;
      }
      case "pi.tool-result": {
        const callId = first?.toolCallId ?? str(data?.callId);
        if (!callId) break;
        const started = toolArgs.get(callId);
        const result = toolResultForDisplay({ content: first?.content ?? [], details: data });
        activities.push(
          toolActivity("tool.completed", callId, started?.name ?? first?.toolName ?? "tool", started?.args, at, seqOf(entry.id), started?.turnId ?? current?.turnId ?? null, {
            result,
            isError: first?.isError === true,
          }),
        );
        break;
      }
      case "pi.compaction": {
        activities.push({
          id: `compaction:${entry.id}` as never, tone: "info", kind: "context-compaction" as never, summary: "Context compacted" as never,
          payload: { itemType: "context_compaction", status: "completed" } as never, turnId: null, sequence: seqOf(entry.id), createdAt: at,
        });
        break;
      }
      default:
        break;
    }
  }

  // The answer in flight: its text streams into the turn's message, its tools show as running.
  const running = live?.run !== undefined;
  if (running && !midTurn) {
    if (!current) startTurn(`run:${live!.run!.taskId}`, lastAt);
    const turn = current!;
    turn.streaming = true;
    const partial = live?.generation?.message;
    const at = iso(partial?.timestamp, lastAt);
    const parts = responseParts(partial?.content, partial?.provider);
    let slot = 0;
    parts.forEach((part, index) => {
      const sequence = seqOf(lastEntryId + 1, slot++);
      if (part.kind === "text") {
        turn.segments.push({ sequence, startedAt: at, endedAt: new Date().toISOString(), text: part.text });
        turn.firstAssistantAt ??= at;
      } else if (part.kind === "reasoning") {
        // Reads as prose while it is the newest block; once anything follows, it folds to one line.
        // Keyed like the saved reply's row (request start and block), so saving it replaces this one.
        activities.push(reasoningActivity(`${partial?.timestamp ?? `live:${live!.run!.taskId}`}:${part.index}`, part.text, index === parts.length - 1, at, sequence, turn.turnId));
      }
      // A tool call still being written shows once it runs (live.tools, below).
    });
    for (const tool of live?.tools ?? []) {
      if (tool.status === "done" && tool.entry !== undefined) continue;
      const started = toolArgs.get(tool.callId);
      activities.push(
        toolActivity("tool.updated", tool.callId, started?.name ?? tool.name, started?.args, started?.at ?? lastAt, started?.sequence ?? seqOf(lastEntryId, slot++), turn.turnId, {
          partialResult: tool.output !== undefined ? { content: [{ type: "text", text: tool.output }], details: tool.details } : undefined,
          status: tool.status,
        }),
      );
    }
    if (live?.generation?.retry) {
      activities.push({
        id: `retry:${live.run!.taskId}:${live.generation.attempt}` as never, tone: "info", kind: "runtime.warning" as never,
        summary: "Retrying the model request" as never, payload: { detail: live.generation.retry.error.slice(0, 500) } as never,
        turnId: turn.turnId as never, sequence: seqOf(lastEntryId + 1, 15), createdAt: lastAt,
      });
    }
  }

  // One assistant message per turn, its text in segments between tool rows.
  for (const turn of turns) {
    if (!turn.segments.length) continue;
    const text = turn.segments.map((segment) => segment.text).join("\n\n");
    messages.push({
      id: turn.assistantId as never,
      role: "assistant",
      text,
      textSegments: turn.segments.map((segment) => ({ ...segment })),
      turnId: turn.turnId as never,
      streaming: turn.streaming,
      source: "native",
      createdAt: turn.firstAssistantAt ?? turn.requestedAt,
      updatedAt: turn.segments.at(-1)!.endedAt,
    } as OrchestrationMessage);
  }
  messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (run) activities.push(...runActivities(run, info.threadId));

  const failure = !running ? live?.runFailure : undefined;
  const lastTurn = turns.at(-1);
  const latestTurn: OrchestrationLatestTurn | null = lastTurn
    ? ({
        turnId: lastTurn.turnId as never,
        state: running ? "running" : failure ? (failure.reason === "aborted" ? "interrupted" : "error") : "completed",
        requestedAt: lastTurn.requestedAt,
        startedAt: lastTurn.startedAt,
        completedAt: running ? null : (lastTurn.endedAt ?? lastTurn.segments.at(-1)?.endedAt ?? lastTurn.requestedAt),
        assistantMessageId: lastTurn.segments.length ? (lastTurn.assistantId as never) : null,
      } as OrchestrationLatestTurn)
    : row?.latestTurn
      ? ({ turnId: row.latestTurn.turnId as never, state: row.latestTurn.state, requestedAt: row.latestTurn.requestedAt, startedAt: row.latestTurn.requestedAt, completedAt: row.latestTurn.completedAt ?? null, assistantMessageId: null } as OrchestrationLatestTurn)
      : null;

  const lastError = failure && failure.reason !== "aborted" ? (failure.detail ?? `The answer stopped (${failure.reason}).`) : null;
  const session: OrchestrationSession = {
    threadId: info.threadId as never,
    status: (running ? "running" : lastError ? "error" : "ready") as never,
    providerName: "pi",
    runtimeMode: "full-access",
    activeTurnId: (running ? (lastTurn?.turnId ?? null) : null) as never,
    lastError: (lastError ? lastError.slice(0, 2000) : null) as never,
    updatedAt: info.updatedAt,
  };

  return {
    ...threadBase(info, row),
    latestTurn,
    latestUserMessageAt: row?.latestUserMessageAt ?? null,
    threadMarkers: info.marks.map((mark) => ({ style: "highlight", color: "yellow", selectedText: "…", label: null, done: false, updatedAt: mark.createdAt, ...mark })) as never,
    messages,
    proposedPlans: [],
    activities,
    checkpoints: [],
    session,
    deletedAt: null,
  } as unknown as OrchestrationThread;
}

function toolActivity(
  kind: "tool.started" | "tool.updated" | "tool.completed",
  callId: string,
  name: string,
  args: unknown,
  at: string,
  sequence: number,
  turnId: string | null,
  extra: { result?: unknown; partialResult?: unknown; isError?: boolean; status?: string } = {},
): OrchestrationThreadActivity {
  const itemType = toolItemType(name);
  const title = toolTitle(name, args);
  // The model's own description (or one built from the arguments) replaces the command preview.
  const described = toolDescription(name, args) !== undefined;
  const status = kind === "tool.completed" ? (extra.isError ? "failed" : "completed") : "inProgress";
  const detail = extra.result !== undefined ? textFromToolResult(extra.result) : undefined;
  return {
    id: `tool:${callId}:${kind === "tool.started" ? "started" : kind === "tool.completed" ? "completed" : "updated"}` as never,
    tone: "tool",
    kind: kind as never,
    summary: (kind === "tool.started" ? `${title} started` : title) as never,
    payload: {
      itemType,
      status,
      title,
      ...(described ? { titleIsDescription: true } : {}),
      // A file read counts as one in folded groups ("Read 4 files"), not as a generic tool.
      ...(name === "read" ? { requestKind: "file-read" } : {}),
      ...(detail ? { detail: detail.slice(0, 4000) } : {}),
      data: toolLifecycleData({
        toolCallId: callId, toolName: name, args,
        ...(extra.result !== undefined ? { result: extra.result } : {}),
        ...(extra.partialResult !== undefined ? { partialResult: extra.partialResult } : {}),
        ...(extra.isError !== undefined ? { isError: extra.isError } : {}),
      }),
    } as never,
    turnId: turnId as never,
    sequence,
    createdAt: at,
  };
}

/** The diligence run card: Synara's workflow card reads task.* activities, and step rows link their threads. */
function runActivities(run: RunInfo, runThreadId: string): OrchestrationThreadActivity[] {
  const out: OrchestrationThreadActivity[] = [];
  const workflowTaskId = `diligence-${run.runId}`;
  const turnId = `diligence-run:${run.runId}`;
  const base = 1_000_000_000; // after any chat in the run thread's own transcript start
  let n = 0;
  const steps = run.order.map((id) => run.steps[id]).filter((step): step is RunStep => step !== undefined);
  const plans = Object.fromEntries(steps.map((step) => [step.title, { ...(step.phase ? { phase: step.phase } : {}), ...(step.model ? { model: step.model } : {}) }]));
  out.push({
    id: `run:${run.runId}:task` as never, tone: "info", kind: "task.started" as never, summary: "durable_workflow task started" as never,
    payload: {
      taskId: workflowTaskId, taskType: "durable_workflow", workflowName: "Diligence",
      workflowPhases: (run.phases ?? [...new Set(steps.map((step) => step.phase).filter(Boolean))]).map((title) => ({ title })),
      workflowAgentPlans: plans, detail: run.title,
    } as never,
    turnId: turnId as never, sequence: base + n++, createdAt: run.startedAt,
  });
  for (const step of steps) {
    if (step.status === "pending") continue;
    const at = step.startedAt ?? run.startedAt;
    const settled = ["done", "failed", "stopped", "skipped"].includes(step.status);
    const itemStatus = step.status === "done" ? "completed" : settled ? "failed" : "inProgress";
    const item = { receiverThreadId: `step:${step.stepId}`, agentNickname: step.title, ...(step.model ? { model: step.model } : {}) };
    // Started and completed are separate activities, as the controller's item events were: the
    // store keeps the richer of two activities with one id, which would keep a stale "started".
    out.push({
      id: `run:${run.runId}:step:${step.stepId}:item` as never, tone: "tool", kind: "tool.started" as never,
      summary: `${step.title} started` as never,
      payload: { itemType: "collab_agent_tool_call", status: "inProgress", title: step.title, data: { item } } as never,
      turnId: turnId as never, sequence: base + n++, createdAt: at,
    });
    if (settled) {
      out.push({
        id: `run:${run.runId}:step:${step.stepId}:item:done` as never, tone: "tool", kind: "tool.completed" as never,
        summary: step.title as never,
        payload: { itemType: "collab_agent_tool_call", status: itemStatus, title: step.title, data: { item: { ...item, status: step.status === "done" ? "completed" : step.status } } } as never,
        turnId: turnId as never, sequence: base + n++, createdAt: step.endedAt ?? at,
      });
    }
    out.push({
      id: `run:${run.runId}:step:${step.stepId}:task` as never, tone: "info", kind: "task.started" as never, summary: "Task started" as never,
      payload: { taskId: `${workflowTaskId}:${step.stepId}`, workflowTaskId, toolUseId: `step:${step.stepId}`, detail: step.title } as never,
      turnId: turnId as never, sequence: base + n++, createdAt: at,
    });
    if (settled) {
      const status = step.status === "done" ? "completed" : step.status === "stopped" ? "stopped" : "failed";
      out.push({
        id: `run:${run.runId}:step:${step.stepId}:done` as never, tone: (status === "failed" ? "error" : "info") as never, kind: "task.completed" as never,
        summary: (status === "failed" ? "Task failed" : status === "stopped" ? "Task stopped" : "Task completed") as never,
        payload: { taskId: `${workflowTaskId}:${step.stepId}`, status } as never,
        turnId: turnId as never, sequence: base + n++, createdAt: step.endedAt ?? at,
      });
    }
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "stopped") {
    const status = run.status === "succeeded" ? "completed" : run.status === "stopped" ? "stopped" : "failed";
    out.push({
      id: `run:${run.runId}:task:done` as never, tone: (status === "failed" ? "error" : "info") as never, kind: "task.completed" as never,
      summary: (status === "failed" ? "Task failed" : status === "stopped" ? "Task stopped" : "Task completed") as never,
      payload: { taskId: workflowTaskId, status } as never,
      turnId: turnId as never, sequence: base + n++, createdAt: run.endedAt ?? run.startedAt,
    });
  }
  void runThreadId;
  return out;
}

// --------------------------------------------------------------------- shell rows

function threadBase(info: Pick<ThreadInfo, "threadId" | "companyId" | "title" | "kind" | "parentThreadId" | "stepId" | "createdAt" | "updatedAt" | "archivedAt" | "pinned" | "model">, row?: ThreadRow) {
  const step = info.kind === "step";
  return {
    id: info.threadId,
    projectId: info.companyId,
    title: info.title || "New thread",
    modelSelection: modelSelectionOf(info.model ?? row?.model),
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: info.pinned === true,
    parentThreadId: info.parentThreadId ?? null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: step ? `step:${info.stepId ?? info.threadId}` : null,
    subagentNickname: step ? info.title : null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    archivedAt: info.archivedAt ?? null,
    settledAt: null,
    handoff: null,
  };
}

export function deriveShellThread(row: ThreadRow, companyId: string): OrchestrationThreadShell {
  const info = { threadId: row.threadId, companyId, title: row.title, kind: row.kind, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.parentThreadId ? { parentThreadId: row.parentThreadId } : {}), ...(row.stepId ? { stepId: row.stepId } : {}), ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}), ...(row.pinned ? { pinned: true } : {}), ...(row.model ? { model: row.model } : {}) };
  const latestTurn = row.latestTurn
    ? { turnId: row.latestTurn.turnId, state: row.latestTurn.state, requestedAt: row.latestTurn.requestedAt, startedAt: row.latestTurn.requestedAt, completedAt: row.latestTurn.completedAt ?? null, assistantMessageId: null }
    : null;
  const feedVisible = (row.kind === "chat" || row.kind === "note") && row.feed && !row.archivedAt;
  return {
    ...threadBase(info, row),
    latestTurn,
    latestUserMessageAt: row.latestUserMessageAt ?? null,
    feedSummary: feedVisible
      ? { firstMessageId: row.feed!.firstMessageId, firstMessageText: row.feed!.firstMessageText, author: row.feed!.author, firstMessageAt: row.feed!.firstMessageAt, replyCount: row.feed!.replyCount, latestReplyAt: row.feed!.latestReplyAt }
      : null,
    session: {
      threadId: row.threadId,
      status: row.status === "running" ? "running" : row.status === "error" ? "error" : "ready",
      providerName: "pi",
      runtimeMode: "full-access",
      activeTurnId: row.status === "running" ? (row.latestTurn?.turnId ?? null) : null,
      lastError: row.status === "error" ? (row.lastError ?? "The last answer failed.") : null,
      updatedAt: row.updatedAt,
    },
  } as unknown as OrchestrationThreadShell;
}

export function deriveProject(project: { companyId: string; slug: string; name: string; repository?: { origin: string; owner: string; repository: string; ref: string } }): OrchestrationProjectShell {
  return {
    id: project.companyId,
    kind: "project",
    title: project.name,
    workspaceRoot: `/workspace/repository/companies/${project.slug}`,
    repositoryBinding: project.repository ? { kind: "git-subdirectory", ...project.repository, path: `companies/${project.slug}` } : null,
    externalKey: `glasswing-company:${project.companyId}`,
    defaultModelSelection: modelSelectionOf(undefined),
    scripts: [],
    isPinned: false,
    spaceId: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  } as unknown as OrchestrationProjectShell;
}

/** A thread's details from its row, for a thread whose transcript is not leased (none yet). */
export function infoFromRow(row: ThreadRow, companyId: string, slug: string): ThreadInfo {
  return {
    threadId: row.threadId, companyId, slug, kind: row.kind, title: row.title,
    ...(row.parentThreadId ? { parentThreadId: row.parentThreadId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.stepId ? { stepId: row.stepId } : {}),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
    ...(row.model ? { model: row.model } : {}),
    marks: [],
  };
}
