# Additive Railway Distributed Provider Runtime

**Date:** 2026-08-04
**Status:** Approved direction

## Goal

Allow the browser-hosted Synara deployment in Railway project `v4` to run an opt-in Pi thread inside a Railway Sandbox while preserving Synara's existing web protocol, orchestration engine, provider events, persistence behavior, and local provider runtime as the default.

The first production milestone is one end-to-end Pi canary thread. Later milestones add durable workspace rehydration, sandbox replacement, thread forking, and broader provider support without replacing the local path.

## Scope

- Browser web client, Synara server/control plane, and Railway Sandbox workers.
- Pi first, behind a server-authoritative opt-in setting.
- One warm sandbox per active distributed thread.
- Railway project `v4`, production environment, using private networking.
- A chronological engineering journal that records hypotheses, commands or experiments, observed failures, causes, corrections, and resulting decisions.
- Additive schemas, services, layers, settings, and adapter registrations.

## Non-goals for the First Milestone

- Electron or desktop packaging.
- Replacing SQLite or making the Synara control plane horizontally scalable.
- Moving every provider to remote execution.
- Treating Railway checkpoints as authoritative durable storage.
- Sharing a sandbox between unrelated threads.
- Exposing a sandbox directly to the public internet.

## Existing Seams to Reuse

Synara already has the primitives the distributed path needs:

- `ProviderAdapterShape` is the provider-neutral lifecycle boundary.
- `ProviderService` is the cross-provider facade used by orchestration.
- `ProviderCommandReactor` converts durable orchestration intent into provider calls.
- `ProviderRuntimeIngestion` journals and projects canonical `ProviderRuntimeEvent` values.
- `ProviderSessionDirectory` persists `adapterKey`, `lifecycleGeneration`, `resumeCursor`, and mergeable `runtimePayload` values per thread.
- Pi already runs through the direct Pi SDK and emits the canonical runtime event stream.
- Server settings already carry provider-scoped, server-authoritative behavior.

Distributed mode extends these seams. It does not introduce a second thread model, event model, message store, approval system, or browser transport.

## Considered Approaches

### Drive Pi through `railway sandbox exec`

The control plane would invoke a Pi CLI command for every turn and parse stdout. This is useful for an infrastructure smoke test but loses the existing direct-SDK behavior, interactive approvals, typed events, and long-lived session object. It would create a second provider protocol and is rejected as the product architecture.

### Run a complete Synara server per sandbox

Each sandbox would host another Synara server and the main service would proxy to it. This duplicates orchestration, persistence, WebSocket behavior, settings, and recovery logic. It creates conflicting sources of truth and is rejected.

### Run a thin remote `ProviderAdapter` worker

The selected approach runs the existing Pi adapter and its workspace inside a small worker mode built from the Synara server code. The main control plane speaks a provider-neutral command/event protocol to that worker. A remote proxy implements `ProviderAdapterShape`, so upstream orchestration is unchanged.

This is the smallest boundary that preserves Synara's existing correctness work while relocating only the machine-bound runtime.

## Architecture

The existing Synara service remains the control plane and browser endpoint. It owns authentication, WebSockets, orchestration, command delivery, event journaling, projections, approvals, and settings.

Add a `ProviderExecutionPlacement` service that chooses an adapter key when a new provider session starts:

- `pi:local` resolves to the existing Pi adapter.
- `pi:railway-sandbox` resolves to a remote adapter proxy.

The selected adapter key is persisted in the existing provider runtime binding. All later operations for that thread use the persisted key rather than re-reading mutable settings. Changing the setting affects new sessions only unless the user explicitly restarts a thread's provider session.

Add a `WorkspaceRuntime` boundary with two implementations:

- `LocalWorkspaceRuntime` describes the current in-process/filesystem placement and remains the default.
- `RailwaySandboxRuntime` provisions, reconnects, heartbeats, and destroys Railway Sandboxes through the Railway TypeScript SDK.

The first implementation may expose only the operations required by the remote adapter. The interface must remain provider-neutral and must not contain Pi-native command names.

Inside each sandbox, a `provider-worker` server entrypoint composes the existing Pi adapter, owns the workspace and Pi session files, connects outward to the Synara control plane, and processes typed provider commands. It does not run orchestration or access Synara's database.

