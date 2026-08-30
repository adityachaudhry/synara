# Task 3 Report: Generic distributed Railway provider runtime

## Outcome

Implemented and committed the generic distributed Railway Pi runtime as:

- `0bd6ce101e2ba8bce1ad7101558155f80c9175ec` — `feat(server): add distributed Railway Pi runtime`

The implementation is limited to one generic Railway workspace adapter, one provider-worker protocol/broker/provisioner chain, and one routed Pi seam. Existing local Pi sessions and every non-Pi provider retain their upstream paths. Remote execution is admitted only when a Pi session carries the canonical repository binding introduced by Task 2.

No Railway, Gitea, deployment, or other external infrastructure was mutated.

## Delivered design

- Added the schema-only provider-worker protocol to `@synara/contracts`, with versioned, generation-fenced registration, requests, responses, events, heartbeats, acknowledgements, and retirement frames.
- Added the generic `WorkspaceRuntime` and Railway Sandbox SDK 3.7 adapter for create/connect/list/exec/file transfer/durable process lifecycle/keepalive/destroy.
- Added a server-only bootstrap authority, authenticated WebSocket route, broker, reconnectable worker client, ordered retained event outbox, and Pi request dispatcher.
- Added the provider-worker provisioner with per-thread locking, idempotent same-generation create, stale-generation rejection, authoritative old-sandbox destruction on replacement, and idempotent stop.
- Added generic repository checkout from the already-admitted `ProjectRepositoryBinding`. Server-owned authorization is passed through sandbox environment only and is not embedded in the checkout command or worker protocol.
- Added `RoutedPiAdapter`: unbound Pi sessions stay local; repository-bound Pi sessions use the worker; the runtime binding is persisted in the existing provider session runtime payload and rehydrated after controller restart.
- Added broker assignment fencing so a worker can emit only Pi events for its assigned thread and lifecycle generation.
- Added restart cleanup that finds persisted remote bindings for `stopSession`/`stopAll`, even before an in-memory adapter binding has been rebuilt. Sandbox destruction remains authoritative if the remote `session.stop` response is lost.
- Added the worker entrypoint to the generic server build and release staging. The release test packs the real server archive, extracts it, starts the exact extracted worker entrypoint, completes a fenced local WebSocket registration, retires it, and observes exit code 0.

## Security and scope boundaries

- Worker bootstrap credentials stay in the server/worker boundary, are stored in the sandbox config with mode `0600`, and are generation-fenced and revocable. Reconnect is permitted only for the exact reserved fence.
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

## Final verification

All commands used Node 24 in `PATH` and Bun 1.3.12 through `npx`. `bun test` was never used.

- Focused workspace runtime, Railway adapter, repository checkout, protocol, broker, bootstrap/fencing, reconnect, provisioner lifecycle, routed Pi, persistence/restart, and release tests: **17 files, 82 tests passed**.
- Full `packages/contracts` suite: **20 files, 246 tests passed**.
- Full `packages/shared` suite: **59 files; 565 passed, 1 skipped**.
- Full `apps/server` suite after the final broker/restart changes: **376 files passed, 3 skipped; 4,172 tests passed, 16 skipped**.
- Generic server build: passed, including `dist/provider-worker/workerMain.mjs`.
- Post-build archive extraction/install and exact-artifact startup probe: **1 test passed**.
- Product-coupling scan over the new runtime paths for Glasswing/ChipSage/SuperTokens/company-catalog/Gitea identifiers: no matches.
- `git diff --cached --check`: passed before the implementation commit.

Per the explicit task instruction, `bun fmt`, `bun lint`, and `bun typecheck` were not run.

## Remaining risks and deferred evidence

- No live Railway Sandbox was created. SDK behavior is covered by focused adapter/lifecycle tests; real environment credentials, private-network reachability, idle behavior, and remote process durability remain Task 7 canary evidence.
- Capacity limits, FIFO queueing, cancellation, startup capacity reconciliation, and orphan reporting belong to Task 4 and are intentionally absent.
- Controller ownership remains process-local and assumes one control-plane replica, consistent with the approved initial architecture. Horizontal ownership would require a separate design.
- Repository authorization is generic and server-configured. Its external identity/project authorization boundary is Task 5; Glasswing company policy remains outside Synara.
