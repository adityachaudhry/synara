# Task 5 report: external identity exchange and release provenance

## Outcome

Synara now exposes the two server-to-server seams Glasswing needs without adding a second authentication system:

- `POST /api/external/projects/resolve` authenticates with `Authorization: Bearer <SYNARA_EXTERNAL_AUTH_SECRET>`, calls the existing external-project resolver, and returns only `{ projectId, repositoryBinding }`.
- `POST /api/auth/external/session` authenticates with the same secret, validates the exact assertion shape `{ subject, email, allowedProjectIds, expiresAt, nonce }`, and issues a normal short-lived Synara bearer session.
- `GET /api/version` returns `{ release, commit, protocolVersion }`.

The external session uses the existing signed bearer credential, persisted session row, revocation/logout behavior, and one-use WebSocket ticket. No OIDC, JWT, SuperTokens, parallel session store, or identity framework was added.

## Security and ownership boundary

- Missing, disabled, or incorrect external service secrets fail closed.
- Assertions reject blank/invalid subjects and emails, expired assertions, lifetimes over 15 minutes, reused nonces, and every unexpected property. Repository coordinates therefore cannot be smuggled into identity assertions.
- Nonces are consumed atomically in the Synara process and retained until assertion expiry. A secret-keyed, opaque deterministic session ID also makes the existing durable session primary key reject the same nonce after a controller restart. The persisted collision is reported as `409` replay without exposing session data. Session issuance failures remain fail closed because the in-process nonce stays consumed.
- Session claims and persisted rows receive the assertion's absolute expiry. Delayed or backward-clock issuance therefore cannot extend authority beyond `expiresAt`.
- `allowedProjectIds` is carried in the signed bearer claim and copied into the signed one-use WebSocket ticket. `undefined` preserves existing owner/local behavior; an explicit empty list is deny-all.
- Snapshot/project/thread outputs are filtered. Every supplied locator is independently checked, so an allowed project/thread cannot authorize a different cwd. Dispatch checks the real nested `{ command }` wire payload, and filesystem browse targets must remain inside the authorized cwd.
- `thread.turn.start` also resolves every nested `thread://` mention at admission time. Same-project mentions are allowed; malformed, missing, and cross-project thread references fail closed before provider prompt context can load a transcript.
- Scoped thread create/meta commands reject client-supplied worktree, working-directory, and associated-worktree paths. A non-null `parentThreadId` is independently resolved and must belong to the scope, preventing a private parent runtime from becoming an interrupt target.
- Project-scoped sessions are denied controller-local terminal/dev-server execution, GitHub provisioning, path-bearing worktree operations, automation management, and the unscoped device-frame socket. Unscoped device-frame sessions retain the full authenticated session and run through the existing revocable connection lifecycle.
- They are also denied provider discovery/compaction/plugin methods other than the safe composer-capabilities descriptor, provider-history import, every device RPC, and filesystem browse. The latter is deliberately denied rather than relying on symlink-unsafe lexical containment.
- File, attachment, provider, voice, local-image, and event-stream access stays project-bound. Local-image temp/generated roots cannot override the authorized workspace. New `thread.deleted` events carry project ownership so the subscriber can receive its own deletion after projection removal without seeing another project's deletion.
- Global administrative/server RPCs are denied to project-scoped sessions; the small global allowlist contains only output-filtered subscriptions/snapshots and globally safe composer capability metadata.
- Existing local startup-token and non-external sessions keep their prior behavior.
- The external project resolver retains Task 2 ownership and admission policy. Runtime wiring supplies fail-closed repository origin/owner allowlists from `SYNARA_EXTERNAL_REPOSITORY_ALLOWED_ORIGINS` and `SYNARA_EXTERNAL_REPOSITORY_ALLOWED_OWNERS`; no second resolver was introduced.
- `SYNARA_EXTERNAL_AUTH_SECRET` is omitted from startup logs and is not added to provider child environment allowlists.

## Provenance

