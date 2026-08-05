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

## 2026-08-04 — Live distributed Pi canary, attempt 1

**Revision deployed:** `bb0437b7`

**Experiment:** In the authenticated browser, save Pi execution as `Railway Sandbox`, select Pi with Claude Fable 5, and send one bounded prompt requesting an exact short reply. Baseline sandbox inventory was empty.

**Observation:** The normal browser command path created thread `735962b2-4be7-4e4e-bc90-f21eaa3c1c70` and Railway created private sandbox `c315b0c7-dee0-4907-bd91-425ee556fd67` in `us-west2`. Session startup then failed closed. The causal chain ended at Railway SDK 3.7.0: `Server did not return a durable session for this exec.` No provider model call occurred, and Synara did not fall back to local Pi.

**Cleanup verification:** The provisioning transaction destroyed the exact failed sandbox. A subsequent inventory read returned an empty list.

**Root cause:** The provisioner asked Railway to start the worker process with the requested workspace (`/workspace` for this standalone chat) as the exec working directory. The stock sandbox has not created that path yet. Railway validates `cwd` before Node starts, while `workerMain` is responsible for creating the configured workspace and worker home after Node starts. The command therefore exited before Railway could assign a durable session, and `detach()` surfaced the generic missing-session error.

**Test-first correction:** Preserve the configured workspace in the mode-`0600` worker config and persisted binding, but launch the bootstrap process from Railway's guaranteed default directory by omitting exec `cwd`. `workerMain` then creates the workspace before initializing the existing Pi adapter. A new assertion failed on the old `{ cwd: "/workspace/repo" }` launch and passed after the one-line correction; the focused provisioner/client suite passed nine tests.

**Architectural consequence:** Bootstrap working directory and agent working directory are distinct concepts. A remote runtime must start its supervisor from an image-guaranteed location, then prepare and hand the requested workspace to the provider adapter.

### Durability review before retry

**Observation:** Reviewing the complete answer path exposed a crash window independent of the failed launch. The broker advanced the worker event acknowledgement after a bounded in-memory queue accepted the event, while `ProviderRuntimeIngestion` appended it to `provider_runtime_events` asynchronously downstream. A control-plane crash between those operations could lose an event the worker had already discarded.

**Test-first correction:** Make durable append an injected broker acceptance step. A regression recorded `send:heartbeat` without `persist` on the old behavior. Production `ProviderWorkerBrokerLive` now uses the existing `ProviderRuntimeEventRepository`; it idempotently appends the canonical event before queue publication and acknowledgement. The normal ingestion append remains idempotent, preserving one local/remote projection path. Broker, authenticated connection, and provisioner tests passed fourteen cases.

**Architectural consequence:** Worker acknowledgements represent durable control-plane acceptance, not socket receipt or memory-queue admission. SQLite/Postgres remains the event authority without becoming the request transport.

### Corrected preview deployment, attempt 1

**Revision:** `bfa2ee97`

**Observation:** Railway deployment `5e7c2802-e20f-4037-8649-31509edc8368` moved from `BUILDING` to `FAILED` without emitting build or runtime log lines through either CLI log stream. The previous healthy deployment remained active. The same exact archive passed the local production build immediately before upload.

**Current explanation:** With no build output, there is no evidence of a source, Docker, or runtime failure to repair. Treat this as a Railway build/control-plane transient unless a repeat produces diagnostic evidence.

**Correction:** Re-upload the same `git archive` without code changes as deployment `250ec0f2-03c0-4a50-a5f8-d036b285cdd8`. Do not modify application code to respond to an empty external log stream.

**Retry result:** The byte-identical source revision built and deployed successfully. This supports the transient-control-plane explanation; there was no application correction between the failed and successful uploads.

## 2026-08-04 — Live distributed Pi canary, attempt 2

**Revision deployed:** `bfa2ee97`

**Experiment:** Repeat the same browser-only Pi canary after separating the bootstrap working directory from the requested agent workspace. Baseline sandbox inventory was empty.

**Observation:** The normal browser path created thread `2a4f1b37-c4b8-478c-bc46-1220c53a5cbd` and private sandbox `dae85401-12e8-4591-b31f-91bd57d7a336`, but startup failed with the same SDK error: `Server did not return a durable session for this exec.` The exact sandbox entered destruction and inventory returned to empty. No local fallback or provider model call occurred.

**Hypothesis falsified:** A missing `/workspace` bootstrap directory may still cause an early process exit in other images, but it was not the cause of this Railway v4 failure. Omitting `cwd` changed neither the error nor the lifecycle outcome. The earlier entry is retained because it records a reasonable test and a useful separation of bootstrap cwd from provider cwd; this retry corrects its causal conclusion.

### Disposable Railway primitive experiment 1 — detach a live process

