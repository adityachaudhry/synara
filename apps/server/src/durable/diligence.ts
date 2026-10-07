/**
 * Durable diligence runs (contract: glasswing-ai-2 docs/superpowers/specs/2026-10-07-durable-diligence-contract.md).
 *
 * Glasswing sends a plan: steps with dependencies, prompts, outputs and gates. Each step is a
 * Pi Durable conversation working in one company sandbox at /workspace/run. Run state lives in
 * the Harness, so a controller restart continues every unfinished step from its checkpoint;
 * finished steps stay finished. Step outputs are kept in the Harness, so a lost sandbox is
 * rebuilt from the company revision plus those outputs.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AgentEvent,
  type ConversationId,
  type EntryRecord,
  type Extension,
  type Conversation,
  type JsonObject,
  defineDoc,
  defineDocFamily,
  UsageDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import { ThreadId, type ChatAttachment, type ProjectRepositoryBinding } from "@synara/contracts";

import { artifactApiClient } from "../providerWorker/artifactPublisher.ts";
import { resumingDurableThreads } from "../providerWorker/headlessSessions.ts";
import type { ProviderWorkerRuntimeBinding } from "../providerWorker/runtimeBinding";
import type { DurablePiEngine, DurableThreadTarget } from "./DurablePiEngine.ts";
import { shellQuote } from "./sandboxEnv.ts";

const ctx = BACKGROUND_CONTEXT;
const RUN_ROOT = "/workspace/run";
const AGENT_UID = 10001;
const CAPTURE_INTERVAL_MS = 60_000;

export interface DiligenceStep {
  readonly id: string;
  readonly model: string;
  readonly thinking?: string;
  readonly after: readonly string[];
  readonly release?: ReadonlyArray<{ readonly step: string; readonly file: string }>;
  readonly prompt: string;
  readonly outputs: readonly string[];
  readonly gate?: { readonly sectionId: string; readonly file: string };
  /** Shown in the run thread; Glasswing names steps and phases (defaults below). */
  readonly label?: string;
  readonly phase?: string;
}

export interface DiligenceRequest {
  readonly runId: string;
  readonly mode: string;
  readonly company: { readonly id: string; readonly slug: string; readonly name: string };
  readonly repository: ProjectRepositoryBinding;
  /** Where the published report will appear (Glasswing web). */
  readonly reportUrl?: string;
  readonly plan: {
    readonly recipeVersion: string;
    readonly instructions: string;
    readonly files: Readonly<Record<string, string>>;
    readonly steps: readonly DiligenceStep[];
    readonly maxConcurrency?: number;
    readonly repair: { readonly model: string; readonly thinking?: string; readonly prompt: string; readonly maxFindings?: number };
    readonly gateCommand: string;
  };
}

type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
type StepRecord = {
  status: StepStatus;
  conversationId?: number;
  phase?: "work" | "gate" | "repair";
  startedAt?: string;
  finishedAt?: string;
  costUsd?: number;
  turns?: number;
  gate?: { findings: string[]; generative: string[] };
  error?: string;
  /** The step's agent was announced in the run thread. */
  shown?: boolean;
};
type RunState = {
  status: "running" | "succeeded" | "failed" | "canceled";
  steps: Record<string, StepRecord>;
  outputs: Record<string, string>;
  sandbox?: ProviderWorkerRuntimeBinding;
  sandboxGeneration: number;
  sourceCommit?: string;
  createdAt: string;
  completedAt?: string;
  delivered?: boolean;
  cancelRequested?: boolean;
  /** The Synara thread that shows this run, and its run-long turn. */
  threadId?: string;
  runTurnId?: string;
};

// Stored as plain JSON; typed through the accessors below.
const PlanDoc = defineDocFamily<JsonObject, null>({
  kind: "synara.diligence-plan", version: 1, family: true, scope: "session", initial: () => ({}),
});
const StateDoc = defineDocFamily<JsonObject, null>({
  kind: "synara.diligence-state", version: 1, family: true, scope: "session",
  initial: () => ({ status: "running", steps: {}, outputs: {}, sandboxGeneration: 0, createdAt: new Date().toISOString() }),
});
const ActiveRuns = defineDoc<{ runs: Record<string, true> }>({
  kind: "synara.diligence-active", version: 1, scope: "session", initial: () => ({ runs: {} }),
});
/** Run thread → run, for messages, stops and chats on finished runs. */
const RunThreads = defineDoc<{ threads: Record<string, string> }>({
  kind: "synara.diligence-threads", version: 1, scope: "session", initial: () => ({ threads: {} }),
});

const STEP_LABELS: Record<string, string> = {
  "diligence-intake": "Intake",
  "company-snapshot": "Company snapshot",
  "market-pain": "Market pain",
  "team-diligence": "Team",
  "product-value": "Product & value",
  "technical-diligence": "Technical",
  "market-sizing": "Market sizing",
  "competition-positioning": "Competition",
  "exit-fund-return": "Exit & fund return",
  "executive-investment-read": "Executive summary",
  "memo-compose": "Investment memo",
  "quick-tearsheet": "Quick read",
  "feedback-review": "Team feedback check",
};
const PHASES = ["Getting oriented", "Working the diligence questions", "Writing the investment read"] as const;
const stepLabel = (step: DiligenceStep) =>
  step.label ?? STEP_LABELS[step.id] ?? step.id.replace(/-/gu, " ").replace(/^./u, (c) => c.toUpperCase());
