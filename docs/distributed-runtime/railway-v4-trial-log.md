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

## 2026-08-04 — Provisioning transaction and browser setting

**Revision:** working tree after `2bca3355`

**Implementation:** Add a `ProviderWorkerProvisioner` above the generic `WorkspaceRuntime`. It creates or reconnects one private Railway sandbox, reserves a fenced worker identity, issues an in-memory bootstrap credential, uploads the atomic worker, starts a named durable process, and waits for authenticated broker registration. Failure cleanup retires the reservation, stops the exact durable session, revokes the credential, and destroys the exact sandbox.

**Storage decision:** Reuse `provider_session_runtime.runtime_payload_json` for the non-secret distributed binding: schema version, sandbox ID/status/region, worker ID, lifecycle generation, durable session name, cwd, and worker home. The bootstrap credential is deliberately absent. Existing orchestration tables remain the source of truth for projects, threads, turns, items, events, and resume cursors.

**Course correction — bootstrap configuration:** The initial design assumed every worker identity field could be supplied as sandbox environment at create time. The sandbox ID does not exist until create returns, creating a dependency cycle. The provisioner now writes an exact, mode-`0600` JSON bootstrap file after creation and starts the worker directly by artifact path. Environment variables remain a local-development fallback. Provider API keys are copied only through an explicit allowlist; Synara and Railway control credentials are rejected from that forwarding list.

**Browser UX:** Pi settings now expose `Local server` and `Railway Sandbox`. Local remains the decoded and UI default. Selecting distributed mode persists through the existing server-settings WebSocket method. A missing Railway configuration produces a direct startup error for that Pi session; it never silently falls back to local execution.

## 2026-08-04 — Isolated browser server check

**Experiment:** Start a browser-only development instance with an isolated Synara home, server port `58991`, web port `9924`, no inherited auth token, and no Electron process.

**Observation:** The Synara server listened on `127.0.0.1:58991`, and `/health` returned HTTP 200. Vite repeated the earlier worktree-only dependency-scan warning for `@fontsource-variable/inter`; it still served its port, and the production browser/server build continued to pass.

**Conclusion:** The distributed application-layer additions do not prevent browser-server startup. The font warning is a worktree development dependency-materialization issue already seen at baseline, not evidence of a distributed runtime defect. Production bundle verification remains the reliable browser gate until that unrelated install residue is repaired.

## 2026-08-04 — Compiled worker process smoke

**Hypothesis:** The single-file artifact can boot the real Pi adapter layer, register over WebSocket, accept retirement, and terminate without making a provider model call.

### Attempts 1–3 — Registration timeout

**Observation:** The worker process stayed alive but never reached the smoke server. The first harness version reported only a timeout, so it was corrected to race registration against child exit and retain bounded stdout/stderr. Safe lifecycle logs then proved the worker reached `booting`, `adapter ready`, and `connecting` but did not open the socket.

**Cause:** The Effect WebSocket writer waits on an open latch. `workerClientSession` sent registration first and sequenced `socket.run` second, while `socket.run` is what acquires the WebSocket and opens that latch. The two operations deadlocked before any network connection.

**Correction:** Extend the internal socket facade with an `onOpen` effect and send the registration from that hook while the read loop is running. Server-side accepted sockets keep the same behavior.

**Verification:** The guarded artifact smoke rebuilt `dist/provider-worker/workerMain.mjs`, launched it as a separate process with a private temporary config, verified the full fenced registration without printing its credential, sent `retire`, and observed exit code 0. Safe result: `{registered:true, retired:true, exitCode:0, protocolVersion:1}`.

**Architectural consequence:** Connection establishment and registration are now one ordered operation. A sandbox worker cannot wait forever on its own pre-open write, and the same smoke can be run without Railway or a model API call before live sandbox trials.

## 2026-08-04 — Additive Railway preview deployment, attempt 1

**Revision:** `6ae170f7`

**Scope:** Create a new `synara-distributed-preview` service in v4 production. The existing `synara` service, databases, and volumes are unchanged. The preview has its own ephemeral SQLite state, Railway-provided HTTPS domain, private service hostname, and a ten-minute sandbox idle timeout.

**Credential scope for trial:** The preview references the existing Synara auth and Anthropic provider variables. Its Sandbox SDK token was copied through stdin from the currently authenticated Railway CLI session without printing the value. That user-session token is suitable only for this bounded trial and must be replaced with a durable, least-privilege project token before the preview is treated as persistent infrastructure.

**Polling mistake:** The first deployment polling command used zsh's reserved read-only parameter name `status` and failed locally before polling. Renaming it to `deployment_state` corrected the command; the deployment itself was unaffected.

**Observation:** Docker reached the Vite production build, generated the application chunks and compression sidecars, then failed resolving `@fontsource-variable/inter` from `apps/web/src/superTokensAuth/render.tsx`.

**Cause:** The source imports Inter, but `apps/web/package.json` and `bun.lock` declared only `@fontsource-variable/jetbrains-mono`. The local worktree contained residual Inter package material, so local builds passed while Railway's clean `bun install --frozen-lockfile` correctly exposed the undeclared dependency. This also explains the earlier Vite dev dependency-scan warning.

**Correction:** Declare `@fontsource-variable/inter` in the web workspace and update the lockfile through the pinned Bun version. Do not externalize the font or weaken the clean Docker build.

## 2026-08-04 — Additive Railway preview deployment, attempt 2

**Revision intended:** `f5659e12`

