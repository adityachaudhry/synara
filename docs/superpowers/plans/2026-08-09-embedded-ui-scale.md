# Embedded Synara UI Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make embedded Synara render at a normal, cohesive 1.30x visual scale inside Glasswing while preserving standalone Synara at scale 1.

**Architecture:** Add a small pure scale-normalization module to the Synara React adapter, expose an optional `displayScale` host prop, and conditionally wrap only scaled mounts in a host-filling CSS layout-zoom viewport. CSS zoom supplies the smaller logical viewport itself; the Glasswing adapter selects `1.3`, while standalone entrypoints omit the prop and retain their current route tree and geometry.

**Tech Stack:** React 19, TypeScript, TanStack Router, Vite embed library build, Next.js 16, Vitest, Chrome browser verification.

## Global Constraints

- The public value is normalized to a conservative `1` through `1.5` range and rounded to two decimals; invalid values fall back to `1`.
- Glasswing passes exactly `1.3`; standalone Synara omits the option and remains at `1`.
- Scaling must resize type, spacing, icons, fixed widths, controls, and route content together rather than changing fonts alone.
- The scaled visual viewport must occupy exactly the existing host rectangle and must not reintroduce bottom clipping or page overflow.
- Changes stay additive in the reusable React adapter and do not replace Synara primitives.
- Do not run `bun fmt`, `bun lint`, `bun typecheck`, or `bun test`; use focused Vitest commands plus production builds.

---

### Task 1: Pure embedded display-scale contract

**Files:**
- Create: `apps/web/src/lib/embeddedDisplayScale.ts`
- Create: `apps/web/src/lib/embeddedDisplayScale.test.ts`

**Interfaces:**
- Consumes: a host-provided `unknown` display scale.
- Produces: `normalizeEmbeddedDisplayScale(value: unknown): number` and `createEmbeddedDisplayScaleStyle(value: unknown): { readonly width: string; readonly height: string; readonly zoom: number } | undefined`.

- [ ] **Step 1: Write the failing normalization and viewport-style tests**

```ts
import { describe, expect, it } from "vitest";

import {
  createEmbeddedDisplayScaleStyle,
  normalizeEmbeddedDisplayScale,
} from "./embeddedDisplayScale";

describe("embedded display scale", () => {
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "1.3"])(
    "falls back to one for invalid value %s",
    (value) => expect(normalizeEmbeddedDisplayScale(value)).toBe(1),
  );

  it("rounds and clamps valid numeric values", () => {
    expect(normalizeEmbeddedDisplayScale(0.8)).toBe(1);
    expect(normalizeEmbeddedDisplayScale(1.296)).toBe(1.3);
    expect(normalizeEmbeddedDisplayScale(1.8)).toBe(1.5);
  });

  it("creates a host-filling layout viewport for scaled mounts", () => {
    expect(createEmbeddedDisplayScaleStyle(1)).toBeUndefined();
    expect(createEmbeddedDisplayScaleStyle(1.3)).toEqual({
      width: "100%",
      height: "100%",
      zoom: 1.3,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the expected missing-module failure**

Run:

```bash
/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run apps/web/src/lib/embeddedDisplayScale.test.ts
```

Expected: FAIL because `./embeddedDisplayScale` does not exist.

- [ ] **Step 3: Implement bounded normalization and host-filling viewport dimensions**

```ts
export const MIN_EMBEDDED_DISPLAY_SCALE = 1;
export const MAX_EMBEDDED_DISPLAY_SCALE = 1.5;

export interface EmbeddedDisplayScaleStyle {
  readonly width: string;
  readonly height: string;
  readonly zoom: number;
}

export function normalizeEmbeddedDisplayScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const bounded = Math.min(
    MAX_EMBEDDED_DISPLAY_SCALE,
    Math.max(MIN_EMBEDDED_DISPLAY_SCALE, value),
  );
  return Math.round(bounded * 100) / 100;
}

