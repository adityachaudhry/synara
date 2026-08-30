# Task 3 Report: Generic distributed Railway provider runtime

## Outcome

Implemented and committed the generic distributed Railway Pi runtime as:

- `0bd6ce101e2ba8bce1ad7101558155f80c9175ec` — `feat(server): add distributed Railway Pi runtime`
- `c5fb7269b` — `fix(server): harden distributed Pi runtime lifecycle`
- `6ca8a9cb3` — `fix(server): persist distributed workspace cleanup ownership`
- `c63fc028a` — `fix(server): make workspace reconciliation crash-safe`

The implementation is limited to one generic Railway workspace adapter, one provider-worker protocol/broker/provisioner chain, and one routed Pi seam. Existing local Pi sessions and every non-Pi provider retain their upstream paths. Remote execution is admitted only when a Pi session carries the canonical repository binding introduced by Task 2.

No Railway, Gitea, deployment, or other external infrastructure was mutated.

## Delivered design

- Added the schema-only provider-worker protocol to `@synara/contracts`, with versioned, generation-fenced registration, requests, responses, events, heartbeats, acknowledgements, and retirement frames.
- Added the generic `WorkspaceRuntime` and Railway Sandbox SDK 3.7 adapter for create/connect/list/exec/file transfer/durable process lifecycle/keepalive/destroy.
- Added a server-only bootstrap authority, pre-upgrade authenticated WebSocket route, broker, reconnectable worker client, ordered retained event outbox, response ledger, and Pi request dispatcher.
- Added the provider-worker provisioner with per-thread locking, idempotent same-generation create, stale-generation rejection, authoritative old-sandbox destruction on replacement, and idempotent stop.
- Added generic repository checkout from the already-admitted `ProjectRepositoryBinding`. Server-owned authorization is written only to a checkout-scoped Git config, never appears in the sandbox environment or command line, and is erased before Pi starts. A failed erasure aborts provisioning and destroys the sandbox.
- Added `RoutedPiAdapter`: unbound Pi sessions stay local; repository-bound Pi sessions use the worker; the runtime binding is persisted in the existing provider session runtime payload and rehydrated after controller restart.
- Added broker assignment fencing so a worker can emit only Pi events for its assigned thread and lifecycle generation.
- Added restart cleanup that finds persisted remote bindings for `stopSession`/`stopAll`, even before an in-memory adapter binding has been rebuilt. Sandbox destruction remains authoritative if the remote `session.stop` response is lost.
- Added the worker entrypoint to the generic server build and release staging. The release test packs the real server archive, extracts it, starts the exact extracted worker entrypoint, completes a fenced local WebSocket registration, retires it, and observes exit code 0.

## Blocking-review hardening

- The worker now consumes and immediately deletes its mode-`0600` bootstrap config before initializing Pi. It retains the generation-fenced credential only in worker memory for reconnects.
- Bootstrap authentication moved out of protocol frames and into a non-URL `Authorization` header checked before WebSocket upgrade. Browser `Origin` requests are rejected, worker frames are capped at 256 KiB, and the existing ten-second registration deadline remains enforced.
- Railway create now carries a server-generated operation identity through the SDK-supported sandbox environment. Failed, interrupted, timed-out, and lost-response creates reconcile inventory by that marker and destroy the matching sandbox without needing the original create binding.
- Transient socket loss retains the controller request ID and replays it on the same fence. The worker executes each request ID once, retains its response until acknowledgement, and keeps a bounded acknowledged-response tombstone so an acknowledgement/replay race cannot duplicate `turn.send`.
- An uncertain routed `turn.send` failure authoritatively stops/destroys the remote runtime before returning failure. If destruction itself fails, the adapter reports that stronger cleanup failure.
- Routed Pi discovery now preserves local and healthy remote sessions when one remote worker is unavailable. Non-Pi provider discovery is unchanged.
- Workspace network isolation is an explicit create policy with `ISOLATED` as the safe default; provider-worker provisioning requests `PRIVATE` only when explicitly configured.
- Unused remote model, skill, command, and composer protocol methods were removed; local discovery continues through the upstream Pi adapter.

## Second review hardening

