# Distributed Pi Concurrency UX Design

## Goal

Keep distributed Pi cold-start preparation invisible in a new-thread composer, guarantee that one
thread has at most one active preparation attempt, and prove that five independent projects and
threads can provision and answer concurrently.

## Evidence and root causes

The current browser prewarm promotes a client-only draft through the existing idempotent
`thread.create` command before calling `provider.prepareThread`. That promotion is necessary because
the authenticated server RPC accepts a durable thread id. It is not itself a user-visible send.

The abrupt layout switch happens because every `runtime.stage` event is projected into an ordinary
thread activity and `deriveWorkLogEntries` turns that activity into a timeline work row. The first
`sandbox.create` stage therefore changes `timelineEntries.length` from zero to nonzero. `ChatView`
correctly interprets that as conversation content and replaces the centered empty landing with the
sent-message transcript layout even though the user has not sent anything.

The per-thread preparation guard in `ProviderCommandReactor` is a mutex, not single-flight. It
prevents two simultaneous starts, but queued callers execute again after the first caller exits. A
successful second caller sees the ready session and is harmless; if the shared first attempt fails,
every queued caller can perform another complete sandbox attempt and emit another
`sandbox.create` lifecycle. This is the source of repeated failed-attempt telemetry.

A direct Railway control test admitted six checkpoint-backed sandboxes in the same dev environment.
Five requests were launched concurrently; four CLI processes reported success, one reported a local
active-sandbox config-file race after Railway had already created its sandbox, and a sixth sequential
request succeeded. Listing showed all six `RUNNING`. The environment is therefore not currently
limited to one sandbox. The CLI race also proves that remote listing and exact sandbox ids are the
authoritative lifecycle evidence.

## Design

### Invisible preparation

Keep `runtime.stage` events durable in `provider_runtime_events` and projected into orchestration
activities for diagnostics, replay, and future observability. Exclude them from the normal browser
work log and timeline. They are controller telemetry, not conversation content. With no user or
provider content, a promoted server thread remains in the centered empty landing while checkout,
worker boot, connection, and Pi session startup proceed in the background.

Warnings and failures remain visible through their existing error surfaces. Only routine stage
progress is hidden.

### Per-thread single-flight

Replace the preparation-only mutex with the existing cancellation-safe keyed single-flight cache.
Use a zero success TTL: simultaneous callers for one thread share the same success or failure, while
a later explicit focus or send can retry after the prior attempt has settled. Different thread ids
use different keys and run concurrently.

The normal first-turn path continues to call the same `ensureSessionForThread` operation. It joins an
in-flight prewarm for its thread instead of starting another sandbox. No new session, lease, worker,
or orchestration primitive is introduced.

### Five-way scale

Do not add a global provisioning semaphore. Each thread keeps its existing provider lifecycle and
Railway sandbox fence. Five projects with five new threads should concurrently reach independent
worker connections, then accept and complete one Pi turn each. Test cleanup destroys only the exact
test sandbox ids and verifies that no test sandboxes remain active.

## Failure handling

- A failed single-flight result is not cached. All simultaneous waiters receive the same failure;
  a later user action may retry.
- A caller cancellation does not cancel preparation while another waiter still needs it.
- A local Railway CLI bookkeeping failure is never treated as proof that create failed remotely;
  tests reconcile with `sandbox list` before cleanup.
- Worker generation fencing, durable event-before-ack ordering, SuperTokens authorization, and
  Gitea checkout authentication remain unchanged.

## Verification

1. A pure web regression test proves that pre-turn `runtime.stage` activities produce no work-log or
   timeline entries.
2. A reactor regression test proves two simultaneous failed `prepareThread` calls invoke provider
   startup once.
3. A concurrency test proves five distinct keys enter preparation before any is released.
4. Focused contracts, web, server, and provider-worker tests and builds pass.
5. The deployed browser path creates five projects and five new Pi threads, launches preparation
   without leaving the empty landing, sends one prompt in each, and observes five independent
   completed answers plus at least five concurrently active Railway sandboxes during the run.

