import { describe, expect, it, vi } from "vitest";

import {
  SandboxCapacity,
  reconcileSandboxCapacityInventory,
  type SandboxCapacitySnapshot,
} from "./SandboxCapacity";

const request = (key: string) => ({
  key,
  threadId: `thread-${key}`,
  lifecycleGeneration: `generation-${key}`,
});

describe("SandboxCapacity", () => {
  it("admits at most N distinct generations and starts N+1 in strict FIFO order", async () => {
    const capacity = new SandboxCapacity(2);
    const first = await capacity.acquire(request("first"));
    const second = await capacity.acquire(request("second"));
    const started: string[] = [];
    const third = capacity.acquire(request("third")).then((lease) => {
      started.push(lease.key);
      return lease;
    });
    const fourth = capacity.acquire(request("fourth")).then((lease) => {
      started.push(lease.key);
      return lease;
    });

    await Promise.resolve();
    expect(capacity.snapshot()).toMatchObject({
      activeKeys: ["first", "second"],
      queued: [
        { key: "third", position: 1 },
        { key: "fourth", position: 2 },
      ],
    });
    first.release();
    const thirdLease = await third;
    expect(started).toEqual(["third"]);
    second.release();
    const fourthLease = await fourth;
    expect(started).toEqual(["third", "fourth"]);
    thirdLease.release();
    fourthLease.release();
  });

  it("returns the same permit for same-key retries without consuming capacity twice", async () => {
    const capacity = new SandboxCapacity(1);

    const first = await capacity.acquire(request("same"));
    const retry = await capacity.acquire(request("same"));

    expect(retry).toBe(first);
    expect(capacity.snapshot().activeKeys).toEqual(["same"]);
    first.release();
  });

  it("removes a cancelled waiter and compacts later queue positions immediately", async () => {
    const capacity = new SandboxCapacity(1);
    const updates: Array<ReadonlyArray<{ key: string; position: number }>> = [];
    capacity.subscribe(() => updates.push(capacity.snapshot().queued));
    const active = await capacity.acquire(request("active"));
    const cancelled = new AbortController();
    const second = capacity.acquire({ ...request("second"), signal: cancelled.signal });
    const third = capacity.acquire(request("third"));
    await Promise.resolve();

    cancelled.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(capacity.snapshot().queued).toEqual([{ key: "third", position: 1 }]);
    expect(updates).toContainEqual([{ key: "third", position: 1 }]);
    active.release();
    (await third).release();
  });

  it("keeps a lifecycle queued when one same-key caller cancels", async () => {
    const capacity = new SandboxCapacity(1);
    const active = await capacity.acquire(request("active"));
    const first = new AbortController();
    const second = new AbortController();
    const firstAttempt = capacity.acquire({ ...request("shared"), signal: first.signal });
    const secondAttempt = capacity.acquire({ ...request("shared"), signal: second.signal });

    first.abort();

    await expect(firstAttempt).rejects.toMatchObject({ name: "AbortError" });
    expect(capacity.snapshot().queued).toEqual([{ key: "shared", position: 1 }]);
    active.release();
    const lease = await secondAttempt;
    expect(capacity.snapshot().activeKeys).toEqual(["shared"]);
    lease.release();
  });

  it("observes later retry cancellation and removes the key only after every caller cancels", async () => {
    const capacity = new SandboxCapacity(1);
    const updates: SandboxCapacitySnapshot[] = [];
    capacity.subscribe((snapshot) => updates.push(snapshot));
    const active = await capacity.acquire(request("active"));
    const first = new AbortController();
    const retry = new AbortController();
    const firstAttempt = capacity.acquire({ ...request("shared"), signal: first.signal });
    const retryAttempt = capacity.acquire({ ...request("shared"), signal: retry.signal });
    const later = capacity.acquire(request("later"));
    let retryCancelled = false;
    void retryAttempt.catch(() => {
      retryCancelled = true;
    });
    const updatesBeforeRetryCancellation = updates.length;

    retry.abort();

    await Promise.resolve();
    expect(retryCancelled).toBe(true);
    expect(updates).toHaveLength(updatesBeforeRetryCancellation);
    expect(capacity.snapshot().queued).toEqual([
      { key: "shared", position: 1 },
      { key: "later", position: 2 },
    ]);

    first.abort();

    await expect(firstAttempt).rejects.toMatchObject({ name: "AbortError" });
    expect(capacity.snapshot().queued).toEqual([{ key: "later", position: 1 }]);
    active.release();
    (await later).release();
  });

  it("releases a permit exactly once", async () => {
    const capacity = new SandboxCapacity(1);
    const first = await capacity.acquire(request("first"));
    const second = capacity.acquire(request("second"));

    first.release();
    first.release();
    const secondLease = await second;

    expect(capacity.snapshot().activeKeys).toEqual(["second"]);
    secondLease.release();
    expect(capacity.snapshot().activeKeys).toEqual([]);
  });

  it("does not admit creates until startup reconciliation succeeds", async () => {
    const capacity = new SandboxCapacity(2, { reconcileBeforeAdmission: true });
    let admitted = false;
    const waiting = capacity.acquire(request("new")).then((lease) => {
      admitted = true;
      return lease;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);

    capacity.reconcile([request("existing")]);
    const lease = await waiting;
    expect(capacity.snapshot().activeKeys).toEqual(["existing", "new"]);
    lease.release();
  });

  it("resolves a queued same-key retry with its recovered startup permit", async () => {
    const capacity = new SandboxCapacity(1, { reconcileBeforeAdmission: true });
    const waiting = capacity.acquire(request("same"));

    capacity.reconcile([request("same")]);

    expect(capacity.snapshot().queued).toEqual([]);
    const lease = await waiting;
    expect(capacity.snapshot().activeKeys).toEqual(["same"]);
    lease.release();
  });
});

describe("reconcileSandboxCapacityInventory", () => {
  it("counts listed runtimes with durable live bindings and pending create intents", () => {
    const report = reconcileSandboxCapacityInventory({
      inventoryRuntimeIds: ["runtime-live", "runtime-pending", "runtime-orphan"],
      liveBindings: [
        {
          capacityKey: "thread-live:generation-live",
          threadId: "thread-live",
          lifecycleGeneration: "generation-live",
          runtimeId: "runtime-live",
        },
      ],
      pendingCreationIntents: [
        { operationId: "operation-pending", runtimeId: "runtime-pending" },
        { operationId: "operation-unresolved", runtimeId: null },
      ],
    });

    expect(report.reservations).toEqual([
      {
        key: "thread-live:generation-live",
        threadId: "thread-live",
        lifecycleGeneration: "generation-live",
      },
      {
        key: "create-intent:operation-pending",
        threadId: "create-intent:operation-pending",
        lifecycleGeneration: "operation-pending",
      },
      {
        key: "create-intent:operation-unresolved",
        threadId: "create-intent:operation-unresolved",
        lifecycleGeneration: "operation-unresolved",
      },
    ]);
    expect(report.orphanRuntimeIds).toEqual(["runtime-orphan"]);
  });

  it("does not count a durable binding whose runtime is absent from inventory", () => {
    const report = reconcileSandboxCapacityInventory({
      inventoryRuntimeIds: [],
      liveBindings: [
        {
          capacityKey: "thread-stale:generation-stale",
          threadId: "thread-stale",
          lifecycleGeneration: "generation-stale",
          runtimeId: "runtime-stale",
        },
      ],
      pendingCreationIntents: [],
    });

    expect(report.reservations).toEqual([]);
    expect(report.orphanRuntimeIds).toEqual([]);
  });
});