- Repository checkout now runs inside an uninterruptible cleanup boundary. Success, typed failure, defect, and fiber interruption all converge on credential erasure before any worker/Pi process can start. An unconfirmed erase aborts provisioning and triggers authoritative sandbox destruction; if destruction also fails, the stronger `workspace.cleanup` failure is surfaced instead of being swallowed.
- Railway create ownership is now durable rather than a bounded client retry. Migration 98 adds one credential-free `workspace_creation_intents` table containing only the server-generated operation ID, optional returned runtime ID, and creation timestamp.
- `WorkspaceRuntime.create` commits the intent before calling the Railway SDK. The live controller temporarily reserves the operation ID in memory, binds the returned runtime ID when available, and releases the durable intent only after `RoutedPiAdapter` has persisted the provider runtime binding and calls `adopt`, or after authoritative destruction succeeds.
- A scoped background reconciler reads pending intents after startup. Known runtime IDs are destroyed directly; lost-response intents are found through the SDK-supported operation marker. A no-match pass does not expire the intent, and transient list/connect/destroy failures retry indefinitely with bounded backoff. Unrelated operation markers are never destroyed.
- The former process-local 30-attempt create cleanup was removed from the Railway client. This avoids two competing owners and prevents a sandbox that appears after the old window from becoming unowned.

### Why a late create remains owned across restart

The SQLite intent is committed before `Sandbox.create` begins, and it contains no token, repository credential, worker bootstrap credential, or environment payload. The same operation ID is placed in the Railway sandbox's SDK-supported environment marker. If the controller is interrupted before receiving a binding, its in-memory reservation disappears but the SQLite row does not. A restarted controller reloads that row and keeps scanning; an empty inventory scan leaves the row intact forever rather than treating absence as terminal. When the delayed sandbox becomes visible, its operation marker identifies it, destruction is confirmed, and only then is the row removed. If the SDK response arrived first, the stored runtime ID gives the restarted controller a direct destruction path. Normal successful sessions clear the row only after their existing provider runtime binding is durable.

## Third review atomicity hardening

- Marker discovery is now read-only: `RailwaySandboxClient` returns the exact matching runtime ID without destroying anything. The workspace reconciler first persists that ID into the existing creation intent, then destroys that exact runtime, treats exact-ID `NotFound` as terminal, and only then clears the intent. A crash after discovery, after binding, or after destruction therefore has a durable restart state and converges without touching unrelated runtimes.
- Active create ownership is reserved in memory before the intent becomes visible in SQLite. The insert runs inside the existing uninterruptible create boundary; failed or duplicate inserts remove the reservation before returning failure. Duplicate operation IDs now fail the database insert instead of silently sharing one intent.

### Final ordering invariant

Create follows `reserve operation ID in memory -> insert durable intent -> invoke Railway create -> bind returned runtime ID -> persist provider runtime binding -> adopt/clear intent`. Reconciliation skips every in-memory reservation and follows `discover marker without mutation -> durably bind exact runtime ID -> destroy exact runtime ID (NotFound is terminal) -> clear intent`. No step that loses the only locator precedes the durable write needed by the next restart.

## Security and scope boundaries

- Worker bootstrap credentials stay in the server/worker boundary, are initially stored in the sandbox config with mode `0600`, are deleted at worker startup, and are generation-fenced and revocable. Reconnect is permitted only for the exact pre-authenticated fence.
- The worker has no browser-facing HTTP server. Its only connection is outbound to the controller's internal worker WebSocket route.
- Worker registration, every frame, persisted event acknowledgement, assigned thread, provider kind, and lifecycle generation are validated before ingress.
- Remote repositories are checked out only from a canonical admitted binding. This task does not add browser repository selection or catalog discovery.
- No Glasswing, ChipSage, SuperTokens, company catalog, Gitea catalog, plugin system, scheduler service, Redis, capacity manager, or provider-generalization layer was added.
- Task 4 capacity/queue behavior remains deliberately deferred.

## TDD evidence

The initial focused tests were introduced before their implementations and failed for the expected missing seams:

- contracts failed because `./providerWorker` did not exist;
- 15 focused server suites failed because workspace-runtime and provider-worker modules were absent;
- repository checkout tests failed because the generic checkout seam and authorization handling were absent;
- release installation failed because the exact extracted worker artifact was not started/probed;
- lifecycle tests exposed duplicate worker creation, missing stale-generation rejection, and a missing routed `threadId`.

During the final v3 hardening audit, two more explicit RED runs were recorded before the fixes:

- broker identity plus persisted restart cleanup: 4 failed, 12 passed;
- concurrent worker event writes: 1 failed, 2 passed, with observed order `[2, 1]` instead of `[1, 2]`.

The minimum implementations then made those focused tests green.

The blocking-review fixes also followed focused RED/GREEN cycles:

