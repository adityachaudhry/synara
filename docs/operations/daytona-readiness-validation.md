# Daytona readiness validation

Status: **dev rollout candidate; production not promoted**. Base `origin/glasswingos/dev` at `464f3b924ec01aabfdcf753f8594e14221985d88`. US container access was restored by the September 30 09:56 UTC read-only check; matching US/EU pools each have two ready workers. Actual no-model lifecycle and same-adapter failback checks passed below. Do not claim chat performance or migration acceptance from control-plane success. Main decision/evidence live in Glasswing `docs/operations/daytona-production-readiness.md` and `daytona-readiness-evidence.json`.

## Current candidate

- A proven region rejection releases its SQLite creation intent and admission reservation. SDK creation also polls readiness, so arbitrary HTTP errors are not treated as proof of no allocation. Post-create setup failure releases ownership only after SDK deletion confirms the disk is destroyed.
- CI requires at least one configured executable region, prepares matching US/EU images, verifies their hashes, and fills eligible pools before publishing their variables together. New starts prefer ready US; a background refresh selects EU during US denial and restores US preference after an empty probe and pool readiness. Existing healthy disks keep their region. Ambiguous allocations never trigger a second regional create. Automatic old-pool cleanup is enabled only with operator-verified `SYNARA_DAYTONA_EXCLUSIVE_POOL_OWNER=1`; shared or unverified pools remain retained for explicit review.
- Terminal archive and Outbox attempts run in an adapter-owned scope, per thread, with one active/coalesced pending job. They no longer block the shared runtime-event stream. Same-thread mutation waits for previously registered terminal attempts; shutdown drains jobs. This is an entry barrier, not proof that every backup succeeds under overlapping writes. Failed backup retains the last successful recovery point.
- Reconcile runs under the existing lifecycle lock and rechecks generation and authorized active turn there. Adapter mutation locking covers its directory write and start/send/stop ordering.
- Session discovery accepts a thread hint. Single-thread cursor refresh, recovery, fork lookup, and idle-stop paths query that remote worker; full discovery still lists all workers.
- Public provider session discovery forwards an advisory session-owner hint through the reactor, runtime ingestion and checkpoints; full inventory retains no argument. This avoids querying every native worker for each concurrent turn while preserving parent/child identity comparisons. Existing checks passed 139 reactor, five provider-service and eight ingestion/checkpoint scenarios.
- Native workspace pointers persist a mutation revision before mutable requests, checkout/reconcile, attachment writes and retirement. Terminal archives remain useful copies, but current recovery coverage requires proven stopped writers, verified upload, and unchanged generation/revision. All native workers use UID 10001; retirement verifies and fences every process under that UID, including detached children. Unknown historical writer coverage retains the original disk. Mutating broker requests hold the thread lifecycle lock through dispatch.
- Native recovery uses direct sandbox-ID evidence. A missing or definitively region-denied stopped disk restores only an archive covering the latest mutation; historical/dirty coverage blocks recovery. Restore failures preserve the original pointer and disk. Region outage relocation retains the original stopped disk and fences its worker generation. Healthy sessions retain their existing region.
- Durable source admission is ordered; independent session-owner FIFOs execute concurrently, with 100 active handlers and 4,096 pending acknowledgement entries. A completed-prefix ledger advances the durable cursor. Pinned routing and same-thread predecessor waits preserve owner order across reparenting. Existing reactor scenarios passed 139/139; real replay/restart and load trials remain required. The pre-existing detached live-event queue remains unbounded.
- Legacy `/root/.pi/agent/sessions/` cursors carry an exact-file copy requirement through provisioning. Copying requires real source/destination directories, independent regular files and identical bytes; conflicts retain the original. UID 10001 workers relocate only that recognized prefix, validate managed JSONL/header and SDK session identity before opening it, and persist the new cursor. Current/v1 history and unsafe-link/missing-file checks passed in an isolated Linux Node24 container as UID 10001. This does not replace the full old Railway conversation migration rehearsal.

Server and worker bundles passed with Node 24.19.0. Existing adapter checks: ten ordinary cases passed; eight virtual-clock cases timed out. The unchanged canonical checkout-hang case also timed out with the same local dependencies. Two selected ProviderService cursor checks returned one pass and one failure; the same failure also reproduced on unchanged canonical ProviderService. The full suite is not green. No new unit tests were added; existing unscoped fixture constructions now retain/close the managed adapter scope. No heavyweight formatting, lint, or type checks ran under AGENTS.md. Cross-thread timing, races, and recovery need actual dev trials.

