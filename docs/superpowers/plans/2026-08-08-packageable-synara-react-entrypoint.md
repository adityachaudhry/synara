# Packageable Synara React Entrypoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one packageable Synara React application root that powers the existing v3 Synara web deployment and renders natively inside the Glasswing Next.js company shell with shared SuperTokens authentication and complete feature parity.

**Architecture:** Extract React root ownership from `main.tsx` into `SynaraApp`, inject memory or browser history through a compatibility provider, and make transport endpoints host-configurable while keeping all current standalone defaults. Build the same source as a Vite library, vendor the exact artifact into Glasswing, and use a Next server bridge to exchange the existing SuperTokens identity for Synara's existing bearer session and one-use WebSocket ticket.

**Tech Stack:** React 19, TanStack Router and Query, Zustand, Vite 8 library mode, Effect WebSocket RPC, Next.js 16 App Router, SuperTokens, Vitest, Playwright, Railway v3.

## Global Constraints

- Preserve every existing standalone Synara web capability and current persistent storage format.
- Do not create a second transcript, composer, orchestration model, auth system, or repository binding primitive.
- Keep React and React DOM as package peer dependencies and lazy-load the package in Glasswing.
- Keep Glasswing login authoritative through its existing SuperTokens configuration.
- Write each behavioral test first, run it to observe the expected failure, then implement only enough to pass.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` without explicit user authorization; never run `bun test`.
- Do not modify or delete user-owned files in either primary checkout.

---

### Task 1: Injectable application history and reusable React root

**Files:**
- Create: `apps/web/src/appHistoryContext.tsx`
- Create: `apps/web/src/appHistoryContext.browser.tsx`
- Create: `apps/web/src/SynaraApp.tsx`
- Create: `apps/web/src/SynaraApp.browser.tsx`
- Modify: `apps/web/src/appNavigation.ts`
- Modify: `apps/web/src/components/AppNavigationButtons.tsx`
- Modify: `apps/web/src/routes/_chat.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/router.ts`

**Interfaces:**
- Produces: `AppHistoryProvider`, `useAppHistory()`, `createEmbeddedAppHistory(initialPath?: string)`, `SynaraApp`, and `SynaraAppProps`.
- Preserves: `appHistory`, `getRouter(history)`, and all current standalone route behavior.

- [ ] **Step 1: Write the failing browser tests**

Test that `useAppHistory()` returns the supplied memory history, that back/forward buttons operate on that history rather than `window.history`, and that `<SynaraApp history={memoryHistory} />` renders through the existing route tree without calling `ReactDOM.createRoot`.

- [ ] **Step 2: Run the focused browser tests and verify they fail because the provider and component do not exist**

Run with the bundled Node runtime and `vitest.browser.config.ts` against the two new browser files.

- [ ] **Step 3: Add the provider and component while retaining standalone defaults**

`SynaraApp` memoizes one router per supplied history and renders `AppHistoryProvider` around `RouterProvider`. `main.tsx` becomes only the standalone `createRoot` call and mounts `<SynaraApp history={appHistory} />`.

- [ ] **Step 4: Replace direct default-history calls in `AppNavigationButtons` and `_chat` with `useAppHistory()` and explicit helper arguments**

- [ ] **Step 5: Run the focused tests and the existing app-navigation/unit route tests**

Expected: all focused and existing navigation tests pass.

### Task 2: Host-configurable HTTP and reconnect-safe WebSocket transport

**Files:**
- Create: `apps/web/src/webRuntimeConfig.ts`
- Create: `apps/web/src/webRuntimeConfig.test.ts`
- Modify: `apps/web/src/wsTransport.ts`
- Modify: `apps/web/src/wsTransport.test.ts`
- Modify: `apps/web/src/wsNativeApi.ts`
- Modify: `apps/web/src/wsNativeApi.test.ts`
- Modify: `apps/web/src/lib/wsHttpUrl.ts`
- Modify: `apps/web/src/lib/wsHttpUrl.test.ts`
- Modify: `apps/web/src/SynaraApp.tsx`

**Interfaces:**
- Produces: `SynaraConnectionOptions`, `configureWebRuntime(options)`, `readWebRuntimeConfig()`, and `WsUrlResolver = () => Promise<string>`.
- `WsTransport` accepts `string | WsUrlResolver`; it calls the resolver once per connection generation and reuses the resolved URL for negotiate plus feature connection.
- `resolveWsHttpUrl(path)` prefixes `httpBaseUrl` while preserving standalone `VITE_WS_URL` behavior when no host configuration is present.

- [ ] **Step 1: Add failing unit tests for endpoint normalization and immutable equivalent configuration**

Cover empty/relative base rejection, trailing-slash normalization, same-config idempotence, and rejecting a conflicting reconfiguration after the Native API has started.

- [ ] **Step 2: Add a failing transport test proving reconnect requests a fresh one-use URL**

Use two literal resolver results and force a reconnect; assert the second feature connection uses the second ticket and that negotiate and feature paths for one generation share the same ticket.

- [ ] **Step 3: Run the tests and verify the expected missing-interface failures**

- [ ] **Step 4: Implement runtime configuration and the per-generation resolver**

Keep the existing string constructor path and default URL behavior unchanged. `createWsNativeApi` reads the configured resolver only when creating the singleton.

- [ ] **Step 5: Route every browser HTTP helper through the configured HTTP base**

This includes auth JSON, attachment upload/cancel/preview, local images, voice transcription, project/site/editor favicons, and thread export.

- [ ] **Step 6: Run all focused transport, Native API, and HTTP URL tests**

Expected: all pass with no new warnings.

### Task 3: SuperTokens bearer adapter and trusted Glasswing origin

**Files:**
- Modify: `apps/server/src/auth/superTokensEffectRoute.test.ts`
- Modify: `apps/server/src/auth/superTokensEffectRoute.ts`
- Modify: `apps/server/src/trustedOrigins.test.ts`
- Modify: `apps/server/src/trustedOrigins.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.test.ts`
- Modify: `turbo.json`

**Interfaces:**
- Produces: `POST /api/supertokens/exchange/bearer`, returning `{ authenticated: true, role: "owner", subject, expiresAt, sessionToken }` after verifying the existing SuperTokens request session.
- Produces: `ServerConfigShape.trustedAppOrigins: ReadonlySet<string>` parsed from comma-separated `SYNARA_TRUSTED_APP_ORIGINS` HTTPS origins.
- `isTrustedAppOrigin` accepts exact normalized configured origins in addition to current public/dev/desktop origins.

- [ ] **Step 1: Write failing route tests**

Prove a valid SuperTokens identity gets a bearer session, an invalid identity gets 401/403, and the bearer subject is the verified Glasswing email.

- [ ] **Step 2: Write failing trusted-origin and config tests**

Prove exact configured origins are accepted, sibling/unrelated origins are rejected, credentials/path/query origins are rejected, and empty configuration preserves current behavior.

- [ ] **Step 3: Run the focused server tests and verify the new cases fail**

- [ ] **Step 4: Implement the bearer exchange by issuing the existing `bearer-session-token` method**

Do not add another credential store or signing mechanism.

- [ ] **Step 5: Implement and wire normalized trusted origins**

Include `SYNARA_TRUSTED_APP_ORIGINS` in Turbo's declared global environment list.

- [ ] **Step 6: Run the focused auth, origin, config, and WebSocket-auth tests**

Expected: all pass.

### Task 4: Build a package artifact from the existing web source

**Files:**
- Create: `apps/web/src/embedded.ts`
- Create: `apps/web/vite.embed.config.ts`
- Create: `apps/web/scripts/write-embed-package.mjs`
- Create: `apps/web/scripts/write-embed-package.test.ts`
- Create: `apps/web/README.embed.md`
- Modify: `apps/web/package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `apps/web/dist-embed/package` containing `package.json`, ESM entry/chunks, `style.css`, declarations, README, and `synara-provenance.json`.
- Package name: `@glasswing/synara-react`.
- Exports: `.`, `./style.css`, and `./provenance`.
- Peer dependencies: `react >=19 <20` and `react-dom >=19 <20`.

