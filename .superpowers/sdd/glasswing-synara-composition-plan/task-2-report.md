# Task 2 Report: Provider-neutral repository-bound projects

## Outcome

Implemented the provider-neutral repository-binding boundary on top of Task 1 without importing the v3 Gitea catalog, company policy, UI, SuperTokens, or plugin framework.

Implementation commits:

- `09f8f2970 feat(server): add repository-bound external projects`
- `cd9920c9b fix(server): protect external project identity`

The result provides:

- A shared `ProjectRepositoryBinding` contract for a canonical HTTPS Git origin, safe owner/repository identifiers, a safe Git ref, and a safe non-empty repository subdirectory.
- Optional, backward-compatible `repositoryBinding` and `externalKey` fields on project events, read models, shells, persistence rows, and provider session-start input.
- Typed repository admission against explicit allowed-origin and allowed-owner policy.
- Migration `097_ProjectionProjectsRepositoryBinding`, following upstream `096`, with nullable binding/key columns and a partial unique index over non-null external keys.
- An internal-only `ExternalProjectResolver` service that admits coordinates before persistence, generates fresh server-owned project/command UUIDs, and resolves concurrent retries idempotently through the durable external-key identity.
- Provider routing of the admitted repository binding alongside the resolved project workspace.

## Security and ownership boundaries

- `origin` must be the exact `URL.origin` form of an HTTPS URL. Credentials, query strings, fragments, non-root paths, alternate casing that would be normalized, and other non-canonical forms are rejected.
- Owner, repository, ref, and subdirectory validation rejects traversal, absolute paths, backslashes, empty/dot segments, encoded traversal, dangerous ref syntax, and `.git` metadata paths. Inputs are rejected instead of silently normalized.
- Admission validates every field and then requires exact origin/owner membership in the injected policy allowlists.
- `externalKey` is present only on the server-internal `project.external.resolve` command. That command is not part of `ClientOrchestrationCommand`; attempts to add `externalKey` or `repositoryBinding` to browser `project.create` are stripped by the client command schema and cannot reach the decider.
- Task 2 does not expose an HTTP or WebSocket endpoint for the resolver. Task 5 remains responsible for constructing it with configured policy and placing it behind the single external-service authentication boundary.
- `externalKey` is not treated as a secret and is never used to derive a project ID or command ID. Fresh cryptographic UUIDs prevent a browser from pre-creating the IDs used by the internal resolver.
- A unique partial SQLite index on non-null `external_key` is the durable concurrency fence. The event append, project metadata projection, and accepted command receipt execute in the same SQL transaction, so a losing uniqueness race rolls back without leaving an orphan event. The normal single-server engine queue serializes commands; the database constraint remains the cross-worker/process fence.
- After any failed dispatch, the resolver re-reads the external key. A matching binding converges on the winner's project ID, while different canonical coordinates return `ExternalProjectBindingMismatchError` and never rebind the row.
- External-key lookup includes soft-deleted projects, so deletion does not free a durable external identity for reassignment.

## Persistence and replay compatibility

- Migration 097 adds nullable columns and preserves all pre-097 rows with `NULL` identity fields.
- The migration is idempotent: it checks existing columns before `ALTER TABLE` and creates the unique index with `IF NOT EXISTS`.
- Historical `project.created` events decode with `repositoryBinding: null` and `externalKey: null`.
- Both project projection paths default missing historical fields to null.
- Projection repository input keeps omitted identity fields backward-compatible and stores SQL `NULL`, preserving existing callers and ordinary projects.
- Snapshot list, workspace-root lookup, and project-id lookup queries all select and decode the new fields.
- The focused projection test verifies both the raw durable row and rehydration through `getProjectShellById`.

## TDD evidence

RED was observed before implementation in each boundary:

