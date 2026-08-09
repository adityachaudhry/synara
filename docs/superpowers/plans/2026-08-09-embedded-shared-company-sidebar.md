# Embedded Shared Company Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse Glasswing's Workspace company identity and footer inside embedded Synara at the same fixed 320px screen width, without embedded collapse or resize controls, while preserving standalone Synara.

**Architecture:** Add a React-only host sidebar context to the Synara package, derive an embedded sidebar presentation policy in one pure helper, and consume it in the chat route and thread sidebar. Extract Glasswing's existing company identity/footer into shared components and pass those components through the new adapter.

**Tech Stack:** React 19, TypeScript, TanStack Router, Vite library build, Next.js 15, Vitest, Testing Library, Railway, Chrome DevTools automation.

## Global Constraints

- The embedded rail is 320 screen pixels wide even when Synara uses `displayScale={1.3}`.
- Embedded mode has no Synara wordmark, collapse control, resize interaction, or seam rail.
- Standalone Synara keeps its existing header, footer, collapse, resize, and persisted-width behavior.
- Glasswing's Workspace and agent views render the same exported company identity and footer component implementations.
- Keep the existing `hostNavigation` runtime adapter supported.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck`; use focused tests and production builds.

---

### Task 1: Synara host sidebar adapter and presentation policy

**Files:**
- Create: `apps/web/src/hostSidebar.tsx`
- Create: `apps/web/src/lib/hostSidebarPresentation.ts`
- Create: `apps/web/src/lib/hostSidebarPresentation.test.ts`
- Modify: `apps/web/src/SynaraApp.tsx`
- Modify: `apps/web/src/embedded.ts`
- Modify: `apps/web/src/routes/_chat.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`

**Interfaces:**
- Produces: `SynaraHostSidebar`, `{ widthPx: number; lockedOpen?: boolean; header?: ReactNode; footer?: ReactNode }`.
- Produces: `useSynaraHostSidebar(): SynaraHostSidebar | null`.
- Produces: `resolveHostSidebarPresentation(hostSidebar, displayScale)` returning `width`, `collapsible`, `resizable`, and `showSeamRail`.

- [ ] **Step 1: Write the failing presentation test**

Assert that `{ widthPx: 320, lockedOpen: true }` at scale `1.3` resolves to `246.153846...px`, `collapsible: "none"`, `resizable: false`, and `showSeamRail: false`; assert that a null adapter resolves to the current off-canvas, resizable presentation.

- [ ] **Step 2: Run the focused test and verify RED**

Run the bundled Node Vitest command for `apps/web/src/lib/hostSidebarPresentation.test.ts`. Expect module-not-found before the helper exists.

- [ ] **Step 3: Implement the minimal adapter and route policy**

Create the context/provider, add `hostSidebar` to `SynaraAppProps`, wrap the router, derive the width from `widthPx / displayScale`, and feed the policy into `SidebarProvider`, `Sidebar`, `SidebarInstanceProvider`, and `SidebarRail`. A locked adapter uses `collapsible="none"`, `resizable={false}`, and renders no rail.

- [ ] **Step 4: Replace embedded chrome with slots**

In `Sidebar.tsx`, render `hostSidebar.header` in place of the Synara wordmark header and `hostSidebar.footer` in place of the footer when supplied. Preserve the current legacy embedded footer and standalone branches as fallbacks.

- [ ] **Step 5: Run the focused test and related route/layout tests for GREEN**

Run the new presentation test plus `chatRouteLayout.test.ts`, `synaraRuntimeConfig.test.ts`, and relevant Sidebar logic tests. Expect all selected tests to pass.

- [ ] **Step 6: Commit Synara implementation**

Commit the adapter, helper, tests, and route/sidebar integration as one independently testable change.

### Task 2: Shared Glasswing company sidebar components

**Files:**
- Create: `/private/tmp/glasswing-ai-2-synara-react-embed/web/src/components/company-sidebar-shell.tsx`
- Create: `/private/tmp/glasswing-ai-2-synara-react-embed/web/src/components/company-sidebar-shell.test.tsx`
- Modify: `/private/tmp/glasswing-ai-2-synara-react-embed/web/src/components/app-shell.tsx`
- Modify: `/private/tmp/glasswing-ai-2-synara-react-embed/web/src/components/synara/synara-workspace.tsx`
- Modify: `/private/tmp/glasswing-ai-2-synara-react-embed/web/src/components/synara/synara-workspace-runtime.tsx`
- Modify: `/private/tmp/glasswing-ai-2-synara-react-embed/web/src/app/app/[company]/page.tsx`

**Interfaces:**
- Produces: `COMPANY_SIDEBAR_WIDTH_PX = 320`.
- Produces: `CompanySidebarIdentity({ company })`.
- Produces: `CompanySidebarFooter({ company, userEmail })`.
- Consumes: Synara's `hostSidebar` prop.

- [ ] **Step 1: Write the failing shared-component test**

Render the identity with a company carrying location and stage and assert the visible name/location/stage behavior. Render the footer under a Next navigation test wrapper and assert the GlasswingOS, Workspace, and Profile navigation labels.

- [ ] **Step 2: Run the focused test and verify RED**

Run the repository's focused Vitest command for `company-sidebar-shell.test.tsx`. Expect the new module import to fail.

- [ ] **Step 3: Extract the exact existing components**

Move the company tag/stage rendering and footer entries from `app-shell.tsx` into `company-sidebar-shell.tsx`. Replace the original markup with the exported components and set `--sidebar-width` from `COMPANY_SIDEBAR_WIDTH_PX`.

- [ ] **Step 4: Pass complete company display data and shared slots to Synara**

Extend `SynaraWorkspaceProject` with the existing company display fields, pass them from the company page, and call `SynaraApp` with `hostSidebar={{ widthPx: COMPANY_SIDEBAR_WIDTH_PX, lockedOpen: true, header: <CompanySidebarIdentity ... />, footer: <CompanySidebarFooter ... /> }}`.

- [ ] **Step 5: Run the focused test and existing embed tests for GREEN**

Run the new shared-component test and the existing Synara workspace/embed tests. Expect all selected tests to pass.

- [ ] **Step 6: Commit Glasswing source integration**

Commit the shared components and adapter usage before refreshing the generated package.

### Task 3: Package, build, deploy, and browser verification

**Files:**
- Regenerate: `apps/web/package/`
- Refresh: `/private/tmp/glasswing-ai-2-synara-react-embed/web/vendor/synara-react/`
- Modify: deployment learning log if a build or live behavior requires correction.

**Interfaces:**
- Consumes: the Synara source commit and Glasswing shared component commit.
- Produces: a generated `@glasswing/synara-react` package containing `hostSidebar` types and runtime behavior.

- [ ] **Step 1: Build the Synara embed package**

Run the Vite embed production build with the bundled Node runtime, generate package metadata using the exact Synara/upstream commits, and sync `apps/web/package/` into Glasswing's vendored package.

- [ ] **Step 2: Run both production builds**

Run the Synara embed build and Glasswing Next production build. Record and correct any failures; known Next CSS parser warnings may remain only if the build exits successfully.

- [ ] **Step 3: Commit generated package and push both branches**

Commit the refreshed vendored package in Glasswing, push `codex/v3-gitea-projects`, push `codex/synara-react-embed`, and update `dev` to the verified Glasswing commit.

- [ ] **Step 4: Monitor Railway deployments**

Watch the Synara v3 dev and Glasswing dev workflows until both succeed, then confirm their deployed commit identities.

- [ ] **Step 5: Verify the live UI in Chrome**

At browser zoom 100%, measure the Workspace rail and embedded GlasswingOS rail in separate live views and require equal 320px widths. Assert that the embedded rail has no Synara logo, toggle-navigation control, toggle-sidebar rail, or resize-sidebar rail; assert that company metadata and all three shared footer entries are visible and clickable; check composer visibility and fresh browser errors.

- [ ] **Step 6: Final verification and handoff**

Run `git diff --check`, confirm both worktrees are clean and remote refs match, mark the goal complete, and report commits, deployments, Chrome measurements, and any trial-and-error learning.