const stepPhase = (step: DiligenceStep) =>
  step.phase ?? (["diligence-intake", "company-snapshot"].includes(step.id) ? PHASES[0]
    : ["executive-investment-read", "memo-compose", "quick-tearsheet", "feedback-review"].includes(step.id) ? PHASES[2] : PHASES[1]);
const MODE_TITLES: Record<string, string> = { full: "full diligence", quick: "a quick read", memo: "the investment memo" };
/** The run thread's ID for a run; the child thread of a step is `subagent:<this>:step:<stepId>`. */
export const diligenceThreadId = (runId: string) => `diligence-run-${runId}`;
const childKey = (threadId: string, stepId: string) => `subagent:${threadId}:step:${stepId}`;
const FOLLOW_UP_RELEASE_MS = 30 * 60_000;

export interface DiligenceSandboxes {
  /** Claims a fresh sandbox with the company checkout. */
  claim(key: string, generation: string, repository: ProjectRepositoryBinding): Promise<ProviderWorkerRuntimeBinding>;
  unavailable(binding: ProviderWorkerRuntimeBinding): Promise<boolean>;
  runner(binding: ProviderWorkerRuntimeBinding): DurableThreadTarget["runner"];
  release(binding: ProviderWorkerRuntimeBinding): Promise<void>;
}

const modelRef = (model: string) => {
  const [provider, ...rest] = model.split("/");
  return rest.length ? { provider: provider!, modelId: rest.join("/") } : { provider: "anthropic", modelId: model };
};

const log = (event: string, detail: Record<string, unknown>) => console.info(`[diligence] ${JSON.stringify({ event, ...detail })}`);

export interface DiligenceThreads {
  /** Opens the run thread's own conversation, so analysts can also chat in it. */
  startThreadSession(threadId: string, repository: ProjectRepositoryBinding): Promise<void>;
}

