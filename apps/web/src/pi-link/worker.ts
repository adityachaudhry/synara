// FILE: pi-link/worker.ts
// Purpose: The Pi Link worker. One per browser (a SharedWorker; a dedicated worker per tab where
// shared workers don't exist). It holds the only socket to the agent service, one copy of each
// viewed conversation, the translation into Synara's events, and one paced queue per tab.
// Layer: Web worker. Never touches the DOM; the page applies only small, merged batches.

/// <reference lib="webworker" />

import type { Context } from "@earendil-works/chord/context";
import { applyImmutable, decoder, type Decoder, type Op } from "@earendil-works/chord/delta";
import { ConversationTranscript } from "@earendil-works/pi-durable";
import type { OrchestrationEvent, OrchestrationThread, OrchestrationThreadShell } from "@synara/contracts";

import {
  deriveProject,
  deriveShellThread,
  deriveThread,
  infoFromRow,
  type ConversationView,
  type LiveState,
  type PiEntry,
  type RunInfo,
  type ThreadInfo,
  type ThreadRow,
} from "./derive";
import { diffShell, diffThread, type ThreadEventDraft } from "./diff";
import type { PortMessage, TabConfig, TabMessage } from "./messages";
import { LIMITS, PROTOCOL, type ClientMessage, type ServerMessage, type Topic } from "./protocol";

declare const self: SharedWorkerGlobalScope & DedicatedWorkerGlobalScope;

const BUILD = (globalThis as { __PI_LINK_BUILD__?: string }).__PI_LINK_BUILD__ ?? "dev";
const RING = 512;
const TAB_BATCH_MS = 100;
const TAB_BATCH_BYTES = 64 * 1024;
const WARM_THREADS = 40;
const UNLEASED_KEEP_MS = 30_000;
const HISTORY_TARGET = 200;
const NO_CONTEXT = { abortSignal: undefined, telemetry: undefined, value: () => undefined, toString: () => "pi-link" } as unknown as Context;

type Item = { channel: string; data: unknown };

// ------------------------------------------------------------------ connection