## Run order

1. Keep the verified US preference and EU fallback. US execution access is restored; actual US lifecycle and a process-local outage injection with real allocations proved background failback in the same adapter. Obtain written US quota/entitlement stability and repeat workload/latency checks with a separately bounded dev model budget.
2. Run the environment lifecycle check against the selected executable region (the older helper defaults to US). The existing `scripts/qa/daytona-native-environment.ts` with `--run-daytona-dev` checks: create, check marker environment, stop/start, prove environment disappears, reapply environment, prove restoration, delete the one owned sandbox. It must pass before runtime deployment is called healthy.
3. Commit/push application changes to `glasswingos/dev`, deploy through GitHub Actions, and verify canonical SHA, worker snapshot digest, successful deployment run, health, and bootstrap connection. Never use local `railway up` or ship a local image. Check Glasswing agent-profile/MCP configuration parity before judging real prompts.
4. Run a four-chat real-material pilot, then baseline/scale trials. The helper below exercises new/warm turns, real file bytes, per-thread markers, private HTTP file preview, and stopped resume. At count 25 or higher the first ten chats use the same company. It records first text observed by 600 ms snapshot polling, which is not an exact streaming-token timestamp. Direct credential/company-isolation checks remain separate. It creates uniquely named QA projects/threads and only requests deletion of its own fixtures. Authentication failure may leave named fixtures; inspect its cleanup entries. The helper captures structured native ownership even on failed runs, waits for all in-flight trial results, and checks each owned native ID directly for 404 after deletion. Failure or unknown cleanup changes the pass result to false. It reuses the real web client's bounded policy only for explicit pre-handler capacity rejection of unary RPCs. Retried commands retain the same command ID and payload; model failures, transport timeouts and uncertain accepted mutations are never retried. One independent WebSocket connection is used per company.

```sh
node scripts/qa/daytona-readiness.mjs --run-dev --profile-check --pool --count=4 --output=output/daytona-readiness/pilot
node scripts/qa/daytona-readiness.mjs --run-dev --profile-check --count=25 --output=output/daytona-readiness/concurrent-25
node scripts/qa/daytona-readiness.mjs --run-dev --profile-check --count=50 --cold-burst=10 --output=output/daytona-readiness/concurrent-50-burst-10
```

Use Node 24 or the supported repository runtime, with installed server dependencies. Locally, Node 24.19.0 is available at `/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`. The helper retrieves only the dev controller's Railway variables into memory. With `--profile-check` it requires a real completed `crunchbase_search` call in the fresh thread, not just configured environment fields. Dev had an explicit forwarding override that omitted the profile pair; both keys must reach the worker. Do not print credentials or commit raw model transcripts. It stores marker-match booleans and activity kinds, not company content. A created pilot pool is removed on exit; an existing pool is left unchanged.

`scripts/qa/daytona-create-rejection.ts --expect-dev-region-rejection` is a narrower real-API check, intended **only while the current entitlement denial exists**. It uses an in-memory SQLite database and a one-slot capacity limit. Four rejected creates must leave no reservations or intents. The original code failed on the first reservation; the candidate passed. Run it through the existing TypeScript bundler/runtime, not against the deployed controller's database. It is not a general successful-create/loss-of-response test.

`bun scripts/qa/daytona-backup-coverage.ts --run-local` exercises actual disposable filesystem pointers: unknown historical coverage, matching verified coverage, a newer mutation, retained native identity, cross-thread rejection and malformed coverage. It makes no provider calls. Real mutation/backup races, region denial, failed restore and deleted-disk journeys still require the dev trials below. Final capture during native retirement can add latency; measure this separately.

`scripts/qa/pi-legacy-session.ts --run-local` uses the actual installed Pi SDK with disposable files. Linux is authoritative for the production copy command: macOS BSD `cp -n` can return failure when skipping an identical file. The verified UID 10001 invocation bundles this QA entry, then runs it without network access:

```sh
bun build scripts/qa/pi-legacy-session.ts --target=node --external glimpseui --outfile output/pi-history-qa.mjs
docker run --rm --network none --user 10001:10001 -e HOME=/workspace \
  --mount "type=bind,src=$PWD/output/pi-history-qa.mjs,dst=/qa/pi-history-qa.mjs,readonly" \
  node:24-bookworm-slim node /qa/pi-history-qa.mjs --run-local
```

