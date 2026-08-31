# Glasswing Chat Context and Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver transient file chat, company-scoped thread context, and explicit persistence of chat and sandbox material without restarting the current Pi sandbox.

**Architecture:** Synara owns transient attachments, live transcripts, sandbox I/O, and in-place checkout reconciliation. Glasswing owns authenticated source resolution and durable writes through its existing serialized Git writer. File-level hashes, lifecycle generations, project scope, and exact commit SHAs form the trust boundaries.

**Tech Stack:** TypeScript, Effect, Vitest, React, Railway Sandbox SDK, Python, FastAPI, Postgres, Git/Gitea, Next.js.

**Spec:** `docs/superpowers/specs/2026-08-30-glasswing-chat-context-persistence-design.md`

## Global Constraints

- No dropped file reaches Gitea without explicit user confirmation.
- No Gitea write credential enters a provider sandbox.
- Normal threads are shared only within the calling thread's project; side chats are excluded.
- Saving preserves the current sandbox and unrelated dirty files.
- Persistence is file-level; hunk-level persistence is out of scope.
- No deployment begins until all local acceptance checks pass.
- Production is out of scope.

---

### Task 1: Stage managed attachments into remote Pi workspaces

**Files:**
- Modify: `packages/contracts/src/providerWorker.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.ts`
- Modify: `apps/server/src/providerWorker/workerDispatch.ts`
- Modify: `apps/server/src/provider/providerAttachmentPaths.ts`
- Test: `packages/contracts/src/providerWorker.test.ts`
- Test: `apps/server/src/provider/Layers/RoutedPiAdapter.test.ts`
- Test: `apps/server/src/providerWorker/workerDispatch.test.ts`

**Interfaces:**
- Consumes: claimed managed attachment records and `WorkspaceRuntime.writeFile`.
- Produces: a worker-only runtime attachment manifest containing attachment ID, sandbox path, byte size, and SHA-256.

- [ ] Add a failing contract test proving `turn.send` accepts the runtime manifest and rejects traversal or malformed hashes.
- [ ] Run the contract test and confirm it fails because the manifest is absent.
- [ ] Add the minimal provider-worker manifest schema.
- [ ] Add a failing routed-adapter test proving claimed bytes are staged before `turn.send` and the request carries the verified manifest.
- [ ] Run it and confirm it fails because remote staging is absent.
- [ ] Stage bytes under a lifecycle-scoped workspace path using `WorkspaceRuntime.writeFile` and attach the manifest.
- [ ] Add a failing worker test proving Pi resolves only the manifest path after verifying size and hash.
- [ ] Implement the worker resolution and run all three focused test files green.
- [ ] Prove locally that Pi reads a sentinel file while the company-data Git HEAD remains unchanged.