class Connection {
  #socket: WebSocket | undefined;
  #state: "connecting" | "open" | "closed" = "connecting";
  #nextSid = 1;
  #nextRid = 1;
  readonly #subs = new Map<number, { topic: Topic; decoder: Decoder; value: unknown; onValue: (value: unknown, ops: readonly Op[]) => void; onError: (code: string) => void }>();
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error & { code?: string }) => void; timer: ReturnType<typeof setTimeout> }>();
  #backoff = 250;
  #lastHeard = Date.now();
  #config: TabConfig | undefined;
  #reauthTimer: ReturnType<typeof setInterval> | undefined;
  readonly #onState: (state: "connecting" | "open" | "closed") => void;

  constructor(onState: (state: "connecting" | "open" | "closed") => void) {
    this.#onState = onState;
    setInterval(() => this.#heartbeat(), 5_000);
  }

  get state() {
    return this.#state;
  }

  configure(config: TabConfig) {
    if (this.#config) return;
    this.#config = config;
    void this.#connect();
  }

  /** A ticket, asked of a tab (its fetch refreshes the host session), or fetched here when no tab answers. */
  async #ticket(): Promise<string> {
    const fromTab = await requestTicketFromTab().catch(() => undefined);
    if (fromTab?.ticket) return fromTab.ticket;
    if (fromTab?.status === 401) throw Object.assign(new Error("ticket 401"), { status: 401 });
    const response = await fetch(this.#config!.ticketUrl, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
    if (!response.ok) throw Object.assign(new Error(`ticket ${response.status}`), { status: response.status });
    const body = (await response.json()) as { ticket?: string };
    if (!body.ticket) throw new Error("no ticket");
    return body.ticket;
  }

  #setState(state: "connecting" | "open" | "closed") {
    if (this.#state === state) return;
    this.#state = state;
    this.#onState(state);
  }

  async #connect() {
    this.#setState("connecting");
    let ticket: string;
    try {
      ticket = await this.#ticket();
    } catch (cause) {
      // Signed out: nothing to reconnect to until a tab reloads.
      if ((cause as { status?: number }).status === 401) return this.#setState("closed");
      return this.#retry();
    }
    const socket = new WebSocket(this.#config!.wsUrl);
    this.#socket = socket;
    socket.onopen = () => {
      this.#lastHeard = Date.now();
      this.#raw({ t: "hello", protocol: PROTOCOL, build: BUILD, ticket });
    };
    socket.onmessage = (event) => {
      this.#lastHeard = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.#receive(message);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (this.#reauthTimer) clearInterval(this.#reauthTimer);
      for (const [rid, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error("Connection lost."), { code: "reconnected" }));
        this.#pending.delete(rid);
      }
      this.#retry();
    };
  }

  #retry() {
    this.#setState("connecting");
    const wait = Math.min(5_000, this.#backoff) * (0.75 + Math.random() * 0.5);
    this.#backoff = Math.min(5_000, this.#backoff * 2);
    setTimeout(() => void this.#connect(), wait);
  }

  #heartbeat() {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    const silent = Date.now() - this.#lastHeard;
    if (silent > LIMITS.silenceCloseMs) this.#socket.close();
    else if (silent > LIMITS.pingIntervalMs) this.#raw({ t: "ping" });
  }

  #raw(message: ClientMessage) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #receive(message: ServerMessage) {
    switch (message.t) {
      case "welcome": {
        this.#backoff = 250;
        this.#setState("open");
        this.#reauthTimer = setInterval(() => {
          void this.#ticket().then((ticket) => this.#raw({ t: "reauth", ticket }), () => undefined);
        }, 4 * 60_000);
        // Every subscription starts again; its first frame is a root replace.
        for (const [sid, sub] of this.#subs) {
          sub.decoder = decoder();
          this.#raw({ t: "sub", sid, topic: sub.topic });
        }
        return;
      }
      case "frame": {
        const sub = this.#subs.get(message.sid);
        if (!sub) return;
        const ops = sub.decoder.decode(message.ops as unknown[]);
        sub.value = applyImmutable(sub.value, ops);
        try {
          sub.onValue(sub.value, ops);
        } finally {
          this.#raw({ t: "ack", sid: message.sid, n: message.n });
        }
        return;
      }
      case "subError":
        this.#subs.get(message.sid)?.onError(message.error.code);
        return;
      case "pageResult":
      case "done": {
        const pending = this.#pending.get(message.rid);
        if (!pending) return;
        this.#pending.delete(message.rid);
        clearTimeout(pending.timer);
        pending.resolve(message.t === "done" ? message.result : { items: message.items, next: message.next });
        return;
      }
      case "fail": {
        const pending = this.#pending.get(message.rid);
        if (!pending) return;
        this.#pending.delete(message.rid);
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        return;
      }
      case "bye":
        if (message.reason === "unauthorized") this.#setState("closed");
        return;
      default:
        return;
    }
  }

  subscribe(topic: Topic, onValue: (value: unknown, ops: readonly Op[]) => void, onError: (code: string) => void): number {
    const sid = this.#nextSid++;
    this.#subs.set(sid, { topic, decoder: decoder(), value: undefined, onValue, onError });
    this.#raw({ t: "sub", sid, topic });
    return sid;
  }

  unsubscribe(sid: number) {
    if (!this.#subs.delete(sid)) return;
    this.#raw({ t: "unsub", sid });
  }

  #request<T>(build: (rid: number) => ClientMessage, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const send = () => {
        const rid = this.#nextRid++;
        const timer = setTimeout(() => {
          this.#pending.delete(rid);
          reject(Object.assign(new Error("The agent service did not answer in time."), { code: "timeout" }));
        }, timeoutMs);
        this.#pending.set(rid, { resolve: resolve as (value: unknown) => void, reject, timer });
        this.#raw(build(rid));
      };
      if (this.#state === "open") send();
      else {
        // Commands wait for the connection (bounded by their own timeout once sent).
        const started = Date.now();
        const wait = setInterval(() => {
          if (this.#state === "open") {
            clearInterval(wait);
            send();
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(wait);
            reject(Object.assign(new Error("Not connected to the agent service."), { code: "offline" }));
          }
        }, 100);
      }
    });
  }

  command<T>(kind: Extract<ClientMessage, { t: "cmd" }>["kind"], args: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    return this.#request((rid) => ({ t: "cmd", rid, kind, args }), timeoutMs);
  }

  page(threadId: string, query: { minEntryId?: number; maxEntryId?: number; order: "ascending" | "descending" }, limit: number, cursor: unknown) {
    return this.#request<{ items: PiEntry[]; next?: unknown }>((rid) => ({ t: "page", rid, threadId, query, limit, ...(cursor !== undefined ? { cursor } : {}) }), 30_000);
  }
}

// ------------------------------------------------------------------------ tabs

class Tab {
  readonly id: string;
  readonly port: MessagePort | DedicatedWorkerGlobalScope;
  config: TabConfig | undefined;
  visible = true;
  shell = false;
  readonly leases = new Set<string>();
  /** Threads this tab has a snapshot of; it gets events for these, a snapshot for others. */
  readonly primed = new Set<string>();
  queue: Item[] = [];
  inflight = false;
  n = 0;
  lastBeat = Date.now();
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor(id: string, port: MessagePort | DedicatedWorkerGlobalScope) {
    this.id = id;
    this.port = port;
  }
  post(message: PortMessage) {
    (this.port as MessagePort).postMessage(message);
  }
}

