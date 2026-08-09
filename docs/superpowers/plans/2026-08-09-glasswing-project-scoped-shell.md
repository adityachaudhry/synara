# Glasswing Project-Scoped Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a project-scoped Glasswing shell on the embeddable Synara React adapter while preserving standalone Synara.

**Architecture:** Glasswing supplies a host-project context and handles cross-company routing. Synara consumes that context only in Glasswing mode to match one project, project its threads, and apply a centralized chrome-visibility policy.

**Tech Stack:** React 19, TypeScript, TanStack Router, Next.js 16, Vitest, Vite

## Global Constraints

- Keep all shared Synara behavior additive and Glasswing-mode gated.
- Do not add provider, orchestration, storage, or WebSocket primitives.
- Hidden controls must not remain keyboard-focusable.
- Standalone Synara retains its current sidebar and composer behavior.

---

### Task 1: Host-project runtime contract and matching

**Files:**
- Modify: `apps/web/src/synaraRuntimeConfig.ts`
- Modify: `apps/web/src/SynaraApp.tsx`
- Create: `apps/web/src/glasswingProjectContext.ts`
- Create: `apps/web/src/glasswingProjectContext.test.ts`

**Interfaces:**
- Produces: `SynaraHostProject`, `SynaraHostProjectSelection`, and `resolveGlasswingHostProject(projects, hostProject)`.

- [ ] Write matching tests for display name, slug, checkout basename, and no-match isolation.
- [ ] Run the focused test and confirm it fails because the helper does not exist.
- [ ] Implement the config types, helper, and `SynaraApp` forwarding.
- [ ] Run the focused test and confirm it passes.

### Task 2: Central Glasswing chrome policy

**Files:**
- Modify: `apps/web/src/glasswingMode.ts`
- Modify: `apps/web/src/glasswingMode.test.ts`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**
- Produces: visibility booleans for sidebar tools, project actions, environment controls, composer access mode, workspace tray, and voice input.

- [ ] Add failing policy tests for Glasswing-hidden and standalone-visible controls.
- [ ] Run the focused test and confirm the new fields are absent.
- [ ] Add the policy fields and gate semantic rendering in `ChatView`.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Project picker and scoped thread rail

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify or create: focused `Sidebar` logic/browser tests selected from the existing suite.

**Interfaces:**
- Consumes: `readSynaraRuntimeConfig().hostProject` and `resolveGlasswingHostProject`.
- Produces: a Glasswing project picker, one-project thread projection, and project-bound new-thread action.

- [ ] Add failing tests for project picker copy, absence of Search/Activity/Automations, and isolation to selected-project threads.
- [ ] Run the focused tests and confirm expected failures.
- [ ] Implement the picker and scoped list using existing thread row renderers.
- [ ] Run the focused tests and confirm they pass.

### Task 4: Glasswing React host integration

**Files:**
- Modify: `web/src/app/app/[company]/page.tsx`
- Modify: `web/src/components/synara/synara-workspace.tsx`
- Modify: `web/src/components/synara/synara-workspace-runtime.tsx`
- Add focused helper/component coverage if supported by the host test setup.

**Interfaces:**
- Consumes: `SynaraApp.hostProject`.
- Produces: exact selected-company label and Next.js navigation on project selection.

- [ ] Pass `{ name, slug }` from the server page into the dynamic client adapter.
- [ ] Derive the target slug from checkout basename with normalized-name fallback.
- [ ] Wire project selection to `/app/<slug>?view=agent`.
- [ ] Build Glasswing and confirm TypeScript accepts the vendored contract.

### Task 5: Package, deploy, and browser acceptance

**Files:**
- Modify: `docs/distributed/synara-react-embed-learnings.md`
- Modify: vendored `web/vendor/synara-react/**` via the existing sync script.

- [ ] Run focused Synara tests and both standalone/embed builds.
- [ ] Stamp and sync the exact Synara package into Glasswing.
- [ ] Run the Glasswing production build.
- [ ] Commit and push the Synara integration branch and Glasswing dev branch.
- [ ] Wait for both deployments to succeed.
- [ ] In Chrome, verify selected-project label/options, only matching threads, correct New thread project, all requested hidden controls, message send, and unchanged company-name underline.

