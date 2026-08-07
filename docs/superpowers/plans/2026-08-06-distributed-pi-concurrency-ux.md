# Distributed Pi Concurrency UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make distributed Pi preparation invisible and single-flight per thread while proving five independent project threads run concurrently.

**Architecture:** Preserve durable `runtime.stage` telemetry but filter it from the browser conversation timeline. Reuse the server's cancellation-safe keyed single-flight cache with zero TTL at the `ensureSessionForThread` boundary, so same-thread callers share one attempt and different threads remain independent.

**Tech Stack:** TypeScript, React, Effect, Vitest, Railway Sandbox SDK and CLI, SuperTokens-authenticated WebSocket RPC.

## Global Constraints

- Distributed Pi remains an additive adapter over the existing Pi provider and orchestration model.
- SuperTokens remains the browser authentication boundary.
- `orchestration_events` and `provider_runtime_events` remain durable truth; sandbox compute is disposable.
- No global sandbox limit or provisioning semaphore is introduced.
- Test cleanup targets only exact sandbox ids created by the test.
- Do not run `bun test`; use focused Vitest commands.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` without an explicit user request.

---

### Task 1: Hide controller stages from the conversation timeline

**Files:**
- Modify: `apps/web/src/workLog.ts`
- Modify: `apps/web/src/workLog.test.ts`

**Interfaces:**
- Consumes: durable `OrchestrationThreadActivity` values whose `kind` can be `runtime.stage`.
- Produces: `deriveWorkLogEntries(...)` and `deriveTimelineEntries(...)` results that exclude routine controller stages.

- [ ] **Step 1: Write the failing test**

Add a test with a pre-turn `runtime.stage` activity and no messages. Assert both
`deriveWorkLogEntries(...)` and `deriveTimelineEntries(...)` return empty arrays.

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run apps/web/src/workLog.test.ts`

Expected: FAIL because the current work log contains `Creating sandbox`.

- [ ] **Step 3: Write minimal implementation**

Filter `runtime.stage` activities before they are converted to `DerivedWorkLogEntry` values. Keep
the durable activity schema and server projection unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run apps/web/src/workLog.test.ts`

Expected: PASS with no `runtime.stage` row.

- [ ] **Step 5: Commit**

Commit message: `fix(web): keep Pi prewarm stages out of transcript`

### Task 2: Coalesce preparation with the shared single-flight primitive

**Files:**
- Create: `apps/server/src/concurrency/KeyedSingleFlightCache.ts`
- Create: `apps/server/src/concurrency/KeyedSingleFlightCache.test.ts`
- Modify: `apps/server/src/pullRequests/KeyedSingleFlightCache.ts`
- Modify: `apps/server/src/pullRequests/KeyedSingleFlightCache.test.ts`
- Modify: `apps/server/src/pullRequests/Layers/PullRequestService.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`

**Interfaces:**
- Consumes: `makeKeyedSingleFlightCache<A, E>({ maxEntries, ttlMs })` and an Effect keyed by thread id.
- Produces: same-key failure sharing, zero-TTL success behavior, and independent execution for different keys.

- [ ] **Step 1: Write the failing tests**

Add one primitive test where two waiters join a failing key and the loader executes once. Add one
reactor test where two simultaneous distributed-Pi `prepareThread` calls share one failing
`ProviderService.startSession` invocation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run apps/server/src/concurrency/KeyedSingleFlightCache.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`

Expected: the new primitive path is absent and the reactor invokes startup twice.

- [ ] **Step 3: Write minimal implementation**

Move the existing generic cache implementation to `concurrency/`, leave a compatibility re-export
at the pull-request path, and construct a zero-TTL cache in `ProviderCommandReactor`. Route
`ensureSessionForThread` through `cache.get(threadId, ensureSessionForThreadUnlocked(...))`.

- [ ] **Step 4: Run tests to verify they pass**

Run the same Vitest command. Expected: both same-thread callers observe one failure and distinct
keys can still execute together.

- [ ] **Step 5: Commit**

Commit message: `fix(server): single-flight distributed Pi preparation`

### Task 3: Deploy and pressure-test five projects

**Files:**
- Modify: `docs/distributed-runtime/railway-v3-gitea-company-projects-trial-log.md`

**Interfaces:**
- Consumes: current checkpoint, dev Railway environment, deployed browser application.
- Produces: five project ids, five thread ids, five sandbox ids, five completed Pi answers, and cleanup evidence.

- [ ] **Step 1: Run focused verification**

Run the touched web/server suites plus the contracts, provider-worker, server, and web builds. Run
`git diff --check`. Do not run the forbidden heavyweight workspace commands.

- [ ] **Step 2: Deploy the exact committed archive**

Materialize `git archive HEAD` in a temporary directory and deploy it to the linked
`synara-gitea-dev` service with `railway up --path-as-root`.

- [ ] **Step 3: Verify health and deployment identity**

Confirm the deployment status is `SUCCESS`, record its id and image digest, and verify `/health`
reports every startup readiness field true.

- [ ] **Step 4: Run the browser pressure test**

Create five projects and five new threads, select Pi in each, observe that all five empty landings
remain stable during preparation, send one unique prompt per thread, and wait for all five answers.
During the run, `railway sandbox list --json` must show at least five independent `RUNNING`
sandboxes.

- [ ] **Step 5: Clean up and document**

Destroy only the exact pressure-test sandbox ids, verify none remain active, and append timings,
failed attempts, causes, corrections, deployment evidence, and browser outcomes to the trial log.

- [ ] **Step 6: Commit**

Commit message: `docs: record five-way Pi sandbox pressure test`

