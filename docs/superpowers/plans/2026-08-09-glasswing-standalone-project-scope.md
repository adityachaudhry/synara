# Glasswing Standalone Project Scope Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the standalone v3 and embedded Glasswing mounts share the same project-scoped shell with different selection owners.

**Architecture:** A pure selector resolves the displayed Synara project from host identity when embedded and from the focused project ID when standalone. Glasswing mode enables the shared presentation; the optional host callback only extends native project activation with outer route navigation.

**Tech Stack:** React 19, TypeScript, TanStack Router, Zustand, Vitest, Vite, Next.js 16

## Global Constraints

- Keep the change behind Glasswing mode and additive to general-purpose Synara.
- Do not introduce a second selected-project store.
- Keep host routing optional and adapter-owned.
- Do not change provider, orchestration, storage, authentication, or WebSocket contracts.
- Hidden controls must be absent from the rendered tree.

---

### Task 1: Standalone and embedded project selection policy

**Files:**
- Modify: `apps/web/src/glasswingProjectContext.ts`
- Modify: `apps/web/src/glasswingProjectContext.test.ts`

**Interfaces:**
- Consumes: ordinary project candidates, optional `hostProject`, optional focused `ProjectId`.
- Produces: `resolveGlasswingSelectedProject(projects, { hostProject, activeProjectId })`.

- [ ] Add literal tests proving host identity wins, standalone focused project resolves by ID, and missing standalone selection returns `null` rather than another project.
- [ ] Run `glasswingProjectContext.test.ts` and observe failure because the selector is missing.
- [ ] Implement the smallest selector using the existing host matcher and direct project-ID lookup.
- [ ] Re-run the focused test and observe all cases pass.

### Task 2: Shared Glasswing presentation policy

**Files:**
- Modify: `apps/web/src/glasswingMode.test.ts`
- Modify: `apps/web/src/glasswingMode.ts`
- Modify: `apps/web/src/components/ChatView.browser.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `glasswingMode` only for presentation enablement.
- Produces: simplified chrome in both standalone and embedded Glasswing mounts.

- [ ] Change policy expectations so standalone Glasswing hides the project, environment, runtime, workspace, and voice controls.
- [ ] Remove `hostProject` from the rendered standalone chat fixture and assert the same controls remain absent.
- [ ] Run the focused policy and rendered tests and observe failures from the current embedded-only gate.
- [ ] Make the project-scoped presentation flag follow Glasswing mode while leaving non-Glasswing behavior unchanged.
- [ ] Re-run the focused tests and observe them pass.

### Task 3: Standalone project picker and scoped rail

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/Sidebar.logic.test.ts` only if selection-order coverage needs extension.

**Interfaces:**
- Consumes: `resolveGlasswingSelectedProject`, focused `activeProjectId`, optional host selection callback.
- Produces: one shared project picker and one-project thread projection for both mounts.

- [ ] Replace the embedded-only shell condition with Glasswing-mode enablement.
- [ ] Resolve embedded selection from host identity and standalone selection from the focused ordinary project ID.
- [ ] Reuse `activateGlasswingProjectSelection`; standalone omits `selectHostProject`, embedded supplies it.
- [ ] Keep missing selection isolated and bind New thread to the resolved project.
- [ ] Run project-context, sidebar-logic, Glasswing policy, and rendered chat tests.

### Task 4: Package, deploy, and live acceptance

**Files:**
- Modify: `docs/distributed/synara-react-embed-learnings.md`
- Regenerate: `apps/web/dist-embed/package/**`
- Regenerate in Glasswing: `web/vendor/synara-react/**`

**Interfaces:**
- Produces: exact Synara package provenance and matching deployed standalone/embed behavior.

- [ ] Record the configuration divergence and convergence correction in the learning log.
- [ ] Run focused tests, the standalone Vite build, and the embed Vite build/package writer.
- [ ] Sync the exact package into Glasswing and run its Next production build.
- [ ] Commit and push the Synara integration branch, then commit and push the refreshed Glasswing package to its feature and dev branches.
- [ ] Wait for both exact-commit Railway workflows to succeed.
- [ ] In Chrome, verify the standalone v3 project picker, project-only thread rail, hidden controls, and underlined company selector; then verify the embedded Nth to Cue Cloud host route transition still works.