## Settings and Configuration

Add a provider execution target to Pi's server settings:

```text
providers.pi.executionTarget = local | railway-sandbox
```

The decoding default is `local`. Existing settings files therefore preserve current behavior without migration work. The browser exposes the choice under Pi provider settings with an experimental warning and current runtime-health summary.

Railway credentials and environment identifiers are server-only environment configuration and are never returned through `ServerSettingsView`:

```text
SYNARA_RAILWAY_SANDBOX_TOKEN
SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID
SYNARA_RAILWAY_SANDBOX_REGION
SYNARA_RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES
```

Distributed mode fails closed when selected but incompletely configured. It never silently falls back to local execution because that would place code and credentials on an unexpected machine.

## Remote Provider Protocol

Place protocol schemas in `packages/contracts`; keep runtime logic in server modules.

Every control command carries:

- protocol version;
- command ID;
- thread ID;
- provider kind;
- adapter key;
- lifecycle generation;
- operation name;
- operation payload.

The first command set mirrors the existing adapter operations needed by Pi: start session, send turn, interrupt, respond to approval, respond to structured user input, read thread, rollback, compact, fork, stop session, and capability/discovery reads.

The worker first returns an acceptance or rejection receipt. Canonical `ProviderRuntimeEvent` values then flow independently from the worker to the control plane. Events carry the lifecycle generation and a worker-local monotonic sequence. The control plane rejects events from retired generations and durably journals accepted events through the existing ingestion path.

Transport is an authenticated WebSocket initiated by the worker over Railway private networking. Worker credentials are short-lived and scoped to one thread, sandbox, and lifecycle generation. A sandbox receives no SQLite/Postgres credentials and no long-lived Railway administration token.

## Sandbox Lifecycle

For a new distributed Pi thread:

1. Orchestration requests a Pi session through `ProviderService` as it does today.
2. Placement selects `pi:railway-sandbox` and persists a provisioning binding with a new lifecycle generation.
3. `RailwaySandboxRuntime` creates a private-network sandbox in the configured region and injects only the scoped worker bootstrap credential and artifact/repository bootstrap values.
4. The runtime prepares the exact Synara worker revision and repository workspace.
5. It starts the worker as a detachable long-running command.
6. The worker connects to the control plane and proves its thread, sandbox, and generation binding.
7. The remote adapter marks the session running and returns the normal `ProviderSession` value.
8. Turns, approvals, interrupts, and runtime events use the existing orchestration flow.
9. A controller heartbeat executes before Railway's idle timeout while a turn, approval, or warm lease is active.
10. On warm-lease expiry, the worker flushes recoverable state, reports a manifest, and the controller destroys the sandbox.

Sandbox IDs, detached command session names, worker instance IDs, lifecycle generations, last accepted event sequences, workspace revisions, and snapshot references live in the existing `runtimePayload` JSON until a proven query/indexing requirement justifies dedicated columns.

## Workspace and Session Persistence

The sandbox disk is working state, not durable authority.

- Git remains the canonical source history.
- Synara's event journal remains the canonical conversation history.
- Pi session files, workspace diffs, untracked-file archives, and generated artifacts are uploaded to S3-compatible object storage under generation-scoped keys.
- The control plane stores immutable object references and content hashes in the provider runtime payload.
- Railway templates cache common toolchain setup.
- Railway checkpoints accelerate prepared workspace startup but are disposable cache entries. Checkpoints do not preserve processes or memory and are limited per environment.

The first canary may keep a sandbox warm for continuity, but production acceptance requires a completed turn to be reconstructible after deliberate sandbox destruction.

## Recovery and Fencing

On control-plane restart, the runtime reconciler reads distributed bindings:

- If the recorded sandbox and detached worker session exist, reconnect and resume event delivery from the last accepted sequence.
- If the sandbox exists but the worker is gone, restart the worker only after incrementing the lifecycle generation or proving the old generation cannot emit.
- If the sandbox is gone, provision a replacement and rehydrate the latest verified snapshot.
- If snapshot integrity cannot be proven, surface a recoverable runtime error and retain the transcript; do not start locally.