export function createEmbeddedDisplayScaleStyle(
  value: unknown,
): EmbeddedDisplayScaleStyle | undefined {
  const zoom = normalizeEmbeddedDisplayScale(value);
  if (zoom === 1) return undefined;
  return { width: "100%", height: "100%", zoom };
}
```

- [ ] **Step 4: Rerun the focused test and confirm it passes**

Run the command from Step 2.

Expected: PASS with three test cases plus the parameterized invalid-value cases.

- [ ] **Step 5: Commit the pure scale contract**

```bash
git add apps/web/src/lib/embeddedDisplayScale.ts apps/web/src/lib/embeddedDisplayScale.test.ts
git commit -m "Add bounded embedded display scaling"
```

### Task 2: Synara React adapter and package declaration

**Files:**
- Modify: `apps/web/src/synaraRuntimeConfig.ts`
- Modify: `apps/web/src/synaraRuntimeConfig.test.ts`
- Modify: `apps/web/src/SynaraApp.tsx`
- Modify: `apps/web/scripts/write-embed-package.mjs`
- Modify: `apps/web/scripts/write-embed-package.test.ts`

**Interfaces:**
- Consumes: `normalizeEmbeddedDisplayScale` and `createEmbeddedDisplayScaleStyle` from Task 1.
- Produces: optional `SynaraRuntimeConfig.displayScale?: number`, optional `SynaraAppProps.displayScale?: number`, and a scaled DOM root marked with `data-synara-display-scale` only when the normalized value exceeds 1.

- [ ] **Step 1: Add failing runtime-config and generated-declaration assertions**

Add this runtime test:

```ts
it("normalizes an optional embedded display scale without changing standalone defaults", () => {
  expect(readSynaraRuntimeConfig().displayScale).toBeUndefined();

  configureSynaraRuntime({ displayScale: 1.296 });
  expect(readSynaraRuntimeConfig().displayScale).toBe(1.3);

  configureSynaraRuntime({ displayScale: Number.POSITIVE_INFINITY });
  expect(readSynaraRuntimeConfig().displayScale).toBe(1);
});
```

In the existing package-writer test, assert the emitted `index.d.ts` contains:

```ts
expect(declarations).toContain("readonly displayScale?: number;");
```

- [ ] **Step 2: Run the two focused suites and confirm the new assertions fail**

```bash
/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run apps/web/src/synaraRuntimeConfig.test.ts apps/web/scripts/write-embed-package.test.ts
```

Expected: FAIL because the runtime config and package declaration do not expose `displayScale`.

- [ ] **Step 3: Add and normalize the optional runtime field**

Import `normalizeEmbeddedDisplayScale` into `synaraRuntimeConfig.ts`, add this property to `SynaraRuntimeConfig`, and copy it only when the caller supplies it:

```ts
/** Optional host-selected visual scale for the complete embedded app surface. */
readonly displayScale?: number;
```

```ts
...(config.displayScale === undefined
  ? {}
  : { displayScale: normalizeEmbeddedDisplayScale(config.displayScale) }),
```

- [ ] **Step 4: Conditionally wrap scaled React mounts**

Destructure `displayScale` in `SynaraApp`, forward it into `configureSynaraRuntime` only when supplied, and create the route tree once:

```tsx
const app = (
  <AppHistoryProvider history={history}>
    <RouterProvider router={router} />
  </AppHistoryProvider>
);
const displayScaleStyle = createEmbeddedDisplayScaleStyle(displayScale);
if (!displayScaleStyle) return app;

return (
  <div
    className="relative min-h-0 min-w-0"
    data-synara-display-scale={displayScaleStyle.zoom}
    style={displayScaleStyle}
  >
    {app}
  </div>
);
```

This conditional return preserves the exact standalone element tree when the option is absent.

- [ ] **Step 5: Add the public field to the deterministic package declaration**

Within the `SynaraRuntimeConfig` declaration string in `write-embed-package.mjs`, add:

```ts
readonly displayScale?: number;
```

- [ ] **Step 6: Rerun the two focused suites plus the scale suite**

```bash
/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run apps/web/src/lib/embeddedDisplayScale.test.ts apps/web/src/synaraRuntimeConfig.test.ts apps/web/scripts/write-embed-package.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the reusable adapter change**

```bash
git add apps/web/src/SynaraApp.tsx apps/web/src/synaraRuntimeConfig.ts apps/web/src/synaraRuntimeConfig.test.ts apps/web/scripts/write-embed-package.mjs apps/web/scripts/write-embed-package.test.ts
git commit -m "Scale embedded Synara as one app surface"
```

### Task 3: Glasswing selection, package sync, deployment, and live verification

**Files:**
- Modify: `/private/tmp/glasswing-ai-2-synara-react-embed/web/src/components/synara/synara-workspace-runtime.tsx`
- Replace generated package contents: `/private/tmp/glasswing-ai-2-synara-react-embed/web/vendor/synara-react/`
- Modify dependency lockfile only if the package sync changes it: `/private/tmp/glasswing-ai-2-synara-react-embed/web/package-lock.json`
- Record: `docs/distributed-runtime/railway-v3-gitea-company-projects-trial-log.md`