## Required trial matrix

Default assumption: 25 simultaneous active chats and a ten-start burst, pending the actual expected peak. Use at least ten chats in one real company, plus other companies; independent private markers must differ. The helper provides a starting probe, **not the complete acceptance suite**.

| Trial | Evidence required |
| --- | --- |
| Pool claims, miss, refill | Pool ready count and errors; exact snapshot/region match; claim latency separated from hydration/Pi readiness; replenishment timing; abandoned claims bounded |
| 25, 50, then 98 concurrent active threads | p50/p95/p99 admission → ready and first token, per-thread streaming delay, CPU/RSS/disk, error rate, model/provider throttling; multiple chats per company and across companies |
| Ten-start burst while other chats run | Pool hit/miss counts; no existing-conversation stall; prepared versus cold results reported separately |
| At-cap queue and cancellation | 98 normal slots plus two reserved maintenance slots; extra normal request queues without provisioning; cancellation releases its waiter; no admission leak |
| Slow backup | Actual delayed archive/Outbox for one QA worker; another company's text/tool events continue; pending terminal barrier applies only to its thread |
| Backup failure and worker loss | Restore the last verified archive; missing newer private state reported accurately; pointers never advance to incomplete data; retry/alert behavior recorded |
| Long running turn across idle windows | Internal background work alone must not keep a sandbox alive; active tool/task execution plus controller activity must; no unintended auto-stop |
| Interrupt/steer and source refresh/save | Real active tool call, edit/publish/reconcile/new-turn overlap, stale-base/fence rejection, credentials removed, agent's own active-turn publication still works |
| Stop, archive, deleted-disk recovery | Session JSONL, image/PDF hashes, draft text, pending Outbox and repository commit preserved; timing by stage; fresh environment and gateway authorization applied |
| Controller replacement/redeploy | Same thread history recovered; old worker/generation cannot publish; no duplicate ownership, events, or Git commits; SQLite and backup pointers intact |
| Isolation | Other company trees/refs/private S3 paths denied; agent UID cannot read root/controller credentials; stale turn token denied; no credentials baked into or returned to a pool |
| Large real company | Largest observed source history and representative PDFs/images; working set fits disk and memory with headroom; refresh preserves private edits |
| Two-hour churn and full-day soak | Creation, idle retirement, archive retention, orphan reconciliation, quota including unclaimed warm workers and stopped disks; cleanup verified from owned IDs |
| Isolated production copy and reverse migration | Production LFS provenance, complete verified exports, separate organization/bucket/session scope, real restore and rollback with drafts/history/binary material |

Target p95 ≤800 ms is provisional for an already prepared session; it is unproven. Set cold/recovery budgets and error/backup-age budgets before judging results. Timestamp command admission, create/claim, environment, data hydration, worker connection, repository refresh, model dispatch, first token, terminal delivery, and backup completion separately. Use existing provider operation logs/metrics; add instrumentation only for missing stages.

User authorizes production promotion conditional on these results passing; no further routine promotion approval is required for this scope. The current global runtime selector cannot canary individual companies. Reverting only the selector is insufficient if newer conversations have native-only state; prove the reverse import first. Retain Railway rollback resources until that proof and the agreed recovery window are complete.

## September 30 regional trial

Three real empty EU fallback allocations passed private-byte read/write, adoption, intent cleanup and capacity release; every owned disk was deleted. Allocation times were 2.298, 1.944 and 2.217 seconds with the official `daytona-small` image. These are control-plane checks, not application/chat latency. Failed early QA harness trials were corrected (Node SQLite/runtime bundling and adoption); their owned disks were also deleted. Evidence is in local `output/daytona-failover/real-region-fallback.json`.

Run the narrower allocator check with Node 24 after bundling the internal TS files while keeping the SDK external:

```sh
bun build scripts/qa/daytona-region-fallback.ts --target node --external @daytona/sdk --outfile apps/server/.daytona-region-qa.mjs
node apps/server/.daytona-region-qa.mjs --run-dev
```

US execution restoration was observed later the same day. The same-adapter failback proof follows below; actual company acceptance and latency results are separate, and broader recovery and production parity gates remain open.

## September 30 functional profile and capture comparison

Canonical dev `2db3267` (Actions 36688922171) loaded the corrected profile forwarding allowlist. The four-company trial passed 18 model turns. The 25-conversation baseline passed 102 turns, 25 native isolation checks and 25 private previews, scoped 403 and latest-observed detached-writer stop/restore. All 25 owned native IDs returned 404. One snapshot-read capacity retry was honored. Cold readiness p50/p95 was 22.313/25.470 seconds; 75 warm samples were 3.080/14.100 seconds, maximum 16.443 seconds.