**Verification before retry:** A local production build from the feature worktree resolved Inter, emitted the Inter font assets, transformed 8,800 modules, and completed both web and server/worker bundles.

**Observation:** Railway attempt 2 produced the same missing-Inter failure, the same pre-fix asset hashes, and the same installed-package count as attempt 1. The declared dependency was absent from the uploaded build context even though it was committed in the worktree.

**Cause:** The feature worktree is intentionally located at `.worktrees/distributed-runtime-railway` under the primary checkout, and the primary checkout ignores `/.worktrees/`. `railway up` discovered the outer repository context and uploaded the primary checkout rather than the nested worktree contents. The deployment message named the intended revision, but the source archive did not represent it.

**Correction:** Materialize `git archive HEAD` into a fresh temporary directory, verify the archived `apps/web/package.json` contains Inter, and pass that exact directory to `railway up --path-as-root`. This preserves worktree isolation while making the deployment source deterministic. Do not copy or merge the feature changes into the user's primary checkout just to satisfy the deploy CLI.

## 2026-08-04 — Additive Railway preview deployment, attempt 3

**Revision:** `561206c0`

**Experiment:** Deploy an exact `git archive HEAD` snapshot from a fresh temporary directory with `railway up --path-as-root`, then delete the materialized archive after upload.

**Observation:** Deployment `5c7fb10d-0371-40a1-a72f-343b3678ade0` succeeded. Railway's clean build installed the declared Inter dependency, built the browser, server, and atomic provider-worker artifact, and started the preview in browser-only mode. Both `/health` and `/` returned HTTP 200. Startup logs confirmed the browser server on Railway's injected port, the existing WebSocket proxy on the adjacent internal port, auth enforcement, and a preview-owned SQLite database under `/data/userdata/state.sqlite`.

**Conclusion:** The deterministic archive is the correct deployment boundary for a nested, ignored worktree. The distributed adapter does not require an Electron package or a second server image: the browser server contains the UI, orchestration control plane, and reusable worker artifact, while Railway Sandboxes supply only the per-provider execution plane.

**Remaining operational boundary:** The preview's SQLite file is ephemeral because this additive trial service has no volume. That is sufficient to validate routing and sandbox lifecycle, but a durable deployment must attach a volume or move orchestration persistence to a network database. Object storage remains appropriate for large immutable artifacts, not for coordinating turns or worker commands.

## 2026-08-04 — Browser pairing trial

**Experiment:** Open the Railway HTTPS domain in the in-app browser, observe the unauthenticated application shell, and use the startup pairing link to establish an owner cookie before exercising settings and a Pi turn.

**Observation:** The browser bundle rendered correctly, but its WebSocket reconnects were rejected before pairing as designed. The startup pairing link from the successful deployment had expired by the time browser verification began, and the UI rendered the explicit pairing-failed screen without exposing the credential.

**Correction:** Restart only `synara-distributed-preview` to mint a fresh one-time startup link. Transfer that link to the test browser through a mode-`0600` temporary file, unlink it before navigation completes, and never print the credential. The in-app browser clipboard is isolated from the macOS clipboard, so `pbcopy`/`pbpaste` cannot bridge the secret into the controlled tab.

**Polling mistake:** A later zsh poll accidentally reused the reserved read-only parameter name `status`, independently reproducing the earlier local-only failure. Use a task-specific name such as `deploy_state` in every script, including one-off verification commands.

### Attempt 2 — Reuse `/pair` with a new fragment

**Why tried:** The failed pairing page was already open, and the replacement credential is carried only in the URL fragment.

**Observation:** Navigating from `/pair` to `/pair#token=...` changed the fragment but did not reliably remount the browser bootstrap module. The old failure DOM remained. A later forced reload reached the bootstrap path only after the short-lived credential was no longer usable.

**Correction:** Treat authentication setup and UI acceptance as separate deterministic steps. Exchange a fresh startup credential once through `POST /api/auth/bootstrap`, collect the scoped browser-session cookie without printing either value, delete the credential handoff, and install the resulting secure HttpOnly cookie into the same-origin test tab through the browser developer protocol. The endpoint returned HTTP 200, the session cookie was installed, and the browser WebSocket opened with no console errors.

**Security note:** The browser session is narrower than the server auth token and remains subject to Synara's existing session expiry and revocation behavior. Neither the one-time credential nor the session value is stored in source, the engineering journal, or command output. The temporary cookie jar was deleted before application navigation.

## 2026-08-04 — Live settings acceptance caught a provider-row wiring defect

**Observation:** The authenticated browser loaded the empty orchestration snapshot and settings application correctly. Expanding the Pi provider row showed only `Pi binary path` and `Pi agent directory`; the new execution target was absent. Source inspection proved the `piExecutionTarget` field descriptor had been inserted in the Codex provider's field array.

**Cause:** Existing app-settings tests covered schema mapping, persistence, reset, and dirty-state behavior, but did not assert which provider disclosure owns the field. The shared control rendered correctly wherever its descriptor was placed, so build and non-rendering tests could not catch the wrong row.

**Test-first correction:** Add a regression asserting that a persisted `railway-sandbox` target auto-opens Pi and leaves Codex closed. After exporting the existing disclosure-state derivation for direct testing, the new assertion failed with `pi: false`. Move the unchanged execution-target descriptor from Codex to Pi; the focused panel and app-settings suite then passed 66 tests.

**Architectural consequence:** The execution placement remains a Pi provider setting, not a global or Codex setting. Browser acceptance is necessary for settings whose correctness depends on visual ownership even when the underlying persistence contract is already covered.
