# Railway v4 Distributed Runtime Trial Log

This is a chronological engineering journal for the additive Synara distributed provider runtime. It intentionally records unsuccessful attempts and abandoned hypotheses, not only the final implementation.

Secrets, raw tokens, session cookies, credential-bearing URLs, and provider prompt contents must not be recorded here.

## 2026-08-04 — Initial environment discovery

**Revision:** `5bd60853`

**Hypothesis:** The repository's phrase “Railway v4” refers to the currently linked Railway project, and Project Sandboxes are available there.

**Scope:** Read-only Railway CLI inspection of the linked project and production environment.

**Observation:** The checkout is linked to project `v4`, production environment. The `synara`, `gitea`, and Postgres resources are online. `railway sandbox list --json` succeeded and returned an empty list. Railway CLI 5.15.0 reports Project Sandboxes as experimental.

**Conclusion:** The project target is unambiguous, the feature is enabled, and no pre-existing sandboxes need to be preserved. The implementation must isolate the experimental Railway API behind a local interface.

## 2026-08-04 — Worktree dependency bootstrap, attempt 1

**Revision:** `5bd60853`

**Hypothesis:** Running Bun 1.3.12 through `npm exec` is sufficient to install the worktree dependencies.

**Why tried:** Bun was not available on the shell `PATH`, while the repository pins Bun 1.3.12.

**Experiment:** Run `bun install --frozen-lockfile` through an ephemeral npm-provided Bun 1.3.12 executable.

**Observation:** Installation failed in Electron's postinstall. The postinstall process used system Node 18.17.1 and attempted CommonJS `require()` of an ESM-only dependency.

**Cause:** Selecting the correct Bun executable did not select the repository's Node 24 runtime for child lifecycle scripts.

**Correction:** Put the bundled Node 24 executable directory first on `PATH` while invoking the same pinned Bun command.

**Verification:** The second frozen install completed with 1,293 installs checked and no dependency changes.

**Architectural consequence:** Local development instructions for this worktree must bind both Bun and Node versions. No repository dependency or production image change is justified; the Dockerfile already uses Node 24 and Bun 1.3.12.

## 2026-08-04 — Baseline test, Electron partial-install residue

**Revision:** `5bd60853`

**Hypothesis:** The successful second install left a testable dependency tree.

**Experiment:** Run the repository test script with Node 24 and Bun 1.3.12.

**Observation:** The desktop suite reported one failed suite: Electron said it had not installed correctly. The other 57 desktop files were able to run; the failure occurred during import of Electron in `browserUsePipeServer.test.ts`.

**Cause:** The first failed Electron postinstall left a partial package directory, and Bun's second install considered the dependency graph present rather than rerunning that postinstall.

**Correction:** Run the generated Electron installer under Node 24, then rerun only the desktop package test.

**Verification:** Desktop completed with 57 passed files, 1 skipped file, 558 passed tests, and 5 skipped tests.

**Architectural consequence:** None. The user subsequently removed Electron from the distributed-runtime scope; browser/server verification is the relevant gate.

## 2026-08-04 — Repository-wide baseline, web build dependency resolution

**Revision:** `5bd60853`

**Hypothesis:** After repairing Electron, the repository-wide test task would provide a clean baseline.

**Experiment:** Rerun the root test task with Turbo error-only logs.

**Observation:** The task reached the web production build and failed to resolve `@fontsource-variable/inter` imported by `apps/web/src/superTokensAuth/render.tsx`. The task was stopped after the failure was captured because desktop is outside the requested scope and a focused browser/server baseline is more informative.

**Current explanation:** The worktree install or lockfile workspace linking did not materialize that declared/expected font package. This predates distributed-runtime production code and is not evidence of a runtime-adapter defect.

**Next correction:** Before the first web-facing change, inspect the package declaration and lockfile entry, repair only the generated install if the dependency is already declared, and run focused contracts/shared/server/web tests and builds. If the package is undeclared in the baseline, record it as a pre-existing build defect rather than silently bundling it into the distributed-runtime architecture.

**Architectural consequence:** Verification is scoped to the browser/server product, but the web production build remains a required acceptance check.

## 2026-08-04 — Railway SDK contract inspection

**Revision:** `4eedceb6`

