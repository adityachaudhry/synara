# Task 4 Report: Bounded FIFO Railway sandbox capacity

## Outcome

Implemented and committed bounded Railway sandbox admission as:

- `1314cd1af` — `feat(server): bound Railway sandbox capacity`

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

## Ownership and recovery invariants

The create ordering is now:

`acquire generation permit -> reserve operation ID -> insert durable intent -> Railway create -> bind runtime ID -> persist provider binding including capacity key -> adopt/clear intent`

The permit is not released by adoption. It remains active until the corresponding sandbox/worker lifetime ends.

Startup ordering is:

`list Railway inventory + read durable bindings + read durable intents -> rebuild occupied permits -> open FIFO admission`

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

Focused coverage includes max-N admission, strict FIFO N+1, same-key idempotency, cancellation and queue compaction, terminal create cleanup, authoritative destroy, stale-generation replacement ordering, double release, controller restart reconciliation, pending intent occupancy, transient inventory failure, orphan reporting, queued event projection/clearing, legacy binding recovery, and the unchanged local Pi path.

## Final verification

All final commands used Node **v24.16.0** in `PATH` and Bun **1.3.12** through `npx`. `bun test` was never used.

- Focused capacity, recovery, routed activity, and ingestion suites: **4 files, 118 tests passed**.
- Full `packages/contracts` suite: **20 files, 250 tests passed**.
- Full `apps/server` suite: **380 files passed, 3 skipped; 4,213 tests passed, 16 skipped**.
- Full `apps/web` suite: **334 files, 4,113 tests passed**.
- `git diff --cached --check`: passed before the implementation commit.

Per the explicit task instruction, `bun fmt`, `bun lint`, and `bun typecheck` were not run.

## Remaining risks and deferred evidence

- Capacity coordination intentionally assumes one controller process. Multiple controllers would each enforce only their own local limit; distributed locks, Redis, schedulers, pools, and horizontal-controller coordination remain outside this task.
- No live Railway sandbox was created. The capacity and recovery behavior is covered with deterministic client/repository tests; live inventory timing and process lifetime remain Task 7 canary evidence.
- Pending creation intents intentionally occupy capacity indefinitely while Task 3 may still discover a late sandbox. A permanently unresolved intent therefore requires the existing cleanup/reconciliation path to converge before the slot becomes available; this is the deliberate fail-closed ownership policy.
- Orphan runtimes are reported but never destroyed automatically. An operational cleanup policy remains a separate decision.
- The conservative default is one. The v3 development environment must explicitly set `SYNARA_RAILWAY_MAX_ACTIVE_SANDBOXES=5` when infrastructure configuration is performed outside this repository task.
