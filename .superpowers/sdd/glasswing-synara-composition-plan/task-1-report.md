# Task 1 report — generic `@synara/react` embed package

## Status

Completed on branch `codex/glasswing-package-boundary`.

Initial implementation commit: `9b4a26e6f433c35c08893962ee13b3c55c715cf0`

Review-correction implementation commit: `ceed395affc2760c8a83e0467b31a8634126e411`

Second review-correction implementation commit: `94249923ed7f9f3da420b8cc07eb255383c970c6`

## Delivered

- Added the reusable `SynaraApp` React entrypoint and preserved standalone startup by mounting it from `main.tsx`.
- Added the generic runtime contract with only `httpBaseUrl`, fresh `resolveWebSocketUrl`, and `project: { projectId, name }`.
- Added host composition types for history, sidebar width/slots, semantic theme tokens, and embedded base typography.
- Added memory-history containment and context-backed app navigation.
- Routed HTTP/auth requests through the configured host base and resolved every WebSocket session URL afresh; legacy bootstrap sockets consume a separate fresh URL.
- Contained embedded theme projection and generated CSS below `[data-synara-app-root]`.
- Added a browser-safe ESM `useSyncExternalStoreWithSelector` adapter so React and React DOM remain peers.
- Added a deterministic `@synara/react` package directory with generated TypeScript declarations, provenance, package exports for `.`, `./style.css`, and `./provenance`, plus an npm tarball.

## TDD evidence

All commands used Node `v24.16.0` in `PATH` and Bun `1.3.12` via `npx --yes bun@1.3.12`.

### RED

```sh
npx --yes bun@1.3.12 run test \
  src/synaraRuntimeConfig.test.ts \
  src/appNavigation.test.ts \
  src/wsTransport.test.ts \
  scripts/scope-embed-css.test.ts \
  scripts/write-embed-package.test.ts
```

Expected result: exit 1. Three suites could not resolve absent modules, `createEmbeddedAppHistory` was absent, and the resolver-backed transport opened no socket. Summary: 5 failed files; 2 failed and 62 passed tests.

```sh
npx --yes bun@1.3.12 run test src/theme/themeDomTarget.test.ts
```

Expected result: exit 1 because the embedded theme target module was absent.

```sh
npx --yes bun@1.3.12 run test scripts/write-embed-package.test.ts
```

Expected result after adding a private declaration fixture: exit 1 because `internal.d.ts` leaked into the package.

```sh
npx --yes bun@1.3.12 run test src/lib/hostThemeStyle.test.ts
```

Expected result: exit 1 because the semantic host-theme adapter was absent.

The first complete web run also exposed a real compatibility failure in partial DOM stubs: 35 `MessagesTimeline` tests failed at `embeddedRoot.hasAttribute`. The guard was fixed at the shared theme boundary, and the focused 55-test file passed before rerunning the full suite.

### GREEN

```sh
npx --yes bun@1.3.12 run test \
  src/synaraRuntimeConfig.test.ts \
  src/appNavigation.test.ts \
  src/wsTransport.test.ts \
  src/theme/themeDomTarget.test.ts \
  src/lib/hostThemeStyle.test.ts \
  scripts/scope-embed-css.test.ts \
  scripts/write-embed-package.test.ts
```

Result: 7 files passed; 75 tests passed.

```sh
npx --yes bun@1.3.12 x vitest run \
  --config vitest.browser.stable.config.ts \
  src/components/AppHistoryProvider.browser.tsx
```

Result: 1 browser file passed; 1 test passed.

```sh
npx --yes bun@1.3.12 run test
```

Result: 329 files passed; 4,104 tests passed.

Per task instruction, `bun fmt`, `bun lint`, and `bun typecheck` were not run.

## Package build and determinism

```sh
SYNARA_COMMIT=9b4a26e6f433c35c08893962ee13b3c55c715cf0 \
  npx --yes bun@1.3.12 run build:embed
```

