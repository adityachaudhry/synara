# Repository preparation: real Git and S3 trials

Date: 2026-09-24. Application code baseline: `d4643f1f3`; candidate changes remain local. No application deployment or source-repository writes were performed.

## Finding and implemented changes

The approximately 22-second baseline is dominated by **serial S3 metadata lookups**, not Git transfer or Linux bind mounts. Bounded concurrency reduced the controlled cold LFS phase from a median **19.055 seconds to 11.257 seconds**, a **40.9% reduction** across two samples per implementation.

- A company-only clone uses the company commit already fetched by `git clone`, avoiding a second fetch. The removed fetch took 86–93 ms in the instrumented baselines.
- LFS stat/bind/remount work runs in batches of eight. A failed batch waits for every in-flight operation to settle before returning failure. File-size checks, pointer checks, local-edit refusal, and read-only mounts remain in place.
- Refresh still fetches and verifies the current source SHA. If unchanged, it retains bindings only after checking the current FUSE root, filesystem device, exact SHA-derived source roots, read-only flags, and expected mount count. Missing or stale bindings are reconstructed.
- `onlyPath` enables a preview to bind one exact repository-relative path inside the company. Other binary edits and bindings are left alone, recursive company ownership changes are skipped, and existing Git attributes are preserved.

## Environment and method

- Railway dev sandbox region: `us-east4-eqdc4a`, Ubuntu 26.04.1 x86_64.
- Current dev worker checkpoint: `synara-worker-tools-v3-us-east4-eqdc4a-518e0d3b643a41887dbf3b337229f9af49e93dd5246d806a8a754aae9038f124`.
- Real Gitea ref: `workspaces/chipsage`; source commit `cc97d20b33b287f575f46792fc3e0acfe0783aba`.
- 28 canonical LFS files, using the existing dev Gitea S3/Tigris backend and configured prefix. Source identity stayed fixed throughout these measurements.
- The material probe was `inbox/box/Ernel Thoughts.png`, 809,689 bytes, SHA-256 `7fcf428536a2ec383ee107f248ca7e2c8f20a78e2aa893fba9f00d221404d381`.

Each controlled cold sample unmounted the company bindings and the root S3 filesystem, then started a new FUSE daemon. Thus “cold” means a new FUSE client and metadata cache. Tigris/server-side caches were not reset or controlled. The sequential/parallel order alternated, and the final sequential sample remained slow. This supports a client-concurrency explanation without claiming a universal latency guarantee.

Sandbox creation, FUSE startup, checkout, image reads, and warm refresh are distinct measurements. In-process LFS durations below exclude the sandbox API round trip. Aggregate per-file durations in parallel samples overlap and must not be read as wall-clock time.

## Measurements

### Instrumented original baseline

| Measurement | Sample 1 | Sample 2 |
| --- | ---: | ---: |
| Checkout command, including one image hash and Git status | 21.925 s | 21.989 s |
| LFS script wall time | 19.623 s | 20.429 s |
| Sum of serial S3 stat calls | 19.228 s | 19.959 s |
| Bind calls | 158 ms | 188 ms |
| Read-only remount calls | 126 ms | 154 ms |
| Recursive ownership change | 5 ms | 5 ms |
| Git pointer enumeration | 11 ms | 9 ms |

### Controlled LFS-only comparison

These four samples ran in one sandbox, resetting the FUSE client each time. Each sample bound all 28 files and verified the same PNG hash afterward.

| Order | Implementation | LFS wall time | Including sandbox exec round trip |
| --- | --- | ---: | ---: |
| 1 | Original sequential operations | 19.346 s | 19.857 s |
| 2 | Eight concurrent operations | 11.056 s | 11.812 s |
| 3 | Eight concurrent operations | 11.458 s | 12.041 s |
| 4 | Original sequential operations | 18.763 s | 19.784 s |

### Final code acceptance

| Operation | Observed time | Result |
| --- | ---: | --- |
| Fresh checkout, before the image probe | 12.448 s | Correct company commit and all 28 bindings |
| LFS portion of that checkout | 11.606 s | Validated source sizes and read-only bindings |
| Unchanged warm refresh | 479 ms | LFS validation 44 ms; zero per-file stat/bind/remount calls |
| Refresh after removing all company bindings | 329 ms | All 28 reconstructed; image and draft preserved |
| Targeted image preview with another binary locally edited | 217 ms | One binding; edited bytes and full attributes file unchanged |
| Refresh after replacing the entire FUSE filesystem | 11.646 s including exec round trip | All 28 reconstructed; source SHA and PNG hash unchanged |

Earlier serial-candidate warm refreshes were 230 ms and 295 ms. Separate final warm calls including sandbox API overhead were 830–855 ms. These are different measurement boundaries, not contradictory timings.

