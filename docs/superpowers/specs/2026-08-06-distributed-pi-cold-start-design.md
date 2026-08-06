# Distributed Pi Cold-Start Design

## Objective

Make a distributed Pi thread begin provider work much faster on its first message while preserving
Synara's existing orchestration, provider adapter, durability, authentication, and per-thread
isolation primitives. Verify the result in the deployed Railway dev environment through Chrome and
through durable/runtime telemetry.

## Current Evidence

Three live cold starts spent 11.1-16.2 seconds before Pi could receive the first turn. Sandbox
creation plus Gitea checkout consumed 3.9-9.1 seconds, uploading the same 14.1 MB worker consumed
3.8-4.0 seconds, and config/process/registration consumed another 3.2 seconds. Once connected, Pi
created its session and accepted the turn in approximately 240 ms. Follow-up turns are fast because
they reuse the existing thread-bound worker.

The controller also periodically rejects a worker frame and forces a reconnect. The current warning
drops the nested broker reason, so diagnosis must first retain the exact rejection operation and
detail before changing protocol behavior.

## Architecture

### Immutable worker-ready base

Build the provider worker once, hash its bytes with SHA-256, and capture a Railway Sandbox checkpoint
named from that digest. A new sandbox may boot from that checkpoint and trust the preinstalled worker
only because the checkpoint name is derived from the expected artifact. Runtime configuration and
credentials are never captured in the checkpoint.

Railway's current template builder accepts shell recipes but not local file inputs. Hosting the
artifact solely to feed a template would create a new artifact-distribution primitive. A named
checkpoint gives the required immutable filesystem snapshot directly. A clean sandbox plus artifact
upload remains the automatic fallback when the checkpoint is disabled, absent, or unavailable.

### Parallel bootstrap and connection reuse

After sandbox creation, repository hydration and worker file preparation run concurrently. The
checkout plan already knows the final company cwd before Git runs, so the tiny per-generation worker
config can be written while Git fetches. Process launch waits for both branches. The Railway client
reuses the created sandbox handle for file operations and retains a fresh connection only where the
Railway durable-exec behavior requires it.

Gitea hydration uses a shallow, no-tags, blob-filtered sparse fetch first and falls back to the
existing shallow fetch when the server does not support partial clone. The immutable checked-out
commit remains recorded in the runtime binding.

### Per-thread prewarming

The browser sends an authenticated, idempotent `provider.prepareThread` hint after a distributed Pi
thread's composer receives meaningful focus/input. The server resolves the thread and project from
its own orchestration read model, starts the normal provider session using the existing
`ProviderService`, and durably binds the resulting session to the thread. It does not send a turn or
contact a model. The first real turn then follows the existing active-session path.

Concurrent hints coalesce per thread. Threads with an active/running session return immediately.
Abandoned prewarms use the existing ten-minute provider idle stop and Railway's bounded sandbox idle
timeout; no keepalive defeats those policies. Mutable sandboxes remain strictly per thread.

### Stage telemetry and user feedback

Add a canonical `runtime.stage` provider event with a bounded stage vocabulary:

- `sandbox.create`
- `workspace.checkout`
- `worker.files`
- `worker.start`
- `worker.connect`
- `session.start`
- `turn.dispatch`

Each event records `state` (`started`, `completed`, or `failed`), a cold/warm flag, elapsed
milliseconds when complete, lifecycle generation, and only non-secret runtime metadata. Routed Pi
emits controller-side stages into the same provider runtime stream already persisted in
`provider_runtime_events`; normal ingestion projects them into durable thread activities. The web
work log renders concise labels such as `Creating sandbox`, `Checking out workspace`, and `Starting
Pi` while preserving the existing Thinking/Working semantics.

Structured controller logs contain the same stage, thread, sandbox, duration, artifact-source, and
checkout-mode fields so Railway log queries can measure the cold path without reconstructing it from
unrelated messages.

### Protocol reliability

Provider worker connection errors retain and log the nested `ProviderWorkerBrokerError` operation and
detail. A regression test reproduces the observed rejection before any protocol fix is made. The
fix must address the proven ordering/identity/correlation cause; the broker continues to reject stale
generations, identity mismatches, sequence gaps, and unmatched responses.

## Security and Failure Behavior

- SuperTokens remains the browser identity boundary; prewarm is available only over the existing
  authenticated WebSocket RPC channel.
- The server derives project repository bindings and provider settings; the client supplies only a
  thread ID.
- Checkpoints contain the executable artifact and its digest marker only—never Gitea tokens, worker
  bootstrap credentials, user data, config files, repositories, or Pi session state.
- Checkpoint boot, partial clone, and prewarm are additive optimizations with explicit clean-path
  fallback. Provider startup continues to fail closed rather than silently running locally.
- Lifecycle generations and the existing `(sandboxId, workerId, lifecycleGeneration)` fence remain
  authoritative.

## Verification

Automated verification covers contract decoding, stage projection, checkpoint selection/fallback,
connection reuse, parallel bootstrap ordering, partial-clone fallback, prewarm authorization and
coalescing, active-session reuse, stage rendering, and the frame-rejection regression.

Live verification creates a fresh distributed Pi thread in Chrome, confirms prewarm visibly reaches
ready state before Send, sends a simple prompt, observes the response, sends a follow-up, and reloads
the page to prove durability. Railway logs and persisted runtime events must show the exact stage
durations, checkpoint use, no artifact upload on the checkpoint path, one sandbox for the thread,
and no frame rejection during the acceptance window.

The delivery target is a measured cold control path materially below the 11.1-16.2 second baseline;
when prewarm completes before Send, user-perceived Send-to-turn-dispatch should be near the warm
follow-up path.