**Hypothesis:** The Railway TypeScript SDK can be hidden behind Synara's own workspace-runtime boundary without leaking experimental SDK types into provider or orchestration code.

**Experiment:** Install the exact `railway@3.7.0` package in `apps/server`, inspect its declarations, and implement a facade-backed client with fake-SDK contract tests.

**Observation:** The SDK supports create, reconnect, list, exec, destroy, file transfer, checkpoints, and durable exec sessions. `Sandbox.create` resolves at `RUNNING`. The observed status union also includes `DESTROYING`, which the initial sketch had omitted.

**Correction:** Preserve `DESTROYING` in Synara's generic runtime status instead of narrowing Railway into an inaccurate lifecycle. Keep the SDK import confined to `Layers/RailwaySandboxClient.ts`.

**Verification:** The SDK mapping tests and generic runtime lifecycle tests pass together, including reconnect refresh, private-network creation, idempotent not-found cleanup, and failed-create cleanup.

**Architectural consequence:** Later orchestration and Pi routing code depends on `WorkspaceRuntime`, not Railway. Durable exec needs a deliberate extension to that generic contract in the worker stage; it should not be improvised inside the Pi adapter.

## 2026-08-04 — Guarded lifecycle smoke and asynchronous teardown

**Revision:** working tree after `4eedceb6`

**Hypothesis:** A bounded smoke can create one sandbox, probe it, reconnect, keep it alive, destroy it, and immediately assert that it disappeared from inventory.

**Experiment:** Add a server-only smoke entry point guarded by `SYNARA_RAILWAY_SANDBOX_SMOKE=1`, with a fake runtime test that returns `DESTROYING` once after destroy.

**Observation:** Immediate absence was an incorrect assumption. Railway destroy is asynchronous and inventory may legitimately retain a `DESTROYING` record.

**Correction:** Poll bounded inventory for disappearance after destroy. The release path still runs on intermediate command failure. Smoke output contains only IDs, region, counts, command exit metadata, and verification flags; it does not copy stdout, stderr, tokens, or provider content.

**Verification:** Four smoke-policy tests pass, including guard refusal, sanitized success output, cleanup after a command failure, and asynchronous teardown.

## 2026-08-04 — Live `v4` sandbox trial

**Revision:** working tree after `4eedceb6`

**Scope:** One sandbox in project `v4`, production environment `bd3494bb-73e4-450b-bd44-1579a5b60e7d`, private networking enabled, five-minute idle timeout. No service deployment or database mutation.

**Sandbox:** `ef1b4542-d435-4aae-b8bb-e531685e3cc6`, region `us-west2`.

**Baseline:** `railway sandbox list --json` returned no sandboxes.

### Attempt 1 — Assume the stock sandbox contains the Pi CLI

**Why tried:** The first smoke draft used `pi --version` as a proxy for worker readiness.

**Observation:** `uname -a` succeeded and Node reported `v24.18.0`. `pi --version` failed with `No such file or directory` and exit code 1.

**Cause:** Railway's stock sandbox is a Node-capable workspace, not a Synara/Pi worker image. Synara's current Pi adapter uses bundled Pi SDK packages; a globally installed Pi CLI is neither provided by Railway nor the correct lifecycle-layer acceptance criterion.

**Correction:** Remove the Pi CLI probe from the generic sandbox smoke. Build a reproducible Synara worker artifact/template in the next stage and test that artifact's own readiness protocol. Keep provider-readiness checks above the generic workspace lifecycle.

### Attempt 2 — Start a detached worker through shell glue

**Why tried:** Validate whether a detached command can be reattached after the initiating client exits.

**Experiment:** Launch a short command via `sh -lc`, detach it, then reattach by the returned durable session name.

**Observation:** Reattachment failed with `/bin/sh` errors including `[[: not found` and an unexpected `(` syntax error.

**Cause:** The shell wrapper introduced dialect and quoting behavior that is not part of the durable-session primitive. It is unsafe to make worker correctness depend on interactive shell initialization or Bash-compatible syntax.

**Correction:** Launch the worker executable directly as argv. A detached direct Node process stayed alive for 30 seconds; reattachment replayed `worker-ready` and continued through `worker-done`, exiting successfully.