Increasing `UV_THREADPOOL_SIZE` to 8 produced 11.408 s and 11.082 s; a subsequent explicit pool-of-4 sample was 12.124 s. These small samples overlap the ordinary variation seen with the default pool, so no process-environment tuning was added.

## Correctness checks

The real-sandbox acceptance trial verified:

- The checked-out Git company tree contains only Chipsage.
- UID 10001 can read the company PNG, cannot open it for writing, and cannot list the root-owned backing S3 mount.
- The PNG SHA matches its actual Git LFS pointer before and after refresh/rebinding.
- Warm refresh retains the existing mount table and reports no changed source files.
- Bindings are absent immediately after uncovering and valid after refresh, including a full FUSE restart.
- An untracked analyst draft survives each successful refresh.
- With another canonical binary deliberately edited, targeted PNG hydration succeeds, the edited bytes remain unchanged, and the complete attributes file stays byte-identical. Full-company hydration fails while preserving the edit. Restoring the original pointer permits full recovery.

One initial QA assertion incorrectly assumed that mount IDs must change after unmount/remount. Linux recycled the IDs. The assertion was corrected to check that bindings actually disappear before refresh and reappear with valid contents afterward; the corrected trial passed. Product code validates filesystem identity and source paths, not increasing mount IDs.

The existing real-Git corruption/migration script also passed: a missing sibling tree does not block isolated checkout; local commits, untracked drafts, migration, and subsequent refresh preserve the expected data. No unit tests were added or run. Generated scripts passed JavaScript/shell syntax checks and `git diff --check`.

## Reproduction

`scripts/qa/repository-preparation-latency.ts` generates a shell trial for an already prepared disposable Linux sandbox. Run it with Node 24 or Bun and a configuration JSON containing `binding`, `repositoryOrigin`, `credentialConfigPath`, `mountRoot`, and `probePath`:

```sh
node scripts/qa/repository-preparation-latency.ts configuration.json > trial.sh
```

Upload and execute `trial.sh` in that sandbox. The generator creates a separate checkout, uses the real configured Git/S3 sources read-only, retains checkout evidence, and provisions no infrastructure. The caller owns credentials and sandbox cleanup. Do not run its deliberate local-edit trial in an existing user checkout.

## AWS Mountpoint comparison

**Decision: use AWS Mountpoint for the Daytona implementation. Actual Daytona integration acceptance remains pending.** All measurements in this report were collected in Railway sandboxes; they establish the storage-driver improvement, not a measured Daytona startup time or a completed deployment.

Daytona documents `mount-s3` with Tigris's endpoint, and AWS documents prefix-scoped mounts and read-only access. The experiment installed the official AWS binary only in a disposable sandbox. [Daytona external storage](https://www.daytona.io/docs/en/mount-external-storage/#mount-a-tigris-bucket), [AWS installation](https://github.com/awslabs/mountpoint-s3/blob/main/doc/INSTALL.md), [AWS configuration](https://github.com/awslabs/mountpoint-s3/blob/main/doc/CONFIGURATION.md).

The comparison used the same candidate hydrator, same company commit, same sandbox, and a newly started filesystem daemon for every cold sample:

| Order | Filesystem | Cold LFS wall time | Including sandbox exec round trip |
| --- | --- | ---: | ---: |
| 1 | s3fs, eight concurrent operations | 10.746 s | 11.534 s |
| 2 | Mountpoint, eight concurrent operations | 4.574 s | 5.241 s |
| 3 | s3fs, eight concurrent operations | 13.479 s | 14.276 s |
| 4 | Mountpoint, eight concurrent operations | 4.589 s | 5.534 s |

The medians are **12.112 seconds for s3fs and 4.582 seconds for Mountpoint**, a **62.2% reduction**, with two samples per driver. A preceding complete fresh Mountpoint checkout took **7.878 seconds**, including Git, with a **7.092-second LFS phase**. Keep this initial sample visible: the trial does not establish that every new worker will bind in 4.6 seconds.

Mountpoint's warm LFS validation took 20–30 ms in the controlled samples, with no per-file stat or mount operations. A full warm source refresh in acceptance took 467 ms. Restarting Mountpoint took 622–743 ms; subsequent cold binding and PNG verification succeeded. Direct PNG hash commands including the sandbox API round trip took 0.957–1.117 seconds, compared with 0.858–0.911 seconds for s3fs; this trial demonstrates metadata/preparation improvement, not faster material-byte transfer.

The full Mountpoint acceptance trial passed company isolation, UID 10001 read-only access, image SHA verification, warm reuse, loss-of-bindings recovery, targeted preview beside an edited binary, refusal of full hydration while preserving the edit, and recovery after restoring the pointer. Loss-of-bindings refresh took 2.843 seconds with Mountpoint versus 329 ms in the s3fs final-code trial; the filesystem defaults differ, so that tradeoff remains visible.

