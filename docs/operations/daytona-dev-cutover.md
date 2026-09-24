# Daytona dev cutover

The Synara dev service keeps using Railway until `SYNARA_WORKSPACE_RUNTIME=daytona` is set. Production is separate. Deploy code only by pushing `glasswingos/dev`; the GitHub Actions dev workflow prepares the worker snapshot before it deploys the controller.

## Cutover gates

1. In the **Glasswing Ventures** Daytona organization, confirm `us` has the `container` sandbox class and enough CPU, memory, and disk quota. The dev target is `us`. A shared region appearing in Daytona's global region list is insufficient; check the organization's available sandbox classes and create a US container from `daytona-medium`.
2. Use a durable, scoped `SYNARA_DAYTONA_API_KEY` with sandbox create/delete and snapshot create/delete access. Rotate the bootstrap key before its expiration. Keep the key in the Synara **dev** service only.
3. Inventory every `provider-outbox-checkpoints/workspaces/*.json` pointer on the Synara dev volume. For each Railway `checkpoint`, confirm the snapshot exists and create a completed S3 archive before switching. Confirm the archive can be restored, including a private draft and native Pi session. Do not delete a snapshot without a verified archive. Retire live Railway workers before the switch.
4. Resolve missing snapshot pointers rather than treating them as migrated. On 2026-09-23, 32 dev pointers existed: 29 Railway checkpoints and 3 S3 archives. Two of the 29 referenced snapshots absent from the Railway checkpoint inventory; both are the named [September 8 archive-test fixtures](https://github.com/adityachaudhry/glasswing-ai-2/blob/dev/docs/benchmarks/2026-09-08-workspace-archives.md), not business threads. Fixture A has an older completed S3 archive, but neither fixture has a copy of its latest checkpoint. Quarantine their pointers reversibly before bulk archive eviction and keep their files for review. One of two running Railway sandboxes was referenced by a pointer. Recheck these counts immediately before migration.
5. Confirm the public `SYNARA_PUBLIC_URL` serves `/internal/provider-worker` over WSS. An unauthenticated upgrade returning 401 is expected. The GitHub Actions prepare step writes `SYNARA_PROVIDER_WORKER_CONTROL_URL`, `SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION=ISOLATED`, and `SYNARA_DAYTONA_SNAPSHOT` only after the US snapshot succeeds. Here `ISOLATED` means no Railway private-network access; it does not block Daytona's public Internet egress.

Set `SYNARA_WORKSPACE_RUNTIME=daytona`, `SYNARA_DAYTONA_TARGET=us`, `SYNARA_DAYTONA_MAX_ACTIVE_SANDBOXES` (at least 2 when archives are enabled), and an idle timeout in the Synara dev service with `--skip-deploys`, then trigger the canonical dev workflow. Verify its source SHA and successful run before using the deployment. Do not use `railway up` locally.

## Acceptance

- Start a real company thread in US Daytona. Confirm the worker connects through WSS and the agent can read a Box-synced PNG by its company path.
- Create an uncommitted draft, retire the worker, restore the next worker from its Daytona checkpoint or S3 archive, and confirm the draft, native Pi context, current Git commit, and S3 file hash.
- Record time for sandbox create, S3 mount, repository checkout, worker connect, first file read, and warm reuse separately. A warm API lookup below 800 ms does not prove a cold workspace is ready below 800 ms.
- Confirm no dev worker or snapshot remains in EU and that production settings and deployments did not change.

Keep Railway checkpoints and dev volume data until the US restore and browser journey pass. Rolling back after Daytona has captured new thread state first requires archiving those Daytona checkpoints and verifying their restore on Railway; merely unsetting the runtime selector would strand that state.
