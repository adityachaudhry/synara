# Glasswing Chat Context and Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver transient file chat, company-scoped thread context, and explicit persistence of chat and sandbox material without restarting the current Pi sandbox.

**Architecture:** Synara owns transient attachments, live transcripts, sandbox I/O, and in-place checkout reconciliation. Glasswing owns authenticated source resolution and durable writes through its existing serialized Git writer. File-level hashes, lifecycle generations, project scope, and exact commit SHAs form the trust boundaries.

**Tech Stack:** TypeScript, Effect, React, Railway Sandbox SDK, Python, FastAPI, Postgres, Git/Gitea, Next.js.

**Spec:** `docs/superpowers/specs/2026-08-30-glasswing-chat-context-persistence-design.md`

## Global Constraints

- No dropped file reaches Gitea without explicit user confirmation.
- No Gitea write credential enters a provider sandbox.
- Normal threads are shared only within the calling thread's project; side chats are excluded.
- Saving preserves the current sandbox and unrelated dirty files.
- Persistence is file-level; hunk-level persistence is out of scope.
- No deployment begins until all local acceptance checks pass.
- Verification is real local end-to-end only; add no unit-test files or mocked feature tests.
- Production is out of scope.

---

### Task 1: Stage managed attachments into remote Pi workspaces

**Files:**
- Modify: `packages/contracts/src/providerWorker.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.ts`
- Modify: `apps/server/src/providerWorker/workerDispatch.ts`
- Modify: `apps/server/src/provider/providerAttachmentPaths.ts`

**Interfaces:**
- Consumes: claimed managed attachment records and `WorkspaceRuntime.writeFile`.
- Produces: a worker-only runtime attachment manifest containing attachment ID, sandbox path, byte size, and SHA-256.

- [ ] Capture the current local failure by dropping a sentinel file into a real remote Pi thread and recording that Pi cannot read the bytes.
- [ ] Add the minimal provider-worker manifest schema.
- [ ] Stage bytes under a lifecycle-scoped workspace path using `WorkspaceRuntime.writeFile` and attach the manifest.
- [ ] Make worker dispatch resolve only verified manifest paths and reject malformed paths, sizes, and hashes at the live boundary.
- [ ] Repeat the real browser flow and prove Pi reads the sentinel while the company-data Git HEAD remains unchanged.
- [ ] Exercise wrong-thread, stale-generation, and corrupted-manifest requests through the local API boundary and record the rejected outcomes.

### Task 2: Scope thread reads to the company project and retain authors

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Add: `apps/server/src/persistence/Migrations/099_ProjectionMessageAuthors.ts`
- Modify: `apps/server/src/orchestration/projector.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify: `apps/server/src/agentGateway/threadReadTools.ts`
- Modify: `apps/server/src/agentGateway/threadSummary.ts`

**Interfaces:**
- Consumes: the authenticated session subject/email already present at the external WebSocket boundary and the caller thread ID already present in Agent Gateway context.
- Produces: optional visible author metadata on user messages and project-filtered list/read results.

- [ ] Capture the current local behavior with two external identities, two company projects, one normal thread, and one side chat.
- [ ] Derive project authorization from `context.callerThreadId`; filter listing and validate direct reads.
- [ ] Add the additive author fields, migration, event propagation, and summary rendering.
- [ ] Repeat the real flow and prove one agent can quote the other's normal company thread with author attribution.
- [ ] Call list/read through the live Agent Gateway and record that the side chat and other project are hidden or rejected.

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

**Interfaces:**
- Consumes: a versioned Synara source reference, deterministic company-relative destination, authenticated Glasswing company context, and current sandbox binding.
- Produces: a Gitea commit SHA, committed paths, and an idempotent in-place reconciliation result.

- [ ] Capture local before-state for Gitea HEAD, source versions, current sandbox ID, and one unrelated dirty file.
- [ ] Add optional file preconditions inside the existing serialized writer lock.
- [ ] Add the smallest scoped Synara source-read endpoints and Glasswing persistence endpoint.
- [ ] Add Save actions for the three sources without adding a candidate database.
- [ ] Implement idle, generation-fenced, path-aware reconciliation with temporary credential erasure.
- [ ] Save a real attachment, assistant response, and complete thread and inspect their committed bytes and metadata in the local Git destination.
- [ ] Prove an unapproved attachment remains transient, the dirty-file hash is unchanged, and the Pi session continues with the same sandbox ID.
- [ ] Create a real same-path conflict and non-ancestor condition locally and record non-destructive rejection.

### Task 4: Persist selected Outbox and checkout files

**Files:**
- Modify: `apps/server/src/workspaceRuntime/Services/WorkspaceRuntime.ts`
- Modify: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.ts`
- Modify: `apps/server/src/orchestration/Layers/StudioOutputReactor.ts`
- Modify: embedded environment/output review components
- Modify: Glasswing persistence request handling from Task 3 only as required for sandbox sources

**Interfaces:**
- Consumes: Railway Sandbox SDK file `read`, `list`, and `stat`, lifecycle generation, current checkout status, and Slice 3 persistence.
- Produces: bounded file candidates with stable hashes and selected source bytes revalidated at confirmation.

- [ ] Capture a real turn that creates an Outbox artifact and checkout edit that the current UI cannot persist.
- [ ] Expose only those existing SDK operations.
- [ ] Generalize existing output capture and return path, size, type, and hash.
- [ ] Route selected files through Task 3, keeping unselected files untouched.
- [ ] Repeat the real turn and prove selected files persist, unselected files remain transient, saved paths reconcile cleanly, and unrelated dirty paths survive.
- [ ] Exercise symlink, traversal, changed-generation, changed-hash, missing-file, and oversized-file cases through the live local boundary and record rejection.

### Task 5: Complete the local gate and deploy dev

**Files:**
- Modify: generated Synara embedded package artifacts in Glasswing only after Synara verification.
- Modify: deployment metadata only when required by the currently inspected dev topology.

**Interfaces:**
- Consumes: four locally green slices in clean feature branches.
- Produces: pushed Synara `glasswingos/dev` and Glasswing `dev` revisions plus dev browser evidence for every acceptance path.

- [ ] Run the complete real local browser journey on isolated ports/state; do not add or run unit-test files for this feature.
- [ ] Run Synara `bun fmt`, `bun lint`, `bun typecheck`, provider-worker build/smoke, web/package build, and `git diff --check` once.
- [ ] Run Glasswing Python syntax/import checks, production build, package synchronization, and `git diff --check`.
- [ ] Review both complete diffs for secrets, generated noise, and unrelated changes.
- [ ] Revalidate remote refs and Railway dev topology.
- [ ] Commit, integrate, and push the verified Synara change to `origin/glasswingos/dev`.
- [ ] Rebuild the exact Synara embed and commit/integrate Glasswing to `origin/dev`.
- [ ] Deploy additive receivers before callers according to the observed topology.
- [ ] Repeat all four acceptance journeys in dev and record deployed revisions, Git SHAs, runtime IDs, browser console health, and secret-redaction evidence.
- [ ] If a dev check fails, roll back callers first and keep additive schemas in place while correcting the owning slice.
