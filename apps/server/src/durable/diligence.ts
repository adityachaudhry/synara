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
import type { ProjectRepositoryBinding, ThreadId } from "@synara/contracts";

import { artifactApiClient } from "../providerWorker/artifactPublisher.ts";
import type { ProviderWorkerRuntimeBinding } from "../providerWorker/runtimeBinding";
import type { DurablePiEngine, DurableThreadTarget } from "./DurablePiEngine.ts";
import { shellQuote } from "./sandboxEnv.ts";

const ctx = BACKGROUND_CONTEXT;
const RUN_ROOT = "/workspace/run";
const AGENT_UID = 10001;

export interface DiligenceStep {
  readonly id: string;
  readonly model: string;
  readonly thinking?: string;
  readonly after: readonly string[];
  readonly release?: ReadonlyArray<{ readonly step: string; readonly file: string }>;
  readonly prompt: string;
  readonly outputs: readonly string[];
  readonly gate?: { readonly sectionId: string; readonly file: string };
}

export interface DiligenceRequest {
  readonly runId: string;
  readonly mode: string;
  readonly company: { readonly id: string; readonly slug: string; readonly name: string };
  readonly repository: ProjectRepositoryBinding;
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

export class DiligenceRunner {
  readonly #engine: DurablePiEngine;
  readonly #sandboxes: DiligenceSandboxes;
  readonly #extensions: readonly Extension[];
  readonly #loops = new Map<string, Promise<void>>();
  readonly #wakers = new Map<string, () => void>();
  readonly #targets = new Map<string, Promise<DurableThreadTarget>>();
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

  /** Continues every run that was active when the controller stopped. */
  async resume() {
    const active = (await this.#harness.snapshot(ActiveRuns, ctx))?.runs ?? {};
    for (const runId of Object.keys(active)) {
      log("run.resumed", { runId });
      this.#start(runId);
    }
  }

  async accept(request: DiligenceRequest): Promise<{ runId: string; accepted: true }> {
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
    this.#start(request.runId);
    return { runId: request.runId, accepted: true };
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
    const loop = this.#run(runId).catch((cause) => log("run.loop-failed", { runId, message: String(cause) }))
      .finally(() => this.#loops.delete(runId));
    this.#loops.set(runId, loop);
  }

  async #run(runId: string) {
    const request = await this.#plan(runId);
    if (!request) return;
    const steps = new Map(request.plan.steps.map((step) => [step.id, step]));
    const limit = Math.max(1, request.plan.maxConcurrency ?? 6);
    const inFlight = new Map<string, Promise<void>>();
    for (;;) {
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
          if (state.steps[dep]?.status === "running" && releases.length > 0 && (await this.#filesExist(runId, request, releases.map((release) => release.file)))) {
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
      await this.#submit(conversation, step.prompt, `diligence:${runId}:${step.id}`, step.id, runId);
      const missing = await this.#missingOutputs(runId, request, step.outputs);
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
          await this.#submit(conversation, prompt, `diligence:${runId}:${step.id}:repair`, step.id, runId);
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

  async #submit(conversation: Conversation, content: string, requestId: string, stepId: string, runId: string) {
    const stream = await watchEvents(this.#harness, conversation.id, ctx);
    stream.start(async (events) => {
      for (const event of events) this.#activity(runId, stepId, event);
    });
    try {
      const submission = await conversation.submit({ type: "input", content, requestId }, ctx);
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
