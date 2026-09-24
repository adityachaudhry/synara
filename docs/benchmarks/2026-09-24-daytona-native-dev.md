# Daytona native dev: final architecture and live evidence

Daytona US is the dev worker runtime. Retain it in dev: stable thread disks and native stop/archive now provide useful lifecycle ownership. The initial exit recommendation was premature. This evaluation does **not** establish consistently sub-800 ms readiness or universal superiority over Railway. Production was not changed.

Application implementation: `baaa898260829fc2e4ecb69712e40f1fc73d5328`, built and deployed from `glasswingos/dev` through GitHub Actions [36054514327](https://github.com/adityachaudhry/synara/actions/runs/36054514327). The final configuration and this evidence are deployed through the same workflow. [Machine-readable evidence](2026-09-24-daytona-native-evidence.json) contains exact timestamps, hashes and sandbox identities.

## Architecture

1. Box sync sends changed source files to the existing Git/LFS writer. Gitea retains Git commits and LFS pointers; its configured Tigris/S3 backend retains canonical LFS bodies. This remains the company audit record.
2. A message reaches Synara on Railway. Synara persists orchestration state and chooses the thread's Daytona US sandbox. Native disk identity is separate from worker generation and credentials.
3. A running thread reuses its disk and process. A stopped or archived thread starts the same disk, reapplies current worker environment, mounts S3, checks the company Git ref, and restarts Pi from its native JSONL session. Ordinary native resume does not restore our S3 archive.
4. The company checkout contains its Git metadata plus read-only file bindings to Mountpoint for S3. Pi runs as UID 10001. It cannot traverse the root-only full-bucket mount or read root controller credentials. File bodies transfer on reads; initial bindings still require metadata work.
5. Drafts and Pi session state live on the private thread disk. After settled turns, the controller records a verified private S3 backup. Canonical mounted materials become their exact Git LFS pointers in this backup; local binary edits, Git index/objects and session files retain their real bytes. The pointer advances only after archive verification.
6. Explicit publication still goes through the existing reviewed Git/LFS path. A private edit does not silently change company source. A missing Daytona disk restores the last verified S3 archive into a new sandbox, then refreshes source bindings. The recovery point is the last successful archive, not arbitrary in-flight process memory.

The control-plane database and thread-to-disk pointers still reside on Railway. Loss of that database or the entire S3 bucket was not part of this trial. Native persistence replaces the usual per-turn checkpoint/clone/cache lifecycle; the Railway adapter and one-time legacy import remain for existing threads.

## Measured latency

All app values below use server `requestedAt` to Pi `startedAt`; model generation is excluded. Each recovery has n=1 unless stated otherwise. The same real Chipsage PNG was opened and its hash checked. These are observations, not percentiles or an SLA.

| Scenario | Observation |
| --- | ---: |
| Railway baseline, new image-reading app thread | 41.577 s |
| One-time Railway-to-Daytona thread migration | 17.992 s, including 7.596 s legacy import |
| Warm native worker, earlier batch, n=3 | median 1.044 s; 0.958–1.070 s |
| Fresh native worker, final code | 33.706 s |
| Warm native worker, final-code batch, n=3 | median 1.604 s; 1.571–1.868 s |
| Controller redeploy, retained running disk | 3.349 s; a later worker-artifact update took 11.109 s |
| Corrected native stop/start | 17.318 s |
| Native archived disk/start | 12.047 s; archive-to-completion itself took 13.149 s |
| Deliberately deleted disk → S3 restore → turn | 20.648 s |
| Stopped-thread PNG preview, including return to stopped | 10.775 s; all 809,689 bytes matched |

The 33.706 s cold trial spent **22.525 s creating the sandbox**, 6.233 s in checkout and 0.862 s connecting the worker. Its prepared worker artifact matched (`reused=true`, `uploadBytes=0`). Another prepared creation earlier in the evaluation took 0.677 s. Creation variability is real; concurrent dev work and placement were not isolated.

A controlled storage experiment reduced median cold LFS work from 12.112 s with s3fs to 4.582 s with Mountpoint (n=2 per driver). The original roughly 22 s checkout spent about 19 s in serial S3 stat calls. This storage improvement is transferable to Railway; it is not evidence that Daytona alone is faster. [Detailed storage method](2026-09-24-repository-preparation-native.md).

Fourteen captured successful app backups ranged from 1.612 to 8.678 s. Backup runs after the model's terminal event; it is separate from start latency. The final deliberate-loss archive was 5,832,474 bytes and was independently downloaded and hash-verified before deletion.

## Reality-driven corrections and recovery proof

- `updateEnv()` is daemon state: a harmless marker set that way disappeared after a real stop/start, while a create-time marker survived. Resume now reapplies current environment before Pi launches. The actual adapter check is `scripts/qa/daytona-native-environment.ts --run-daytona-dev`; it passed against real US sandboxes and deletes its test sandbox.
- Failed requests formerly deleted the retained disk. Native failures now fence and park it. Failed launches persist ownership before parking, so creation-intent cleanup cannot mistake them for orphans. Sanitized worker error details remain visible. Uncertain commands are not blindly retried; the failed read-only QA delivery was reconciled through the application's existing control.
- Native stop/start clears FUSE mounts. The corrected path rebuilds them. Daytona's FUSE file-bind remount/unmount behavior required verifying inherited read-only flags and moving detached binds to a protected root directory.
- The original 1,343,416-byte Pi JSONL prefix and the unchanged 416-byte private note survived migration, controller redeploy, native stop/start, native archive/start and deliberate disk deletion. Final JSONL was 8,091,210 bytes; every prior-prefix comparison passed. The real PNG SHA-256 remained `7fcf428536a2ec383ee107f248ca7e2c8f20a78e2aa893fba9f00d221404d381`.
- A separate real filesystem trial compared all 98 file records after S3 restoration, including 36 `.git` files, staged/unstaged text and private binary edits. [Archive evidence](2026-09-24-daytona-portable-archive.md).

Server and worker bundles passed, as did CI image smoke checks and the real API journeys. No unit tests were added. Full repository formatting/lint/typecheck gates were not run in this task; they are not claimed green. A 100-worker load test, multi-company concurrency/failure soak, full Box resync, controller database loss, and US Linux VM memory resume remain outside this evidence.

## Operating decision

Dev has 100 active sandbox slots, including two reserved for maintenance; this matches the previous Railway cap. Tier 3 quotas observed were 250 vCPU / 500 GiB RAM / 2,000 GiB disk. The configured worker is 2 CPU / 4 GiB RAM / 8 GiB disk. The prepared image is approximately 0.54 GB instead of the original 14.3 GB image.

Keep recent threads warm for **30 minutes**, use a **45-minute provider idle backstop**, auto-archive after **24 hours stopped**, and disable auto-delete. This is the existing idle timer, not a custom warm pool. At published rates the reserved worker costs about $0.1665/hour active, at most $0.0208/day stopped before storage allowances, and zero sandbox resource charges archived. Extending idle retention from 10 to 30 minutes adds at most about $0.0555 per idle retirement. S3, model and controller charges are additional. [Pricing](https://www.daytona.io/pricing), [lifecycle billing](https://www.daytona.io/docs/billing).

Do not buy or build around unavailable optional features. US Linux VM and warm-pool access are still pending on support ticket #19388; they are not prerequisites for this dev architecture. Daytona volumes would duplicate our canonical S3 store. Memory-preserving resume should be evaluated only when the actual US VM class is available. [Persistence semantics](https://www.daytona.io/docs/en/persistence/).

After explicit user approval, the non-expiring `glasswing-dev-daytona-runtime` key replaced the six-day bootstrap credential in dev. Its only explicit permissions are write/delete sandboxes and write/delete snapshots; implicit organization-level runtime access still applies. No new payment or production configuration change was made.
