# Task 4 Report: Bounded FIFO Railway sandbox capacity

## Outcome

Implemented and committed bounded Railway sandbox admission as:

- `1314cd1af` — `feat(server): bound Railway sandbox capacity`
- `f41d58240` — `fix(server): harden sandbox capacity lifecycle`
- `1790e021f` — `fix(server): bound full remote Pi launch`

The implementation adds one process-local FIFO capacity service, one positive-integer Railway capacity setting, and the minimum contract/projection/UI additions needed to show queued sessions and their positions. It composes with Task 3's durable workspace creation intents and provider runtime bindings; it does not add a second cleanup owner or alter Task 3's marker reconciliation ordering.

No Railway or other external infrastructure was mutated.

## Delivered behavior

- Added `SandboxCapacity`, a process-local, strict-FIFO lease service keyed by the distinct thread lifecycle generation. Same-key acquisitions share one lease, cancellation removes a waiter and immediately compacts later positions, and release is idempotent.
- Added `SYNARA_RAILWAY_MAX_ACTIVE_SANDBOXES`. Missing configuration defaults conservatively to one active Railway sandbox; zero, negative, fractional, and non-numeric values fail closed during startup. Disabled/local runtime configuration never constructs or consumes Railway capacity.
- Moved capacity acquisition before durable intent publication and Railway create. A successful lease remains held across sandbox creation, worker bootstrap, binding persistence, adoption, and the complete worker lifetime.
- Releases occur after authoritative destroy/NotFound confirmation or terminal create cleanup. SDK create uncertainty deliberately retains both the durable intent and permit until Task 3's sole reconciler finds and cleans the possible sandbox.
- Persisted `capacityKey` in new distributed runtime bindings. Decoding a legacy Task 3 binding synthesizes the same key from its persisted thread and lifecycle generation, so a controller restart can release recovered occupancy on stop/destroy.
- Preserved stale-generation replacement ordering: the old sandbox is authoritatively destroyed and its permit released before replacement creation can acquire capacity. A queued same-key retry present while startup reconciliation is closed inherits its recovered lease, avoiding self-deadlock.
- Added startup reconciliation before admission. Occupancy is rebuilt from listed Railway runtimes with durable live provider bindings plus every pending creation intent, including unresolved intents whose sandbox may appear later. Inventory failure keeps admission closed and retries with bounded backoff.
- Reports unowned listed runtimes through a warning only. No destructive orphan policy was added.
- Added canonical `runtime.capacity.changed` events to the existing provider runtime stream. Queue positions are projected into the existing orchestration session status, normalized through the existing connecting UI path, and shown as `Queued #N`. Position state clears on cancellation/admission/failure transitions.

## Blocking review hardening

- Stale replacement now keeps the old binding addressable and unretired while authoritative destruction is attempted. A failed destroy therefore leaves a retryable handle; a later stop retries destruction, releases the original permit, and allows a replacement at capacity one. The old generation is marked retired and replaced in memory only after replacement succeeds.
- Initial capacity recovery and Task 3 intent cleanup no longer start as independent fibers. Recovery installs every durable occupied reservation and opens admission first; only then does the existing intent cleanup loop begin, so a concurrent cleanup release cannot be lost and reappear as a ghost permit.
- A Railway queue wait no longer consumes the provider service's 60-second launch budget. Only repository-bound Pi starts on the capacity-managed path use the adapter-owned deadline; local Pi and every other adapter retain the existing provider-service deadline.
- Same-key queue entries now hold independent caller waiters. Cancelling either the first or a later retry rejects only that caller; the lifecycle key remains at the same FIFO position until every caller cancels. Admission resolves every remaining caller with one shared lifecycle lease.
- Startup recovery now installs the decoded persisted `capacityKey`, after validating it against the durable row's thread and lifecycle generation and the binding's workspace/fence generation. Legacy bindings still synthesize that key during decode. A mismatch fails closed before any occupancy is installed or new create is admitted.

## Full remote launch deadline hardening

- Replaced the create-only Railway timeout with one adapter-owned deadline for the complete repository-bound remote Pi launch transaction. `WorkspaceRuntime.create` synchronously signals admission immediately after the generation permit is granted; the 60-second clock starts from that signal, not queue entry.
- Threaded only that callback through `ProviderWorkerProvisioner.start`/`restart` into `WorkspaceRuntime.create`. No scheduler, timer service, or additional capacity abstraction was introduced.
- The deadline now covers durable creation-intent publication, Railway create and runtime-ID binding, checkout and credential cleanup, worker artifact/config writes, durable-process startup, worker connection, remote `session.start`, provider binding persistence, and creation-intent adoption.
- Timeout interrupts the launch transaction and then waits for its existing cleanup path. Before a runtime is known, an uncertain Railway create retains its durable intent and permit for Task 3 reconciliation. After a binding exists, timeout invokes `ProviderWorkerProvisioner.stop`; the permit and intent clear only after authoritative destroy/NotFound and intent removal succeed. A destroy failure is surfaced as `session.start.cleanup` and retains ownership fail-closed.
- Creation-intent publication/runtime binding and adoption are interruptible at the deadline boundary. Known-runtime binding interruption destroys the sandbox before removing its intent and releasing capacity; adoption interruption leaves the intent/permit intact until the timeout cleanup retries them.

## Ownership and recovery invariants

The create and deadline ordering is now:

