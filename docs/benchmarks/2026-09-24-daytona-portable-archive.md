# Daytona portable workspace archive — real filesystem trial

On September 24, 2026, one completed end-to-end trial exported a live, idle Daytona filesystem to the actual Glasswing dev archive API and S3, restored it into a fresh Daytona sandbox, and verified every archived file before hydrating and reading a real company image. All 98 file records matched, including 36 files under `.git`, local binary drafts, and separately staged and unstaged text. The 27 remaining canonical S3 file binds were stored as Git LFS pointer bytes.

This trial covers filesystem recovery. It did not launch Pi or create synthetic Pi sessions; there were zero native JSONL session files. Pi turn completion, native session resume, lifecycle locking, capacity recovery, and hostile-archive boundary cases are outside this trial's evidence.

## Real inputs and production path

- Repository: `glasswing-admin/glasswing-company-data`, company ref `workspaces/chipsage`, verified Git HEAD `e15739f3826dc9f7e63c2bff5400edf0e9d73b42`. Checkout used the public dev Gitea origin and the production company checkout/hydration helpers. No shared Git refs were written.
- Source: `7f62f35d-fa64-421a-852f-3825136da876`; destination: `f1e2d8cb-89f0-4de7-936e-f16d6752146c`, both in `us`.
- Restore image: `synara-native-worker-us-3e5d7efa47388b831c204a00d16bf5072b2d56a7a50b5fab9188ddf020685d91`, snapshot ID `f31af3ac-06dd-4a3b-a5b0-5982682e5bc0`. The name contains the worker/artifact/recipe content digest `3e5d7efa47388b831c204a00d16bf5072b2d56a7a50b5fab9188ddf020685d91`; the snapshot API returned an empty `imageName`, so this is not presented as an OCI registry digest. Observed snapshot fields were `size: 0.5387221481651068`, `cpu: 2`, and `disk: 8`.
- The harness imported `makeDaytonaSandboxClientLive`, `makeWorkspaceRuntimeLive`, `archiveWorkspace`, `restoreWorkspaceArchive`, `hydrateLfs`, and `uncoverLfs` from the working tree based on `d4643f1f362a761cf7450c2e8b5d87c54b99d17c`. It used real SQLite intent storage in memory and actual Daytona/API/S3 requests, without mocked transports or filesystem implementations.
- Archive metadata requests used a local SSH bridge to the existing private dev API. Sandbox upload/download used the real signed S3 URLs directly; company payload bytes did not pass through the bridge or local coordinator.

## Measured result

There was **one successful capture and one successful restore (n = 1)**. An earlier capture attempt failed with HTTP 502 at the diagnostic bridge and is excluded from successful timing measurements; its server-side arrival was uncertain. The later successful attempt used a new immutable QA revision and did not overwrite source data.

| Operation | Observed wall time | Included diagnostic bridge time |
| --- | ---: | ---: |
| Destination sandbox create | 884 ms | None |
| Pack, upload, and complete archive | 6,146 ms | Grant 1,629 ms + complete 1,729 ms |
| Fetch archive metadata, download, and restore | 3,154 ms | Metadata GET 1,474 ms |

These are diagnostic end-to-end timings, **not native controller latency measurements**. The SSH bridge adds an extra transport hop to each metadata request. The remainder also includes Daytona command/file-transfer round trips, Python packing or extraction, and real S3 transfer. This single small-workspace sample does not establish throughput or large-workspace latency.

Archive metadata:

| Field | Value |
| --- | --- |
| Archive ID | `f62f1f7a-e4b4-4048-a041-c172bc507a68` |
| Revision | `qa-archive-7d473406-8a51-41f0-8676-50e27a3f879b` |
| Format | `tar-gzip-v1` |
| Compressed bytes | 1,015,585 |
| SHA-256 | `f5a98563630d4a47c64bf185db1f84d21be6e2813e033a39d058a5ca34322b37` |
| Files compared | 98 |
| Serialized file payload bytes | 1,261,155 |
| Canonical bind entries represented by pointer bytes | 27 |

