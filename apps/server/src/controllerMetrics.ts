/**
 * Controller health metrics and single-line structured logs.
 *
 * `GET /metrics` renders these in the Prometheus text format (Glasswing's Prometheus scrapes the
 * controller over the Railway private network). Every series carries `version="<commit>"`, the
 * deployed source revision. Counters live for the process; Prometheus handles resets.
 */
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import * as V8 from "node:v8";

const VERSION = (process.env.SYNARA_COMMIT?.trim() || "development").replace(
  /[^0-9A-Za-z._-]/gu,
  "",
);

/** One JSON object per line, so Railway keeps it as one entry with its fields as attributes. */
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ event, level, ...fields });
  if (level === "info") console.info(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
}

type Labels = Readonly<Record<string, string>>;

const escapeLabel = (value: string) =>
  value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');
const labelText = (labels: Labels) => {
  const all = { version: VERSION, ...labels };
  return `{${Object.entries(all)
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",")}}`;
};
const number = (value: number) =>
  Number.isFinite(value) ? String(value) : value > 0 ? "+Inf" : value < 0 ? "-Inf" : "NaN";

class Counter {
  readonly #values = new Map<string, { labels: Labels; value: number }>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1) {
    const key = JSON.stringify(labels);
    const entry = this.#values.get(key) ?? { labels, value: 0 };
    entry.value += by;
    this.#values.set(key, entry);
  }
  render(out: string[]) {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`);
    if (this.#values.size === 0) out.push(`${this.name}${labelText({})} 0`);
    for (const { labels, value } of this.#values.values())
      out.push(`${this.name}${labelText(labels)} ${number(value)}`);
  }
}

class Gauge {
  readonly #values = new Map<string, { labels: Labels; value: number }>();
  readonly name: string;
  readonly help: string;
  readonly read: (() => number | undefined) | undefined;
  constructor(name: string, help: string, read?: () => number | undefined) {
    this.name = name;
    this.help = help;
    this.read = read;
  }
  set(labels: Labels, value: number) {
    this.#values.set(JSON.stringify(labels), { labels, value });
  }
  render(out: string[]) {
    const current = this.read?.();
    if (this.read && current === undefined) return;
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`);
    if (this.read) out.push(`${this.name}${labelText({})} ${number(current!)}`);
    for (const { labels, value } of this.#values.values())
      out.push(`${this.name}${labelText(labels)} ${number(value)}`);
  }
}

class Histogram {
  readonly #counts: number[];
  #sum = 0;
  #count = 0;
  readonly name: string;
  readonly help: string;
  readonly buckets: readonly number[];
  constructor(name: string, help: string, buckets: readonly number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
    this.#counts = buckets.map(() => 0);
  }
  observe(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    this.#sum += value;
    this.#count++;
    this.buckets.forEach((bound, index) => {
      if (value <= bound) this.#counts[index]!++;
    });
  }
  render(out: string[]) {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`);
    this.buckets.forEach((bound, index) =>
      out.push(`${this.name}_bucket${labelText({ le: String(bound) })} ${this.#counts[index]}`),
    );
    out.push(`${this.name}_bucket${labelText({ le: "+Inf" })} ${this.#count}`);
    out.push(
      `${this.name}_sum${labelText({})} ${number(this.#sum)}`,
      `${this.name}_count${labelText({})} ${this.#count}`,
    );
  }
}

// ------------------------------------------------------------------ providers set by the engine

let openWatches: () => number | undefined = () => undefined;
let activeConversations: () => number | undefined = () => undefined;

/** The durable engine reports its open event watches and conversations with a running turn. */
export function setDurableEngineGauges(input: {
  readonly openWatches: () => number;
  readonly activeConversations: () => number;
}) {
  openWatches = input.openWatches;
  activeConversations = input.activeConversations;
}

export const durableEngineCounts = () => ({
  openWatches: openWatches(),
  activeConversations: activeConversations(),
});

// ------------------------------------------------------------------ process sampling

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let gcSeconds = 0;
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcSeconds += entry.duration / 1000;
  }).observe({ entryTypes: ["gc"] });
} catch {
  // No GC entries on this runtime; the series stays at zero.
}

