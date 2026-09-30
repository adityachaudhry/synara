# Daytona readiness validation

Status: **dev rollout candidate; production not promoted**. Base `origin/glasswingos/dev` at `464f3b924ec01aabfdcf753f8594e14221985d88`. Current US container entitlement is denied; do not claim runtime acceptance from bundle success. Main decision/evidence live in Glasswing `docs/operations/daytona-production-readiness.md` and `daytona-readiness-evidence.json`.

## Current candidate

- A proven region rejection releases its SQLite creation intent and admission reservation. SDK creation also polls readiness, so arbitrary HTTP errors are not treated as proof of no allocation. Post-create setup failure releases ownership only after SDK deletion confirms the disk is destroyed.
- CI requires at least one configured executable region, prepares matching US/EU images, verifies their hashes, and fills eligible pools before publishing their variables together. New starts prefer ready US; a background refresh selects EU during US denial and restores US preference after an empty probe and pool readiness. Existing healthy disks keep their region. Ambiguous allocations never trigger a second regional create. Automatic old-pool cleanup is enabled only with operator-verified `SYNARA_DAYTONA_EXCLUSIVE_POOL_OWNER=1`; shared or unverified pools remain retained for explicit review.
- Terminal archive and Outbox attempts run in an adapter-owned scope, per thread, with one active/coalesced pending job. They no longer block the shared runtime-event stream. Same-thread mutation waits for previously registered terminal attempts; shutdown drains jobs. This is an entry barrier, not proof that every backup succeeds under overlapping writes. Failed backup retains the last successful recovery point.
- Reconcile runs under the existing lifecycle lock and rechecks generation and authorized active turn there. Adapter mutation locking covers its directory write and start/send/stop ordering.
- Session discovery accepts a thread hint. Single-thread cursor refresh, recovery, fork lookup, and idle-stop paths query that remote worker; full discovery still lists all workers.
- Native workspace pointers persist a mutation revision before mutable requests, checkout/reconcile, attachment writes and retirement. Terminal archives remain useful copies, but current recovery coverage requires proven stopped writers, verified upload, and unchanged generation/revision. All native workers use UID 10001; retirement verifies and fences every process under that UID, including detached children. Unknown historical writer coverage retains the original disk. Mutating broker requests hold the thread lifecycle lock through dispatch.
- Native recovery uses direct sandbox-ID evidence. A missing or definitively region-denied stopped disk restores only an archive covering the latest mutation; historical/dirty coverage blocks recovery. Restore failures preserve the original pointer and disk. Region outage relocation retains the original stopped disk and fences its worker generation. Healthy sessions retain their existing region.
- Durable source admission is ordered; independent session-owner FIFOs execute concurrently, with 100 active handlers and 4,096 pending acknowledgement entries. A completed-prefix ledger advances the durable cursor. Pinned routing and same-thread predecessor waits preserve owner order across reparenting. Existing reactor scenarios passed 139/139; real replay/restart and load trials remain required. The pre-existing detached live-event queue remains unbounded.

Server and worker bundles passed with Node 24.19.0. Existing adapter checks: ten ordinary cases passed; eight virtual-clock cases timed out. The unchanged canonical checkout-hang case also timed out with the same local dependencies. Two selected ProviderService cursor checks returned one pass and one failure; the same failure also reproduced on unchanged canonical ProviderService. The full suite is not green. No new unit tests were added; existing unscoped fixture constructions now retain/close the managed adapter scope. No heavyweight formatting, lint, or type checks ran under AGENTS.md. Cross-thread timing, races, and recovery need actual dev trials.

## Run order

1. Verify EU execution while US container entitlement is denied. User authorizes EU fallback and automatic US preference after restoration. Obtain US quota/entitlement confirmation and verify actual failback when support restores access; current US absence does not block the authorized EU pilot.
2. Run the environment lifecycle check against the selected executable region (the older helper defaults to US). The existing `scripts/qa/daytona-native-environment.ts` with `--run-daytona-dev` checks: create, check marker environment, stop/start, prove environment disappears, reapply environment, prove restoration, delete the one owned sandbox. It must pass before runtime deployment is called healthy.
3. Commit/push application changes to `glasswingos/dev`, deploy through GitHub Actions, and verify canonical SHA, worker snapshot digest, successful deployment run, health, and bootstrap connection. Never use local `railway up` or ship a local image. Check Glasswing agent-profile/MCP configuration parity before judging real prompts.
4. Run a four-chat real-material pilot, then baseline/scale trials. The helper below exercises new/warm turns, real file bytes, per-thread markers, private HTTP file preview, and stopped resume. At count 25 or higher the first ten chats use the same company. It records first text observed by 600 ms snapshot polling, which is not an exact streaming-token timestamp. Direct credential/company-isolation checks remain separate. It creates uniquely named QA projects/threads and only requests deletion of its own fixtures. Authentication failure may leave named fixtures; inspect its cleanup entries. Deletion acknowledgement is not physical disk-destruction proof.

```sh
node scripts/qa/daytona-readiness.mjs --run-dev --pool --count=4 --output=output/daytona-readiness/pilot
node scripts/qa/daytona-readiness.mjs --run-dev --count=25 --output=output/daytona-readiness/concurrent-25
```

Use Node 24 or the supported repository runtime, with installed server dependencies. Locally, Node 24.19.0 is available at `/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`. The helper retrieves only the dev controller's Railway variables into memory. Do not print credentials or commit raw model transcripts. It stores marker-match booleans and activity kinds, not company content. A created pilot pool is removed on exit; an existing pool is left unchanged.

`scripts/qa/daytona-create-rejection.ts --expect-dev-region-rejection` is a narrower real-API check, intended **only while the current entitlement denial exists**. It uses an in-memory SQLite database and a one-slot capacity limit. Four rejected creates must leave no reservations or intents. The original code failed on the first reservation; the candidate passed. Run it through the existing TypeScript bundler/runtime, not against the deployed controller's database. It is not a general successful-create/loss-of-response test.

`bun scripts/qa/daytona-backup-coverage.ts --run-local` exercises actual disposable filesystem pointers: unknown historical coverage, matching verified coverage, a newer mutation, retained native identity, cross-thread rejection and malformed coverage. It makes no provider calls. Real mutation/backup races, region denial, failed restore and deleted-disk journeys still require the dev trials below. Final capture during native retirement can add latency; measure this separately.

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

US restoration/failback, real worker latency and company chat acceptance remain open.