**Architectural consequence:** The remote worker supervisor should start a compiled Node entry point directly. Durable session name is a recoverable binding to persist alongside sandbox ID and lifecycle generation.

### Teardown

Destroy was issued for the exact sandbox ID. The first inventory read returned the sandbox as `DESTROYING`, confirming the asynchronous-teardown behavior already captured in tests. A later inventory read returned an empty list. No broad cleanup command was used.

## 2026-08-04 — Browser/server bundle recheck

**Revision:** working tree after `4eedceb6`

**Observation:** A focused `apps/server` production build completed and bundled the React web client into `dist/client`. The earlier unresolved Inter font error did not reproduce after dependency bootstrap completed.

**Conclusion:** The browser-only product build is healthy at this stage. Electron remains outside distributed-runtime scope.

## 2026-08-04 — Worker transport direction and connection fencing

**Revision:** `6688759f` through working tree after `bb676de7`

**Hypothesis:** The control plane should open a connection to a listening process inside each sandbox.

**Why reconsidered:** Railway documents stable private DNS for deployed services. The Sandbox SDK and CLI document a sandbox's ability to join the environment private network and reach services, but do not expose a stable per-sandbox private service name for inbound control-plane traffic.

**Correction:** Invert the connection. A private-network sandbox opens an outbound WebSocket to `synara.railway.internal`; the browser continues to connect only to Synara's public browser WebSocket. The worker route is a separate, uncompressed internal protocol and never creates a browser owner session.

**Implementation:** Add a schema-only, versioned protocol carrying existing Pi adapter inputs and canonical `ProviderRuntimeEvent` values. Add a broker that reserves an exact sandbox/worker/generation tuple, correlates bounded requests, fails them on disconnect, rejects sequence gaps, deduplicates replay, and preserves the acknowledged sequence across reconnects. Add a per-runtime bootstrap authority that stores only SHA-256 credential digests and uses constant-time comparison. The credential can reconnect only the same fenced runtime until explicit revocation.

**Verification:** Eight protocol codec tests, thirteen broker/auth/connection tests, and the browser/server production bundle pass. Wrong credentials, malformed frames, idle registration sockets, duplicate workers, stale generations, disconnects, timeouts, response mismatches, and event gaps are rejected.

**Architectural consequence:** SQLite/Postgres and object storage are not worker message buses. The control plane remains the orchestration authority; the worker WebSocket is a replaceable transport under the existing provider adapter seam.

## 2026-08-04 — Reusable Pi worker bundle

**Revision:** working tree after `ad109e53`

**Hypothesis:** Bundling the worker entry point with every runtime dependency inlined would produce one artifact that Synara can upload atomically to a stock Railway sandbox.

### Attempt 1 — Treat `noExternal` as sufficient for one file

**Why tried:** `noExternal: [/.*/]` asks the bundler to inline package dependencies, which appeared to cover the self-contained-worker requirement.

**Observation:** The build succeeded but emitted 36 files totaling about 14.4 MB, including a 7.8 MB shared chunk and provider-specific chunks. A sandbox would need a directory-shaped upload whose partial failure could leave an unusable worker.

**Cause:** Inlining dependencies and disabling code splitting are separate bundler decisions.

### Attempt 2 — Use `inlineOnly: true`

**Why tried:** The option name suggested a single inline output.

**Observation:** The build failed before compilation. `tsdown` passed the boolean to its pattern matcher, which rejected it with `Expected pattern to be a non-empty string`.

**Cause:** In this `tsdown` version, `inlineOnly` is a dependency-selection pattern rather than the output-topology switch.

**Correction:** Keep `noExternal` for dependency inclusion and set Rolldown's `outputOptions.codeSplitting` to `false`.

**Verification:** The corrected build emits one `workerMain.mjs` module, approximately 13 MB. Twenty-four worker protocol, broker, authentication, replay, dispatch, configuration, and client-session tests pass. The normal browser/server production build also passes.

**Packaging correction:** The first successful single-file artifact landed in `apps/server/dist-worker`, outside the CLI package's declared `dist` payload. The worker build now writes `dist/provider-worker/workerMain.mjs`, and the normal server build produces it after the main server bundle. This makes the artifact available to the running browser server without adding a second deployment image.
