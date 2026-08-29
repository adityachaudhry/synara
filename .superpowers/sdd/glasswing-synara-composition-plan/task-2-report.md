# Task 2 Report: Provider-neutral repository-bound projects

## Outcome

Implemented the provider-neutral repository-binding boundary on top of Task 1 without importing the v3 Gitea catalog, company policy, UI, SuperTokens, or plugin framework.

Implementation commit: `09f8f2970 feat(server): add repository-bound external projects`

The result provides:

- A shared `ProjectRepositoryBinding` contract for a canonical HTTPS Git origin, safe owner/repository identifiers, a safe Git ref, and a safe non-empty repository subdirectory.
- Optional, backward-compatible `repositoryBinding` and `externalKey` fields on project events, read models, shells, persistence rows, and provider session-start input.
- Typed repository admission against explicit allowed-origin and allowed-owner policy.
- Migration `097_ProjectionProjectsRepositoryBinding`, following upstream `096`, with nullable binding/key columns and a partial unique index over non-null external keys.
- An internal-only `ExternalProjectResolver` service that admits coordinates before persistence, derives deterministic service-owned project/command IDs from `externalKey`, and resolves concurrent retries idempotently.
- Provider routing of the admitted repository binding alongside the resolved project workspace.

## Security and ownership boundaries

- `origin` must be the exact `URL.origin` form of an HTTPS URL. Credentials, query strings, fragments, non-root paths, alternate casing that would be normalized, and other non-canonical forms are rejected.
- Owner, repository, ref, and subdirectory validation rejects traversal, absolute paths, backslashes, empty/dot segments, encoded traversal, dangerous ref syntax, and `.git` metadata paths. Inputs are rejected instead of silently normalized.
- Admission validates every field and then requires exact origin/owner membership in the injected policy allowlists.
- `externalKey` is present only on the server-internal `project.external.resolve` command. That command is not part of `ClientOrchestrationCommand`; attempts to add `externalKey` or `repositoryBinding` to browser `project.create` are stripped by the client command schema and cannot reach the decider.
- Task 2 does not expose an HTTP or WebSocket endpoint for the resolver. Task 5 remains responsible for constructing it with configured policy and placing it behind the single external-service authentication boundary.
- A unique partial SQLite index is the durable concurrency fence. Deterministic IDs and post-dispatch lookup make same-binding retries converge on one project; the same external key with different canonical coordinates returns `ExternalProjectBindingMismatchError` and never rebinds the row.
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

## Verification

All commands used Node 24 from `/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` and Bun 1.3.12 through `npx --yes bun@1.3.12`.

Focused verification:

- Contracts (`repositoryBinding`, orchestration, provider): 3 files passed, 79 tests passed.
- Server admission, resolver, migration 097, migration replay/registry, projection repository/pipeline, and provider routing: 8 files passed, 214 tests passed.
- Direct repository identity project-shell rehydration: 1 test passed, 39 skipped by the focus filter.
- Backward-compatibility repair check: 2 files passed, 27 tests passed.

Complete affected package verification:

- `packages/contracts`: 19 files passed, 238 tests passed.
- `apps/server`: 359 files passed, 3 files skipped; 4,087 tests passed, 16 tests skipped.
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
