export interface SandboxCapacityRequest {
  readonly key: string;
  readonly threadId: string;
  readonly lifecycleGeneration: string;
  readonly signal?: AbortSignal;
}

export interface SandboxCapacityReservation {
  readonly key: string;
  readonly threadId: string;
  readonly lifecycleGeneration: string;
}

export interface SandboxCapacityLease extends SandboxCapacityReservation {
  readonly release: () => void;
}

export interface SandboxCapacitySnapshot {
  readonly activeKeys: ReadonlyArray<string>;
  readonly queued: ReadonlyArray<{ readonly key: string; readonly position: number }>;
  readonly reconciled: boolean;
}

interface CapacityCaller {
  readonly promise: Promise<SandboxCapacityLease>;
  readonly resolve: (lease: SandboxCapacityLease) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface CapacityWaiter extends SandboxCapacityReservation {
  readonly callers: Set<CapacityCaller>;
}

function abortError() {
  return new DOMException("Sandbox capacity acquisition was cancelled.", "AbortError");
}

export class SandboxCapacity {
  readonly #maxActive: number;
  readonly #active = new Map<string, SandboxCapacityLease>();
  readonly #queued: CapacityWaiter[] = [];
  readonly #queuedByKey = new Map<string, CapacityWaiter>();
  readonly #subscribers = new Set<(snapshot: SandboxCapacitySnapshot) => void>();
  #reconciled: boolean;

  constructor(
    maxActive: number,
    options: { readonly reconcileBeforeAdmission?: boolean } = {},
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error("Sandbox capacity must be a positive integer.");
    }
    this.#maxActive = maxActive;
    this.#reconciled = options.reconcileBeforeAdmission !== true;
  }

  acquire(input: SandboxCapacityRequest): Promise<SandboxCapacityLease> {
    if (input.signal?.aborted) return Promise.reject(abortError());
    const active = this.#active.get(input.key);
    if (active) return Promise.resolve(active);
    const queued = this.#queuedByKey.get(input.key);
    if (queued) return this.#addCaller(queued, input.signal);
    if (this.#reconciled && this.#active.size < this.#maxActive && this.#queued.length === 0) {
      const lease = this.#makeLease(input);
      this.#active.set(input.key, lease);
      this.#publish();
      return Promise.resolve(lease);
    }

    const waiter: CapacityWaiter = {
      key: input.key,
      threadId: input.threadId,
      lifecycleGeneration: input.lifecycleGeneration,
      callers: new Set(),
    };
    this.#queued.push(waiter);
    this.#queuedByKey.set(waiter.key, waiter);
    const promise = this.#addCaller(waiter, input.signal);
    this.#publish();
    return promise;
  }

  reconcile(reservations: ReadonlyArray<SandboxCapacityReservation>): void {
    if (!this.#reconciled) {
      for (const reservation of reservations) {
        if (!this.#active.has(reservation.key)) {
          const lease = this.#makeLease(reservation);
          this.#active.set(reservation.key, lease);
          const waiter = this.#queuedByKey.get(reservation.key);
          if (waiter) {
            this.#admit(waiter, lease);
          }
        }
      }
      this.#reconciled = true;
      this.#drain();
      this.#publish();
    }
  }

  release(key: string): void {
    this.#active.get(key)?.release();
  }

