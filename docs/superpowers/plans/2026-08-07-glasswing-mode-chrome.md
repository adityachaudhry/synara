# Glasswing Mode Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply GlasswingOS branding and remove Kanban, Pull requests, and Handoff entry points only while Glasswing mode is active.

**Architecture:** Reuse the page-lifetime Glasswing-mode flag. Keep sidebar policy in a small pure presentation helper and pass an explicit Handoff-visibility prop from `ChatView` to `ChatHeader`, preserving all normal Synara behavior and underlying routes.

**Tech Stack:** React, TypeScript, Vitest, Vitest Browser, Bun, GitHub Actions, Railway.

## Global Constraints

- Browser-only behavior; Electron is out of scope.
- Changes are additive presentation adapters on existing Synara primitives.
- Do not remove Kanban, pull-request, or Handoff implementation.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` in this task.
- Use `bun run test`, never `bun test`.

---

### Task 1: Sidebar Glasswing presentation

**Files:**
- Modify: `apps/web/src/glasswingMode.ts`
- Modify: `apps/web/src/glasswingMode.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `getGlasswingModeForCurrentPage(): boolean`
- Produces: a pure sidebar presentation resolver returning the threads title and primary-action visibility.

- [ ] **Step 1: Write the failing tests**

Add assertions that Glasswing mode resolves `GlasswingOS` with Kanban and Pull requests hidden, while normal mode resolves `Synara` with both actions visible.

- [ ] **Step 2: Run the focused test and verify it fails**

Run `bun run test apps/web/src/glasswingMode.test.ts` from the repository root and expect failure because the presentation resolver is not implemented.

- [ ] **Step 3: Implement the minimal presentation resolver and sidebar rendering**

Add the pure resolver in `glasswingMode.ts`; consume it once in `Sidebar`, pass its title to `SidebarSurfacePicker`, and conditionally render the Kanban and Pull requests actions.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `bun run test apps/web/src/glasswingMode.test.ts` and expect all assertions to pass.

### Task 2: Chat-header Handoff visibility

**Files:**
- Modify: `apps/web/src/components/chat/ChatHeader.tsx`
- Modify: `apps/web/src/components/chat/ChatHeader.dockLauncher.browser.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `hideHandoffAction?: boolean`
- Produces: Handoff badge/menu omission without hiding provider usage.

- [ ] **Step 1: Write the failing browser test**

Render `ChatHeader` with `hideHandoffAction` and a valid Handoff target, then assert the Handoff button is absent. Render the default case and assert it remains visible.

- [ ] **Step 2: Run the focused browser test and verify it fails**

Run the existing Vitest Browser target for `ChatHeader.dockLauncher.browser.tsx` and expect failure because the prop is not implemented.

- [ ] **Step 3: Implement the minimal header change**

Add `hideHandoffAction` to `ChatHeader`, gate only the Handoff badge/menu with it, and pass the current Glasswing-mode value from `ChatView`.

- [ ] **Step 4: Run the focused browser test and verify it passes**

Run the same Vitest Browser target and expect all assertions to pass.

### Task 3: Verify and deploy

**Files:**
- Modify: `docs/distributed-runtime/railway-v3-gitea-company-projects-trial-log.md` only if deployment produces a material learning.

**Interfaces:**
- Consumes: the existing `deploy-railway-v3-dev.yml` push workflow.
- Produces: a successful v3/dev Railway deployment and browser-verified UI.

- [ ] **Step 1: Run focused verification**

Run the focused unit/browser tests, the production web build, and `git diff --check`.

- [ ] **Step 2: Review and commit**

Inspect the final diff, commit the scoped files, and push `codex/v3-gitea-projects`.

- [ ] **Step 3: Verify deployment**

Wait for the matching GitHub Actions workflow run and Railway deployment to succeed, then confirm the public health endpoint returns HTTP 200.

- [ ] **Step 4: Browser acceptance**

Reload the deployed v3/dev browser app in Glasswing mode and verify `GlasswingOS` is visible while `Kanban`, `Pull requests`, and `Hand off` are absent.

