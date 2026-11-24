// FILE: pi-link/transport.ts
// Purpose: The page side of Pi Link. Stands in for WsTransport (same surface wsNativeApi uses:
// request, subscribe, state), forwarding requests to the Pi Link worker and handing its merged
// batches to Synara's listeners. All decoding and translation happen in the worker.
// Layer: Web transport.

import type { WsBootstrapNegotiateResult, WsCompatibilityError, WsPush, WsPushChannel, WsPushMessage } from "@synara/contracts";

import type { WsRequestOptions, WsThreadStreamFailure } from "../wsTransport";
import type { WsTransportState } from "../wsTransportEvents";
import type { PortMessage, TabConfig, TabMessage } from "./messages";
import piLinkWorkerUrl from "./worker.ts?worker&url";

const REQUEST_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 5_000;

type WorkerPort = { postMessage(message: TabMessage): void; onmessage: ((event: MessageEvent<PortMessage>) => void) | null; start?: () => void };

/** One SharedWorker per browser and build; a dedicated worker where shared workers don't exist. */
function startWorker(): { port: WorkerPort; shared: boolean } {
  const name = `pi-link@${import.meta.env.VITE_PI_LINK_BUILD ?? "dev"}`;
  // A plain URL (Vite's ?worker&url): the host's bundler leaves it alone, and the worker is
  // a classic script, which every browser runs as a shared worker.
  if (typeof SharedWorker !== "undefined") {
    try {
      const worker = new SharedWorker(piLinkWorkerUrl, { name });
      return { port: worker.port as unknown as WorkerPort, shared: true };
    } catch {
      // Fall through to a dedicated worker.
    }
  }
  const worker = new Worker(piLinkWorkerUrl, { name });
  return { port: worker as unknown as WorkerPort, shared: false };
}

export class PiLinkTransport {
  readonly #config: TabConfig;
  readonly #port: WorkerPort;
  readonly #listeners = new Map<string, Set<(message: WsPush) => void>>();
  readonly #latest = new Map<string, WsPush>();
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #stateListeners = new Set<(state: WsTransportState) => void>();
  readonly #failureListeners = new Set<(failure: WsThreadStreamFailure) => void>();
  #state: WsTransportState = "connecting";
  #nextRid = 1;
  #pushSequence = 0;
  #disposed = false;
  readonly #beat: ReturnType<typeof setInterval>;
  readonly #onVisibility = () => this.#post({ t: "visible", visible: document.visibilityState === "visible" });
  readonly #onUnload = () => this.#post({ t: "bye" });

  constructor(config: TabConfig) {
    this.#config = config;
    const { port } = startWorker();
    this.#port = port;
    port.onmessage = (event) => this.#receive(event.data);
    port.start?.();
    this.#post({ t: "init", config, visible: typeof document === "undefined" || document.visibilityState === "visible" });
    this.#beat = setInterval(() => this.#post({ t: "beat" }), HEARTBEAT_MS);
    document.addEventListener("visibilitychange", this.#onVisibility);
    window.addEventListener("pagehide", this.#onUnload);
  }

  get project() {
    return this.#config.project;
  }

  #post(message: TabMessage) {
    if (!this.#disposed || message.t === "bye") this.#port.postMessage(message);
  }

  #setState(state: WsTransportState) {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) {
      try {
        listener(state);
      } catch {
        // A listener must not break delivery.
      }
    }
  }

  #receive(message: PortMessage) {
    if (this.#disposed) return;
    switch (message.t) {
      case "state":
        this.#setState(message.state);
        return;
      case "needTicket":
        void fetch(this.#config.ticketUrl, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" })
          .then(async (response) => {
            const body = response.ok ? ((await response.json()) as { ticket?: string }) : undefined;
            this.#post({ t: "ticket", rid: message.rid, ...(body?.ticket ? { ticket: body.ticket } : { status: response.status }) });
          })
          .catch(() => this.#post({ t: "ticket", rid: message.rid, status: 0 }));
        return;
      case "res": {
        const pending = this.#pending.get(message.rid);
        if (!pending) return;
        this.#pending.delete(message.rid);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(Object.assign(new Error(message.error?.message ?? "Request failed."), { code: message.error?.code }));
        return;
      }
      case "batch": {
        for (const item of message.items) {
          const push = { type: "push", sequence: ++this.#pushSequence, channel: item.channel, data: item.data } as unknown as WsPush;
          this.#latest.set(item.channel, push);
          for (const listener of this.#listeners.get(item.channel) ?? []) {
            try {
              listener(push);
            } catch {
              // Synara's own listeners isolate their failures the same way.
            }
          }
        }
        // Confirmed once handed to Synara's store; its own throttle decides when to paint.
        this.#post({ t: "ack", n: message.n });
        return;
      }
      default:
        return;
    }
  }

  async request<T = unknown>(method: string, params?: unknown, options?: WsRequestOptions): Promise<T> {
    if (this.#disposed) throw new Error("Transport disposed");
    const rid = this.#nextRid++;
    const timeoutMs = options?.timeoutMs === null ? undefined : (options?.timeoutMs ?? REQUEST_TIMEOUT_MS);
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined ? (undefined as unknown as ReturnType<typeof setTimeout>) : setTimeout(() => {
        this.#pending.delete(rid);
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms.`), { code: "WS_REQUEST_TIMEOUT" }));
      }, timeoutMs);
      this.#pending.set(rid, { resolve: resolve as (value: unknown) => void, reject, timer });
      options?.signal?.addEventListener("abort", () => {
        if (!this.#pending.delete(rid)) return;
        clearTimeout(timer);
        reject(Object.assign(new Error(`${method} was cancelled.`), { code: "WS_REQUEST_ABORTED" }));
      }, { once: true });
      this.#post({ t: "req", rid, method, params: params ?? {} });
    });
  }

  subscribe<C extends WsPushChannel>(channel: C, listener: (message: WsPushMessage<C>) => void, options?: { readonly replayLatest?: boolean }): () => void {
    let set = this.#listeners.get(channel);
    if (!set) {
      set = new Set();
      this.#listeners.set(channel, set);
    }
    const wrapped = (message: WsPush) => listener(message as WsPushMessage<C>);
    set.add(wrapped);
    if (options?.replayLatest) {
      const latest = this.#latest.get(channel);
      if (latest) wrapped(latest);
    }
    return () => {
      set?.delete(wrapped);
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    return (this.#latest.get(channel) as WsPushMessage<C> | undefined) ?? null;
  }

  onStateChange(listener: (state: WsTransportState) => void, options?: { readonly replayCurrent?: boolean }): () => void {
    this.#stateListeners.add(listener);
    if (options?.replayCurrent) listener(this.#state);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  getState(): WsTransportState {
    return this.#state;
  }

  getCompatibility(): WsBootstrapNegotiateResult | null {
    return null;
  }

  onCompatibilityChange(listener: (compatibility: WsBootstrapNegotiateResult | null) => void, options?: { readonly replayCurrent?: boolean }): () => void {
    if (options?.replayCurrent) listener(null);
    return () => undefined;
  }

  onCompatibilityIssue(listener: (issue: WsCompatibilityError | null) => void, options?: { readonly replayCurrent?: boolean }): () => void {
    if (options?.replayCurrent) listener(null);
    return () => undefined;
  }

  onThreadStreamFailure(listener: (failure: WsThreadStreamFailure) => void): () => void {
    this.#failureListeners.add(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#post({ t: "bye" });
    this.#disposed = true;
    clearInterval(this.#beat);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    window.removeEventListener("pagehide", this.#onUnload);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport disposed"));
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.#setState("disposed");
  }
}