  snapshot(): SandboxCapacitySnapshot {
    return {
      activeKeys: Array.from(this.#active.keys()),
      queued: this.#queued.map((entry, index) => ({ key: entry.key, position: index + 1 })),
      reconciled: this.#reconciled,
    };
  }

  subscribe(listener: (snapshot: SandboxCapacitySnapshot) => void): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  reservation(key: string): SandboxCapacityReservation | undefined {
    return this.#active.get(key) ?? this.#queuedByKey.get(key);
  }

  #makeLease(input: SandboxCapacityReservation): SandboxCapacityLease {
    let released = false;
    return {
      ...input,
      release: () => {
        if (released) return;
        released = true;
        if (!this.#active.delete(input.key)) return;
        this.#drain();
        this.#publish();
      },
    };
  }

  #addCaller(waiter: CapacityWaiter, signal?: AbortSignal): Promise<SandboxCapacityLease> {
    let resolve!: (lease: SandboxCapacityLease) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<SandboxCapacityLease>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    let caller!: CapacityCaller;
    const onAbort = signal === undefined ? undefined : () => this.#cancelCaller(waiter, caller);
    caller = {
      promise,
      resolve,
      reject,
      ...(signal === undefined ? {} : { signal }),
      ...(onAbort === undefined ? {} : { onAbort }),
    };
    waiter.callers.add(caller);
    signal?.addEventListener("abort", onAbort!, { once: true });
    return promise;
  }

  #cancelCaller(waiter: CapacityWaiter, caller: CapacityCaller): void {
    if (!waiter.callers.delete(caller)) return;
    if (caller.signal && caller.onAbort) {
      caller.signal.removeEventListener("abort", caller.onAbort);
    }
    caller.reject(abortError());
    if (waiter.callers.size > 0) return;
    const index = this.#queued.indexOf(waiter);
    if (index >= 0) this.#queued.splice(index, 1);
    this.#queuedByKey.delete(waiter.key);
    this.#publish();
  }

  #admit(waiter: CapacityWaiter, lease: SandboxCapacityLease): void {
    const index = this.#queued.indexOf(waiter);
    if (index >= 0) this.#queued.splice(index, 1);
    this.#queuedByKey.delete(waiter.key);
    for (const caller of waiter.callers) {
      if (caller.signal && caller.onAbort) {
        caller.signal.removeEventListener("abort", caller.onAbort);
      }
      caller.resolve(lease);
    }
    waiter.callers.clear();
  }

  #drain(): void {
    while (this.#reconciled && this.#active.size < this.#maxActive && this.#queued.length > 0) {
      const waiter = this.#queued.shift()!;
      const lease = this.#makeLease(waiter);
      this.#active.set(lease.key, lease);
      this.#admit(waiter, lease);
    }
  }

  #publish(): void {
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) subscriber(snapshot);
  }
}

export function reconcileSandboxCapacityInventory(input: {
  readonly inventoryRuntimeIds: ReadonlyArray<string>;
  readonly liveBindings: ReadonlyArray<{
    readonly capacityKey: string;
    readonly threadId: string;
    readonly lifecycleGeneration: string;
    readonly runtimeId: string;
  }>;
  readonly pendingCreationIntents: ReadonlyArray<{
    readonly operationId: string;
    readonly runtimeId: string | null;
  }>;
}) {
  const inventory = new Set(input.inventoryRuntimeIds);
  const pendingRuntimeIds = new Set(
    input.pendingCreationIntents.flatMap((intent) =>
      intent.runtimeId === null ? [] : [intent.runtimeId],
    ),
  );
  const ownedRuntimeIds = new Set(pendingRuntimeIds);
  const reservations: SandboxCapacityReservation[] = [];

  for (const binding of input.liveBindings) {
    if (!inventory.has(binding.runtimeId) || pendingRuntimeIds.has(binding.runtimeId)) continue;
    ownedRuntimeIds.add(binding.runtimeId);
    reservations.push({
      key: binding.capacityKey,
      threadId: binding.threadId,
      lifecycleGeneration: binding.lifecycleGeneration,
    });
  }
  for (const intent of input.pendingCreationIntents) {
    const key = `create-intent:${intent.operationId}`;
    reservations.push({
      key,
      threadId: key,
      lifecycleGeneration: intent.operationId,
    });
  }

  return {
    reservations,
    orphanRuntimeIds: input.inventoryRuntimeIds.filter((runtimeId) => !ownedRuntimeIds.has(runtimeId)),
  };
}