Only one generation holds write authority for a thread. Command IDs are idempotent, and ambiguous delivery is reconciled through receipts rather than blind replay. Late events from an old sandbox are logged and discarded.

## Railway Trial Strategy

Experiments in project `v4` are deliberately incremental:

1. Create an isolated sandbox with no Synara credentials; verify create, exec, file API, detach, reconnect, heartbeat, and destroy.
2. Verify private-network connectivity to a narrow health endpoint, not to databases.
3. Run a local fake worker through the protocol and force disconnect/replay cases.
4. Run the worker bundle in a real sandbox without invoking a model.
5. Run one explicit Pi canary turn with a bounded provider-call budget.
6. Destroy the sandbox and prove completed-turn rehydration.
7. Enable the browser setting only after those checks pass.

Every sandbox receives a recognizable purpose label when the API supports it, a bounded idle timeout, and explicit teardown in success and failure paths. Experiments record resource IDs before mutation and verify teardown afterward.

## Engineering Journal

`docs/distributed-runtime/railway-v4-trial-log.md` is append-only during this project. Each entry records:

- timestamp and code revision;
- hypothesis and reason for the experiment;
- exact scope and external resources touched;
- observation, including unsuccessful output;
- root cause or current best explanation;
- correction and whether it was verified;
- architectural consequence;
- remaining uncertainty.

Secrets, raw tokens, and credential-bearing URLs are never written to the journal.

## Delivery Stages

### Stage 1: Lifecycle substrate

Add contracts, settings, placement, `WorkspaceRuntime`, a fake runtime, and a Railway SDK implementation. Validate reversible sandbox lifecycle operations in `v4` without provider calls.

### Stage 2: Remote adapter transport

Add the worker protocol, authenticated connection, remote adapter proxy, worker entrypoint, command receipts, generation fencing, and deterministic local integration tests.

### Stage 3: Pi canary

Prepare the worker in a real Railway Sandbox and send one bounded Pi thread through the browser while local remains the default.

### Stage 4: Durable rehydration

Externalize Pi/workspace snapshots to object storage, deliberately destroy the sandbox, recreate it, and continue the thread.

### Stage 5: Operational hardening

Add quotas, metrics, reconciliation dashboards, orphan reaping, cost controls, and additional provider adapters. A separate design will address shared SQL storage and horizontally scaling the control plane.

## Testing

Implementation follows test-first development.

- Contract tests reject version, provider, generation, and payload mismatches.
- Settings tests prove missing fields decode to local execution and incomplete distributed configuration fails closed.
- Placement tests prove existing bindings remain sticky across setting changes.
- Runtime tests cover create, reconnect, keepalive, destroy, timeout, and orphan cleanup with a fake Railway client.
- Protocol tests cover authentication, receipts, duplicate commands, reconnect sequence replay, and stale-generation rejection.
- Remote adapter contract tests reuse provider fixtures wherever possible.
- Integration tests run a fake Pi adapter across a real local WebSocket boundary.
- Railway smoke tests are explicit and opt-in; they create named resources, enforce call/resource budgets, and always verify teardown.
- Browser acceptance proves a Pi response arrives through existing orchestration events with no new UI transcript path.

Desktop-only suites and packaging are outside this feature's verification gate. Focused server, contracts, shared, and web tests plus server/web production builds are required. Repository-wide `fmt`, `lint`, and `typecheck` remain subject to the repository instruction requiring explicit user request.

## Acceptance Criteria for the First End-to-End Milestone

- Existing installations and settings continue using the unchanged local adapters.
- Selecting Railway Sandbox execution for Pi affects only newly started Pi sessions.
- A browser-created Pi thread provisions one sandbox in Railway project `v4` and receives its answer through the existing Synara transcript flow.
- Approvals, interrupts, terminal settlement, and runtime errors remain canonical Synara events.
- The sandbox cannot access Synara's database and has no public endpoint.
- A control-plane reconnect does not duplicate a command or accept stale-generation events.
- Completed-turn state is uploaded before sandbox teardown and can be integrity-checked.
- The sandbox is destroyed after the configured warm lease or explicit stop.
- The engineering journal includes failed experiments and course corrections as well as successful steps.

