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
- Nonces are consumed atomically in the Synara process and retained until assertion expiry. A secret-keyed, opaque deterministic session ID also makes the existing durable session primary key reject the same nonce after a controller restart. Session issuance failures remain fail closed because the in-process nonce stays consumed.
- `allowedProjectIds` is carried in the signed bearer claim and copied into the signed one-use WebSocket ticket. `undefined` preserves existing owner/local behavior; an explicit empty list is deny-all.
- Snapshot/project/thread outputs are filtered. Project, thread, turn, provider, terminal, file, attachment, dev-server, and event-stream access is admitted only when its project can be resolved inside the session scope. Global administrative/server RPCs are denied to project-scoped sessions; the small global allowlist contains only filtered subscriptions/snapshots and globally safe composer capability metadata.
- Existing local startup-token and non-external sessions keep their prior behavior.
- The external project resolver retains Task 2 ownership and admission policy. Runtime wiring supplies fail-closed repository origin/owner allowlists from `SYNARA_EXTERNAL_REPOSITORY_ALLOWED_ORIGINS` and `SYNARA_EXTERNAL_REPOSITORY_ALLOWED_OWNERS`; no second resolver was introduced.
- `SYNARA_EXTERNAL_AUTH_SECRET` is omitted from startup logs and is not added to provider child environment allowlists.

## Provenance

- The server reports the release and source commit supplied as `SYNARA_RELEASE` and `SYNARA_COMMIT`, falling back to the package version and `development` only outside a staged build.
- Server and provider worker provenance share one implementation and assert the existing WebSocket/provider-worker protocol epochs agree.
- The generated React embed package provenance preserves its compatibility keys and adds the common `{ release, commit, protocolVersion }` fields.

## TDD evidence

RED was recorded before implementation for:

- the missing external identity module and exchange service;
- absent project-scope propagation through bearer and WebSocket credentials;
- missing resolver/session/version routes;
- unrestricted cross-project snapshot, command, file, provider, terminal, and event access;
- missing package/server/worker provenance alignment.

GREEN focused regression locks cover secret rejection, assertion validation and nonce replay, session attribution/scope propagation, one-use WebSocket tickets, canonical resolver response, deny-all and cross-project scope behavior, configuration/log redaction, and release alignment.

Final verification used Node 24 and Bun 1.3.12 via `npx`:

- `bun run --cwd apps/server test`: 384 files passed, 3 skipped; 4,254 tests passed, 16 skipped.
- `bun run --cwd apps/web test`: 334 files passed; 4,113 tests passed.
- `bun run --cwd packages/contracts test`: 20 files passed; 250 tests passed.
- `bun run --cwd apps/server build`: passed.
- `git diff --check`: passed.

Per instruction, formatting, lint, and typecheck commands were not run.

## Deliberate limits and remaining operational requirements

- Concurrent replay status classification follows Synara's current one-controller boundary. The existing durable session primary key rejects restart replay, but a future horizontally replicated controller would need a shared nonce ledger to return a uniform replay-specific response from every replica; no such architecture was introduced.
- Production must set one strong `SYNARA_EXTERNAL_AUTH_SECRET`, both repository admission allowlists, and build provenance (`SYNARA_RELEASE`, `SYNARA_COMMIT`). Empty repository allowlists intentionally deny new external bindings.
- This task did not deploy or mutate Railway or Glasswing.
