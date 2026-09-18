# Dev Pi startup failure — 2026-09-18

## Confirmed cause and scope

At 19:27:51 UTC, ChipSage thread `5223222d-7b1c-4756-b48b-77a77c1ddd99`
failed before Pi started. Trace `166153107fb65f9ffe1946ae6efd7685`, event 4983,
created its sandbox successfully, then failed cloning the company-data repository:
`remote: fatal: bad tree object abb08cb91ffb3466c8d6fa1bedb5931125ef7d31`.

Seven Git objects were physically missing from dev Gitea, including a commit and
Wonder's tree. Disabling MIDX/commit-graph did not make them readable. A fresh
whole-repository Git transfer needs reachable trees even when the client later
selects only ChipSage; blob filtering cannot hide a missing tree.

Production was not modified.

## Recovery

Temporarily rejected dev pushes with a dedicated pre-receive hook. Preserved a
full 1.1 GB bare-repository backup on the Gitea volume at
`/data/git-integrity-backups/20260918-missing-objects/repository.tar`.
SHA256: `c5b1cd0704b7223ce99aeff5b1aa07edb5e8bf359e4345d58b9aca24e0e80fe0`.

Recovered the original seven objects from the healthy **dev** sync mirror,
verified every Git object hash, and wrote them with `git hash-object -w` as the
repository owner. Did not reset or rewrite refs. Preserved main at
`4cdb1b517c44c01a38f83f055b688298af87e622` and the other existing branch at
`739d817cb626f5ac245b3d22f27db8ed83123a43` throughout the repair.
Full `git fsck --full --no-dangling` and a fresh Git transfer passed. Removed
the temporary push-rejection hook. Normal sync subsequently advanced main.

## Why objects disappeared: unresolved historical evidence

The first missing-object errors were at 23:48:53 UTC on September 17. The missing
commit was only 22 seconds old. Seven large packs, cruft packs, and the MIDX had
modification times in that same minute. Storage was not full and Gitea had not
restarted then. No matching manual maintenance command was found in the inspected
Codex sessions. There was no process-level Git maintenance trace.

Git 2.54 changed default automatic maintenance to geometric repacking.
`receive-pack` can run it after a push even with Gitea's cron GC disabled.
This explains the maintenance mechanism, but **does not prove which operation
removed these seven objects**. An upstream MIDX read race is not sufficient to
explain objects absent during fresh MIDX-disabled inspection.

## Durable dev configuration

Railway project `2fb578c6-304e-4a97-abd4-38b3897d9030`, dev environment,
service `glasswing-gitea`. Applied both repository-local Git settings and Railway
Gitea configuration variables, verified after service restart:

```ini
[git.config]
maintenance.auto = false
receive.autoGC = false
gc.auto = 0
gc.pruneExpire = never
receive.fsckObjects = true

[cron.git_gc_repos]
ENABLED = false
NOTICE_ON_SUCCESS = true

[cron.repo_health_check]
ENABLED = true
RUN_AT_START = true
SCHEDULE = @every 5m
TIMEOUT = 5m
ARGS = --connectivity-only --no-dangling
NOTICE_ON_SUCCESS = true
```

`gc.auto=0` alone is insufficient for Git 2.54 geometric maintenance.
`maintenance.auto=false` stops automatic invocation before it starts.
Do not use `maintenance.strategy=none`: Git 2.54's parser rejects it.
These controls do not prevent an administrator from explicitly running destructive
Git commands. Any future repack/prune must be deliberate, backed up, and performed
with writers stopped; capture sanitized maintenance diagnostics for that operation.
Retaining objects increases disk usage: re-enable only after a verified safe
maintenance procedure exists, not by quietly removing these settings.

Gitea previously recorded a failed midnight integrity check at 00:00:52 UTC, but
it was only an admin notice; no out-of-band alert reached us. Checks now run every
five minutes and record completion notices, with failures recorded separately.
The repository's `is_fsck_enabled` is true. A completion notice means the cron ran;
check repository failure notices too, because Gitea can finish the cron after
recording an individual repository failure. No external paging integration was
created by this change.

## Application diagnostics and acceptance

Commit `8cd42b7f63f7b1032a634aec111fafb16ae6f28b` adds a dedicated
`repository.checkout` start/finish trace with thread, sandbox, worker, lifecycle,
and duration. Failed checkout logs classify integrity errors and record the
missing object ID, exit code, and timeout flag without logging credentials or
checkout command arguments.

- Existing worker provisioner suite: 11 tests passed.
- Canonical `glasswingos/dev` deployment: Actions run `35389711530` succeeded.
- The original failed conversation returned a normal response after repair.
- Fresh thread `44fca81d-e3a4-426b-a09f-600384c68125` created a new sandbox;
  checkout completed in 3859 ms and the assistant returned two diligence questions.
- An authenticated fresh clone from dev sync succeeded. A temporary verification
  branch was pushed, read back, and deleted successfully; company files unchanged.

Investigation artifacts are in the local Glasswing checkout's
`.tmp/dev-pi-failure-20260918/` (private; includes recovery object payloads).
