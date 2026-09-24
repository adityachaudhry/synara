# Daytona native dev runtime

Scope: Synara dev only. Production remains on its separate branch, service, and configuration. Ship application changes only through the canonical `glasswingos/dev` GitHub Actions workflow.

## Ownership

- Gitea keeps canonical company commits; its native LFS backend keeps heavy objects in external Tigris S3.
- Each thread owns one US Daytona container disk: isolated company checkout, private drafts, Git metadata, and native Pi JSONL.
- The controller keeps durable thread events and the current worker generation. A stable disk ID is independent of that process generation.
- At a settled turn, a direct portable S3 archive captures private files, Git state, and Pi sessions. Kernel-verified read-only canonical mounts become Git pointer bytes; their bodies are not downloaded into the archive. The previous backup remains authoritative until upload completion and atomic pointer replacement.

## Native lifecycle

A running worker handles the next message after verifying the company revision. Unchanged revisions retain healthy FUSE bindings; changed revisions preserve private edits and tell Pi which company files changed. A process replacement fences every old agent-UID process, keeps the running disk/mounts when possible, and launches the current worker artifact. Idle retirement stops the container after the controller's existing ten-minute idle period. Daytona's thirty-minute auto-stop is a backstop; periodic outbox reads renew activity for live workers. Stopped containers auto-archive after twenty-four hours, with automatic deletion disabled.

Stopped/archived threads start the same sandbox ID, remount external S3, and resume Pi from the retained JSONL. File previews can start the disk without launching Pi and hydrate only the requested canonical pointer. If the sandbox is conclusively missing, restore the last verified portable archive into a fresh prepared sandbox. A transient provider error must never authorize disk deletion.

Native pointers distinguish the current live binding from the binding captured in an older archive. Old-generation events cannot create backups of a newer generation. Startup reconciliation adopts durably owned creation intents instead of deleting their disks. Capacity transfers retain a physical slot across process generations and failed preview cleanup.

## Image and storage driver

CI builds a native Daytona image snapshot from pinned Node24 Debian, the worker/Photon artifacts, document tools, Git/LFS, and checksum-pinned Mountpoint for S3 1.24.0. This avoids capturing Daytona's approximately14GB general-purpose image. The tested minimal image is approximately0.54GB.

Daytona uses Mountpoint with the existing external Tigris endpoint/prefix, root-owned temporary credentials, and read-only company file bindings exposed to UID10001. Mountpoint binds inherit read-only state and receive kernel identity validation. Daytona's documented mount-move workaround uncovers pointers during source changes; detached bindings stay under a protected root directory until container stop/delete removes them. The Railway compatibility path retains s3fs.

## Dev configuration and migration

Set `SYNARA_WORKSPACE_RUNTIME=daytona`, `SYNARA_DAYTONA_TARGET=us`, a scoped Daytona key, and `SYNARA_DAYTONA_MAX_ACTIVE_SANDBOXES=100` in the dev service only. CI prepares and records `SYNARA_DAYTONA_SNAPSHOT`, public WSS callback, and source SHA. The cap includes two maintenance slots and does not allocate100 running sandboxes. Dormant disks do not consume application running slots.

An existing Railway checkpoint is imported once through the established S3 archive API on its first Daytona resume. Import metadata is attached by immutable checkpoint key, so it cannot overwrite a newer live pointer; original Railway snapshots remain intact. Existing S3-only records restore directly. Two missing September8 QA checkpoint fixtures remain a pre-existing coverage gap; they are not business threads and must not be represented as migrated. No bulk canonical file export is involved.

## Acceptance before completion

Use real company materials and the actual dev Pi route. Record cold creation, warm turn readiness, stopped/archive resume, first image read, direct backup, and provider-loss restore separately. Verify exact private draft and native-session continuity, new company revisions, isolation, file previews, cleanup, and the successful canonical dev deployment. A default-container start time is not full workspace readiness. VM pause and warm pools are optional future improvements, not prerequisites for the container architecture.
