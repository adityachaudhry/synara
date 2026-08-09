# Synara React Embed: Trial Log and Learnings

## Goal

Expose Synara's existing React application as a packageable entrypoint, keep that entrypoint as the
standalone v3 web application, and render the exact same route/component graph inside Glasswing's
Next.js company shell. The adapter may configure history and transports; it must not fork Synara's
conversation, orchestration, provider, authentication, or persistence primitives.

## Stable seams

- `SynaraApp` owns the full TanStack route tree. Standalone `main.tsx` and Glasswing both mount it.
- A supplied memory history keeps embedded Synara navigation inside the Glasswing surface.
- `httpBaseUrl` sends Synara HTTP traffic through a same-origin Glasswing proxy.
- `resolveWebSocketUrl()` is called for every connection generation, so reconnects receive fresh
  one-use Synara WebSocket tickets.
- Glasswing's SuperTokens session remains authoritative. Its server exchanges that identity for
  Synara's existing `bearer-session-token`; no new credential or user store was added.
- Synara SQLite, Gitea-backed project discovery, provider sessions, and event projections remain the
  only runtime/storage primitives.

## Trial 1: Vite copied every public icon into the package

The first successful library build produced roughly 4,500 files because Vite library mode copied
both complete Central icon sets. That made the vendored package needlessly large and would have
made updates noisy.

**Why it failed:** the normal standalone build pruned only the reversed set, while the new library
config initially omitted the pruning plugin entirely.

**Correction:** the shared build plugin now scans source literals once and prunes both `reversed`
and `fill` sets. The package retains the same root-relative asset contract while including only
referenced icon names. The standalone build uses the same improved pruning path.

## Trial 2: Vite worker URLs failed inside Next/Turbopack

The first Glasswing production build failed on Vite-emitted URLs such as
`/assets/composerImagePreparation.worker-*.js`. Turbopack attempted to resolve the Vite package's
worker asset expression as an application module and reported that server-relative imports were
not implemented.

**Why it failed:** an application build can assume ownership of `/assets`; a portable library
cannot assume the consuming host's asset root or bundler semantics.

**Correction:** Synara's image-preparation worker and Pierre diff worker are now emitted inline.
Their call sites and behavior are unchanged, they remain lazy with the features that need them, and
the package no longer carries a host-specific worker URL. The existing image-preparation tests and
the subsequent Next/Turbopack production build passed.

## Trial 3: Authentication must remain server mediated

Returning a reusable Synara bearer to package JavaScript would have duplicated auth concerns and
expanded the impact of any browser-side injection.

**Correction:** Glasswing stores the Synara bearer only in an HTTP-only cookie scoped to
`/api/synara`. The browser receives only a one-use WebSocket URL. HTTP routes stream through the
same-origin proxy, which refreshes the bearer once after a 401 by re-verifying the current
SuperTokens request session.

## Trial 4: Package asset sync must not own host branding

The first Glasswing sync mirrored the package's complete `brand` directory into the host public
directory. Because the sync deliberately replaces generated directories, that deleted Glasswing's
existing black and white logo variants and rewrote the shared red marks.

**Why it failed:** the sync treated every root-relative package asset as package-owned, even though
`/brand/*` is an intentional host-owned contract in Glasswing mode.

**Correction:** only the two already-pruned Central icon directories are generated into
Glasswing's public tree. The package may reference the stable `/brand/glasswing-*.svg` paths, but
Glasswing supplies those files. A checksum-before/after sync check confirmed that refreshing the
package leaves all six existing host brand assets byte-for-byte unchanged.

## Trial 5: Parsed trusted origins did not reach the runtime service

The first live cross-origin negotiation probe still returned `403` for the configured Glasswing
origin even though Railway showed the expected `SYNARA_TRUSTED_APP_ORIGINS` value.

**Why it failed:** the environment parser correctly built the trusted-origin set, but the parsed
value was not copied into the final `ServerConfig` object. The optional property allowed that
omission to compile.

**Correction:** copy the set into the runtime configuration and make `trustedAppOrigins` required,
so every future `ServerConfig` constructor must make an explicit choice (normally an empty set).
The acceptance check now probes both the allowed Glasswing origin and an unrelated rejected origin.