// ------------------------------------------------------------------ series

export const turnsTotal = new Counter(
  "synara_turns_total",
  "Agent turns settled, by outcome and thread kind.",
);
const turnDuration = new Histogram(
  "synara_turn_duration_seconds",
  "Wall time of a settled agent turn.",
  [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600],
);
const firstToken = new Histogram(
  "synara_first_token_seconds",
  "Time from turn start to the first streamed assistant text.",
  [0.5, 1, 2, 3, 5, 10, 20, 40, 60, 120],
);
export const sandboxEvents = new Counter(
  "synara_sandbox_events_total",
  "Sandbox lifecycle events (claimed, lost, replaced).",
);
export const sqliteSlowStatements = new Counter(
  "synara_sqlite_slow_statements_total",
  "state.sqlite statements that took 250 ms or more.",
);
const backupDuration = new Gauge(
  "synara_backup_last_duration_seconds",
  "Duration of the last successful off-volume backup, by kind.",
);
const backupBytes = new Gauge(
  "synara_backup_last_bytes",
  "Size of the last uploaded off-volume backup, by kind.",
);
export const backupOverlaps = new Counter(
  "synara_backup_overlaps_total",
  "Backups skipped because the previous one of the same kind was still running.",
);
export const llmFallbacks = new Counter(
  "synara_llm_fallbacks_total",
  "Turns moved from Anthropic to OpenAI, by reason and feature (chat, diligence).",
);
export const llmCircuitOpen = new Gauge(
  "synara_llm_circuit_open",
  "1 from an Anthropic fallback until a probe finds Anthropic answering; new turns go straight to OpenAI meanwhile.",
);
llmCircuitOpen.set({}, 0);

export type ThreadKind = "chat" | "run" | "note_reply" | "diligence_step";

export function recordTurn(input: {
  readonly status: string;
  readonly threadKind: ThreadKind;
  readonly durationMs?: number | undefined;
  readonly firstTokenMs?: number | undefined;
}) {
  turnsTotal.inc({ status: input.status, thread_kind: input.threadKind });
  if (input.durationMs !== undefined) turnDuration.observe(input.durationMs / 1000);
  if (input.firstTokenMs !== undefined) firstToken.observe(input.firstTokenMs / 1000);
}

export function recordBackup(kind: string, durationMs: number, bytes: number) {
  backupDuration.set({ kind }, durationMs / 1000);
  backupBytes.set({ kind }, bytes);
}

export function renderMetrics(): string {
  const memory = process.memoryUsage();
  const p99 = loopDelay.count > 0 ? loopDelay.percentile(99) / 1e9 : 0;
  loopDelay.reset();
  const out: string[] = [];
  new Gauge("synara_heap_used_bytes", "V8 heap in use.", () => memory.heapUsed).render(out);
  new Gauge(
    "synara_heap_limit_bytes",
    "V8 heap size limit.",
    () => V8.getHeapStatistics().heap_size_limit,
  ).render(out);
  new Gauge(
    "synara_rss_bytes",
    "Resident set size of the controller process.",
    () => memory.rss,
  ).render(out);
  new Gauge(
    "synara_event_loop_delay_p99_seconds",
    "p99 event loop delay since the previous scrape.",
    () => p99,
  ).render(out);
  out.push(
    "# HELP synara_gc_seconds_total Time spent in garbage collection.",
    "# TYPE synara_gc_seconds_total counter",
    `synara_gc_seconds_total${labelText({})} ${number(gcSeconds)}`,
  );
  new Gauge(
    "synara_durable_open_watches",
    "Open Pi Durable event watches (each holds a conversation view in memory).",
    openWatches,
  ).render(out);
  new Gauge(
    "synara_active_conversations",
    "Durable conversations with a running turn.",
    activeConversations,
  ).render(out);
  for (const series of [
    turnsTotal,
    turnDuration,
    firstToken,
    sandboxEvents,
    sqliteSlowStatements,
    backupDuration,
    backupBytes,
    backupOverlaps,
    llmFallbacks,
    llmCircuitOpen,
  ])
    series.render(out);
  return `${out.join("\n")}\n`;
}
