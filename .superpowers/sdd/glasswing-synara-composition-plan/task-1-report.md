# Task 1 report — generic `@synara/react` embed package

## Status

Completed on branch `codex/glasswing-package-boundary`.

Implementation commit: `9b4a26e6f433c35c08893962ee13b3c55c715cf0`

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

- The tarball contains the full Synara app and its lazy runtime assets, so it is intentionally sizeable (7.5 MiB packed). Further asset pruning should be driven by measured host load behavior.
- `SynaraHostSidebar` exposes the source-compatible host slot contract, while this boundary directly applies its width token; deeper placement of host-owned header/footer content remains the embedding shell's responsibility.