The first direct Railway redeploy attempt also failed while `bun install` was applying the Effect
language-service patch (`UnableToFindPositionToPatchError`). Re-running the repository's pinned,
exact-commit GitHub deployment workflow succeeded on the same source. This reinforced using the
checked-in deployment path and live behavior probes instead of treating a successful variable write
as proof that the running process consumed it.

## Trial 6: A successful Next build did not prove browser-safe module evaluation

The first authenticated Edge load reached the native company route, displayed the lazy loading
state, and then fell into the route error boundary with `dynamic usage of require is not supported`.
Next/Turbopack had compiled successfully, but a CommonJS `use-sync-external-store` compatibility
module inside the Vite library still attempted to load peer React through Rolldown's runtime
`require` shim in the browser.

**Correction:** the embed-only Vite configuration aliases the CommonJS selector shim to a small ESM
adapter built directly on React's `useSyncExternalStore`. React remains a peer dependency, so the
host still owns the single React instance. The package writer now rejects any generated chunk that
combines the Rolldown runtime with a dynamic call for peer React, turning this browser-only failure
into a deterministic build failure.

## Trial 7: Durable setup telemetry was intentionally invisible at the wrong time

The first-message path could spend seconds preparing a Railway sandbox after the user had already
submitted a message, while the transcript did not become active until the provider emitted a formal
turn start. The runtime was healthy and already streaming `runtime.stage` events, but the React
work-log projection intentionally excluded them after an earlier version had polluted empty draft
threads with infrastructure rows.

**Why it failed:** filtering durable setup telemetry from conversation history was correct, but the
working indicator used only `hasLiveTurn`. That coupled perceived activity to provider turn start
and created a silent interval during real pre-turn work.

**Correction:** keep `runtime.stage` out of the durable transcript, derive the latest unresolved
stage as transient presentation state only after a user message exists, and update the existing
stable working row in place. Glasswing mode shows provider-neutral phase copy and falls back to
`Working…`; standalone Synara retains its existing behavior. Completed turns ignore any stale
unresolved telemetry, and prewarming an untouched draft stays invisible.

## Trial 8: Project scoping belongs at the host/state boundary, not in CSS

The first design temptation was to hide the general Synara rail and composer controls with selectors
on the Glasswing host wrapper. That would have been visually fast but semantically incomplete:
keyboard shortcuts could still open hidden surfaces, `New thread` could still target the latest
unrelated project, and the sidebar would continue computing and exposing cross-project rows.

**Correction:** Glasswing now passes an explicit `hostProject` context through the React package.
The host owns cross-company URL navigation, while Synara's existing Glasswing-mode projection
matches that company to one project and renders only its threads. The more opinionated control
removals require both Glasswing mode and this host-project context, so standalone GlasswingOS keeps
its existing general-purpose tools and upstream Synara is unchanged.

The first rendered regression-test attempt also failed before reaching an assertion because an
empty server snapshot did not create a client draft automatically. The corrected fixture registers
the local draft in `useComposerDraftStore`, then mounts the real chat route. That produced the
intended RED (the Environment button was still present) and the subsequent semantic-gating change
turned the same real-browser case GREEN.

The first package write then exposed a second adapter-boundary failure: the Vite runtime build
accepted `hostProject`, but the package writer generated declarations from a manual string that did
not include it. The writer now emits the host-project types and its deterministic package test
asserts that the public declaration contains the new contract, preventing runtime/type drift.

The first deployed Chrome pass found one more state-boundary bug: switching the host route from Nth
to Cue Cloud correctly changed the project picker and thread rail, but the existing empty draft
still rendered Nth in the underlined prompt. Host navigation alone does not change Synara's active
draft store. The picker now activates or restores the target project's native Synara draft first,
then asks Glasswing to change its company URL. A focused ordering test locks that handoff down.

The final local recheck also could not use the assumed toolchain: `bun` was absent from `PATH`, the
machine's Node 18 lacked `node:util.styleText`, and ChatGPT's signed Node 24 could not load the
unsigned Rolldown native binding because their Team IDs differ. Running the same repository-local
Vitest and Vite entrypoints with an unsigned Node 24 package was the non-destructive correction;
the focused tests and production build then passed without reinstalling or rewriting dependencies.

## Trial 9: Shipping the same component did not mean activating the same shell