export class DiligenceRunner {
  readonly #engine: DurablePiEngine;
  #threads: DiligenceThreads | undefined;
  readonly #releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #sandboxes: DiligenceSandboxes;
  readonly #extensions: readonly Extension[];
  readonly #loops = new Map<string, Promise<void>>();
  readonly #wakers = new Map<string, () => void>();
  readonly #targets = new Map<string, Promise<DurableThreadTarget>>();
  readonly #captured = new Map<string, Map<string, string>>();
  readonly #pendingEvents = new Map<string, Array<{ kind: string; data: Record<string, unknown> }>>();
  #flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(engine: DurablePiEngine, sandboxes: DiligenceSandboxes) {
    this.#engine = engine;
    this.#sandboxes = sandboxes;
    this.#extensions = [engine.toolsExtension, engine.researchExtension];
    this.#flushTimer = setInterval(() => void this.#flushEvents(), 2000);
    this.#flushTimer.unref();
  }

  get #harness() {
    return this.#engine.harness;
  }

  setThreads(threads: DiligenceThreads) {
    this.#threads = threads;
  }

  /** Continues every run that was active when the controller stopped. */
  async resume() {
    const active = (await this.#harness.snapshot(ActiveRuns, ctx))?.runs ?? {};
    for (const runId of Object.keys(active)) {
      const state = await this.#state(runId);
      if (state?.threadId && state.runTurnId && this.#engine.hasSession(state.threadId)) {
        // The run's turn is still open in Synara; keep it open and keep startup from settling it.
        this.#engine.beginExternalTurn(state.threadId, state.runTurnId, false);
        resumingDurableThreads.add(state.threadId);
      }
      log("run.resumed", { runId });
      this.#start(runId);
    }
    // Finished runs keep answering follow-ups in their step threads.
    const threads = (await this.#harness.snapshot(RunThreads, ctx))?.threads ?? {};
    for (const runId of new Set(Object.values(threads))) {
      const request = await this.#plan(runId);
      const state = await this.#state(runId);
      if (!request || !state) continue;
      for (const record of Object.values(state.steps)) {
        if (record.conversationId !== undefined) this.#engine.registerConversationTarget(record.conversationId as ConversationId, RUN_ROOT, () => this.#target(request));
      }
    }
  }

  async accept(request: DiligenceRequest, options: { readonly threadId?: string } = {}): Promise<{ runId: string; accepted: true; threadId?: string }> {
    if (!(await this.#plan(request.runId))) {
      await this.#harness.commit(async (tx) => {
        (await tx.doc(PlanDoc, request.runId, null)).request = JSON.parse(JSON.stringify(request)) as JsonObject;
        const state = (await tx.doc(StateDoc, request.runId, null)) as unknown as RunState;
        for (const step of request.plan.steps) state.steps[step.id] = { status: "pending" };
        (await tx.doc(ActiveRuns)).runs[request.runId] = true;
      }, ctx);
      log("run.accepted", { runId: request.runId, steps: request.plan.steps.length, mode: request.mode });
      this.#event(request.runId, "status", { state: "running-durable" });
    }
    if (options.threadId) await this.#openThread(request, options.threadId).catch((cause) =>
      log("thread.open-failed", { runId: request.runId, message: String(cause) }));
    this.#start(request.runId);
    const threadId = (await this.#state(request.runId))?.threadId;
    return { runId: request.runId, accepted: true, ...(threadId ? { threadId } : {}) };
  }

  // ------------------------------------------------------------ run thread

  /** Starts the run thread: its run-long turn, an opening note and the workflow card. */
  async #openThread(request: DiligenceRequest, threadId: string) {
    const runId = request.runId;
    const state = await this.#state(runId);
    if (!state || state.threadId || state.status !== "running" || !this.#threads) return;
    if (!this.#engine.hasSession(threadId)) await this.#threads.startThreadSession(threadId, request.repository);
    const runTurnId = `diligence-run:${runId}`;
    await this.#harness.commit(async (tx) => {
      const draft = (await tx.doc(StateDoc, runId, null)) as unknown as RunState;
      draft.threadId = threadId;
      draft.runTurnId = runTurnId;
      (await tx.doc(RunThreads)).threads[threadId] = runId;
    }, ctx);
    this.#engine.beginExternalTurn(threadId, runTurnId, true);
    this.#engine.emitExternalMessage(threadId, `${runId}-open`,
      `Running ${MODE_TITLES[request.mode] ?? request.mode} on ${request.company.name}. ` +
      (request.plan.steps.length > 1
        ? "Each step works in its own thread below. Open one to watch it work, or message it to steer: point it at a source, ask it to check something, or question a claim. "
        : "Open the step below to watch it work, or message it to steer. ") +
      "The report updates when the run finishes.");
    const plans = Object.fromEntries(request.plan.steps.map((step) => [stepLabel(step), { phase: stepPhase(step), model: step.model.split("/").pop() }]));
    this.#engine.emitExternal(threadId, {
      type: "task.started",
      payload: {
        taskId: `diligence-${runId}`,
        taskType: "durable_workflow",
        description: `Diligence · ${request.company.name}`,
        workflowName: "Diligence",
        workflowPhases: PHASES.filter((phase) => request.plan.steps.some((step) => stepPhase(step) === phase)).map((title) => ({ title })),
        workflowAgentPlans: plans,
      },
    });
  }

  #threadOf(state: RunState | undefined) {
    return state?.threadId && this.#engine.hasSession(state.threadId) ? state.threadId : undefined;
  }

  /** Shows a starting step: an agent row in the workflow card and its own child thread. */
  async #showStep(request: DiligenceRequest, step: DiligenceStep, conversationId: ConversationId) {
    const state = await this.#state(request.runId);
    const threadId = this.#threadOf(state);
    if (!threadId) return undefined;
    const key = childKey(threadId, step.id);
    if (!state!.steps[step.id]?.shown) {
      const label = stepLabel(step);
      this.#engine.emitExternal(threadId, {
        type: "item.started",
        itemId: `diligence-agent-${request.runId}-${step.id}`,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: label,
          data: { item: { receiverThreadId: `step:${step.id}`, agentNickname: label, model: step.model.split("/").pop() } },
        },
      });
      this.#engine.emitExternal(threadId, {
        type: "task.started",
        payload: { taskId: `diligence-${request.runId}:${step.id}`, description: label, workflowTaskId: `diligence-${request.runId}`, toolUseId: `step:${step.id}` },
      });
      await this.#update(request.runId, (draft) => { draft.steps[step.id]!.shown = true; });
    }
    await this.#engine.attachChild({ key, conversationId, cwd: RUN_ROOT, route: { parentThreadId: threadId, providerThreadId: `step:${step.id}` }, model: step.model });
    return key;
  }

  async #stepSettled(runId: string, step: DiligenceStep, status: "completed" | "failed") {
    const threadId = this.#threadOf(await this.#state(runId));
    if (!threadId) return;
    this.#engine.emitExternal(threadId, {
      type: "task.completed",
      payload: { taskId: `diligence-${runId}:${step.id}`, status },
    });
    this.#engine.emitExternal(threadId, {
      type: "item.completed",
      itemId: `diligence-agent-${runId}-${step.id}`,
      payload: {
        itemType: "collab_agent_tool_call",
        status: status === "completed" ? "completed" : "failed",
        title: stepLabel(step),
        data: { item: { receiverThreadId: `step:${step.id}`, agentNickname: stepLabel(step), status } },
      },
    });
  }

  async #closeThread(request: DiligenceRequest, state: RunState) {
    const threadId = this.#threadOf(state);
    if (!threadId || !this.#engine.hasExternalTurn(threadId)) return;
    const steps = request.plan.steps;
    const failed = steps.filter((step) => state.steps[step.id]?.status === "failed");
    const skipped = steps.filter((step) => state.steps[step.id]?.status === "skipped");
    const report = request.reportUrl ? ` [Open the report](${request.reportUrl}).` : "";
    const text = state.status === "succeeded"
      ? `Diligence finished: all ${steps.length} steps completed. Glasswing is publishing the report now.${report} Each step thread keeps its agent's research, so you can ask any of them a follow-up.`
      : state.status === "canceled"
        ? "Diligence was stopped. Steps that finished keep their threads and research."
        : `Diligence finished with problems. ${failed.map((step) => `${stepLabel(step)} failed: ${(state.steps[step.id]?.error ?? "unknown error").slice(0, 200)}`).join(" ")}` +
          (skipped.length ? ` Skipped because an earlier step failed: ${skipped.map(stepLabel).join(", ")}.` : "") +
          " Steps that finished keep their threads; you can message them.";
    this.#engine.emitExternalMessage(threadId, `${request.runId}-close`, text);
    this.#engine.emitExternal(threadId, {
      type: "task.completed",
      payload: { taskId: `diligence-${request.runId}`, status: state.status === "succeeded" ? "completed" : state.status === "canceled" ? "stopped" : "failed" },
    });
    this.#engine.endExternalTurn(threadId, state.status === "canceled" ? "interrupted" : state.status === "failed" ? "failed" : "completed",
      state.status === "failed" ? "Some diligence steps failed." : undefined);
  }

  async #runFor(threadId: string) {
    return (await this.#harness.snapshot(RunThreads, ctx))?.threads[threadId];
  }

  /** The company of a run thread, for the thread's own chat sandbox. */
  async repositoryForThread(threadId: string) {
    const runId = await this.#runFor(threadId);
    return runId ? (await this.#plan(runId))?.repository : undefined;
  }

  /** Stop on the run thread stops the run. */
  async cancelByThread(threadId: string) {
    const runId = await this.#runFor(threadId);
    if (!runId) return false;
    const state = await this.#state(runId);
    if (state?.status !== "running") return false;
    await this.cancel(runId);
    return true;
  }

  /** An analyst's message to a step thread: steers a running step, or starts a follow-up turn. */
  async steer(threadId: string, providerThreadId: string, input: { readonly input: string; readonly attachments?: ReadonlyArray<ChatAttachment> | undefined }) {
    const runId = await this.#runFor(threadId);
    const stepId = providerThreadId.startsWith("step:") ? providerThreadId.slice("step:".length) : undefined;
    const request = runId ? await this.#plan(runId) : undefined;
    const state = runId ? await this.#state(runId) : undefined;
    const record = stepId ? state?.steps[stepId] : undefined;
    if (!request || !state || !stepId || !record) throw new Error("This diligence step is not known to the controller.");
    if (record.conversationId === undefined) throw new Error("This step has not started yet. Message it once it is running.");
    const key = childKey(threadId, stepId);
    if (!this.#engine.isDurableThread(key)) {
      const step = request.plan.steps.find((entry) => entry.id === stepId)!;
      await this.#engine.attachChild({ key, conversationId: record.conversationId as ConversationId, cwd: RUN_ROOT, route: { parentThreadId: threadId, providerThreadId }, model: step.model });
    }
    this.#engine.registerConversationTarget(record.conversationId as ConversationId, RUN_ROOT, () => this.#target(request));
    if (state.status !== "running") this.#releaseLater(runId!);
    await this.#engine.steerTurn({
      threadId: ThreadId.makeUnsafe(key),
      input: input.input,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      attachmentsDir: "/workspace/.synara-provider-worker/state/attachments",
    });
  }

  /** A finished run's sandbox is reclaimed for follow-ups; release it after a quiet half hour. */
  #releaseLater(runId: string) {
    clearTimeout(this.#releaseTimers.get(runId));
    const timer = setTimeout(() => {
      this.#releaseTimers.delete(runId);
      void this.#state(runId).then(async (state) => {
        if (state?.status === "running" || !state?.sandbox) return;
        await this.#sandboxes.release(state.sandbox).catch(() => undefined);
        this.#targets.delete(runId);
      });
    }, FOLLOW_UP_RELEASE_MS);
    timer.unref();
    this.#releaseTimers.set(runId, timer);
  }

  async cancel(runId: string) {
    await this.#update(runId, (state) => { state.cancelRequested = true; });
    const state = await this.#state(runId);
    for (const step of Object.values(state?.steps ?? {})) {
      if (step.status === "running" && step.conversationId !== undefined) {
        await (await this.#harness.conversation(step.conversationId as ConversationId, ctx))?.abort(ctx);
      }
    }
    this.#wakers.get(runId)?.();
  }

  async status(runId: string) {
    const state = await this.#state(runId);
    if (!state) return undefined;
    return { runId, state: state.status, steps: Object.entries(state.steps).map(([id, step]) => ({ id, state: step.status })) };
  }

  // ------------------------------------------------------------------ core

  async #state(runId: string): Promise<RunState | undefined> {
    return (await this.#harness.snapshot(StateDoc, runId, ctx)) as unknown as RunState | undefined;
  }

  async #plan(runId: string): Promise<DiligenceRequest | undefined> {
    const doc = await this.#harness.snapshot(PlanDoc, runId, ctx);
    return (doc?.request as unknown as DiligenceRequest | undefined) ?? undefined;
  }

  #update(runId: string, change: (state: RunState) => void) {
    return this.#harness.commit(async (tx) => change((await tx.doc(StateDoc, runId, null)) as unknown as RunState), ctx);
  }

  #start(runId: string) {
    if (this.#loops.has(runId)) return;
    const loop = this.#run(runId).catch(async (cause) => {
      // Steps keep running; the scheduler restarts after a pause.
      log("run.loop-failed", { runId, message: String(cause) });
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return "retry" as const;
    }).then((outcome) => {
      this.#loops.delete(runId);
      if (outcome === "retry") this.#start(runId);
    });
    this.#loops.set(runId, loop);
  }

  async #run(runId: string) {
    const request = await this.#plan(runId);
    if (!request) return;
    const steps = new Map(request.plan.steps.map((step) => [step.id, step]));
    const limit = Math.max(1, request.plan.maxConcurrency ?? 6);
    const inFlight = new Map<string, Promise<void>>();
    let lastCapture = Date.now();
    for (;;) {
      try {
        if (Date.now() - lastCapture > CAPTURE_INTERVAL_MS && inFlight.size > 0) {
          lastCapture = Date.now();
          await this.#captureOutbox(request);
        }
      } catch (cause) {
        log("run.capture-failed", { runId, message: String(cause).slice(0, 300) });
      }
      const state = await this.#state(runId);
      if (!state) return;
      if (state.status !== "running") break;
      // Running steps (including after a restart) are re-attached by their request IDs.
      for (const [id, record] of Object.entries(state.steps)) {
        if (record.status === "running" && !inFlight.has(id) && !state.cancelRequested) {
          inFlight.set(id, this.#runStep(request, steps.get(id)!).finally(() => inFlight.delete(id)));
        }
      }
      if (state.cancelRequested) {
        await Promise.allSettled(inFlight.values());
        await this.#finish(request, "canceled");
        return;
      }
      const ready: string[] = [];
      for (const [id, record] of Object.entries(state.steps)) {
        if (record.status !== "pending") continue;
        const step = steps.get(id)!;
        const blocked = step.after.some((dep) => ["failed", "skipped"].includes(state.steps[dep]?.status ?? ""));
        if (blocked) {
          await this.#update(runId, (draft) => { draft.steps[id]!.status = "skipped"; draft.steps[id]!.error = "upstream step failed"; });
          this.#event(runId, "step", { skill: id, state: "skipped" });
          continue;
        }
        let satisfied = true;
        for (const dep of step.after) {
          if (state.steps[dep]?.status === "done") continue;
          const releases = (step.release ?? []).filter((release) => release.step === dep);
          if (state.steps[dep]?.status === "running" && releases.length > 0 &&
            (await this.#filesExist(runId, request, releases.map((release) => release.file)).catch(() => false))) {
            continue;
          }
          satisfied = false;
          break;
        }
        if (satisfied) ready.push(id);
      }
      for (const id of ready) {
        if (inFlight.size >= limit) break;
        await this.#update(runId, (draft) => {
          draft.steps[id]!.status = "running";
          draft.steps[id]!.phase = "work";
          draft.steps[id]!.startedAt = new Date().toISOString();
        });
        this.#event(runId, "step", { skill: id, state: "running" });
        inFlight.set(id, this.#runStep(request, steps.get(id)!).finally(() => inFlight.delete(id)));
      }
      const after = await this.#state(runId);
      const open = Object.values(after?.steps ?? {}).some((record) => record.status === "pending" || record.status === "running");
      if (!open && inFlight.size === 0) {
        const failed = Object.values(after!.steps).some((record) => record.status === "failed" || record.status === "skipped");
        await this.#finish(request, failed ? "failed" : "succeeded");
        return;
      }
      // Wake on a step change, or poll release files.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        this.#wakers.set(runId, () => { clearTimeout(timer); resolve(); });
        Promise.race(inFlight.values()).then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
      });
    }
    const final = await this.#state(runId);
    if (final && final.status !== "running" && !final.delivered) await this.#deliver(request, final);
  }

  async #runStep(request: DiligenceRequest, step: DiligenceStep) {
    const runId = request.runId;
    try {
      const conversation = await this.#conversationFor(request, step);
      const key = await this.#showStep(request, step, conversation.id).catch((cause) => {
        log("thread.step-failed", { runId, step: step.id, message: String(cause) });
        return undefined;
      });
      const submit = (content: string, requestId: string) => this.#submit(conversation, content, requestId, step.id, runId, key);
      await submit(step.prompt, `diligence:${runId}:${step.id}`);
      let missing = await this.#missingOutputs(runId, request, step.outputs);
      if (missing.length) {
        // A replaced sandbox can lose files written since the last capture; the conversation still has the work.
        log("step.recovering", { runId, step: step.id, missing });
        await submit(`These required files are missing from the workspace: ${missing.map((file) => `\`${file}\``).join(", ")}. The workspace may have been replaced. Recreate each file now from your work in this conversation, then reply only: recovered.`,
          `diligence:${runId}:${step.id}:recover`);
        missing = await this.#missingOutputs(runId, request, step.outputs);
      }
      if (missing.length) throw new Error(`Step finished without its outputs: ${missing.join(", ")}`);
      let gate: { findings: string[]; generative: string[] } | undefined;
      if (step.gate) {
        await this.#update(runId, (draft) => { draft.steps[step.id]!.phase = "gate"; });
        gate = await this.#runGate(runId, request, step.gate);
        const repairable = gate.findings.filter((finding) => !gate!.generative.includes(finding)).slice(0, request.plan.repair.maxFindings ?? 12);
        if (repairable.length > 0) {
          await this.#update(runId, (draft) => { draft.steps[step.id]!.phase = "repair"; });
          await conversation.configure({
            model: modelRef(request.plan.repair.model),
            ...(request.plan.repair.thinking ? { thinkingLevel: request.plan.repair.thinking as never } : {}),
          }, ctx);
          const prompt = request.plan.repair.prompt
            .replaceAll("{findings}", repairable.map((finding) => `- ${finding}`).join("\n"))
            .replaceAll("{file}", step.gate.file)
            .replaceAll("{sectionId}", step.gate.sectionId);
          await submit(prompt, `diligence:${runId}:${step.id}:repair`);
          gate = await this.#runGate(runId, request, step.gate);
        }
      }
      // Everything the step left in the outbox (handoffs, project memory, review results), not only declared outputs.
      const outputs = await this.#readFiles(runId, request, [...step.outputs, ...(await this.#outboxFiles(request))]);
      const usage = await this.#usage(conversation.id);
      await this.#update(runId, (draft) => {
        const record = draft.steps[step.id]!;
        record.status = "done";
        record.finishedAt = new Date().toISOString();
        record.costUsd = usage.costUsd;
        record.turns = usage.turns;
        if (gate) record.gate = gate;
        Object.assign(draft.outputs, outputs);
      });
      this.#event(runId, "step", { skill: step.id, state: "done", turns: usage.turns, cost_usd: usage.costUsd, duration_seconds: await this.#duration(runId, step.id) });
      log("step.done", { runId, step: step.id, costUsd: usage.costUsd, turns: usage.turns, gateFindings: gate?.findings.length ?? 0 });
      await this.#stepSettled(runId, step, "completed");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await this.#update(runId, (draft) => {
        draft.steps[step.id]!.status = "failed";
        draft.steps[step.id]!.error = message.slice(0, 2000);
        draft.steps[step.id]!.finishedAt = new Date().toISOString();
      });
      this.#event(runId, "step", { skill: step.id, state: "failed" });
      this.#event(runId, "log", { line: `${step.id} failed: ${message.slice(0, 300)}` });
      log("step.failed", { runId, step: step.id, message: message.slice(0, 500) });
      await this.#stepSettled(runId, step, "failed").catch(() => undefined);
    } finally {
      this.#wakers.get(runId)?.();
    }
  }

  async #conversationFor(request: DiligenceRequest, step: DiligenceStep) {
    const runId = request.runId;
    const state = await this.#state(runId);
    const existingId = state?.steps[step.id]?.conversationId;
    let conversation = existingId !== undefined ? await this.#harness.conversation(existingId as ConversationId, ctx) : undefined;
    if (!conversation) {
      conversation = await this.#harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: {
          model: modelRef(step.model),
          ...(step.thinking ? { thinkingLevel: step.thinking as never } : {}),
          cwd: RUN_ROOT,
          instructions: request.plan.instructions,
          extensions: [...this.#extensions],
        },
      }, ctx);
      const id = conversation.id;
      await this.#update(runId, (draft) => { draft.steps[step.id]!.conversationId = id as number; });
    }
    this.#engine.registerConversationTarget(conversation.id, RUN_ROOT, () => this.#target(request));
    return conversation;
  }

  async #submit(conversation: Conversation, content: string, requestId: string, stepId: string, runId: string, key?: string) {
    const stream = await watchEvents(this.#harness, conversation.id, ctx);
    stream.start(async (events) => {
      for (const event of events) this.#activity(runId, stepId, event);
    });
    try {
      // Shown in the step's thread when the run has one.
      const submission = key
        ? await this.#engine.runChildTurn(key, content, requestId)
        : await conversation.submit({ type: "input", content, requestId }, ctx);
      const settled = await submission.wait(ctx);
      if (settled.status !== "done") throw new Error(`Step ${stepId} ended without an answer (${settled.reason}).`);
    } finally {
      await stream.stop();
    }
  }

  #activity(runId: string, stepId: string, event: AgentEvent) {
    if (event.type === "tool_execution_start") {
      const detail = JSON.stringify(event.args).slice(0, 200);
      this.#event(runId, "activity", { type: "tool", skill: stepId, tool: event.toolName, detail });
    } else if (event.type === "message_end") {
      const message = event.entry.model?.[0] as { role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
      const text = message?.role === "assistant" ? message.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ").trim() : "";
      if (text && text.length >= 12) this.#event(runId, "activity", { type: "text", skill: stepId, detail: text.slice(0, 240) });
    }
  }

  async #usage(conversationId: ConversationId) {
    const usage = (await this.#harness.snapshot(UsageDoc, conversationId, ctx)) as { models?: Record<string, { cost?: { total?: number } }> } | undefined;
    const costUsd = Object.values(usage?.models ?? {}).reduce((total, model) => total + (model.cost?.total ?? 0), 0);
    const conversation = await this.#harness.conversation(conversationId, ctx);
    let turns = 0;
    let cursor: unknown;
    for (let page = 0; page < 50 && conversation; page++) {
      const result = await conversation.entries({}, 200, cursor as never, ctx);
      turns += result.items.filter((entry: EntryRecord) => entry.kind === "pi.assistant").length;
      cursor = (result as { next?: unknown }).next;
      if (!cursor) break;
    }
    return { costUsd: Math.round(costUsd * 10000) / 10000, turns };
  }

  async #duration(runId: string, stepId: string) {
    const record = (await this.#state(runId))?.steps[stepId];
    if (!record?.startedAt || !record.finishedAt) return undefined;
    return Math.round((Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000);
  }

  // --------------------------------------------------------------- sandbox

  /** The run's sandbox: claimed once, replaced if lost, rebuilt with the plan files and step outputs. */
  #target(request: DiligenceRequest): Promise<DurableThreadTarget> {
    const runId = request.runId;
    const cached = this.#targets.get(runId);
    const fresh = async () => {
      const state = await this.#state(runId);
      let binding = state?.sandbox;
      if (!binding || (await this.#sandboxes.unavailable(binding))) {
        const generation = (state?.sandboxGeneration ?? 0) + 1;
        binding = await this.#sandboxes.claim(`diligence-${runId}`, `diligence-${runId}-${generation}`, request.repository);
        await this.#prepare(request, binding, state?.outputs ?? {});
        const claimed = binding;
        await this.#update(runId, (draft) => {
          draft.sandbox = claimed as never;
          draft.sandboxGeneration = generation;
          if (!draft.sourceCommit && claimed.repositoryCheckout?.commit) draft.sourceCommit = claimed.repositoryCheckout.commit;
        });
        log("sandbox.ready", { runId, sandboxId: binding.workspace.runtimeId, generation, commit: binding.repositoryCheckout?.commit });
      }
      const ready = binding;
      return { threadId: `diligence-${runId}`, lifecycleGeneration: ready.fence.lifecycleGeneration, cwd: RUN_ROOT, homeDir: "/workspace", runner: this.#sandboxes.runner(ready), envId: ready.workspace.runtimeId };
    };
    const next = (cached ?? Promise.reject(new Error("no sandbox yet"))).then(async (target) => {
      const state = await this.#state(runId);
      return state?.sandbox && !(await this.#sandboxes.unavailable(state.sandbox)) ? target : fresh();
    }).catch(() => fresh());
    this.#targets.set(runId, next);
    return next;
  }

  async #prepare(request: DiligenceRequest, binding: ProviderWorkerRuntimeBinding, outputs: Record<string, string>) {
    const runner = this.#sandboxes.runner(binding);
    const company = `/workspace/repository/${request.repository.path}`;
    const setup = await runner.run([
      `mkdir -p ${RUN_ROOT}/inbox/companies ${RUN_ROOT}/outbox ${RUN_ROOT}/.observability ${RUN_ROOT}/.tmp`,
      `ln -sfn ${shellQuote(company)} ${shellQuote(`${RUN_ROOT}/inbox/companies/${request.company.slug}`)}`,
      // The inbox is immutable for the agent.
      `find ${shellQuote(company)} -xdev \\( -type f -o -type d \\) -exec chmod a-w {} + 2>/dev/null || true`,
    ].join(" && "), { timeoutSeconds: 120 });
    if (setup.exitCode !== 0) throw new Error(`Run directory setup failed: ${setup.output.slice(-400)}`);
    const files = { ...request.plan.files, ...outputs };
    const entries = Object.entries(files);
    for (let index = 0; index < entries.length; index += 6) {
      await Promise.all(entries.slice(index, index + 6).map(async ([relative, content]) => {
        if (relative.startsWith("/") || relative.split("/").includes("..")) throw new Error(`Invalid plan path: ${relative}`);
        const target = `${RUN_ROOT}/${relative}`;
        const dir = target.slice(0, target.lastIndexOf("/"));
        const made = await runner.run(`mkdir -p ${shellQuote(dir)}`, { timeoutSeconds: 30 });
        if (made.exitCode !== 0) throw new Error(`Could not create ${dir}`);
        await runner.upload(target, new TextEncoder().encode(content));
      }));
    }
    const owned = await runner.run(
      `chown -R ${AGENT_UID}:${AGENT_UID} ${RUN_ROOT}/outbox ${RUN_ROOT}/.observability ${RUN_ROOT}/.tmp ${RUN_ROOT}/.glasswing 2>/dev/null; chmod -R a+rX ${RUN_ROOT}; chown ${AGENT_UID}:${AGENT_UID} ${RUN_ROOT}`,
      { timeoutSeconds: 60 },
    );
    if (owned.exitCode !== 0) throw new Error(`Run directory ownership failed: ${owned.output.slice(-400)}`);
  }

  async #filesExist(runId: string, request: DiligenceRequest, files: readonly string[]) {
    const target = await this.#target(request);
    const result = await target.runner.run(files.map((file) => `test -s ${shellQuote(`${RUN_ROOT}/${file}`)}`).join(" && "), { timeoutSeconds: 20 });
    return result.exitCode === 0;
  }

  async #missingOutputs(runId: string, request: DiligenceRequest, files: readonly string[]) {
    const target = await this.#target(request);
    const missing: string[] = [];
    for (const file of files) {
      const result = await target.runner.run(`test -s ${shellQuote(`${RUN_ROOT}/${file}`)}`, { timeoutSeconds: 20 });
      if (result.exitCode !== 0) missing.push(file);
    }
    return missing;
  }

  /** Saves changed outbox files into the run state, so a replacement sandbox starts close to the lost one. */
  async #captureOutbox(request: DiligenceRequest) {
    const target = await this.#target(request);
    const listed = await target.runner.run(`cd ${RUN_ROOT} && find outbox -type f -size -4M -printf '%T@ %p\\n'`, { timeoutSeconds: 30 });
    if (listed.exitCode !== 0) return;
    const seen = this.#captured.get(request.runId) ?? new Map<string, string>();
    this.#captured.set(request.runId, seen);
    const changed = listed.output.split("\n").map((line) => line.trim()).map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]).filter(([mtime, file]) =>
      mtime && file?.startsWith("outbox/") && seen.get(file) !== mtime);
    if (!changed.length) return;
    const files = await this.#readFiles(request.runId, request, changed.map(([, file]) => file!));
    await this.#update(request.runId, (draft) => { Object.assign(draft.outputs, files); });
    for (const [mtime, file] of changed) if (file && file in files) seen.set(file, mtime!);
  }

  async #outboxFiles(request: DiligenceRequest) {
    const target = await this.#target(request);
    const listed = await target.runner.run(`cd ${RUN_ROOT} && find outbox -type f -size -4M`, { timeoutSeconds: 30 });
    return listed.exitCode === 0 ? listed.output.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("outbox/")) : [];
  }

  async #readFiles(runId: string, request: DiligenceRequest, files: readonly string[]) {
    const target = await this.#target(request);
    const read: Record<string, string> = {};
    for (const file of new Set(files)) {
      const result = await target.runner.run(`base64 -w0 ${shellQuote(`${RUN_ROOT}/${file}`)}`, { timeoutSeconds: 60 });
      if (result.exitCode === 0) read[file] = Buffer.from(result.output.trim(), "base64").toString("utf8");
    }
    return read;
  }

  async #runGate(runId: string, request: DiligenceRequest, gate: NonNullable<DiligenceStep["gate"]>) {
    const target = await this.#target(request);
    const command = request.plan.gateCommand
      .replaceAll("{file}", shellQuote(`${RUN_ROOT}/${gate.file}`))
      .replaceAll("{sectionId}", shellQuote(gate.sectionId));
    const result = await target.runner.run(`cd ${RUN_ROOT} && ${command}`, { timeoutSeconds: 120 });
    if (result.exitCode !== 0) throw new Error(`Gate failed to run: ${result.output.slice(-400)}`);
    const json = result.output.slice(result.output.indexOf("{"));
    const parsed = JSON.parse(json) as { findings?: string[]; generative_findings?: string[] };
    return { findings: parsed.findings ?? [], generative: parsed.generative_findings ?? [] };
  }

  // ---------------------------------------------------------------- finish

  async #finish(request: DiligenceRequest, status: RunState["status"]) {
    await this.#update(request.runId, (draft) => {
      draft.status = status;
      draft.completedAt = new Date().toISOString();
    });
    log("run.finished", { runId: request.runId, status });
    const state = await this.#state(request.runId);
    if (state) await this.#closeThread(request, state).catch((cause) => log("thread.close-failed", { runId: request.runId, message: String(cause) }));
    if (state) await this.#deliver(request, state);
  }

  async #deliver(request: DiligenceRequest, state: RunState) {
    const runId = request.runId;
    await this.#flushEvents();
    const steps = request.plan.steps.map((step) => {
      const record = state.steps[step.id] ?? { status: "pending" as const };
      const duration = record.startedAt && record.finishedAt ? (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000 : undefined;
      return { step, record, duration };
    });
    const pipeline = {
      engine: "pi-durable",
      recipe_version: request.plan.recipeVersion,
      steps: steps.map(({ step, record, duration }) => ({
        skill: step.id,
        status: record.status,
        cost_usd: record.costUsd ?? null,
        turns: record.turns ?? null,
        wall_seconds: duration ?? null,
        started_at: record.startedAt ?? null,
        finished_at: record.finishedAt ?? null,
        ...(record.gate ? { gate: record.gate } : {}),
        ...(record.error ? { error: record.error } : {}),
      })),
    };
    const body = {
      status: state.status,
      ...(state.status === "failed" ? { error: steps.filter(({ record }) => record.status === "failed").map(({ step, record }) => `${step.id}: ${record.error ?? "failed"}`).join("; ").slice(0, 4000) } : {}),
      costUsd: Math.round(steps.reduce((total, { record }) => total + (record.costUsd ?? 0), 0) * 10000) / 10000,
      turns: steps.reduce((total, { record }) => total + (record.turns ?? 0), 0),
      ...(state.sourceCommit ? { sourceCommit: state.sourceCommit } : {}),
      files: { ...state.outputs, ".observability/pipeline.json": JSON.stringify(pipeline, null, 2) },
      steps: steps.map(({ step, record, duration }) => ({
        id: step.id, state: record.status, costUsd: record.costUsd ?? 0, turns: record.turns ?? 0,
        durationSeconds: duration ?? 0, ...(record.gate ? { gate: record.gate } : {}),
      })),
    };
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        // Completion publishes to Git and S3 and can take minutes; a repeat gets 409 until it is done.
        await completeRun(runId, body);
        await this.#harness.commit(async (tx) => {
          ((await tx.doc(StateDoc, runId, null)) as unknown as RunState).delivered = true;
          delete (await tx.doc(ActiveRuns)).runs[runId];
        }, ctx);
        log("run.delivered", { runId, status: state.status, files: Object.keys(body.files).length, costUsd: body.costUsd });
        break;
      } catch (cause) {
        log("run.delivery-failed", { runId, attempt, message: String(cause) });
        if (String(cause).includes("HTTP 404")) {
          // Glasswing does not know this run; retrying (now or after a restart) cannot help.
          await this.#harness.commit(async (tx) => { delete (await tx.doc(ActiveRuns)).runs[runId]; }, ctx);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
      }
    }
    if (state.sandbox) await this.#sandboxes.release(state.sandbox).catch(() => undefined);
    this.#targets.delete(runId);
  }

  // ---------------------------------------------------------------- events

  #event(runId: string, kind: string, data: Record<string, unknown>) {
    const queue = this.#pendingEvents.get(runId) ?? [];
    queue.push({ kind, data });
    this.#pendingEvents.set(runId, queue);
  }

  async #flushEvents() {
    const api = artifactApiClient();
    if (!api) return;
    for (const [runId, events] of this.#pendingEvents) {
      if (events.length === 0) continue;
      this.#pendingEvents.set(runId, []);
      await api(`/internal/runs/${encodeURIComponent(runId)}/events`, { events: events.slice(0, 500) }).catch((cause) =>
        log("events.delivery-failed", { runId, count: events.length, message: String(cause) }));
    }
  }
}

async function completeRun(runId: string, body: unknown) {
  const origin = process.env.SYNARA_ARTIFACT_API_URL?.trim();
  const token = process.env.GLASSWING_ARTIFACT_SERVICE_TOKEN?.trim();
  if (!origin || !token) throw new Error("Glasswing API is not configured.");
  const response = await fetch(`${new URL(origin).origin}/internal/runs/${encodeURIComponent(runId)}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new Error(`Completion failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

let current: DiligenceRunner | undefined;
export const setDiligenceRunner = (runner: DiligenceRunner) => { current = runner; };
export const diligenceRunner = () => current;
export type { ThreadId };