Controller/API Railway resource peaks were 0.505/0.029 vCPU and 870.63/253.34 MB over that trial window. Native archive bodies stream sandbox→S3; the controller handles metadata. The capture-queue audit found archive execution p95 3.123 seconds but a much longer preceding wait; exact semaphore admission and Outbox timing are not instrumented.

Canonical dev `36a8393` (Actions 36691694360) increased the existing single controller-wide capture limit to eight when Daytona is selected; Railway-selected controllers use four. Mixed bindings under a Daytona-selected bridge share eight. Lifecycle locks, terminal barriers, validated capture/upload and mutation/generation fencing remain intact.

The repeated 25-conversation workload passed the same 102 turns and all functional checks; every owned native ID returned 404. Cold readiness p50/p95 was 22.329/24.062 seconds; 75 warm samples were 3.125/4.917 seconds, maximum 7.743 seconds. Stopped readiness was 22.753 seconds in one sample. Observed first text uses 600 ms polling, not exact streaming TTFT. Two dev batches show an improvement for this workload, not production latency parity. The initial single-client 50-conversation scale trial failed with control-request backpressure and five provider-start failures; five allocations remained creating when the SDK's 60-second readiness deadline expired. Explicit operation/thread ownership was established before QA cleanup. A multi-client repeat uses cold bursts of ten followed by all 50 warm turns concurrently; it does not erase the simultaneous cold-burst failure. Private sanitized comparison receipt: `output/daytona-failover/concurrent-25-capture-8/latency-comparison.receipt.json`.

The subsequent four-client 50 run with cold bursts of ten reached 50 provider turns, but all 50 model turns failed, with 49 explicit shared Anthropic API usage-limit errors (400 invalid_request_error; provider-reported resume 2026-10-01T00:00Z). Dev and production use exactly the same credential; no value was printed/stored. Further model trials are stopped. Establish a dev credential/workspace with independent bounded model budget before more load tests. The helper now stops subsequent cold bursts after a failed batch and records current provider-start failure detail privately, without retrying model failures. This follow-up is not functional 50 acceptance. All 50 owned IDs are now directly 404, but three normal retirement attempts exceeded 90 seconds; one later disappeared and two required explicitly owned QA cleanup. Logical intent/capacity settlement is unproven. Seven existing web transport capacity scenarios passed under `bun run test`; no new unit tests or named heavyweight checks ran.

## September 30 US restoration and same-adapter failback

At 09:56 UTC, the available-class API included US containers and both matching `5f99335a` pools had two ready workers without errors. No billing or entitlement setting was changed by this chat. The vendor support reply remains unverified while the Mac is locked; execution success does not establish reserved US capacity or entitlement stability.

The configured dev adapter at `30a649ae2` selected US. A disposable native lifecycle check passed at 10:12 UTC: allocation/setup 545 ms, stop/start with fresh environment 1.208 s, and archive/resume with the exact private marker plus fresh environment 3.093 s. Its owned disk returned 404. An initial run completed the lifecycle but its redundant cleanup reader failed on a stale list record whose disk was already deleted; the reader was corrected to accept only a direct not-found result and the clean repeat passed.

A second actual-API check at 10:14 UTC used one running adapter instance. Its only outage injection removed US from this process's read-only available-class response. Real SDK allocation, empty recovery-probe, snapshot and pool calls were unchanged. Initial readiness was `[eu]`; after restoring inventory visibility, background checks changed it to `[us, eu]` in 14.903 s, without restarting the adapter. EU claim/setup took 1.508 s and the next US claim/setup 723 ms. The existing EU worker stayed in EU and retained its private marker. EU, US and the empty US probe each returned direct ID404 after deletion. All three pre-existing managed business disks retained their archived state. These are small no-model lifecycle measurements, not end-to-end chat latency, a vendor outage, or a production parity test. No company/model credential was sent to the disposable workers.

Private receipts and reproducible local QA sources remain in the retained readiness worktree at `output/daytona-failover/us-restored/`; SHA-256 provenance is recorded in the Glasswing evidence. No production app, configuration or business data changed. Shared Anthropic exhaustion, consistent controller/private-writer exports, migration/reverse-migration and higher-scale/fault/soak gates remain open.