- Contract tests failed because `repositoryBinding.ts`, the new project fields, the internal resolve command, and provider session binding were absent.
- Admission tests failed because `repositoryBindingAdmission.ts` did not exist.
- Migration and projection repository tests failed because migration 097, its columns, external-key uniqueness, and JSON round-trip behavior did not exist.
- Projection pipeline dispatch failed because `project.external.resolve` was not a known internal command.
- Provider routing failed because the provider session input did not receive repository binding metadata.
- Resolver integration tests failed because the internal resolver service did not exist.
- An additional key-canonicality RED test caught whitespace acceptance and was fixed by exact, no-trim validation.

GREEN was reached with the smallest provider-neutral implementation. The first complete server run then found three backward-compatibility assertions: two older repository callers omitted the new optional fields, and one exact snapshot expectation lacked the decoded null defaults. The repository write boundary was changed to safely encode omission as SQL `NULL`, the snapshot expectation was updated to the new public shape, and the affected files passed 27/27 before the full rerun.

Review-fix RED/GREEN evidence:

- A regression test used the literal SHA-256-derived project and command IDs from the original implementation to pre-create a normal client project. RED failed with `OrchestrationCommandIdentityCollisionError`, proving that public `externalKey` values let a browser consume the resolver's deterministic IDs.
- GREEN replaced both derived IDs with independent server-generated UUIDs and derives the workspace directory from the fresh project ID. The resolver test then passed 6/6, including successful resolution to a different server-owned project ID while preserving the unrelated client project.
- The new simultaneous same-key/different-binding test passed against the existing transactional engine path: exactly one request succeeded, exactly one returned `ExternalProjectBindingMismatchError`, the stored coordinates matched the winner, and exactly one matching `project.created` event remained.
- The new retry-after-soft-deletion test also passed against existing behavior: lookup includes tombstoned rows, so different coordinates were rejected and the original project ID, binding, and deletion timestamp were preserved.
- Removed the tautological `segments.join("/") === value` repository-path check; the segment validator already rejects empty, dot, traversal, encoded, and unsafe segments.

## Verification

All commands used Node 24 from `/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` and Bun 1.3.12 through `npx --yes bun@1.3.12`.

Focused verification:

- Contracts (`repositoryBinding`, orchestration, provider): 3 files passed, 79 tests passed.
- Server admission, resolver, migration 097, migration replay/registry, projection repository/pipeline, and provider routing: 8 files passed, 214 tests passed.
- Direct repository identity project-shell rehydration: 1 test passed, 39 skipped by the focus filter.
- Backward-compatibility repair check: 2 files passed, 27 tests passed.
- Review-fix resolver RED: 1 expected failure and 5 passes; failure was the preempted deterministic command identity.
- Review-fix resolver GREEN: 1 file passed, 6 tests passed.
- Review-fix resolver/orchestration/projection suite: 5 files passed, 72 tests passed.

Complete affected package verification:

- `packages/contracts`: 19 files passed, 238 tests passed.
- `apps/server` after the review fix: 359 files passed, 3 files skipped; 4,090 tests passed, 16 tests skipped.
- Migration lineage: passed across 83 release tags (`v0.0.16..v0.7.3`).
- `git diff --check`: passed before the implementation commit.

Per repository instructions, `bun fmt`, `bun lint`, and `bun typecheck` were not run because the user explicitly prohibited them for this task. `bun test` was never used; all Vitest runs used `bun run test`.

## Deliberate omissions and follow-up seams

- No external endpoint or auth mechanism was added; Task 5 owns that boundary.
- No runtime repository checkout/provisioning or worker implementation was added; the admitted binding is routed in provider session start input for the later runtime task.
- No browser project UI accepts repository coordinates or external keys.
- No Gitea catalog/discovery, Glasswing company model, SuperTokens integration, Railway code, or plugin abstraction was ported.
- No broad v3 commit was cherry-picked.

No unresolved Task 2 defect remains. The integration dependency is explicit: Task 5 must inject the configured origin/owner allowlists when it wires `makeExternalProjectResolverLive` behind service authentication.
