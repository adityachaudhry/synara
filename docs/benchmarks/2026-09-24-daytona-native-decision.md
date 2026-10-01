# Daytona-native recovery decision (dev)

> Historical decision, superseded by the reopened Daytona-native dev evaluation. Its conclusion was premature: the recorded native trial did not exercise Pi recovery, and the shared 20-second storage path had not been profiled. See [the subsequent storage measurements](2026-09-24-repository-preparation-native.md).

Decision on 2026-09-24: do not cut Synara dev over to Daytona. Keep the existing Railway worker runtime. Production was not changed.

The paired company-workspace trial measured 25,423 ms to prepare a US Daytona sandbox versus 25,011 ms on Railway US East. A Daytona container stop preserved its draft and local Git disk but lost the S3 FUSE mount. Rebinding the 28 company LFS objects and refreshing Git took 20,454 ms in the recovery trial. See [the paired benchmark](2026-09-24-daytona-us-vs-railway.md).

A separate disposable US Daytona API trial confirmed native identity and local-disk persistence: create 260 ms, first stop 11,326 ms, start 736 ms, second stop 2,582 ms, archive 371 ms, and archived start 2,725 ms. The draft hash matched after both recoveries. This trial did **not** include Git, S3 FUSE, Pi, or a browser; its subsecond start is not a usable company workspace time. All trial sandboxes were deleted.

The proposed persistent-thread adapter required new park/resume and capacity accounting while retaining the existing snapshot and S3 archive paths until portable recovery could be proven. Since the FUSE mount and LFS bindings still need reconstruction after stop, this added a second recovery model without a measured readiness advantage. US Linux VM pause, which could preserve memory and mounts, was unavailable to this organization; warm pools were not enabled. Daytona's native archive is not an independent copy in Glasswing's S3.

The dev inventory remained at 32 saved thread pointers: 29 Railway checkpoints and 3 S3 archives. Two of the 29 checkpoint IDs were absent from Railway and matched the named September 8 QA fixtures. We did not migrate or delete any of those pointers, checkpoints, or archives. No production resource or setting was touched.

The Daytona adapter and dev configuration are being removed. Reconsider only if a real US Linux VM pause trial preserves the mounted company workspace and Pi continuation at an acceptable cost, or if another measurable advantage outweighs the additional storage and recovery model.