Two consecutive builds stamped with the same commit produced byte-identical required artifacts:

| Artifact | SHA-256 |
| --- | --- |
| `package.json` | `918b06b78c90ea18c65ca95298844bd48dd754de382634d2bdcaa9838f2f2660` |
| `index.d.ts` | `9437947a8f974b80599b95db92da8221395d62335bbab7cc42138861f5c02468` |
| `style.css` | `f67a9eabfc2d9b0225adb12a56ec5e2250d64fc78071a751a719945b1c9e2569` |
| `synara-provenance.json` | `2d10971f70609f452260c93f33d4b3096cfbe9292927842207fa712c3a27b70d` |

`npm pack` produced `dist-embed/synara-react-0.7.3.tgz` (7.5 MiB), SHA-256 `9f0555a8552247d15e1cd758e93a7d12a5919711446cf39c36a07f919488e714`.

## Files changed

- Package/build: `.gitignore`, `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/vite.embed.config.ts`, `apps/web/tsconfig.embed.json`, `apps/web/README.embed.md`, package/CSS scripts and their tests.
- Public entry/runtime: `SynaraApp.tsx`, `embedded.ts`, `embeddedBundle.ts`, `embeddedHistory.ts`, `synaraRuntimeConfig.ts`, `main.tsx`.
- Routing/transport: `appNavigation.ts`, `wsTransport.ts`, `wsNativeApi.ts`, `lib/wsHttpUrl.ts`, and focused tests.
- Containment/adapters: `themeDomTarget.ts`, `hostThemeStyle.ts`, `useTheme.ts`, `useSyncExternalStoreWithSelectorAdapter.ts`, and focused/browser tests.

## Self-review

- Confirmed the public runtime config has no product-specific fields or identity/auth concepts.
- Confirmed React/React DOM are peers and no emitted chunk dynamically requires peer React.
- Confirmed declarations are emitted from TypeScript source, not maintained as a declaration string; private declarations are pruned from the package.
- Confirmed standalone behavior retains browser/hash history and default server URL discovery.
- Confirmed actual embedded CSS and theme mutations target the Synara root.
- `git diff --check` passed before the implementation commit.

## Concerns

- The tarball contains the full Synara app and its lazy runtime assets, so it remains sizeable at 6,099,052 bytes packed. Further pruning should be driven by measured host load behavior.
- No blocking concerns remain from the Task 1 review.

## Review corrections

The blocking review findings were corrected generically without adding host-product behavior.

### Correction RED

```sh
npx --yes bun@1.3.12 run test \
  src/hostSidebar.test.tsx \
  src/hostPortalCoverage.test.ts \
  src/lib/central-icons.test.ts \
  src/embeddedHistory.contract.test.ts \
  scripts/write-embed-package.test.ts
```

Expected result: exit 1. `hostSidebar` was absent; all 12 shared Base UI portal files lacked a Synara portal container; icon URLs were root-absolute; the public history was narrowed and cast; and standalone favicon/app assets leaked through the package writer. Summary: 5 failed files; 4 failed and 2 passed tests.

```sh
npx --yes bun@1.3.12 run test src/lib/centralIconAssets.test.ts
```

Expected result: exit 1 because the package had no collector capable of pruning both central-icon variants to referenced names.

The first complete correction run then exposed five stale filename assertions after icons became self-contained data URLs: 2 files failed, 332 passed; 5 tests failed, 4,105 passed. Adding a stable `data-central-icon` marker preserved precise glyph assertions without restoring the asset-server seam.

### Correction GREEN