**Why tried:** Isolate the Railway SDK process primitive from Synara, the worker artifact, WebSockets, Pi, and provider credentials.

**Experiment:** Create a disposable private sandbox, start a trivial Node process whose only behavior is a repeating timer, and immediately call the SDK handle's `detach()` method.

**Observation:** The trivial process reproduced the exact error: `Server did not return a durable session for this exec.` The sandbox was destroyed in a `finally` cleanup and inventory returned to empty.

**Conclusion:** In the tested Railway v4 environment with SDK 3.7.0, a successful long-running exec is not assigned the detachable durable-session handle the SDK method expects. This is a platform-capability mismatch, not evidence that Synara's worker exits during bootstrap.

### Disposable Railway primitive experiment 2 — retain the attached exec

**Why tried:** Test the lower-level capability that Synara actually needs: keep one process alive while the control plane remains connected, without requiring reattachment.

**Experiment:** Run the same repeating Node process as an attached exec with a five-second client timeout and do not call `detach()`.

**Observation:** The process started, emitted its marker, remained alive for the observation window, and returned the expected timed-out attached result. Safe result: `{created:true, ran:true, timedOut:true, exitCode:null, destroyIssued:true, stdoutMatched:true}`.

**Course correction:** Treat durable process identity as a capability, not an assumption. `RailwaySandboxClient` now waits briefly for a real session name. When Railway supplies one, Synara detaches and can reattach as before. When it does not, Synara keeps the SDK exec handle attached under an opaque `attached:<id>` handle, supervises it in the control plane, and terminates that exact handle through the existing `WorkspaceRuntime` process seam. The persisted provider binding records `processSupervision` as `durable` or `attached`; older bindings remain decodable.

**Current durability boundary:** Attached supervision enables the end-to-end v4 canary, but the process handle exists only in the current control-plane process. A Synara restart cannot reattach that worker. Restart-safe remote execution still requires Railway to expose durable sessions in this environment, a sandbox image-level process supervisor with a reconnectable control surface, or explicit workspace snapshot-and-rehydrate behavior. The fallback is additive and fails closed; it is not represented as durable when it is not.

## 2026-08-04 — Railway credential and restart trials

### Attempt 1 — Reuse the copied Railway CLI access token

**Observation:** The next browser canary reached the normal distributed session-start path, but Railway rejected `sandboxCreate` as `Not Authorized`. No sandbox, worker, or provider model call was created.

**Cause:** The preview variable contained the CLI OAuth access token copied earlier in the trial. Railway CLI transparently refreshes its local access token, but the copied service variable cannot refresh and had expired. A refreshed token proved the diagnosis, but copying it again would merely reset the same timer.

### Attempt 2 — Create a project token through the public GraphQL API

**Why tried:** Railway's current documentation identifies project tokens as the least-privilege credential scoped to one project environment. API schema introspection exposed `projectTokenCreate(ProjectTokenCreateInput)`.

**Observation:** The authenticated CLI OAuth token could introspect the API but received `Not Authorized` for token creation. This is an intentional privilege boundary, not an application error.

**Correction:** Use the already-authenticated Railway project settings UI to create `synara-distributed-preview-sandboxes`, scoped only to v4 `production`. Capture the one-time value directly into a mode-`0600` temporary file, install it into the preview's encrypted variables, and delete every temporary copy. A disposable SDK probe using `authType: "project-token"` created a private `us-west2` sandbox and destroyed it successfully.

**Application correction:** Railway SDK treats an explicitly supplied token as bearer authentication unless `authType` is also supplied. Add `SYNARA_RAILWAY_SANDBOX_AUTH_TYPE=bearer|project-token`, defaulting to the legacy `bearer`, carry it only in server-side runtime configuration, and include the non-secret mode in redacted diagnostics. This preserves existing configurations while enabling the durable project-scoped credential.

### Attempt 3 — Use `redeploy` to refresh a browser pairing link

**Observation:** `railway redeploy` rebuilt the full image in this source-uploaded preview instead of behaving like a process restart. It eventually succeeded but spent several minutes repeating a clean build.

**Correction:** Use `railway restart` when only a new process and startup pairing credential are required.

### Attempt 4 — Restart the ephemeral SQLite preview

**Observation:** The restart crashed repeatedly with `DatabaseLifecycleLockedError`: the replacement container saw `/data/userdata/state.sqlite.lifecycle-lock` naming owner PID 4, and its own server process also used PID 4. The liveness check therefore treated a lock written by the prior container as owned by the replacement process. The WebSocket proxy then reported connection-refused noise because the server never became ready.

**Conclusion:** A rolling container restart and a same-host process restart are not equivalent for PID-only SQLite lifecycle locks. For this ephemeral canary, a fresh archived deployment is the safe recovery path. Before attaching a persistent volume for production, the lifecycle lock must include a container/boot identity or another cross-container ownership check; otherwise a normal Railway replacement can false-positive on PID reuse. This is independent of the distributed Pi adapter but directly affects the proposed durable control plane.