The standalone v3 deployment contained the project-picker code but still showed Search, Activity,
Automations, cross-project threads, and the full composer chrome. The deployment was current and
served with `no-cache`; this was configuration divergence, not stale assets. Standalone `main.tsx`
mounted `<SynaraApp />`, while the Glasswing adapter supplied `hostProject`, and the first design
used that optional host value as the feature gate.

**Why it failed:** `hostProject` answered who owns selection and outer navigation, but it was also
made to answer whether the project-scoped Glasswing presentation should exist. Those are separate
decisions. Two mounts of the same React component therefore activated different feature subsets.

**Correction:** Glasswing mode now enables the project-scoped shell on both mounts. Embedded
Glasswing resolves selection from host company identity and keeps its outer route callback;
standalone v3 resolves selection from Synara's already-reactive focused project ID and performs only
native draft navigation. No parallel selected-project store was added. Host identity still takes
precedence when present, and a missing standalone focus exposes no unrelated project.

The first focused browser command was launched from the monorepo root even though the browser
Vitest config resolves `src/routes` relative to `apps/web`; it failed during configuration before
collecting the test. Re-running the identical case from `apps/web` produced the intended RED
(Environment was rendered) and then GREEN after the shared Glasswing-mode gate was applied.

The first live standalone acceptance pass exposed a separate adapter-ownership mistake. The picker
opened and marked Nth as active, but clicking it left Cue Cloud selected. The standalone runtime has
no host project object, while the click handler evaluated `hostProject.onSelectProject` before the
shared activation helper could run. Embedded Glasswing hid the bug because its host object exists.
Passing the nullable host object across the helper boundary, then optional-chaining its callback
inside the helper, keeps native draft activation mandatory and outer host navigation optional. The
regression test covers both the null-host standalone path and the embedded activation-before-host
ordering.

## Trial 10: Product identity and runtime identity should not be conflated

Glasswing uses Pi as its provider harness, but presenting the Pi glyph and Pi's complete discovered
catalog exposed an implementation detail and made the product surface inconsistent with the
Claude-native experience users expect. Renaming the provider itself would have been the wrong seam:
persisted selections, WebSocket contracts, session routing, and the distributed worker all rely on
`pi` as the real provider identity.

**Correction:** keep `pi` unchanged through selection, persistence, orchestration, and execution.
In Glasswing mode only, the shared icon renderer maps Pi to the Claude glyph, and the catalog
projection orders and filters Pi's discovered models to Sonnet 5, Opus 4.8, Opus 5, and Fable 5.
Native Synara mode still renders Pi and its full catalog.

The installed Pi model bundle already contained Sonnet 5, Opus 4.8, and Fable 5 but predated Opus
5. Simply filtering the client catalog would therefore have hidden Opus 5 permanently. The existing
authenticated-Anthropic catalog repair seam was extended with Anthropic's published `claude-opus-5`
metadata. It only synthesizes the entry after Anthropic authentication is present; it does not
invent an unavailable provider or create a parallel execution primitive.

The first host-package refresh was run from the Glasswing repository root and failed with
`Cannot find module .../scripts/sync-synara-package.mjs`; the script belongs to the Next app at
`web/scripts`. Re-running from `web` succeeded without cleanup because the failed command had not
changed any files. Keep the host working directory explicit in future refresh automation.

## Current tradeoffs to measure

- The package intentionally contains the complete feature graph. Heavy editor grammars, terminals,
  PDF rendering, and diffs remain route/feature chunks rather than being removed for the embed.
- The compiled stylesheet is large because the existing Synara font and Tailwind output is kept for
  pixel/feature parity. It is loaded only with the lazy GlasswingOS client surface, but CSS ordering
  and host collisions must be checked in the rendered Glasswing app after every package refresh.
- The vendored artifact is a deterministic initial distribution mechanism. Moving it to a registry
  later changes only the dependency locator, not the React or transport contract.

## Refresh workflow

1. Merge or semantically reconcile the latest Synara upstream into the Synara integration branch.
2. Run Synara's focused tests and both standalone/embed production builds.
3. Build with explicit `SYNARA_COMMIT` and `SYNARA_UPSTREAM_COMMIT` values.
4. Run Glasswing's `scripts/sync-synara-package.mjs` against `apps/web/dist-embed/package`.
5. Inspect `synara-provenance.json`, run a Glasswing production build, and verify both the existing
   diligence views and the GlasswingOS view in Edge.