```sh
npx --yes bun@1.3.12 run test \
  src/synaraRuntimeConfig.test.ts \
  src/appNavigation.test.ts \
  src/wsTransport.test.ts \
  src/theme/themeDomTarget.test.ts \
  src/lib/hostThemeStyle.test.ts \
  scripts/scope-embed-css.test.ts \
  scripts/write-embed-package.test.ts \
  src/hostSidebar.test.tsx \
  src/hostPortalCoverage.test.ts \
  src/lib/central-icons.test.ts \
  src/lib/centralIconAssets.test.ts \
  src/embeddedHistory.contract.test.ts
```

Result: 12 files passed; 81 tests passed.

```sh
npx --yes bun@1.3.12 x vitest run \
  --config vitest.browser.stable.config.ts \
  src/components/hostPortal.browser.tsx \
  src/components/AppHistoryProvider.browser.tsx
```

Result: 2 browser files passed; 2 tests passed. The dialog portal mounted below `[data-synara-portal-container]` and `[data-synara-app-root]`; host memory history remained browser-contained.

```sh
npx --yes bun@1.3.12 run test
```

Result: 334 files passed; 4,110 tests passed.

Per instruction, `bun fmt`, `bun lint`, and `bun typecheck` were not run.

### Correction package evidence

```sh
SYNARA_COMMIT=ceed395affc2760c8a83e0467b31a8634126e411 \
  npx --yes bun@1.3.12 run build:embed
```

Two consecutive builds stamped with the correction commit passed. `cmp` confirmed byte-identical manifest, generated declarations, scoped stylesheet, and provenance.

| Artifact | SHA-256 |
| --- | --- |
| `package.json` | `918b06b78c90ea18c65ca95298844bd48dd754de382634d2bdcaa9838f2f2660` |
| `index.d.ts` | `7b4bae732494cfce0a10a8c4a6e12aa4464471484bda9889ff96f1325d3b4a6b` |
| `style.css` | `f67a9eabfc2d9b0225adb12a56ec5e2250d64fc78071a751a719945b1c9e2569` |
| `synara-provenance.json` | `c85fee0c6668ce23d764d518919b5b53ad0272f3133f79f7578c44112941db32` |

`npm pack` produced `synara-react-0.7.3.tgz`, 6,245,585 bytes, SHA-256 `cbf994eb1df3705dd4a4ff1dcda83214811740d9a0540a4a44db6f0a23412803`.

- The generated public history declaration is `SynaraHistory = RouterHistory`; `SynaraApp` no longer casts it.
- The package contains no `central-icons-reversed`, `central-icons-fill`, favicon, app-icon, Apple-touch-icon, or standalone `synara.png` paths.
- The build embeds 254 referenced reversed icons and 256 referenced fill icons as data URLs, so installed hosts need no public asset server seam.
- The shared portal coverage test enumerates all 12 current Base UI portal primitive files; each resolves the root-owned container and falls back to Base UI's standalone body behavior when no provider exists.
- The existing chat sidebar consumes host width/lock presentation and renders the host header, optional project title, and footer slots around the thread content.

## Second review corrections

The scoped re-review found that icon pruning still shared one filename-literal set across both variants and that the public `RouterHistory` declaration referenced an undeclared package. Both were corrected without changing the public history shape or adding a host asset-serving seam.

### Second correction RED

```sh
npx --yes bun@1.3.12 run --cwd apps/web test -- \
  src/lib/centralIconAssets.test.ts \
  scripts/write-embed-package.test.ts
```

Expected result: exit 1. The fill-only fixture leaked into the reversed map, and the generated manifest omitted `@tanstack/react-router`. Summary: 2 failed files; 2 failed and 2 passed tests.

### Second correction GREEN

```sh
npx --yes bun@1.3.12 run --cwd apps/web test -- \
  src/lib/centralIconAssets.test.ts \
  src/lib/central-icons.test.ts \
  scripts/write-embed-package.test.ts \
  src/embeddedHistory.contract.test.ts
```

Result: 4 files passed; 7 tests passed. The icon fixture proves a reversed-only asset is absent from fill, a fill-only asset is absent from reversed, a shared asset is retained in both, and an unrelated filename literal is excluded.