`wait outside deadline -> acquire generation permit -> synchronously signal admission/start 60s clock -> reserve operation ID -> insert durable intent -> Railway create -> bind runtime ID -> checkout/config/bootstrap/connect -> remote session.start -> persist provider binding including capacity key -> adopt/clear intent`

The permit is not released by adoption. It remains active until the corresponding sandbox/worker lifetime ends.

Timeout cleanup ordering is:

`interrupt launch -> if create may be unknown, retain Task 3 intent + permit -> otherwise stop worker -> authoritative sandbox destroy/NotFound -> remove intent -> release permit -> surface timeout`

If authoritative cleanup fails, the cleanup error wins and the durable owner plus permit remain available for recovery rather than being cleared early.

Startup ordering is:

`list Railway inventory + read durable bindings + read durable intents -> validate persisted capacity keys -> rebuild occupied permits -> open FIFO admission -> start Task 3 intent cleanup`

Task 3 remains the only owner of pending-intent cleanup:

`discover marker -> durably bind exact runtime ID -> authoritative destroy/NotFound -> remove intent -> release its recovered permit`

A failed inventory read leaves the capacity service unreconciled, so no new create can start from an incomplete view.

## TDD evidence

The implementation was driven through focused RED/GREEN cycles:

- The first capacity/config run failed because `SandboxCapacity` did not exist and Railway configuration had no bounded capacity/default.
- The lifecycle RED allowed two Railway creates through a limit of one (`expected 1, received 2`).
- Startup recovery RED failed because `reconcileSandboxCapacityAtStartup` did not exist; transient inventory closure and orphan accounting were added before it passed.
- Contract, ingestion, and web RED runs rejected the new runtime event, failed to project a queued session, dropped queue position, and rendered `Connecting` instead of `Queued`.
- Routed-adapter RED failed because there was no capacity-aware runtime-event source.
- Final edge review added two more RED cases: a pre-reconciliation same-key waiter remained queued behind its own recovered permit, and a legacy Task 3 binding had no releasable capacity key. The run recorded **2 failed, 9 passed** before both fixes; the focused capacity/recovery/routing/ingestion rerun passed **4 files, 118 tests**.
- Blocking-review RED runs then reproduced all five reported defects: first-caller cancellation removed a shared queue entry; later-caller cancellation was ignored; failed replacement destruction left the old capacity permit unreachable; slow initial inventory let cleanup release before a stale reservation was installed; and a mismatched persisted key was silently replaced with a reconstructed key. Two test-harness polling assertions were corrected and not counted as product failures. A dedicated virtual-time RED run additionally proved the outer provider deadline expired during a 61-second queue wait while post-admission Railway create had no deadline. The minimum fixes made the final focused server run pass **7 files, 238 tests**.
- The second timeout-review RED run added five virtual-time stage hangs—checkout, worker connection, remote `session.start`, provider binding persistence, and intent adoption. All five remained pending after 61 seconds post-admission (`expected Failure, received undefined`), proving the create-only timer left the rest of launch unbounded.
- GREEN coverage verifies 61 seconds of queue time consumes none of the launch budget, every covered stage remains pending at 59 seconds after admission and fails after 61, an uncertain Railway create retains its intent/permit without calling stop, successful post-create cleanup reclaims both before timeout is returned, and failed authoritative cleanup is surfaced while retaining ownership. Workspace tests additionally cover interrupted runtime-ID binding and adoption retry cleanup.

Focused coverage includes max-N admission, strict FIFO N+1, same-key idempotency, cancellation and queue compaction, terminal create cleanup, authoritative destroy, stale-generation replacement ordering, double release, controller restart reconciliation, pending intent occupancy, transient inventory failure, orphan reporting, queued event projection/clearing, legacy binding recovery, and the unchanged local Pi path.

## Final verification

All final commands used Node **v24.16.0** in `PATH` and Bun **1.3.12** through `npx`. `bun test` was never used.

- Round 2 focused capacity, provisioner, provider timeout, recovery, routed activity, and ingestion suites: **9 files, 266 tests passed**.
- Focused contracts queue projection: **2 files, 54 tests passed**.
- Focused web queue projection: **2 files, 137 tests passed**.
- Full `packages/contracts` suite: **20 files, 250 tests passed**.
- Full `apps/server` suite: **380 files passed, 3 skipped; 4,231 tests passed, 16 skipped**.
- Full `apps/web` suite: **334 files, 4,113 tests passed**.
- `git diff --cached --check`: passed before the implementation commit.

Per the explicit task instruction, `bun fmt`, `bun lint`, and `bun typecheck` were not run.

## Remaining risks and deferred evidence

- Capacity coordination intentionally assumes one controller process. Multiple controllers would each enforce only their own local limit; distributed locks, Redis, schedulers, pools, and horizontal-controller coordination remain outside this task.
- No live Railway sandbox was created. The capacity and recovery behavior is covered with deterministic client/repository tests; live inventory timing and process lifetime remain Task 7 canary evidence.
- Pending creation intents intentionally occupy capacity indefinitely while Task 3 may still discover a late sandbox. A permanently unresolved intent therefore requires the existing cleanup/reconciliation path to converge before the slot becomes available; this is the deliberate fail-closed ownership policy.
- Orphan runtimes are reported but never destroyed automatically. An operational cleanup policy remains a separate decision.
- The conservative default is one. The v3 development environment must explicitly set `SYNARA_RAILWAY_MAX_ACTIVE_SANDBOXES=5` when infrastructure configuration is performed outside this repository task.