// --------------------------------------------------------------------- replicas

type EventItem = { sequence: number; event: OrchestrationEvent };

class ThreadReplica {
  readonly threadId: string;
  sid: number | undefined;
  view: ConversationView | undefined;
  readonly transcript: ConversationTranscript;
  entries: PiEntry[] = [];
  derived: OrchestrationThread | undefined;
  info: ThreadInfo | undefined;
  seq = 0;
  readonly ring: EventItem[] = [];
  readonly tabs = new Set<Tab>();
  readonly waiters: Array<() => void> = [];
  missing = false;
  loadingHistory = false;
  unleasedTimer: ReturnType<typeof setTimeout> | undefined;
  lastUsed = Date.now();
  constructor(threadId: string) {
    this.threadId = threadId;
    this.transcript = new ConversationTranscript(
      (query, limit) => connection.page(threadId, query as never, limit, undefined) as never,
      { pageSize: LIMITS.pageLimit },
    );
  }
}

class CompanyReplica {
  readonly companyId: string;
  slug: string;
  name: string;
  repository: TabConfig["project"]["repository"];
  sid: number | undefined;
  value: { companyId: string; slug: string; threads: Record<string, ThreadRow> } | undefined;
  shell = new Map<string, OrchestrationThreadShell>();
  seq = 0;
  readonly waiters: Array<() => void> = [];
  constructor(project: TabConfig["project"]) {
    this.companyId = project.companyId;
    this.slug = project.slug;
    this.name = project.name;
    this.repository = project.repository;
  }
}

const tabs = new Map<string, Tab>();
const ticketWaiters = new Map<number, (result: { ticket?: string; status?: number }) => void>();
let nextTicketRid = 1;

function requestTicketFromTab(): Promise<{ ticket?: string; status?: number }> {
  const candidates = [...tabs.values()].sort((a, b) => Number(b.visible) - Number(a.visible));
  const tab = candidates[0];
  if (!tab) return Promise.reject(new Error("no tab"));
  const rid = nextTicketRid++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ticketWaiters.delete(rid);
      reject(new Error("tab did not answer"));
    }, 10_000);
    ticketWaiters.set(rid, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    tab.post({ t: "needTicket", rid });
  });
}
const threads = new Map<string, ThreadReplica>();
const companies = new Map<string, CompanyReplica>();
let modelCache: { at: number; value: unknown } | undefined;
let transportState: "connecting" | "open" | "closed" = "connecting";

const connection = new Connection((state) => {
  transportState = state;
  for (const tab of tabs.values()) tab.post({ t: "state", state });
  if (state === "open") for (const tab of tabs.values()) enqueue(tab, providerStatusItem());
});

function providerStatusItem(): Item {
  return {
    channel: "server.providerStatusesUpdated",
    data: { providers: [{ provider: "pi", status: "ready", available: true, authStatus: "authenticated", checkedAt: new Date().toISOString() }] },
  };
}

// ------------------------------------------------------------------- scheduling

/** One batch per tab per 100 ms, one unconfirmed at a time; hidden tabs wait. */
function enqueue(tab: Tab, item: Item, urgent = false) {
  // Join a streaming text delta onto the previous one for the same message.
  const last = tab.queue.at(-1);
  const event = (item.data as { kind?: string; event?: OrchestrationEvent }).event;
  const lastEvent = (last?.data as { kind?: string; event?: OrchestrationEvent } | undefined)?.event;
  if (
    last && event && lastEvent && last.channel === item.channel &&
    event.type === "thread.message-sent" && lastEvent.type === "thread.message-sent" &&
    (event.payload as { streaming: boolean }).streaming && (lastEvent.payload as { streaming: boolean }).streaming &&
    (event.payload as { messageId: string }).messageId === (lastEvent.payload as { messageId: string }).messageId
  ) {
    const joined = { ...lastEvent, sequence: event.sequence, payload: { ...lastEvent.payload, text: `${(lastEvent.payload as { text: string }).text}${(event.payload as { text: string }).text}`, updatedAt: (event.payload as { updatedAt: string }).updatedAt } };
    tab.queue[tab.queue.length - 1] = { channel: item.channel, data: { kind: "event", event: joined } };
  } else {
    tab.queue.push(item);
  }
  schedule(tab, urgent);
}

