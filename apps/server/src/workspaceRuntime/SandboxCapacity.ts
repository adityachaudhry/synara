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

interface CapacityWaiter extends SandboxCapacityReservation {
  readonly promise: Promise<SandboxCapacityLease>;
  readonly resolve: (lease: SandboxCapacityLease) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
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
    const active = this.#active.get(input.key);
    if (active) return Promise.resolve(active);
    const queued = this.#queuedByKey.get(input.key);
    if (queued) return queued.promise;
    if (input.signal?.aborted) return Promise.reject(abortError());
    if (this.#reconciled && this.#active.size < this.#maxActive && this.#queued.length === 0) {
      const lease = this.#makeLease(input);
      this.#active.set(input.key, lease);
      this.#publish();
      return Promise.resolve(lease);
    }

    let resolve!: (lease: SandboxCapacityLease) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<SandboxCapacityLease>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const waiter: CapacityWaiter = {
      key: input.key,
      threadId: input.threadId,
      lifecycleGeneration: input.lifecycleGeneration,
      promise,
      resolve,
      reject,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    if (input.signal) {
      const onAbort = () => this.#cancel(waiter);
      Object.assign(waiter, { onAbort });
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
    this.#queued.push(waiter);
    this.#queuedByKey.set(waiter.key, waiter);
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
            const index = this.#queued.indexOf(waiter);
            if (index >= 0) this.#queued.splice(index, 1);
            this.#queuedByKey.delete(reservation.key);
            if (waiter.signal && waiter.onAbort) {
              waiter.signal.removeEventListener("abort", waiter.onAbort);
            }
            waiter.resolve(lease);
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

  #cancel(waiter: CapacityWaiter): void {
    const index = this.#queued.indexOf(waiter);
    if (index < 0) return;
    this.#queued.splice(index, 1);
    this.#queuedByKey.delete(waiter.key);
    waiter.reject(abortError());
    this.#publish();
  }

  #drain(): void {
    while (this.#reconciled && this.#active.size < this.#maxActive && this.#queued.length > 0) {
      const waiter = this.#queued.shift()!;
      this.#queuedByKey.delete(waiter.key);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      const lease = this.#makeLease(waiter);
      this.#active.set(lease.key, lease);
      waiter.resolve(lease);
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
      key: `${binding.threadId}:${binding.lifecycleGeneration}`,
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
