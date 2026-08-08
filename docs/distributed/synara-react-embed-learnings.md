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
