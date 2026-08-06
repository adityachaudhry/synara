# Distributed Pi Cold-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce distributed Pi first-turn latency with a worker-ready Railway base, parallel bootstrap, per-thread browser prewarming, durable stage telemetry, and a proven worker-frame reliability fix.

**Architecture:** Extend the existing `WorkspaceRuntime`, `ProviderWorkerProvisioner`, routed Pi adapter, provider runtime event stream, authenticated WebSocket API, and orchestration projections. Keep local Pi and the clean sandbox path unchanged as fallbacks; do not introduce a parallel orchestrator, provider protocol, identity system, or shared mutable sandbox.

**Tech Stack:** TypeScript, Effect, Vitest, React/Vite, Railway Sandbox SDK 3.7, SQLite orchestration/provider journals, SuperTokens-authenticated WebSocket RPC.

## Global Constraints

- Preserve local Pi as the default and fail closed for distributed startup failures.
- Reuse existing Synara lifecycle generations, runtime bindings, provider event journals, projections, and session idle cleanup.
- Keep mutable sandbox state isolated per thread; checkpoints contain no secrets or company/user data.
- Use test-driven development for every behavior change and `bun run test`, never `bun test`.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` without an explicit user request naming those commands.
- Verify the deployed browser-only path in Chrome and measure it from both Railway logs and durable telemetry.

---

### Task 1: Canonical runtime-stage telemetry

**Files:**
- Modify: `packages/contracts/src/providerRuntime.ts`
- Modify: `packages/contracts/src/providerRuntime.test.ts`
- Modify: `apps/server/src/orchestration/providerRuntimeActivityProjection.ts`
- Modify: `apps/server/src/orchestration/providerRuntimeActivityProjection.test.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.test.ts`
- Modify: `apps/web/src/workLog.ts`
- Modify: `apps/web/src/workLog.test.ts`

**Interfaces:**
- Produces `ProviderRuntimeStageEvent` with stage, state, cold, elapsedMs, and detail payload.
- Produces durable `runtime.stage` thread activities and concise browser work-log rows.

- [ ] Write contract, projection, routed-stream, and work-log tests that fail because `runtime.stage` is unknown.
- [ ] Run the four focused test files and confirm schema/projection/render failures.
- [ ] Add the `runtime.stage` schema, controller-side stage queue, activity projection, and work-log mapping.
- [ ] Run the focused tests and confirm all new stage behaviors pass.

### Task 2: Explain and fix worker frame rejection

**Files:**
- Modify: `apps/server/src/providerWorker/providerWorkerConnection.ts`
- Modify: `apps/server/src/providerWorker/providerWorkerConnection.test.ts`
- Modify: `apps/server/src/providerWorker/Layers/ProviderWorkerBroker.ts`
- Modify: `apps/server/src/providerWorker/Layers/ProviderWorkerBroker.test.ts`
- Modify if evidence requires: `apps/server/src/providerWorker/workerClientSession.ts`
- Modify if evidence requires: `apps/server/src/providerWorker/workerClientSession.test.ts`

**Interfaces:**
- Preserves the nested broker `operation` and `detail` in controller logs and transport errors.
- Serializes or makes idempotent only the exact frame class proven to race; all fencing checks remain.

- [ ] Add a failing connection test asserting the nested rejection reason is retained and logged.
- [ ] Run the connection test and confirm the reason is currently missing.
- [ ] Implement structured cause retention, deploy diagnostic instrumentation if the existing tests cannot reproduce the live rejection, and capture the precise live broker cause.
- [ ] Write a failing regression test for that cause and verify the failure.
- [ ] Implement the minimal ordering/correlation fix and run broker, connection, client-session, and outbox tests.

### Task 3: Worker-ready Railway checkpoint and client reuse

**Files:**
- Create: `apps/server/src/providerWorker/workerArtifactBase.ts`
- Create: `apps/server/src/providerWorker/workerArtifactBase.test.ts`
- Create: `apps/server/scripts/prepare-railway-worker-checkpoint.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/workspaceRuntime/railwaySandboxConfig.ts`
- Modify: `apps/server/src/workspaceRuntime/railwaySandboxConfig.test.ts`
- Modify: `apps/server/src/workspaceRuntime/Services/RailwaySandboxClient.ts`
- Modify: `apps/server/src/workspaceRuntime/Layers/RailwaySandboxClient.ts`
- Modify: `apps/server/src/workspaceRuntime/Layers/RailwaySandboxClient.test.ts`
- Modify: `apps/server/src/workspaceRuntime/Services/WorkspaceRuntime.ts`
- Modify: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.ts`
- Modify: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.test.ts`

**Interfaces:**
- Produces `workerArtifactDigest()` and deterministic `workerCheckpointName()`.
- Adds optional checkpoint boot input and reports whether the requested base was used.
- Keeps clean `Sandbox.create(options)` fallback and cached handle behavior.

- [ ] Write failing digest/name, config, checkpoint selection/fallback, and handle-reuse tests.
- [ ] Run focused tests and confirm checkpoint/base fields and reuse behavior are absent.
- [ ] Implement deterministic checkpoint configuration and SDK boot fallback without persisting secrets.
- [ ] Implement the checkpoint-preparation script using exact-name list/delete, clean seed creation, artifact upload, digest marker, checkpoint capture, and seed destruction.
- [ ] Run focused artifact-base, config, Railway client, and workspace runtime tests.

### Task 4: Parallel worker bootstrap and cheaper Gitea hydration

**Files:**
- Modify: `apps/server/src/providerWorker/giteaCheckout.ts`
- Modify: `apps/server/src/providerWorker/giteaCheckout.test.ts`
- Modify: `apps/server/src/providerWorker/Services/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner.test.ts`
- Modify: `apps/server/src/providerWorker/runtimeBinding.ts`

**Interfaces:**
- `ProviderWorkerProvisionInput` carries thread identity and an Effect stage callback.
- Provisioning overlaps checkout with artifact/config preparation and reports artifact source plus checkout mode.
- Gitea fetch attempts `--depth=1 --no-tags --filter=blob:none` before the existing compatible fallback.

- [ ] Write failing tests for partial-clone fallback, checkpoint artifact skip, stage order/durations, and checkout/file overlap.
- [ ] Run focused tests and confirm the old serial order and fetch command fail expectations.
- [ ] Split file preparation from process start, overlap independent effects, and retain authoritative cleanup on either branch failure.
- [ ] Add partial-clone fallback and immutable commit parsing without exposing the checkout token.
- [ ] Run provisioner and checkout tests, then run the provider-worker artifact smoke.

### Task 5: Authenticated idempotent thread prewarming

**Files:**
- Modify: `packages/contracts/src/provider.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ws.ts`
- Modify: `packages/contracts/src/ws.test.ts`
- Create: `apps/server/src/provider/threadPrewarm.ts`
- Create: `apps/server/src/provider/threadPrewarm.test.ts`
- Modify: `apps/server/src/wsRpc.ts`
- Modify: `apps/server/src/wsRpc.test.ts`
- Modify: `apps/web/src/wsNativeApi.ts`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.logic.ts`
- Modify: `apps/web/src/components/ChatView.logic.test.ts`