function schedule(tab: Tab, urgent: boolean) {
  if (tab.inflight || !tab.visible || tab.queue.length === 0) return;
  if (urgent) {
    if (tab.timer) clearTimeout(tab.timer);
    tab.timer = undefined;
    flush(tab);
    return;
  }
  tab.timer ??= setTimeout(() => {
    tab.timer = undefined;
    flush(tab);
  }, TAB_BATCH_MS);
}

function flush(tab: Tab) {
  if (tab.inflight || !tab.visible || tab.queue.length === 0) return;
  const items: Item[] = [];
  let bytes = 0;
  while (tab.queue.length) {
    const size = JSON.stringify(tab.queue[0]!.data).length;
    if (items.length && bytes + size > TAB_BATCH_BYTES) break;
    items.push(tab.queue.shift()!);
    bytes += size;
  }
  tab.inflight = true;
  tab.n += 1;
  tab.post({ t: "batch", n: tab.n, items });
}

// ---------------------------------------------------------------- thread events

function envelope(replica: ThreadReplica, draft: ThreadEventDraft, sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: `pi:${replica.threadId}:${sequence}`,
    aggregateKind: "thread",
    aggregateId: replica.threadId,
    occurredAt: draft.occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: draft.type,
    payload: draft.payload,
  } as unknown as OrchestrationEvent;
}

function threadSnapshotItem(replica: ThreadReplica): Item {
  return { channel: "orchestration.threadEvent", data: { kind: "snapshot", snapshot: { snapshotSequence: replica.seq, thread: replica.derived } } };
}

function restateShell(company: CompanyReplica, threadId: string) {
  const thread = company.shell.get(threadId);
  if (!thread) return;
  for (const tab of tabs.values()) {
    if (!tab.shell || tab.config?.project.companyId !== company.companyId) continue;
    company.seq += 1;
    enqueue(tab, { channel: "orchestration.shellEvent", data: { kind: "thread-upserted", thread, sequence: company.seq } });
  }
}

function rowOf(threadId: string): { row: ThreadRow; company: CompanyReplica } | undefined {
  for (const company of companies.values()) {
    const row = company.value?.threads[threadId];
    if (row) return { row, company };
  }
  return undefined;
}

function rederive(replica: ThreadReplica, opts: { forceSnapshot?: boolean } = {}) {
  const view = replica.view;
  if (!view) return;
  const docs = view.docs;
  const located = rowOf(replica.threadId);
  const info = (docs["glasswing.thread"] as ThreadInfo | undefined)?.threadId
    ? (docs["glasswing.thread"] as ThreadInfo)
    : located
      ? infoFromRow(located.row, located.company.companyId, located.company.slug)
      : replica.info;
  if (!info) return;
  replica.info = info;
  const next = deriveThread({
    info,
    entries: replica.entries,
    live: docs["pi.live"] as LiveState | undefined,
    run: (docs["glasswing.run"] as RunInfo | undefined)?.runId ? (docs["glasswing.run"] as RunInfo) : undefined,
    row: located?.row,
  });
  const prev = replica.derived;
  replica.derived = next;
  const turnEnded = prev?.session?.status === "running" && next.session?.status !== "running";
  const result = prev && !opts.forceSnapshot ? diffThread(prev, next) : "snapshot";
  if (result === "snapshot") {
    replica.seq += 1;
    replica.ring.length = 0;
    for (const tab of replica.tabs) {
      tab.primed.add(replica.threadId);
      enqueue(tab, threadSnapshotItem(replica));
    }
  } else if (result.length) {
    const firstChunk = result.some((draft) => draft.type === "thread.message-sent" && !prev?.messages.some((message) => message.id === (draft.payload as { messageId: string }).messageId));
    for (const draft of result) {
      replica.seq += 1;
      const event = envelope(replica, draft, replica.seq);
      replica.ring.push({ sequence: replica.seq, event });
      if (replica.ring.length > RING) replica.ring.shift();
      for (const tab of replica.tabs) {
        if (!tab.primed.has(replica.threadId)) continue;
        enqueue(tab, { channel: "orchestration.threadEvent", data: { kind: "event", event } }, firstChunk);
      }
    }
    // Synara's reducer adds a reply each time it sees a message settle, on top of the server's row
    // count; restating the row afterwards keeps the server's count.
    const settled = result.some((draft) => draft.type === "thread.message-sent" && (draft.payload as { streaming?: boolean }).streaming === false);
    if (settled && located) restateShell(located.company, replica.threadId);
    for (const tab of replica.tabs) {
      if (tab.primed.has(replica.threadId)) continue;
      tab.primed.add(replica.threadId);
      enqueue(tab, threadSnapshotItem(replica));
    }
  }
  // At the end of a turn the transcript settles into its final shape (text between tool rows).
  if (turnEnded) setTimeout(() => rederive(replica, { forceSnapshot: true }), 50);
  for (const waiter of replica.waiters.splice(0)) waiter();
}