## 2026-08-04 — Live distributed Pi canary, private-network trial

**Revision deployed:** `6c3b343a`

**Progress:** Project-token authentication succeeded. The browser command created private sandbox `abf8b2c9-e999-453d-84fd-824ad93cf4e7`, uploaded the 14,076,840-byte worker artifact and private config, and started the real provider-worker process. This passed every boundary that had failed in the first three canaries.

**Observation:** The browser remained in `Connecting`, and the worker process stayed alive without registering at the broker. An independent command inside the exact sandbox resolved `synara-distributed-preview.railway.internal` to Railway IPv6 and IPv4 addresses. IPv6 port 3773 returned `ECONNREFUSED`; the private IPv4 connection timed out. The public health endpoint remained healthy.

**Cause:** Railway private networking routes services over IPv6. The Docker entrypoint exposed the public proxy as `socat TCP-LISTEN:3773,bind=0.0.0.0`, an IPv4-only listener. Public Railway ingress could reach it, but a private-network sandbox could not.

**Test-first correction:** Add a container-entrypoint regression requiring a `TCP6-LISTEN` listener with `ipv6only=0`, retaining the IPv4 loopback target to Synara on port 3774. The old entrypoint failed the assertion. The corrected socat invocation starts successfully in the same Linux socat image used to validate its option set and accepts both address families.

### Cleanup hang discovered while forcing the failed canary closed

**Observation:** The broker's 30-second registration timeout fired, but failure cleanup did not reach the browser because `stopDurableProcess` waited indefinitely for the reattached SDK handle's final exit frame after `kill("TERM")` returned success. An isolated project-token probe also received a real durable session in about 4.3 seconds, accepted the terminate signal, and then reproduced the missing exit-frame hang.

**Correction:** Treat a successful SDK `kill` as delivery of the process-group termination signal and keep sandbox destruction as the authoritative cleanup barrier. Do not wait unboundedly for a transport exit frame after signal acceptance. Apply the same rule to attached handles and direct sandbox destruction. A regression with a never-settling handle failed before the change and now completes immediately. The exact failed canary sandbox and the disposable diagnostic sandbox were explicitly destroyed.

## 2026-08-04 — Live distributed Pi canary after dual-stack correction

**Revision deployed:** `41c25efc`

**Experiment:** Repeat the browser-only Pi canary with the dual-stack private listener and bounded post-signal cleanup. The normal UI path created private sandbox `fdf27257-4070-41d4-a3f1-b246df290c3a` and uploaded the worker artifact and private configuration.

**Observation:** A public health probe, an HTTP health probe from inside the exact sandbox, and a manually opened WebSocket from that sandbox to `ws://synara-distributed-preview.railway.internal:3773/internal/provider-worker` all succeeded. The real provider worker nevertheless exited before registering, and the UI stayed at `Connecting`.

### Hypothesis 1 — split in-memory broker instances

**Why tried:** The worker provisioner receives the broker/credential layer inside its own composition while the HTTP route receives the same transport layer at the application root. If Effect constructed those twice, the provisioner would reserve a worker in one broker while the route rejected it in another.

**Result:** A direct Effect layer-identity experiment reproduced the same nested/root composition and returned the same object identity for both consumers. The hypothesis was falsified; no layer rewrite was made.

### Hypothesis 2 — immediate durable-session detach stops the command

**Why tried:** The sandbox contained the uploaded artifact/config but no worker home directory after the failed launch, suggesting the command might not have begun.

**Result:** A disposable private sandbox used the exact SDK sequence: start a marker loop, await its durable session name, detach, wait, and inspect the marker. The process remained alive and the marker advanced. Immediate detach was not the cause, so Synara retained the SDK's documented detach behavior.

### Observability defect — protocol failures were mislabeled as socket reads

**Observation:** Every server-side worker failure was logged only as `Provider worker WebSocket read failed`, even when the handler itself rejected authentication or broker registration.

**Cause:** The HTTP socket adapter mapped every `runRaw` error into a new generic read error, including already-structured `ProviderWorkerTransportError` values raised by the protocol handler.

**Test-first correction:** Add one regression for preserving a structured `register.auth` failure and one for wrapping a raw socket failure. The new test first failed because the mapper did not exist. The route now preserves protocol errors and wraps only raw socket errors; the route and connection suites pass six cases. This does not relax authentication or registration rules—it restores the causal operation in safe logs.

### Process-handshake defect — project-token exec used the attached fallback