- bootstrap-file consumption, checkout-only credentials, safe network defaults, and provisioner cleanup: **7 failed, 20 passed** before implementation;
- lost/delayed Railway create reconciliation: **2 failed** before operation tagging and orphan cleanup;
- reconnect-safe broker replay and the worker response ledger: broker replay failures plus a missing ledger module before implementation;
- uncertain routed turns and degraded remote discovery: **2 failed, 6 passed** before authoritative cleanup and per-worker omission;
- pre-upgrade header authentication, fence matching, browser rejection, and the worker payload cap: **9 failed, 5 passed** before implementation;
- mandatory checkout credential erasure: **1 failed, 6 passed** before cleanup failure became fatal;
- the late acknowledgement/replay race: **1 failed** because `turn.send` executed twice, then passed with the bounded acknowledged-response tombstone.
- interruption-safe checkout cleanup: **2 failed, 7 passed** before fiber-exit finalization and authoritative destroy failure reporting; the new interruption and double-cleanup-failure cases then passed;
- durable create ownership: the persistence and Railway cleanup tests first failed on the missing repository/method, then the workspace runtime suite recorded **3 failed, 7 passed** because no intent preceded create, no operation ID was returned, and interruption lost ownership; the minimum durable boundary made all cases green;
- migration-lineage verification exposed **4 expected-list failures** after adding migration 98; the lineage expectations were updated and all 19 migration tests passed.
- marker cleanup atomicity first failed because the Railway seam still destroyed and returned a boolean; focused crash/restart coverage was added for discovery-before-bind, bind-before-destroy, and destroy-before-clear before the read-only discovery seam was implemented;
- active-create publication recorded **2 failed, 16 passed**: reconciliation reached an intent while its insert was blocked, and a duplicate insert incorrectly succeeded. Reserving before publication and restoring the SQLite uniqueness failure made both cases green.

## Final verification

All commands used Node 24 in `PATH` and Bun 1.3.12 through `npx`. `bun test` was never used.

- Round-two focused workspace runtime, Railway adapter, checkout cleanup, routed Pi adoption, and intent persistence tests: **5 files, 43 tests passed**. The file-backed SQLite restart test also passed independently (**2 tests** in its persistence file).
- Round-two affected integration suite, including all migrations and the global provider boundary: **8 files, 151 tests passed** after updating migration 98 expectations.
- Full `packages/contracts` suite: **20 files, 249 tests passed**.
- Full `packages/shared` suite: **59 files; 565 passed, 1 skipped**.
- Final round-two full `apps/server` suite: **378 files passed, 3 skipped; 4,192 tests passed, 16 skipped**.
- Round-three focused workspace runtime, Railway adapter, persistence/migrations, provisioner, and routed Pi suites: **6 files, 68 tests passed**.
- Final round-three full `apps/server` suite: **378 files passed, 3 skipped; 4,197 tests passed, 16 skipped**.
- Generic server build: passed, including `dist/provider-worker/workerMain.mjs`.
- Post-build archive extraction/install and exact-artifact startup probe: **1 test passed**, including header-only authentication and proof that the extracted worker deleted its bootstrap file before registration.
- Product-coupling scan over the new runtime paths for Glasswing/ChipSage/SuperTokens/company-catalog/Gitea identifiers: no matches.
- `git diff --cached --check`: passed before the implementation commit.

Per the explicit task instruction, `bun fmt`, `bun lint`, and `bun typecheck` were not run.

## Remaining risks and deferred evidence

- No live Railway Sandbox was created. SDK behavior is covered by focused adapter/lifecycle tests; real environment credentials, private-network reachability, idle behavior, and remote process durability remain Task 7 canary evidence.
- Railway must still confirm in canary that its internal proxy preserves the worker `Authorization` header and that the SDK-provided environment marker is visible soon enough for delayed-create reconciliation.
- Checkout credential removal, file modes, and provider-environment isolation are covered by the adapter/provisioner/archive tests; the live sandbox filesystem boundary remains canary evidence.
- Capacity limits, FIFO queueing, cancellation, startup capacity reconciliation, and orphan reporting belong to Task 4 and are intentionally absent.
- Pending Railway create cleanup now survives controller restart in SQLite. Active worker routing still assumes one control-plane replica, consistent with the approved initial architecture; horizontal live-session ownership remains a separate design.
- Repository authorization is generic and server-configured. Its external identity/project authorization boundary is Task 5; Glasswing company policy remains outside Synara.