function onThreadValue(replica: ThreadReplica, value: unknown) {
  const view = value as ConversationView & { before?: number };
  replica.view = view;
  replica.missing = false;
  const merged = replica.transcript.merge(view as never);
  replica.entries = merged.items.flatMap((item) => (item.kind === "entry" ? [item.entry as unknown as PiEntry] : []));
  rederive(replica);
  void loadHistory(replica, merged.items.some((item) => item.kind === "earlier"));
}

/** Older entries in pages, up to what Synara's store keeps, then one snapshot with them above. */
async function loadHistory(replica: ThreadReplica, hasEarlier: boolean) {
  if (!hasEarlier || replica.loadingHistory || replica.entries.length >= HISTORY_TARGET || replica.tabs.size === 0) return;
  replica.loadingHistory = true;
  try {
    let merged = await replica.transcript.loadEarlier(NO_CONTEXT);
    while (merged.items.some((item) => item.kind === "earlier") && merged.items.length < HISTORY_TARGET) {
      merged = await replica.transcript.loadEarlier(NO_CONTEXT);
    }
    replica.entries = merged.items.flatMap((item) => (item.kind === "entry" ? [item.entry as unknown as PiEntry] : []));
    rederive(replica, { forceSnapshot: true });
  } catch {
    // History is a nicety; the window is already on screen.
  } finally {
    replica.loadingHistory = false;
  }
}

function ensureThread(threadId: string): ThreadReplica {
  let replica = threads.get(threadId);
  if (!replica) {
    replica = new ThreadReplica(threadId);
    threads.set(threadId, replica);
    evictThreads();
  }
  replica.lastUsed = Date.now();
  if (replica.unleasedTimer) {
    clearTimeout(replica.unleasedTimer);
    replica.unleasedTimer = undefined;
  }
  if (replica.sid === undefined) {
    const target = replica;
    target.sid = connection.subscribe(
      { kind: "thread", threadId },
      (value) => onThreadValue(target, value),
      (code) => {
        if (code === "thread_not_found") {
          // A draft thread: subscribe again once it is created.
          target.missing = true;
          if (target.sid !== undefined) connection.unsubscribe(target.sid);
          target.sid = undefined;
        }
        for (const waiter of target.waiters.splice(0)) waiter();
      },
    );
  }
  return replica;
}

function releaseThread(replica: ThreadReplica) {
  if (replica.tabs.size > 0 || replica.unleasedTimer) return;
  replica.unleasedTimer = setTimeout(() => {
    replica.unleasedTimer = undefined;
    if (replica.tabs.size > 0 || replica.sid === undefined) return;
    connection.unsubscribe(replica.sid);
    replica.sid = undefined;
    // The copy stays warm: reopening resumes from its newest entry.
  }, UNLEASED_KEEP_MS);
}

function evictThreads() {
  if (threads.size <= WARM_THREADS) return;
  const idle = [...threads.values()].filter((replica) => replica.tabs.size === 0).sort((a, b) => a.lastUsed - b.lastUsed);
  for (const replica of idle.slice(0, threads.size - WARM_THREADS)) {
    if (replica.sid !== undefined) connection.unsubscribe(replica.sid);
    threads.delete(replica.threadId);
  }
}

function waitFor(replica: { waiters: Array<() => void> }, ready: () => boolean, timeoutMs: number): Promise<boolean> {
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(ready()), timeoutMs);
    replica.waiters.push(() => {
      clearTimeout(timer);
      resolve(ready());
    });
  });
}

// ----------------------------------------------------------------- company lists

function ensureCompany(project: TabConfig["project"]): CompanyReplica {
  let replica = companies.get(project.companyId);
  if (!replica) {
    replica = new CompanyReplica(project);
    companies.set(project.companyId, replica);
  }
  if (replica.sid === undefined) {
    const target = replica;
    target.sid = connection.subscribe(
      { kind: "company", companyId: project.companyId, slug: project.slug },
      (value) => onCompanyValue(target, value as CompanyReplica["value"]),
      () => {
        for (const waiter of target.waiters.splice(0)) waiter();
      },
    );
  }
  return replica;
}

function shellSnapshot(replica: CompanyReplica) {
  return {
    snapshotSequence: replica.seq,
    spaces: [],
    projects: [deriveProject({ companyId: replica.companyId, slug: replica.slug, name: replica.name, ...(replica.repository ? { repository: replica.repository } : {}) })],
    threads: [...replica.shell.values()],
    updatedAt: new Date().toISOString(),
  };
}

