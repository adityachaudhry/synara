# US Daytona and Railway company-workspace trial

Measured on 2026-09-24 against **Synara dev**, using disposable sandboxes. No production resources or live dev runtime selector changed.

Both sandboxes used the same public Gitea origin, company path `companies/chipsage`, S3 LFS bucket in `sjc`, company ref commit `961a84d800561f19513f5e8be6ce9d2ab7d90041`, and 28 LFS pointers. Both exposed `inbox/box/Ernel Thoughts.png` to UID 10001 with SHA-256 `7fcf428536a2ec383ee107f248ca7e2c8f20a78e2aa893fba9f00d221404d381`, and Git reported a clean checkout.

| Stage | Daytona US | Railway US East |
| --- | ---: | ---: |
| Create prepared sandbox and reach command readiness | 3,254 ms | 2,263 ms |
| Mount S3 with `s3fs` | 996 ms | 1,317 ms |
| Clone company Git ref and bind 28 S3 LFS objects | 21,173 ms | 21,431 ms |
| Sum of those three stages | **25,423 ms** | **25,011 ms** |

The 412 ms difference is one paired observation, not a percentile or a platform performance advantage. The Daytona preparation snapshot contained the full document/Git/FUSE toolchain but **not** the worker JavaScript/Photon artifact; Railway used the current dev worker template. Neither run included Pi worker connection, model work, browser rendering, or first-file-read latency. Daytona's base `daytona-medium` sandbox created in 252 ms, but its usable prepared snapshot took 3,254 ms; the base-image number is not workspace readiness.

The Daytona US recovery trial wrote an uncommitted draft, saved a sandbox snapshot, and deleted the original sandbox. Creating from that snapshot took 1,991 ms, remounting S3 took 1,047 ms, and Git refresh plus LFS rebinding took 20,454 ms. The exact PNG hash and draft content survived. The snapshot capture itself took 6,398 ms. One-time tool installation and prepared snapshot capture took 6,212 ms and 13,966 ms respectively; those are excluded from the prepared-create timing.

A separate US Daytona container stop/start trial took 1,445 ms to stop and 1,606 ms to start. The S3 FUSE mount **did not survive** the stop, so persistent container disk alone does not preserve a ready company workspace; it still needs remounting and the LFS file bindings restored.

The earlier Daytona EU trial used the same S3/Git design and took 6.3–6.5 seconds to create its prepared sandbox, 1.5–1.7 seconds to mount, and 35.9–39.5 seconds to check out the company. The US result removes most of the observed EU checkout penalty, consistent with reduced distance to the `sjc` bucket, but no network trace isolated that cause. Railway dev is pinned to `us-east4-eqdc4a`; Railway also supports US West placement, which was not tested here.

The Glasswing Ventures Daytona organization now has US container access. Its warm-pools API still returns 404. This trial does not satisfy the requested 800 ms **fully ready workspace** target. All disposable Daytona QA sandboxes/snapshots and the paired Railway sandbox were deleted; the two pre-existing running Railway sandboxes remained.