### Task 2: Scope thread reads to the company project and retain authors

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Add: `apps/server/src/persistence/Migrations/099_ProjectionMessageAuthors.ts`
- Modify: `apps/server/src/orchestration/projector.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify: `apps/server/src/agentGateway/threadReadTools.ts`
- Modify: `apps/server/src/agentGateway/threadSummary.ts`
- Test: `apps/server/src/agentGateway/Layers/AgentGateway.test.ts`
- Test: affected orchestration projection tests

**Interfaces:**
- Consumes: the authenticated session subject/email already present at the external WebSocket boundary and the caller thread ID already present in Agent Gateway context.
- Produces: optional visible author metadata on user messages and project-filtered list/read results.

- [ ] Write a failing gateway test where a caller reads a normal thread in the same project.
- [ ] Add failing cases proving a side chat and another project's thread are hidden and rejected.
- [ ] Derive project authorization from `context.callerThreadId`; filter listing and validate direct reads.
- [ ] Run the focused gateway tests green.
- [ ] Write a failing projection test proving an externally authored user message retains stable subject and display email.
- [ ] Add the additive author fields, migration, event propagation, and summary rendering.
- [ ] Run the affected projection and gateway tests green.
- [ ] Prove locally with two external identities that one agent can quote the other's normal company thread but not a side chat or another project.

### Task 3: Persist attachments, responses, and complete threads

**Files:**
- Modify: Glasswing `packages/git_storage/models.py`
- Modify: Glasswing `packages/git_storage/repository.py`
- Modify: Glasswing `packages/api/app.py`
- Modify: Glasswing `web/src/lib/synara/server-bridge.ts`
- Add: Glasswing `web/src/app/api/companies/[id]/chat-persistence/route.ts`
- Modify: Synara `apps/web/src/components/chat/MessagesTimeline.tsx`
- Modify: Synara `apps/web/src/components/chat/AttachmentCard.tsx`
- Modify: Synara `apps/web/src/components/chat/ChatHeader.tsx`
- Add: Synara `apps/server/src/providerWorker/repositoryReconcile.ts`
- Modify: Synara provider-worker provisioner/runtime binding as required to invoke reconciliation
- Test: focused Glasswing writer/API tests
- Test: focused Synara reconciliation and UI tests

**Interfaces:**
- Consumes: a versioned Synara source reference, deterministic company-relative destination, authenticated Glasswing company context, and current sandbox binding.
- Produces: a Gitea commit SHA, committed paths, and an idempotent in-place reconciliation result.

- [ ] Write failing writer tests for absent/matching path preconditions and conflicting current blobs.
- [ ] Add optional file preconditions inside the existing serialized writer lock.
- [ ] Write failing source-export tests for attachment, assistant message, and complete-thread Markdown; include visible authors and exclude internal events.
- [ ] Add the smallest scoped Synara source-read endpoints and Glasswing persistence endpoint.
- [ ] Write failing UI tests for confirmation contents and stale-source conflict handling.
- [ ] Add Save actions for the three sources without adding a candidate database.
- [ ] Write failing reconciliation tests for exact-commit fetch, unrelated dirty-file preservation, same-path divergence, non-ancestor refusal, and stable runtime identity.
- [ ] Implement idle, generation-fenced, path-aware reconciliation with temporary credential erasure.
- [ ] Run all focused writer, API, UI, and reconciliation tests green.
- [ ] Prove locally that all three source types persist while unapproved attachments remain transient and the Pi session continues in the same sandbox.

### Task 4: Persist selected Outbox and checkout files

**Files:**
- Modify: `apps/server/src/workspaceRuntime/Services/WorkspaceRuntime.ts`
- Modify: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.ts`
- Modify: `apps/server/src/orchestration/Layers/StudioOutputReactor.ts`
- Modify: embedded environment/output review components
- Modify: Glasswing persistence request handling from Task 3 only as required for sandbox sources
- Test: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.test.ts`
- Test: `apps/server/src/orchestration/Layers/StudioOutputReactor.test.ts`
- Test: focused embedded UI tests

**Interfaces:**
- Consumes: Railway Sandbox SDK file `read`, `list`, and `stat`, lifecycle generation, current checkout status, and Slice 3 persistence.
- Produces: bounded file candidates with stable hashes and selected source bytes revalidated at confirmation.

- [ ] Write failing WorkspaceRuntime tests for bounded read, list, and stat plus symlink and missing-file behavior.
- [ ] Expose only those existing SDK operations.
- [ ] Write failing output-capture tests for a remote company sandbox's Outbox and checkout changes.
- [ ] Generalize existing output capture and return path, size, type, and hash.
- [ ] Write failing UI tests for complete-file selection and stale-generation/hash rejection.
- [ ] Route selected files through Task 3, keeping unselected files untouched.
- [ ] Run the focused runtime, capture, UI, and persistence tests green.
- [ ] Prove locally that selected files persist, unselected files remain transient, saved paths reconcile cleanly, and unrelated dirty paths survive.

### Task 5: Complete the local gate and deploy dev

**Files:**
- Modify: generated Synara embedded package artifacts in Glasswing only after Synara verification.
- Modify: deployment metadata only when required by the currently inspected dev topology.

**Interfaces:**
- Consumes: four locally green slices in clean feature branches.
- Produces: pushed Synara `glasswingos/dev` and Glasswing `dev` revisions plus dev browser evidence for every acceptance path.

- [ ] Run all focused suites and the complete local browser journey on isolated ports/state.
- [ ] Run Synara `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, provider-worker build/smoke, web/package build, and `git diff --check` once.
- [ ] Run Glasswing Python checks, web tests, production build, package-sync tests, and `git diff --check`.
- [ ] Review both complete diffs for secrets, generated noise, and unrelated changes.
- [ ] Revalidate remote refs and Railway dev topology.
- [ ] Commit, integrate, and push the verified Synara change to `origin/glasswingos/dev`.
- [ ] Rebuild the exact Synara embed and commit/integrate Glasswing to `origin/dev`.
- [ ] Deploy additive receivers before callers according to the observed topology.
- [ ] Repeat all four acceptance journeys in dev and record deployed revisions, Git SHAs, runtime IDs, browser console health, and secret-redaction evidence.
- [ ] If a dev check fails, roll back callers first and keep additive schemas in place while correcting the owning slice.