function onCompanyValue(replica: CompanyReplica, value: CompanyReplica["value"]) {
  const first = replica.value === undefined;
  replica.value = value;
  const next = new Map<string, OrchestrationThreadShell>();
  for (const row of Object.values(value?.threads ?? {})) next.set(row.threadId, deriveShellThread(row, replica.companyId));
  const changes = diffShell(replica.shell, next);
  replica.shell = next;
  for (const tab of tabs.values()) {
    if (!tab.shell || tab.config?.project.companyId !== replica.companyId) continue;
    if (first) {
      replica.seq += 1;
      enqueue(tab, { channel: "orchestration.shellEvent", data: { kind: "snapshot", snapshot: shellSnapshot(replica) } }, true);
      continue;
    }
    for (const change of changes) {
      replica.seq += 1;
      enqueue(tab, { channel: "orchestration.shellEvent", data: { ...change, sequence: replica.seq } });
    }
  }
  // A row changed (title, status): threads without their own details yet follow it.
  for (const change of changes) {
    if (change.kind !== "thread-upserted") continue;
    const thread = threads.get(change.thread.id);
    if (thread?.missing && thread.tabs.size) ensureThread(thread.threadId);
    else if (thread?.view && !(thread.view.docs["glasswing.thread"] as ThreadInfo | undefined)?.threadId) rederive(thread);
  }
  for (const waiter of replica.waiters.splice(0)) waiter();
}

// ---------------------------------------------------------------------- requests

const PI_THINKING = [
  { value: "off", label: "Off", description: "No extra reasoning" },
  { value: "minimal", label: "Minimal", description: "Light reasoning" },
  { value: "low", label: "Low", description: "Faster reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning" },
  { value: "high", label: "High", description: "Deeper reasoning" },
  { value: "xhigh", label: "Extra High", description: "Extra-high reasoning" },
  { value: "max", label: "Max", description: "Maximum reasoning" },
];

async function listModels() {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.value;
  const result = await connection.command<{ models: Array<{ provider: string; modelId: string; name: string; thinkingLevels: string[] }> }>("models.list", {});
  const names: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI" };
  const value = {
    models: result.models.map((model) => {
      const options = PI_THINKING.filter((option) => model.thinkingLevels.includes(option.value));
      return {
        slug: `${model.provider}/${model.modelId}`,
        name: model.name,
        upstreamProviderId: model.provider,
        upstreamProviderName: names[model.provider] ?? model.provider,
        ...(options.length ? { supportedReasoningEfforts: options, ...(options.some((option) => option.value === "medium") ? { defaultReasoningEffort: "medium" } : {}) } : {}),
      };
    }),
    source: "pi.durable",
    cached: false,
  };
  modelCache = { at: Date.now(), value };
  return value;
}

function modelOf(selection: unknown) {
  const value = selection as { provider?: string; model?: string; options?: { thinkingLevel?: string } } | undefined;
  if (value?.provider !== "pi" || !value.model) return undefined;
  const [provider, ...rest] = value.model.split("/");
  if (!provider || !rest.length) return undefined;
  return { provider, modelId: rest.join("/"), ...(value.options?.thinkingLevel ? { thinkingLevel: value.options.thinkingLevel } : {}) };
}