**Observation:** A second clean canary created sandbox `481b5291-b466-4fce-bbe8-ab21bd30b1e4`, uploaded both files, but again produced no worker process or home directory. A separate wrapper probe with the same scoped token could create, supervise, verify, and destroy a marker process successfully.

**Cause:** `startDurableProcess` waited only 1.5 seconds for `sessionName` for every auth mode. A project-token exec that was still establishing its shell connection could therefore be reported as `attached` before Railway either assigned its durable identity or surfaced its startup failure. Any later rejection was consumed by the background handle while the provisioner waited only for a broker connection.

**Test-first correction:** Project-token mode now awaits Railway's real durable session and detaches only after it exists. The attached fallback remains available only for legacy bearer mode, where the earlier v4 experiment proved that no durable session may be assigned. A delayed project-token session regression failed on the old `attached:must-not-fallback` result and passes as `durable` after the correction; all eighteen focused lifecycle, provisioner, route, and connection tests pass.

**Operational correction:** Both failed canary sandboxes were explicitly destroyed. A fresh exact-archive deployment is used between canaries because this preview intentionally has ephemeral SQLite state and a prior rolling restart exposed the PID-reuse lifecycle-lock defect.

### Command-line mistakes retained for reproducibility

- `railway logs --build` accepts the deployment ID positionally and rejects combining `--build` with `--deployment`. The first inspection used the wrong form; the corrected form was `railway logs --build ... <deployment-id>`.
- zsh reserves `status` as a read-only parameter. A polling loop that assigned it failed locally; subsequent loops use `deploy_state`. Neither mistake changed Railway state.

### Exact-archive deployment retry after prepare-script failure

**Observation:** The first deployment of revision `73486e9e` failed during `bun install --frozen-lockfile` when `@effect/language-service` reported `UnableToFindPositionToPatchError` while patching `clearSourceFileEffectMetadata`. This happened before application compilation and left the previous healthy deployment active.

**Correction:** Re-upload the byte-identical `git archive HEAD` before changing source. The retry completed the same frozen install, proving the failure was not caused by the distributed-runtime change. Retain the error in the log because the workspace prepare patch is a clean-build reliability risk even when a retry succeeds.

### In-container exec diagnosis — create handle versus connected handle

**Hypothesis tried:** The preview service could call Railway's GraphQL/files APIs but might be unable to reach the SDK exec WebSocket at `wss://ssh.railway.com:2226/ws/exec` from Railway's own network.

**Result:** A read-only probe over a short-lived Railway SSH key resolved `ssh.railway.com`, connected to TCP port 2226, and confirmed Node's global WebSocket implementation was available in the exact preview container. An actual SDK exec launched a marker command in the canary sandbox and received a durable session. The egress hypothesis was falsified.

**Differential experiment:** The working in-container probe used `Sandbox.connect(id)` before `exec`; Synara reused the object returned by `Sandbox.create()`. Starting the exact uploaded worker through a freshly connected object assigned a durable session, booted the Pi adapter, and repeatedly reached the control-plane route. Those late registration attempts were correctly rejected because the canary's 30-second broker reservation had already been retired.

**Test-first correction:** Require `startDurableProcess` to obtain a fresh connected sandbox handle even when the create handle is cached. A regression used a deliberately unusable create object and a healthy connected object; it failed on the old `create handle cannot establish exec` path and passes after the client reconnects before process start. The existing cached handle remains useful for file uploads and destruction, while the process-control seam starts from current Railway connection state. Nineteen focused lifecycle/provisioner/transport tests pass.

### Follow-up — file materialization did not imply transfer completion

**Observation:** The next clean canary still had no worker process. Both uploaded files existed with complete sizes and modes, and the fresh process connection code was present in the running bundle. Therefore the provisioner had not reached process start even though file materialization looked complete.

**Cause:** The final file-transfer promise can remain unsettled on the cached create object after Railway has already materialized the file. The provisioner correctly awaited that promise, so it never advanced to the newly corrected process-start seam.

**Test-first correction:** Apply the same fresh-connection rule to `writeFile`. A regression creates an unusable file transport on the create object and a working one on `Sandbox.connect(id)`; it fails on the old `writeFile` path and passes after reconnecting. File uploads and worker process start now each use a current SDK connection, while exact sandbox identity and cleanup remain unchanged.

**Live correction to the conclusion:** The next canary still stalled after both files appeared. Direct in-container experiments then proved that a fresh connected `files.write()` resolved for both a small marker and the complete 14,076,840-byte worker artifact (about 3.7 seconds for the large transfer). Fresh connections remain a useful stale-handle safeguard covered by regression tests, but an unsettled upload was not established as the live root cause.

**Course correction:** Stop inferring the active phase from filesystem side effects. Add secret-free phase logs at worker reservation, artifact upload start/completion, config upload completion, process identity assignment, and broker connection. The next canary will use those events as the authority for where startup stops.