No `--cache`, `--cache-xz`, or `--metadata-ttl` override was used. AWS documents the default metadata mode without a data cache as `minimal`. Client daemons were replaced, but server-side S3/Tigris caches were not controlled. [AWS caching configuration](https://github.com/awslabs/mountpoint-s3/blob/main/doc/CONFIGURATION.md#caching-configuration).

### Pinned artifact and mount contract

- Version: `mount-s3 1.24.0`, x86_64.
- [Official pinned tarball](https://s3.amazonaws.com/mountpoint-s3-release/1.24.0/x86_64/mount-s3-1.24.0-x86_64.tar.gz), listed in the [AWS release](https://github.com/awslabs/mountpoint-s3/releases/tag/mountpoint-s3-1.24.0).
- SHA-256: `a99bea20510eaabaf9d7cbfe95ab221a11005cacaa77cfc311a2912bbbdbfd72`. The pinned download was independently checked against the tarball used in the trial.
- Archive member: `./bin/mount-s3`; extracting under `/opt/aws/mountpoint-s3` yields `/opt/aws/mountpoint-s3/bin/mount-s3`.
- Options: existing bucket, prefix, endpoint, and region; `--prefix <trailing-slash-prefix> --endpoint-url <endpoint> --region <region> --force-path-style --read-only --allow-other --uid 10001 --gid 10001`.
- Credentials were passed only into the mount daemon's child environment from a root-only temporary JSON file. The JSON file was removed immediately after launch. `AWS_EC2_METADATA_DISABLED=true` was set; credentials were not put in command arguments, logs, or snapshots.

The actual kernel identity is **filesystem type `fuse`, source `mountpoint-s3`**, rather than a `fuse.*` subtype. The root and PNG bind rows were:

```text
52 35 0:30 / /root/.synara-s3-lfs ro,nosuid,nodev,noatime - fuse mountpoint-s3 ro,user_id=0,group_id=0,default_permissions,allow_other
59 35 0:30 /7f/cf/428536a2ec383ee107f248ca7e2c8f20a78e2aa893fba9f00d221404d381 <company-checkout>/inbox/box/Ernel\040Thoughts.png ro,nosuid,nodev,noatime - fuse mountpoint-s3 ro,user_id=0,group_id=0,default_permissions,allow_other
```

The repository hydrator now explicitly accepts only the pairs `fuse.s3fs`/`s3fs` and `fuse`/`mountpoint-s3`. A reused target must match its root's device, filesystem type, source, expected SHA-derived root, and read-only flag. The primary implementation owns the Daytona image/driver integration and remaining native-platform acceptance.

All disposable sandboxes created by this subtask were destroyed; none remains running. Two Mountpoint setup attempts ended before timing samples while correcting a probe-escaping error and discovering the generic `fuse` identity. Both were cleaned up, and the complete comparative trial subsequently passed. No remote snapshots, Gitea objects, or source refs were modified.

## Final Daytona image compatibility correction

The actual minimal Debian-based Daytona image subsequently exposed a platform difference not present in the Railway trial: plain file binding succeeded and inherited kernel `ro`, but a target-only read-only remount failed while resolving `mountpoint-s3` as a device. Explicit source/target remount and combined bind/read-only commands also failed. Ordinary and lazy FUSE-file unmount attempts failed despite the target appearing in `mountinfo` and having the expected device number.

Daytona documents relocating a FUSE mount with `mount --move` to free its original path. In the real native sandbox, moving a FUSE file bind to a root-owned temporary file exposed the original local pointer/probe bytes; binding the same real source again succeeded. UID 10001 read the actual document and could not open it for writing. [Daytona FUSE cleanup](https://www.daytona.io/docs/en/mount-external-storage/#unmount).

The compatibility correction uses plain `mount --bind`, then verifies every resulting mount against the same filesystem identity, SHA-derived root, and read-only predicate used for warm reuse. Mountpoint bindings are uncovered with `mount --move` into exclusive mode-0600 UUID placeholders beneath mode-0700 `/root/.synara-detached-lfs`. Legacy s3fs retains its validated unmount operation. Targeted preview still moves only the selected binding; an unchanged source with healthy bindings moves none.

Retired bindings remain private and outside the archive roots until actual sandbox teardown. They do not copy canonical object bytes. The documented cleanup guarantee is container deletion/teardown; the idle lifecycle must reach that boundary to bound their lifetime.

The corrected production `hydrateLfs` subsequently completed the full company on the final minimal Daytona image. Production `uncoverLfs` with `onlyPath` moved only the real `benchmark-final.xlsx` binding, permitted preservation/editing of the 4,887-byte spreadsheet, and left the other canonical mounts in place. The coordinated archive/restore trial is continuing with that spreadsheet, an 809,724-byte untracked PNG draft, and staged/unstaged text changes. The Railway timing samples above predate this compatibility correction.