async function dispatch(tab: Tab, command: Record<string, unknown>): Promise<{ sequence: number }> {
  const project = tab.config!.project;
  const threadId = String(command.threadId ?? "");
  const replica = threadId ? threads.get(threadId) : undefined;
  const sequence = () => ({ sequence: replica?.seq ?? 0 });
  switch (command.type) {
    case "thread.create": {
      const model = modelOf(command.modelSelection);
      await connection.command("thread.create", { threadId, companyId: project.companyId, slug: project.slug, title: command.title, ...(model ? { model } : {}) });
      const created = threads.get(threadId);
      if (created && created.tabs.size) ensureThread(threadId);
      return sequence();
    }
    case "thread.turn.start": {
      const message = command.message as { messageId: string; text: string; attachments?: unknown[] };
      const model = modelOf(command.modelSelection);
      // A draft created in the same breath: make sure it exists first (idempotent).
      if (threads.get(threadId)?.missing || !rowOf(threadId)) {
        await connection.command("thread.create", { threadId, companyId: project.companyId, slug: project.slug, title: (message.text || "New thread").slice(0, 80) }).catch(() => undefined);
        const created = threads.get(threadId);
        if (created && created.tabs.size) ensureThread(threadId);
      }
      await connection.command("send", { threadId, text: message.text, requestId: message.messageId, ...(message.attachments?.length ? { attachments: message.attachments } : {}), ...(model ? { model } : {}) });
      return sequence();
    }
    case "thread.meta.update": {
      const model = modelOf(command.modelSelection);
      if (command.title !== undefined || model) await connection.command("thread.update", { threadId, ...(typeof command.title === "string" ? { title: command.title } : {}), ...(model ? { model } : {}) });
      return sequence();
    }
    case "thread.archive":
    case "thread.unarchive":
      await connection.command("thread.update", { threadId, archived: command.type === "thread.archive" });
      return sequence();
    case "thread.turn.interrupt":
    case "thread.session.stop":
      await connection.command("stop", { threadId });
      return sequence();
    case "thread.task.stop": {
      const runId = replica?.info?.runId ?? (threadId.startsWith("diligence-run-") ? threadId.slice("diligence-run-".length) : undefined);
      if (runId) await connection.command("run.stop", { runId });
      else await connection.command("stop", { threadId });
      return sequence();
    }
    case "thread.marker.add": {
      // Synara's command carries the mark's fields flat; the agent stores them as one mark.
      const mark = Object.fromEntries(
        ["messageId", "startOffset", "endOffset", "selectedText", "style", "color", "segmentIndex", "textFormat", "textPrefix", "textSuffix"]
          .filter((key) => command[key] !== undefined)
          .map((key) => [key, command[key]]),
      );
      await connection.command("mark.add", { threadId, mark: { id: command.markerId, ...mark } });
      return sequence();
    }
    case "thread.marker.remove":
      await connection.command("mark.remove", { threadId, markId: command.markerId });
      return sequence();
    case "thread.marker.done.set":
      await connection.command("mark.update", { threadId, markId: command.markerId, done: command.done });
      return sequence();
    case "thread.marker.label.set":
      await connection.command("mark.update", { threadId, markId: command.markerId, label: command.label ?? "" });
      return sequence();
    case "thread.delete":
      await connection.command("thread.delete", { threadId });
      return sequence();
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.task.background":
      return sequence();
    default:
      throw Object.assign(new Error(`${String(command.type)} is not available in this workspace.`), { code: "unsupported" });
  }
}

async function request(tab: Tab, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
  const project = tab.config!.project;
  switch (method) {
    case "orchestration.subscribeShell": {
      tab.shell = true;
      const replica = ensureCompany(project);
      if (replica.value) {
        replica.seq += 1;
        enqueue(tab, { channel: "orchestration.shellEvent", data: { kind: "snapshot", snapshot: shellSnapshot(replica) } }, true);
      }
      return undefined;
    }
    case "orchestration.unsubscribeShell":
      tab.shell = false;
      return undefined;
    case "orchestration.getShellSnapshot": {
      const replica = ensureCompany(project);
      await waitFor(replica, () => replica.value !== undefined, 10_000);
      return shellSnapshot(replica);
    }
    case "orchestration.subscribeThread": {
      const threadId = String(params?.threadId ?? "");
      const replica = ensureThread(threadId);
      replica.tabs.add(tab);
      tab.leases.add(threadId);
      const after = typeof params?.afterSequence === "number" ? params.afterSequence : undefined;
      if (replica.derived) {
        const oldest = replica.ring[0]?.sequence;
        if (after !== undefined && tab.primed.has(threadId) && after <= replica.seq && (after >= replica.seq || (oldest !== undefined && after >= oldest - 1))) {
          const missed = replica.ring.filter((item) => item.sequence > after);
          for (const item of missed) enqueue(tab, { channel: "orchestration.threadEvent", data: { kind: "event", event: item.event } });
        } else {
          tab.primed.add(threadId);
          enqueue(tab, threadSnapshotItem(replica), true);
        }
      } else if (!replica.sid && replica.missing) {
        // Nothing yet: a draft. It appears when created.
      }
      return undefined;
    }
    case "orchestration.unsubscribeThread": {
      const threadId = String(params?.threadId ?? "");
      tab.leases.delete(threadId);
      tab.primed.delete(threadId);
      const replica = threads.get(threadId);
      if (replica) {
        replica.tabs.delete(tab);
        releaseThread(replica);
      }
      return undefined;
    }
    case "orchestration.getThreadDetailSnapshot": {
      const threadId = String(params?.threadId ?? "");
      const replica = ensureThread(threadId);
      await waitFor(replica, () => replica.derived !== undefined || replica.missing, 10_000);
      if (!replica.tabs.size) releaseThread(replica);
      return replica.derived ? { snapshotSequence: replica.seq, thread: replica.derived } : null;
    }
    case "orchestration.replayEvents": {
      const threadId = String(params?.threadId ?? "");
      const from = Number(params?.fromSequenceExclusive ?? 0);
      const replica = threads.get(threadId);
      return replica ? replica.ring.filter((item) => item.sequence > from).map((item) => item.event) : [];
    }
    case "orchestration.dispatchCommand":
      return dispatch(tab, (params?.command ?? params) as Record<string, unknown>);
    case "orchestration.getSnapshot": {
      const replica = ensureCompany(project);
      await waitFor(replica, () => replica.value !== undefined, 10_000);
      const shell = shellSnapshot(replica);
      return { snapshotSequence: shell.snapshotSequence, spaces: [], projects: shell.projects, threads: [], updatedAt: shell.updatedAt };
    }
    case "orchestration.repairState":
      return { repaired: false };
    case "provider.listModels":
      return listModels();
    case "provider.getComposerCapabilities":
      return {
        provider: "pi", supportsSkillMentions: false, supportsSkillDiscovery: false, supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false, supportsPluginDiscovery: false, supportsRuntimeModelList: true, supportsThreadCompaction: false, supportsThreadImport: false,
      };
    case "provider.prepareWorkspace":
      void connection.command("workspace.prepare", { companyId: project.companyId, slug: project.slug, threadId: params?.threadId }).catch(() => undefined);
      return { started: true };
    case "server.refreshProviders":
      return (providerStatusItem().data as { providers: unknown[] });
    case "git.listBranches":
      return { branches: [], isRepo: false, hasOriginRemote: false };
    case "git.status":
      return { branch: null, hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 }, hasUpstream: false, upstreamBranch: null, aheadCount: 0, behindCount: 0, pr: null };
    case "projects.listDevServers":
      return { servers: [] };
    case "projects.resolveWorkspaceFileReferences": {
      const cwd = String(params?.cwd ?? "").replace(/\/$/u, "");
      const paths = Array.isArray(params?.relativePaths) ? (params!.relativePaths as string[]) : [];
      return { relativePaths: paths.map((value) => (value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value.startsWith("/") ? null : value)) };
    }
    default:
      throw Object.assign(new Error(`${method} is not available in this workspace.`), { code: "unsupported" });
  }
}