- [ ] **Step 1: Write a failing artifact test**

Run the package writer against a temporary built fixture and assert exact metadata, peer dependencies, required exports, missing-secret behavior, and provenance fields.

- [ ] **Step 2: Run the test and verify failure because the package writer is absent**

- [ ] **Step 3: Add the embedded export and Vite library configuration**

Use Vite `build.lib`, externalize React/React DOM, retain route code splitting, and emit one explicit CSS artifact.

- [ ] **Step 4: Implement deterministic package metadata/provenance generation**

The writer receives explicit `SYNARA_COMMIT` and `SYNARA_UPSTREAM_COMMIT` values; it never shells out or reads secrets.

- [ ] **Step 5: Run the artifact test, build the package, and inspect `npm pack --dry-run`**

Expected: only intended package files appear and the package can be imported with React resolved from the consumer.

- [ ] **Step 6: Build the normal standalone web app and run the full web unit suite**

Expected: standalone build succeeds and the 3,539-test baseline has no regressions except intentional new passing tests.

### Task 5: Vendor the package and add the Glasswing server transport bridge

**Files in `glasswing-ai-2`:**
- Create: `web/scripts/sync-synara-package.mjs`
- Create: `web/scripts/sync-synara-package.test.mjs`
- Create: `web/vendor/synara-react/**` (generated exact package artifact)
- Create: `web/src/lib/synara/server-bridge.ts`
- Create: `web/src/lib/synara/server-bridge.test.ts`
- Create: `web/src/app/api/synara/session/route.ts`
- Create: `web/src/app/api/synara/proxy/[...path]/route.ts`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`

**Interfaces:**
- `POST /api/synara/session` returns `{ webSocketUrl, expiresAt }` and sets HTTP-only `gw_synara_session` scoped to `/api/synara`.
- `/api/synara/proxy/*` forwards method, query, body, content type, range, and conditional headers using `Authorization: Bearer <gw_synara_session>`; it streams status, safe response headers, and body back.
- Required server environment: `SYNARA_SERVICE_ORIGIN` with an HTTPS root origin.

- [ ] **Step 1: Write a failing sync-script test**

Prove the script replaces a stale vendor fixture, preserves only declared package files, and writes the exact provenance SHA.

- [ ] **Step 2: Write failing bridge tests**

Cover missing Glasswing session, successful SuperTokens-to-bearer exchange, reuse of a valid bearer, 401 refresh/retry, fresh WebSocket ticket issuance, query preservation, binary streaming, range headers, and rejection of an invalid configured Synara origin.

- [ ] **Step 3: Run tests and verify they fail for missing code**

- [ ] **Step 4: Implement the bridge and thin App Router handlers**

Use `hasValidSession()` before issuing or refreshing a Synara bearer. Never return the bearer to client JavaScript or logs.

- [ ] **Step 5: Build and sync the exact Synara package into the Glasswing vendor directory**

- [ ] **Step 6: Install the `file:vendor/synara-react` dependency and run bridge/sync tests**

Expected: tests pass and the lockfile resolves one React instance through peer dependencies.

### Task 6: Render Synara natively inside the Glasswing company shell

**Files in `glasswing-ai-2`:**
- Create: `web/src/components/synara/synara-workspace.tsx`
- Create: `web/src/components/synara/synara-workspace-loading.tsx`
- Modify: `web/src/app/layout.tsx`
- Modify: `web/src/components/app-shell.tsx`
- Modify: `web/src/app/app/[company]/page.tsx`
- Modify: `web/next.config.ts`

**Interfaces:**
- `SynaraWorkspace` is a client-only lazy component that supplies memory history, `resolveWebSocketUrl: () => fetch('/api/synara/session')`, and `httpBaseUrl: '/api/synara/proxy'` to package `SynaraApp`.
- Glasswing `View` gains `agent`; the company rail entry is labeled `GlasswingOS` and the content inset renders `<SynaraWorkspace companyId companySlug />`.

- [ ] **Step 1: Write the failing view-selection test**

Prove the literal `agent` view renders the agent surface, marks the GlasswingOS rail entry active, suppresses the right Ask panel, and leaves research/memo/workspace selections unchanged.

- [ ] **Step 2: Run the test and verify failure because the view is unsupported**

- [ ] **Step 3: Implement the lazy client boundary and loading state**

Use `next/dynamic` with `ssr: false`; do not import the package into server components. Import the external package stylesheet once from the root app layout after Glasswing globals.

- [ ] **Step 4: Add the agent view to the existing shell and company page**

Do not create a second Next application layout, iframe, or full-page redirect.

- [ ] **Step 5: Run focused tests and the production Next build**

Expected: build succeeds, the package is isolated to the lazy agent chunk, and existing routes remain present.

### Task 7: Integrated local browser verification and defect correction

**Files:**
- Modify only files implicated by failing browser behavior, always with a failing regression test first.

- [ ] **Step 1: Start an isolated Synara server using non-default ports and home directory**

Follow repository isolation instructions and confirm both server and web ports are free before launch.

- [ ] **Step 2: Start Glasswing Next with a controlled dev configuration pointing to the isolated Synara origin**

- [ ] **Step 3: Exercise the standalone Synara parity matrix**

Verify project/thread hydration, first send, follow-up, concurrent thread switching, stream completion, attachments, approval/input surfaces, settings, files, diff/terminal availability, reload persistence, and reconnect.

- [ ] **Step 4: Exercise the Glasswing embedded matrix**

Verify company-to-agent navigation stays inside `AppShell`, no second login appears, thread/project state matches standalone, first send/follow-up/reload/reconnect work, dialogs and menus render correctly, and normal Glasswing views remain usable.

- [ ] **Step 5: For each discovered defect, add a failing regression test before correcting it**

- [ ] **Step 6: Re-run both matrices after corrections**

### Task 8: Commit, deploy v3 dev, and verify exact live revisions

**Files:**
- Modify: `docs/distributed-runtime/railway-v3-gitea-company-projects-trial-log.md`
- Modify deployment environment only within Railway project v3, environment dev, services `synara-gitea-dev` and `glasswing-web`.

- [ ] **Step 1: Review both diffs and run the allowed final verification set**

Run focused/full tests, standalone/package/Next builds, `git diff --check`, package provenance validation, and deployment workflow tests. Do not run the forbidden heavyweight commands without explicit authorization.

- [ ] **Step 2: Commit Synara with the design, plan, implementation, tests, package builder, and trial-log evidence**

- [ ] **Step 3: Push `codex/v3-gitea-projects` and wait for the exact GitHub Actions/Railway deployment**

- [ ] **Step 4: Configure only the v3 dev Synara trusted Glasswing origin and Glasswing Synara service origin variables**

Install values without printing secrets. Redeploy exact images when variable snapshots require it.

- [ ] **Step 5: Commit and push the Glasswing feature branch, then promote the verified change to `dev` for its existing path-filtered `glasswing-web` deployment**

- [ ] **Step 6: Verify health, deployment SHAs, and browser acceptance on both live v3 dev URLs**

- [ ] **Step 7: Append attempts, failures, corrections, exact deployments, and remaining operational caveats to the v3 trial log**

- [ ] **Step 8: Audit every design requirement against current files, tests, package artifact, deployed revisions, and browser evidence before marking the goal complete**
