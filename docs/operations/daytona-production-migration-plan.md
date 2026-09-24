# Daytona production migration plan

Planning only. No production writes, deployments, resource creation or migrations are authorized by this document. Verified September 24, 2026. Dev uses Daytona US; production remains at Synara `98183771a69ab9e0f7d97c505401ba3faca90755`, with Railway sandbox credentials, private worker networking, no Daytona key, and no worker-side S3 LFS mount settings.

## Current dev boundary

New company workers and the normal execution of migrated threads use Daytona. This is a configured backend choice, not automatic failover to Railway. Legacy checkpoint-only threads can still create a temporary Railway sandbox for a one-time export to the private S3 archive API. Dev retains Railway credentials for that import.

The live dev inventory currently contains two running Railway sandboxes (`5d934049-2217-4d54-90b2-4d81baaef87a`, `17c2f5b8-2bdd-4503-a2b9-a1806680f17b`) and 42 checkpoints, including templates and historical/QA checkpoints. Both running instances contain prior company-worker directories. Those resource counts are not a count of unmigrated business threads. The two owned Daytona QA disks are archived in US.

Therefore the switch of the agent execution backend is complete, but retirement of the old sandbox platform is not. Before removing it, map every retained business thread to a verified S3 archive or native Daytona disk, resolve missing states explicitly, and then retire old instances/checkpoints. Gitea and the Synara controller will continue to run as ordinary Railway services.

## 1. Establish a reversible baseline

Inventory live production thread bindings, active turns, current/retired checkpoints, S3 archives, private drafts and Pi session files. Distinguish business data from QA fixtures; never count a missing checkpoint as a successful migration. Obtain consistent backups of Synara's SQLite state, archive metadata, Gitea configuration/database, Git repositories and all historical LFS objects. Record exact source revisions and hash/size manifests.

Review the complete dev-to-production release delta, including storage, worker lifecycle and unrelated UI changes. Prepare and rehearse a compatible bridge release that understands both Railway and Daytona state and S3 archives. Initially keep Railway selected. Do not assume the old production binary understands newly written native pointers.

## 2. Prepare production isolation and canonical storage

Use a separate production Daytona organization, with US container entitlement, agreed quota/budget and production-only credentials. A separate key in the dev organization does not isolate sandbox runtime access: Daytona documents the organization as the trust boundary. Confirm billing and US access before provisioning; do not reuse dev credentials or prefixes. [Daytona authentication](https://www.daytona.io/docs/api-keys).

Inspect the actual production Gitea `app.ini` storage backend; absence of Railway environment overrides alone is not proof of on-disk configuration. If LFS bodies remain local, pre-copy them to production S3 using the proven dev object layout. Validate all referenced historical OIDs, not only latest company files. Briefly suspend Git/LFS writers (including sync/publication), copy the final delta, configure Gitea's native S3 backend, and verify reads of old revisions and new writes before releasing writers. Preserve the old copy for rollback. Git commits and company refs must remain unchanged.

Enable production worker S3 access with its own prefix/credentials. Verify the private archive API and external signed transfers. Validate public authenticated WSS callbacks from Daytona; workers cannot join Railway's private network. Keep the private metadata API on the controller side. Do not combine a Gitea storage cutover and the agent-provider cutover into one unverified step.

## 3. Rehearse migration and rollback against real copies

Use an isolated controller and copied state, not two writers attached to the live production database. Disable ingestion, scheduled actions and external publication in the rehearsal. Cover small and large company workspaces, image/PDF/spreadsheet reads, staged/unstaged binary drafts, native conversation continuity, publication conflicts, controller restart, stop/archive resume, worker deletion and failed uploads. Measure concurrency and latency under a representative load; the 100-slot configuration is not a completed load test.

Pre-export every legacy business-thread checkpoint to verified S3 so first use after cutover does not depend on spinning up a Railway importer. Idle/completed thread revisions can be prepared first; active threads need a final settled capture. Current dev's lazy import proves the transfer path, but a complete production export inventory is still required.

Prove the reverse path: the bridge release with Railway selected must restore the newest S3 archive written after Daytona activity and resume its Pi session and drafts. Reverting only the runtime flag or only the old application image is not an established rollback procedure. Rehearse storage rollback too: any LFS objects written after the S3 switch must remain available; the pre-switch local copy alone is insufficient.

## 4. Controlled cutover, after explicit production approval

Use a short maintenance window to stop admitting new turns and drain current work. Fence old worker generations, capture the final per-thread S3 revision and verify the export inventory. Keep one writer for each thread. Promote the exact tested bridge/cutover release through `glasswingos/main` and its GitHub Actions production workflow, then set the production Daytona runtime and prepare its US image through CI.

The current runtime selector applies to the controller globally; per-company canary routing is not implemented. Use the isolated rehearsal as the canary, followed by controlled live acceptance immediately after the switch. Verify historical images, a resumed old thread, a new thread, private draft continuity and one reviewed publication before reopening ordinary traffic. Observe errors, archive completion, creation latency, queue length and resource use.

The workflow's `prepare_only` option still changes production variables and prepares real resources. It is not a read-only planning action and must not be run before approval.

## 5. Rollback and retirement

On a failed acceptance gate, stop new turns, drain/fence Daytona writers, verify their latest S3 archives and use the rehearsed bridge release with Railway selected. Keep a record of any work beyond the last verified archive; do not silently restore an older point. Leave canonical Git/S3 storage intact unless its separately rehearsed rollback is required.

Retain old checkpoints and deployment artifacts for an agreed rollback window. Retire Railway sandbox credentials, templates, import calls and residual instances only when all business-thread state is accounted for and the rollback window has ended, with cleanup approval. Keep ordinary Railway services and their necessary metadata volumes.

Latency acceptance must be explicit: current dev warm medians are roughly 1.0-1.6 seconds, with cold and stopped-thread readiness in seconds to tens of seconds. If sub-800 ms is mandatory for all states, production promotion waits for a demonstrated design meeting it. Optional warm pools or VM memory resume require real US access and measurements, not assumptions.