// --------------------------------------------------------------------------- ports

function onTabMessage(tab: Tab, message: TabMessage) {
  tab.lastBeat = Date.now();
  switch (message.t) {
    case "init":
      tab.config = message.config;
      tab.visible = message.visible;
      connection.configure(message.config);
      tab.post({ t: "state", state: transportState });
      if (transportState === "open") enqueue(tab, providerStatusItem(), true);
      return;
    case "visible":
      tab.visible = message.visible;
      if (message.visible) {
        // A tab coming back gets its queue (merged meanwhile) at once.
        schedule(tab, true);
      }
      return;
    case "ack":
      if (message.n === tab.n) {
        tab.inflight = false;
        schedule(tab, false);
      }
      return;
    case "beat":
      return;
    case "ticket": {
      const waiter = ticketWaiters.get(message.rid);
      ticketWaiters.delete(message.rid);
      waiter?.({ ...(message.ticket ? { ticket: message.ticket } : {}), ...(message.status ? { status: message.status } : {}) });
      return;
    }
    case "req":
      void request(tab, message.method, message.params as Record<string, unknown> | undefined).then(
        (value) => tab.post({ t: "res", rid: message.rid, ok: true, value }),
        (error: Error & { code?: string }) => tab.post({ t: "res", rid: message.rid, ok: false, error: { message: error.message, code: error.code ?? "failed" } }),
      );
      return;
    case "bye":
      dropTab(tab);
      return;
    default:
      return;
  }
}

function dropTab(tab: Tab) {
  if (!tabs.delete(tab.id)) return;
  for (const threadId of tab.leases) {
    const replica = threads.get(threadId);
    if (!replica) continue;
    replica.tabs.delete(tab);
    releaseThread(replica);
  }
}

// Tabs that stop beating (closed without a goodbye) let go of their leases.
setInterval(() => {
  const now = Date.now();
  for (const tab of [...tabs.values()]) if (now - tab.lastBeat > 15_000) dropTab(tab);
}, 5_000);

let tabCounter = 0;
function attach(port: MessagePort | DedicatedWorkerGlobalScope) {
  const tab = new Tab(`tab-${++tabCounter}`, port);
  tabs.set(tab.id, tab);
  port.onmessage = (event: MessageEvent) => onTabMessage(tab, event.data as TabMessage);
  (port as MessagePort).start?.();
}

if (typeof (self as SharedWorkerGlobalScope).onconnect !== "undefined" || "SharedWorkerGlobalScope" in globalThis) {
  (self as SharedWorkerGlobalScope).onconnect = (event: MessageEvent) => attach(event.ports[0]!);
} else {
  attach(self as DedicatedWorkerGlobalScope);
}