**Interfaces:**
- Consumes: `SynaraAppProps.displayScale?: number` from Task 2.
- Produces: Glasswing embedded mounts configured with `displayScale={1.3}` and a deployed package whose provenance points at the Synara adapter commit.

- [ ] **Step 1: Build the deterministic Synara embed package**

Resolve the current adapter commit and its merge base with this checkout's upstream remote,
`emanuele/main`, then run the checked-in Vite and package-writer entrypoints with bundled Node:

```bash
NODE_BIN="/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
SYNARA_COMMIT="$(git rev-parse HEAD)"
SYNARA_UPSTREAM_COMMIT="$(git merge-base HEAD emanuele/main)"
(
  cd apps/web
  "$NODE_BIN" node_modules/vite/bin/vite.js build --config vite.embed.config.ts
  SYNARA_COMMIT="$SYNARA_COMMIT" SYNARA_UPSTREAM_COMMIT="$SYNARA_UPSTREAM_COMMIT" \
    "$NODE_BIN" scripts/write-embed-package.mjs
)
```

Expected: `apps/web/dist-embed/package` contains `index.js`, `style.css`, `index.d.ts`, and `synara-provenance.json` with non-empty commit identifiers.

- [ ] **Step 2: Sync the generated package into Glasswing and select scale 1.3**

Use a directory-aware copy that removes only the existing generated vendor package contents and replaces them with `apps/web/dist-embed/package`. In `synara-workspace-runtime.tsx`, add the prop beside the other host adapter fields:

```tsx
displayScale={1.3}
```

- [ ] **Step 3: Build both production surfaces**

```bash
NODE_BIN="/Users/adityachaudhry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
(
  cd apps/web
  "$NODE_BIN" node_modules/vite/bin/vite.js build
)
PATH="$(dirname "$NODE_BIN"):$PATH" \
  "$NODE_BIN" /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run build \
  --prefix /private/tmp/glasswing-ai-2-synara-react-embed/web
```

Expected: both production builds exit 0. Do not substitute workspace-wide lint/typecheck commands.

- [ ] **Step 4: Record the trial and compatibility finding**

Append a dated entry to
`docs/distributed-runtime/railway-v3-gitea-company-projects-trial-log.md` stating:

- Live 100% Chrome measurements showed Synara at 12px type and 28px rows inside a 16px Glasswing host.
- Font-only and density-only changes were rejected because they do not scale the full surface.
- The reusable adapter now accepts bounded `displayScale`; Glasswing chooses 1.3 and standalone omits it.
- The model picker portals to `body` and already inherits the 16px Glasswing base, so it remains visually consistent with the main surface at approximately 15.6px rendered type.

- [ ] **Step 5: Commit and push Synara, then commit and push Glasswing**

Commit the trial log with the Synara package provenance/build outputs excluded, push `codex/v3-gitea-projects`, then commit the Glasswing runtime plus vendor package and push both `codex/synara-react-embed` and its configured `dev` delivery ref. Confirm each remote commit before monitoring deployment.

- [ ] **Step 6: Verify deployment health before opening the user path**

Confirm Railway/GitHub delivery jobs for both pushed commits succeed and the deployed package provenance/asset change is present. If a deployment fails, inspect the failed stage, correct the source, rebuild, and redeploy before browser verification.

- [ ] **Step 7: Verify the live Glasswing experience in Chrome at 100% zoom**

On `https://glasswing-web-dev.up.railway.app/app/cue-cloud?view=agent`, assert:

```js
({
  browserScale: window.visualViewport?.scale,
  displayScale: document
    .querySelector("[data-synara-display-scale]")
    ?.getAttribute("data-synara-display-scale"),
  pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  pageOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
})
```

Expected: `browserScale === 1`, `displayScale === "1.3"`, and both overflow deltas are `0`. Also compare rendered row/composer/sidebar dimensions with the recorded baseline, verify their growth is approximately 30%, verify the scaled root and composer bottom stay within `data-glasswing-synara-host`, open and close the model picker, switch between two existing threads, and inspect console errors plus a final screenshot.

- [ ] **Step 8: Finalize the Chrome tab only after all browser checks**

Keep the verified live Glasswing tab as `deliverable`. This must be the last Chrome action.
