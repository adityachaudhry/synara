# Thread Outbox Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each thread's generated Outbox artifacts across Railway sandbox replacement, keep explicit Gitea promotion, and always expose the host Files panel.

**Architecture:** Reuse Synara's persistent home volume as a content-addressed blob store with one atomic manifest per thread. The current Railway sandbox remains the working copy; Synara checkpoints stable Outbox files periodically, on terminal turn events, and before intentional destruction, then restores the manifest before starting Pi in a replacement sandbox. Host-provided Files is gated by the host capability rather than internal workspace hydration.

**Tech Stack:** TypeScript, Effect, Node filesystem primitives, Railway Sandbox file APIs, React.

**Spec:** Approved architecture in the 2026-08-30 task conversation.

## Global Constraints

- Do not create unit-test files; verification is local and deployed end-to-end only.
- Do not add storage services or dependencies; reuse the persistent Synara home volume.
- Keep `/workspace/.synara/outbox` as the agent-visible working path.
- Keep Gitea writes explicit and user initiated.
- Refuse intentional sandbox destruction when the latest Outbox cannot be checkpointed.

---

### Task 1: Durable Outbox checkpoint and restore

**Files:**

- Create: `apps/server/src/providerWorker/outboxCheckpointStore.ts`
- Modify: `apps/server/src/providerWorker/Services/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.ts`
- Modify: `apps/server/src/serverLayers.ts`
- Modify: `apps/server/src/providerWorker/repositoryCheckout.ts`

**Interfaces:**

- Consumes: existing safe-path, SHA-256, candidate-list, Railway file-read/write, lifecycle-generation, and persistent runtime-binding behavior.
- Produces: checkpoint, restore, checkpoint-backed list/read, and promoted-hash tracking on `ProviderWorkerProvisionerShape`.

- [ ] **Step 1: Capture the failing real flow**

Run a local Pi turn that writes a uniquely named Markdown file to `/workspace/.synara/outbox`, confirm no durable checkpoint manifest exists, and retain the thread ID and marker for the green verification.

- [ ] **Step 2: Implement the smallest durable store**

Persist immutable SHA-256 blobs before atomically replacing `threads/<sha256(threadId)>.json`; validate every path/hash/size on write and read, preserve promoted hashes, and fsync files/directories before acknowledgement.

- [ ] **Step 3: Wire checkpoint and restore**

Checkpoint Outbox on a single global interval, terminal Pi events, and before restart/stop. Restore exact paths after creating the replacement Railway workspace and before `session.start`. Fall back to checkpoint-backed listing and reads when no worker connection exists.

- [ ] **Step 4: Verify the real recovery flow**

Create an unsaved Markdown artifact, observe the checkpoint, restart local Synara, resume the same thread, and have Pi read the exact marker from the same Outbox path. Confirm the artifact is absent from Gitea until explicit Save, then Save it and confirm the Gitea commit.

### Task 2: Host Files launcher availability

**Files:**

- Modify: `apps/web/src/components/chat/SingleChatSurface.tsx`

**Interfaces:**

- Consumes: `hostSidebar.filesPane` and the existing right-dock launcher metadata.
- Produces: Files availability whenever the embedding host supplies a Files pane, regardless of internal workspace hydration.

- [ ] **Step 1: Capture the failing browser state**

Open `http://localhost:13000/app/chipsage?view=agent` and record that the right launcher contains Side chats but not Files while the host supplied `filesPane`.

- [ ] **Step 2: Apply the root fix**

Treat `workspaceRoot !== null || hostSidebar?.filesPane !== undefined` as `hasWorkspace`; do not special-case Glasswing elsewhere.

- [ ] **Step 3: Verify rendered interaction**

Reload locally, confirm Files is visible, open it, select a repository file, and confirm the preview renders without framework or relevant console errors.

### Task 3: Dev delivery and verification

**Files:**

- Update the two existing branch histories only through normal commits; do not create another worktree.

**Interfaces:**

- Consumes: verified Synara and Glasswing commits.
- Produces: deployed Synara and Glasswing dev services with the same end-to-end behavior.

- [ ] **Step 1: Commit and push Synara, then vendor that exact embed into Glasswing**

Record the Synara SHA in the vendored package and commit the Glasswing update plus any required local-launch/deployment wiring.

- [ ] **Step 2: Deploy dev services**

Deploy Synara first, wait for health, then deploy Glasswing web/API so the host never points at a not-yet-ready runtime.

- [ ] **Step 3: Repeat the two end-to-end flows in dev**

Verify Files open/preview and create/checkpoint/restore/read an unsaved Outbox Markdown artifact across a real dev sandbox replacement. Confirm explicit Save promotes it to Gitea.