```sh
npx --yes bun@1.3.12 run --cwd apps/web test
```

Result: 334 files passed; 4,111 tests passed.

```sh
npx --yes bun@1.3.12 run --cwd apps/web test:browser:stable -- \
  src/components/hostPortal.browser.tsx \
  src/components/AppHistoryProvider.browser.tsx
```

Result: 2 browser files passed; 2 tests passed.

Per instruction, `bun fmt`, `bun lint`, and `bun typecheck` were not run. The embed package build's declaration-only `tsc -p tsconfig.embed.json` step was run as required for package/declaration verification.

### Second correction implementation

- `apps/web/vite.config.ts` now reads actual `CentralIcon` JSX and `centralIconWrapper`, `createCentralIconComponent`, `createCentralIconElement`, and `getCentralIconUrl` calls. Each static name is assigned only to its requested variant. Dynamic default-variant render sites retain the available literals from the calling module and its direct local imports, preserving file, settings, automation, and Space catalogs without restoring the fill union.
- `apps/web/src/lib/centralIconAssets.test.ts` covers per-variant exclusivity, shared names, and an unrelated literal.
- `apps/web/scripts/write-embed-package.mjs` derives the router peer range from `apps/web/package.json` and writes it beside the existing React peers.
- `apps/web/scripts/write-embed-package.test.ts` uses the real exported `RouterHistory` import and verifies that every bare public declaration import is present in generated dependencies or peer dependencies.

### Second correction package evidence

```sh
SYNARA_COMMIT=94249923ed7f9f3da420b8cc07eb255383c970c6 \
  npx --yes bun@1.3.12 run --cwd apps/web build:embed
```

Two consecutive exact-SHA builds passed. `cmp` confirmed byte-identical manifest, generated declarations, scoped stylesheet, and provenance.

| Artifact | SHA-256 |
| --- | --- |
| `package.json` | `a9e739e2e0780a1813c04278ea957cb27b7e6569d1151d60a8a96c6bfc95ca05` |
| `index.d.ts` | `7b4bae732494cfce0a10a8c4a6e12aa4464471484bda9889ff96f1325d3b4a6b` |
| `style.css` | `f67a9eabfc2d9b0225adb12a56ec5e2250d64fc78071a751a719945b1c9e2569` |
| `synara-provenance.json` | `264390739c9439af4a313cf2741e07fcc17ac674d2f3b321951cd076097ef7c6` |

Two consecutive `npm pack` runs were byte-identical. `synara-react-0.7.3.tgz` is 6,099,052 bytes with SHA-256 `1f78f4bfef20e09cecc7fa001682b9cc0c530ecbe4ba9837b98e6c5053fa6ee6`.

- Embedded icon maps contain 157 reversed assets and 8 fill assets (`arrow-up`, `circle-check`, `circle-x`, `pause`, `pin`, `play`, `stop`, `zap`), down from 254 and 256 respectively.
- Tarball listing contains no `central-icons-reversed`, `central-icons-fill`, favicon, app-icon, Apple-touch-icon, or standalone `synara.png` path.
- The generated manifest declares `@tanstack/react-router: ^1.160.2` as a peer, matching the web package's exact compatible range; `embeddedHistory.d.ts` resolves `RouterHistory` from that declared peer rather than duplicating the interface.

### Second correction self-review and concerns

- Confirmed the collector's test names are present in both fixture asset folders, so the negative assertions prove variant selection rather than missing files.
- Confirmed runtime icon data remains bundled as data URLs and the package still exposes no public asset path.
- Confirmed the package writer rejects an absent router version instead of emitting an incomplete contract.
- Confirmed `git diff --check` passed before the implementation commit.
- No blocking concerns remain. The dynamic default-variant fallback intentionally examines only the rendering source and its direct local imports; a future indirect icon catalog will need an explicit render/reference path or a focused collector test.