- The server reports the release and source commit supplied as `SYNARA_RELEASE` and `SYNARA_COMMIT`, falling back to the package version and `development` only outside a staged build. Canary now supplies both the desktop display hash and canonical `SYNARA_COMMIT`.
- Server and provider worker provenance share one implementation and assert the existing WebSocket/provider-worker protocol epochs agree.
- The trusted controller forwards only `SYNARA_RELEASE` and `SYNARA_COMMIT` through the existing distributed-runtime config into the real Railway sandbox create environment; other `SYNARA_*` values, including the external auth secret, remain forbidden.
- The generated React embed package provenance preserves its compatibility keys and adds the common `{ release, commit, protocolVersion }` fields. Package generation now fails when protocol provenance is absent instead of silently assuming version `1`.

## TDD evidence

RED was recorded before implementation for:

- the missing external identity module and exchange service;
- absent project-scope propagation through bearer and WebSocket credentials;
- missing resolver/session/version routes;
- unrestricted cross-project snapshot, command, file, provider, terminal, and event access;
- missing package/server/worker provenance alignment.

GREEN focused regression locks cover secret rejection, assertion validation and nonce replay, session attribution/scope propagation, one-use WebSocket tickets, canonical resolver response, deny-all and cross-project scope behavior, configuration/log redaction, and release alignment.

The hardening review additionally recorded RED before each minimal fix for:

- trusted release provenance missing from the actual sandbox create environment;
- delayed/backward-clock issuance extending assertion expiry and restart replay returning `500`;
- allowed project/thread locators bypassing an unrelated cwd at dev-server, terminal, provider, and voice sinks;
- scoped local-image reads escaping through global temp/generated roots and scoped device-frame access accepting an arbitrary UDID;
- the nested dispatch wire shape being denied, absolute filesystem browse targets escaping, and deletion events disappearing after projection removal;
- scoped GitHub provisioning, worktree/handoff, terminal/dev-server execution, and automation management being admitted.
- a scoped turn loading another project's transcript through a nested `message.mentions` thread reference.
- scoped thread path injection/private-parent assignment, provider discovery overrides, provider-history import, device RPCs, and symlink-capable filesystem browse being admitted.

Each case is GREEN in the focused suites below.

Final verification used Node 24 and Bun 1.3.12 via `npx`:

- `bun run --cwd apps/server test`: 384 files passed, 3 skipped; 4,254 tests passed, 16 skipped.
- `bun run --cwd apps/web test`: 334 files passed; 4,113 tests passed.
- `bun run --cwd packages/contracts test`: 20 files passed; 250 tests passed.
- `bun run --cwd apps/server build`: passed.
- `git diff --check`: passed.

The nested-reference/fail-closed follow-up reran the focused project-scope, WebSocket admission, connection-lifecycle, and thread-mention projection suites: 4 files and 55 tests passed, followed by the server build and `git diff --check`. Inspection found no `replyTo` field on this command: assistant-selection attachments carry client-supplied text and do not resolve their message ID, binary attachments are claimed against the destination thread/principal, and `sourceProposedPlan.threadId` is independently required by the decider to belong to the destination project.

Per instruction, formatting, lint, and typecheck commands were not run.

Hardening-fix verification, also using Node 24 and Bun 1.3.12 via `npx`:

- 14 focused server auth/route/worker/provenance/lifecycle files: 124 tests passed.
- contracts orchestration schema: 44 tests passed.
- Canary tooling: 8 tests passed.
- React embed package writer: 5 tests passed.
- `bun run --cwd apps/server build`: passed.
- `git diff --check`: passed.

## Deliberate limits and remaining operational requirements

- Concurrent replay status classification follows Synara's current one-controller boundary. The existing durable session primary key rejects restart replay, but a future horizontally replicated controller would need a shared nonce ledger to return a uniform replay-specific response from every replica; no such architecture was introduced.
- Production must set one strong `SYNARA_EXTERNAL_AUTH_SECRET`, both repository admission allowlists, and build provenance (`SYNARA_RELEASE`, `SYNARA_COMMIT`). Empty repository allowlists intentionally deny new external bindings.
- This task did not deploy or mutate Railway or Glasswing.