**Interfaces:**
- Adds authenticated `provider.prepareThread({ threadId }) -> { status, session }` RPC.
- Server resolves thread/project/provider/runtime options and coalesces concurrent preparation.
- Browser issues one best-effort hint after meaningful composer intent for a distributed Pi thread.

- [ ] Write failing RPC contract, server coalescing/security, active-session reuse, and browser trigger tests.
- [ ] Run focused contract/server/web tests and confirm the prewarm surface is absent.
- [ ] Implement server-owned input resolution, normal `ProviderService.startSession`, durable `thread.session.set`, and in-flight coalescing.
- [ ] Implement browser trigger/cancellation rules without blocking typing, Send, or non-distributed threads.
- [ ] Run the focused prewarm and ChatView logic tests.

### Task 6: Verification, deployment, Chrome acceptance, and learning log

**Files:**
- Modify: `docs/distributed-runtime/railway-v3-gitea-company-projects-trial-log.md`
- Modify: `docs/distributed-runtime/railway-v4-trial-log.md` if the generic Sandbox primitive changes.

**Interfaces:**
- Produces a digest-named Railway worker checkpoint, a deployed dev controller using it, Chrome evidence, and before/after stage telemetry.

- [ ] Run contracts, server, and web focused suites plus provider-worker and application builds required by the changed surfaces.
- [ ] Build/capture the worker checkpoint, set the additive dev configuration, deploy the exact committed source archive, and verify health/readiness.
- [ ] In Chrome, open a fresh distributed Pi thread, trigger prewarm, observe stage UI, send a simple first prompt, send a follow-up, and reload.
- [ ] Query Railway structured logs and durable provider events for stage durations, checkpoint source, artifact-upload absence, sandbox identity, and frame-rejection absence.
- [ ] Compare the measured result with the 11.1-16.2 second baseline and document every failed attempt, cause, correction, and residual boundary.
- [ ] Audit each design requirement against source, tests, deployment state, Chrome state, and telemetry before marking the goal complete.