Source and restored manifests compared paths, file sizes, modes, and SHA-256 hashes before any destination hydration. The archive metadata completion and subsequent download both passed the production metadata/checksum validation. All `.git` bytes matched, including HEAD, the index, the staged text blob, and local objects.

## Draft and material preservation

Paths below are relative to `companies/chipsage/`.

| File/state | Bytes | SHA-256 |
| --- | ---: | --- |
| `qa-portable-archive/analyst-draft.md` — staged text plus an unstaged continuation | 118 | `22dc34602c4fbb6de97702bd27fb30aae89a2dd7c9b33f86c02440b14e8040ee` |
| `qa-portable-archive/material-draft.png` — untracked copy of a real PNG with appended local annotation bytes | 809,724 | `4f4668beca31a0016b4cfba3ab304c49d79182707f478d7619a7c3c068180f8d` |
| `analysis/generated/eb0ad626-3cdf-4a7d-a710-420f8faa7725/benchmark-final.xlsx` — tracked real spreadsheet with appended unpublished bytes | 4,887 | `0291d5031b0397cdaca91d91b0352968cdb4e89cf1e8d41ca7b6d2b9be570e08` |
| `inbox/box/Ernel Thoughts.png` — unchanged canonical material, hydrated only after restoration | 809,689 | `7fcf428536a2ec383ee107f248ca7e2c8f20a78e2aa893fba9f00d221404d381` |

The source Git index SHA-256 was `6b99164036e04ce079a3a1ecde6646a953a84240106ac1927299fa0a4c2a5500`; its staged text blob was `a5394c625f3fea0f9fbacb7445961cded7dc8932`. The whole-manifest comparison preserved both that index and the distinct unstaged text bytes.

After restoration, targeted production hydration of the canonical PNG succeeded despite the unrelated edited spreadsheet. The PNG's real body matched its Git LFS OID, and all three local draft hashes were checked again after hydration and still matched.

## Mount behavior established during preparation

The final Debian image exposed a Daytona/Mountpoint constraint: target-only remount, explicit-source remount, and ordinary/lazy FUSE file-bind unmounts failed even though mountinfo and file reads showed the bind. This differs from a plain local-file bind trial. Canonical binds already inherited read-only mount flags from the read-only source.

The production correction was exercised here: plain-bind each source, verify the resulting kernel identity and read-only flag, and use `mount --move` to a unique protected root-owned placeholder when uncovering a Mountpoint file. Moving the bind revealed the original local pointer; rebinding preserved the real material hash, and UID 10001 could read but could not open it for writing. Targeted uncover then allowed the real spreadsheet draft above without modifying S3.

Archive packing recognizes exact root-owned `(fuse, mountpoint-s3)` or `(fuse.s3fs, s3fs)` identities and requires matching device, source root derived from the Git LFS OID, and read-only mounts. It emits verified pointer bytes without `lstat`, `gettarinfo`, or body reads against those canonical files. All local/private files retain the pre/post metadata inventory, and the mount table is compared before and after packing. Size limits, archive checksums, credential exclusions, and checked extraction remain in place.

## Cleanup and retained evidence

All four owned disposable sandboxes were deleted and then confirmed missing through the Daytona API at 19:42:43–19:42:45 UTC: source `7f62f35d-fa64-421a-852f-3825136da876`, destination `f1e2d8cb-89f0-4de7-936e-f16d6752146c`, transferred tool-probe sandbox `14ec5b0c-3ceb-4d66-95d8-21f7c10c8ecb`, and superseded builder `f2fd2082-9e0e-44b1-a1b7-1507754b22e8`. Named image snapshots were retained. QA archive records were not deleted.

Local diagnostic evidence is in `/tmp/daytona-portable-archive-trial/`: `config.json`, `drafts.json`, `source-manifest.json`, `restored-manifest.json`, `archive.json`, `result.json`, `api-trace.json`, `post-hydration-drafts.json`, `image-provenance.json`, and `cleanup.json`. These contain identifiers, hashes, and timings; credential values are excluded from this report. The temporary fetched credential file is removed after cleanup.
