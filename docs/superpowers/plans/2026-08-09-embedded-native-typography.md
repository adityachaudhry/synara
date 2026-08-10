# Embedded Native Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Glasswing's 1.3x whole-app scale and make embedded Synara readable through its existing typography token system.

**Architecture:** Add a small React adapter helper that converts a host-provided base font size into Synara's existing CSS custom properties. `SynaraApp` applies the variables at its embedded root while retaining backward-compatible display-scale support; Glasswing selects a 15px embedded base and stops selecting geometric scale.

**Tech Stack:** React, TypeScript, CSS custom properties, Vitest, Vite, Next.js, Railway.

## Global Constraints

- Standalone Synara behavior and persisted user typography settings must remain unchanged.
- Glasswing's shared company sidebar component and 320px width remain unchanged.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` under the repository instructions for this task.
- Use `bun run test`, never `bun test`.
- Verify the deployed browser-only experience in Chrome at 100% browser zoom.

---

### Task 1: Embedded typography adapter

**Files:**
- Create: `apps/web/src/lib/embeddedTypography.ts`
- Create: `apps/web/src/lib/embeddedTypography.test.ts`
- Modify: `apps/web/src/SynaraApp.tsx`
- Modify: `apps/web/scripts/write-embed-package.mjs`
- Test: `apps/web/scripts/write-embed-package.test.ts`

**Interfaces:**
- Consumes: `getAppTypographyScale(baseFontSizePx: number): AppTypographyScale`
- Produces: `createEmbeddedTypographyStyle(value: unknown): CSSProperties | undefined`
- Produces: `SynaraAppProps.embeddedBaseFontSizePx?: number`

- [ ] **Step 1: Write the failing unit test**

Add literal assertions showing that a 15px host base produces the expected UI/chat custom properties and that invalid or absent values produce no override.

- [ ] **Step 2: Run the focused test and verify RED**

Run `bun run test apps/web/src/lib/embeddedTypography.test.ts` and confirm failure because the helper does not exist.

- [ ] **Step 3: Implement the minimal helper and mount adapter**

Create the helper from `getAppTypographyScale`, add the optional prop, merge its style with any legacy display-scale style, and add a diagnostic `data-synara-embedded-base-font-size` attribute only when the override is active.

- [ ] **Step 4: Add and verify the public declaration test**

Require the generated React package declaration to expose `embeddedBaseFontSizePx?: number`, then update the package build entry template/export path as needed.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the helper, Synara runtime, host sidebar presentation, and React package build tests with `bun run test`.

### Task 2: Glasswing host configuration and delivery

**Files:**
- Modify: `/private/tmp/glasswing-ai-2-synara-react-embed/web/src/components/synara/synara-workspace-runtime.tsx`
- Modify: generated `@glasswing/synara-react` package artifacts synced by the established package script
- Create: `docs/distributed-runtime/learnings/2026-08-09-embedded-native-typography.md`

**Interfaces:**
- Consumes: `SynaraAppProps.embeddedBaseFontSizePx`
- Produces: native-scale GlasswingOS mount with `embeddedBaseFontSizePx={15}`

- [ ] **Step 1: Remove the geometric scale selection**

Delete `displayScale={1.3}` from the Glasswing runtime and pass `embeddedBaseFontSizePx={15}`.

- [ ] **Step 2: Build and sync the package**

Build `@glasswing/synara-react`, sync the generated package into Glasswing using the repository's existing workflow, and run both production builds.

- [ ] **Step 3: Deploy both dev services**

Commit and push the additive Synara and Glasswing changes to their existing dev branches, then wait for the Railway services to report successful deployment.

- [ ] **Step 4: Verify in Chrome**

At 100% browser zoom, confirm `visualViewport.scale === 1`, no `[data-synara-display-scale]` wrapper, a 15px embedded base token, a 320px host sidebar, readable composer/transcript/control text, and no bottom clipping or console errors.

- [ ] **Step 5: Record trial-and-error evidence**

Document why CSS zoom failed, the live before/after measurements, the chosen adapter seam, verification commands, deploy identifiers, and any course corrections.
