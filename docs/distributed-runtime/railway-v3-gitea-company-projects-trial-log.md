# Railway v3 Gitea company projects — trial log

Date: 2026-08-06

## Objective and boundary

Deploy an additive, browser-only Synara service into Railway project `v3`, environment `dev`.
Users choose a company directory from the private `glasswing-admin/glasswing-company-data`
Gitea repository, create an ordinary Synara project/thread, and run Pi in a disposable Railway
Sandbox hydrated with only that company directory. Existing v3 services are not modified.

The implementation remains an adapter over Synara's existing primitives:

- `Project` receives an optional immutable `repositoryBinding`.
- `Thread`, `Turn`, orchestration commands/events, provider sessions, and provider runtime events
  remain the durable flow.
- Railway sandboxes and Pi sessions remain disposable execution attempts.
- SQLite on the Synara `/data` volume remains control-plane truth; sandbox files are not truth.

## Target topology

- Railway project: `v3` (`7bf8f727-f0a8-4aea-b1b4-4266aecc49f0`)
- Railway environment: `dev` (`51f1e0e3-5714-4b56-8214-03e69b0c6afc`)
- Existing Gitea service: `glasswing-gitea` (`999981ea-3c2a-4bb2-a077-068673527a7d`)
- Existing Gitea origin: `https://glasswing-gitea-dev.up.railway.app`
- New additive service: `synara-gitea-dev` (`ad3904fc-9b54-460d-b147-d87a4f0956c6`)
- New additive volume: `synara-gitea-dev-volume` mounted at `/data`
- Browser URL: `https://synara-gitea-dev-dev.up.railway.app`
- Sandbox policy: `ISOLATED` (public NAT egress only), 30-minute idle timeout, `us-east4-eqdc4a`

The Dockerfile builds `apps/web` and `apps/server` only. Electron is not built or deployed.

## Repository catalog observations

The Gitea repository is private and has 33 directories under `companies/`. The contents API and
Git smart HTTP both accept the existing read token. The user-scoped `/api/v1/user/repos` endpoint
returns `403`, so catalog enumeration uses the repository contents endpoint rather than relying on
user repository listing.

Each directory must have a safe slug. A valid `company.json` supplies the preferred stable ID and
display name; missing or malformed metadata now remains selectable through a deterministic ID and
humanized directory name, with an explicit diagnostic. Authentication, authorization, network,
and server failures fail the whole refresh visibly instead of being mislabeled as bad metadata.
Project creation revalidates the descriptor server-side and canonicalizes title, compatibility
workspace root, repository origin, owner, repository, ref, and path before dispatching Synara's
existing `project.create` command.

## Implementation trials and corrections

### Catalog and project persistence

Added schema-only Gitea binding/catalog contracts, an optional `repository_binding_json` projection
column, catalog RPC, browser company picker, and server-side create admission. Ordinary local and
GitHub projects retain their current behavior. The migration lineage check passed through 73 tags.

### Provider startup propagation

The first focused provider-reactor test proved that repository metadata stopped at the Project
projection. The reactor now resolves project and cwd together and includes the binding only for a
bound project. A companion assertion proves an ordinary project still omits it.

### Sandbox hydration

The first provisioner test showed the worker could start before any repository checkout. The
provisioner now validates the binding against the configured Gitea repository, creates a fresh
sandbox, sparse-checks out only the selected company under `/workspace/repository`, verifies
`company.json`, records the immutable commit SHA, and only then uploads/starts the provider worker.

The checkout token is installed only in the sandbox environment. The shell command contains the
environment variable name, never the token. The token is not written to the worker config, runtime
binding, SQLite, browser RPC payloads, or logs. A failed checkout destroys the sandbox before worker
launch.

The routed Pi adapter now fails closed if a Gitea-bound project is configured for local execution.
For remote execution it gives the provisioner the binding, removes the binding before the provider
RPC, and replaces the controller compatibility cwd with the verified sandbox company cwd.

### Network policy

Railway SDK 3.7 documents `ISOLATED` as NAT egress without environment private-network access and
`PRIVATE` as membership in the Railway environment network. The original runtime hard-coded
`PRIVATE`. A new validated setting makes the policy explicit. v3/dev uses `ISOLATED`, reaches Gitea
over HTTPS, and returns to Synara over its public WSS endpoint.

### Pi model default caught before deployment

Pi deliberately has no global static model default because its catalog is discovered dynamically.
The first company UI path called `getDefaultModel("pi")`, which returns `null`. Focused tests had
covered binding transport but not the Sidebar call site. The company adapter now selects
`anthropic/claude-fable-5`, one of the Anthropic models the existing Pi adapter explicitly ensures,
while normal model selection remains available after project creation.

## Railway deployment trials

### Wrong local link detected before mutation

`railway status` initially showed the isolated worktree linked to v4/production and
`synara-distributed-preview`. No mutation was made there. The worktree was explicitly relinked by
project and environment IDs to v3/dev and verified before creating the new service.

### Volume selector mismatch

Attempting `railway volume add` with top-level `--project`, `--environment`, and `--service`
selectors failed because those flags are accepted by the `volume` parent but not forwarded by the
`volume add` subcommand in Railway CLI 5.15.0. After verifying the exact linked service, the retry
used `railway volume add --mount-path /data --json` and created only the new service volume.

### Project-token API boundary

GraphQL schema introspection showed `projectTokenCreate(ProjectTokenCreateInput!)`, but invoking it
with the authenticated Railway CLI OAuth identity returned `Not Authorized`. This reproduces the
earlier v4 trial: token creation is intentionally a Railway settings-UI privilege boundary.

For the initial canary only, the refreshed CLI access token is installed as `bearer`. It is
temporary and must not be called durable. The final configuration must replace it with a v3/dev
project token and change `SYNARA_RAILWAY_SANDBOX_AUTH_TYPE` to `project-token`.

### Secret-safe variable installation mistakes

The first secret-safe pipeline used GNU `base64 --decode`; macOS `base64` rejected that flag. A
non-secret origin probe verified the Railway CLI syntax, then the pipeline switched to `base64 -D`.
The long Anthropic value still failed through that pipeline, so the correction passed it directly
to `railway variable set ... --stdin` through a spawned process. No secret value was printed.

### Clean Docker build

The first source upload is deployment `d1c33aa8-e10a-4fbe-93ac-72c818348599`. The clean build
installed 2,583 packages, built the browser bundle in 1 minute 58 seconds, built the server and
provider-worker artifact successfully, and then spent additional time exporting the large runtime
image. End-to-end status remains to be appended after the service and browser canary are verified.

### First boot — mounted volume ownership

**Observation:** The image built successfully, but the public health endpoint returned `502` and
the container restarted repeatedly. The exact startup cause was `EACCES: permission denied, mkdir
'/data/userdata'`.

**Cause:** The image's build stage created and owned `/data` as `node`, but Railway mounts the new
volume over that path at runtime. The mount root is owned by root, and the Dockerfile started
directly as `USER node`, so Synara could not initialize its private state directory.

**Correction:** Add a focused entrypoint regression. The runtime now starts at the container
default user only long enough to `install` `/data/userdata` with mode `0700` and owner `node`, then
immediately re-executes the same entrypoint through `runuser -u node`. A disposable Docker-volume
probe verified that `node` can create a directory inside the initialized path; the probe volume was
then removed. The application and proxy still run unprivileged.

### Browser shell healthy, WebSocket origin rejected

**Observation:** Corrected deployment `0d5ed8fa-1047-4a8d-aee1-0426c6e9a482` returned HTTP 200 and
ran all migrations, but the browser stayed at `Loading projects...`. Its WebSocket repeatedly failed
before any snapshot reached the UI.

**Cause:** The service had no `SYNARA_PUBLIC_URL`. The loopback server therefore had no trusted
Railway HTTPS origin and correctly rejected the browser upgrade instead of accepting an unrelated
Origin header.

**Correction:** Configure the exact Railway HTTPS origin and a generated server auth token, using
Synara's existing secure remote-access and owner-session primitives. Deployment
`23975e51-a244-47ad-8e75-cad66cd3ba43` then hydrated the empty durable snapshot. Origin checks were
not weakened. A zsh polling helper also failed because `status` is a reserved read-only parameter;
the corrected helper uses `deploy_state`. One build-log command placed the deployment ID behind an
unsupported `--deployment` flag; the CLI's documented positional deployment argument worked.

### One-time browser pairing extraction

**Observation:** Two fresh startup pairing attempts rendered Synara's explicit pairing-failed
screen even though the credentials were consumed immediately.

**Cause:** The first log parser matched non-whitespace and included the trailing single quote from
the structured log field. A second diagnostic orchestration attempt used JavaScript's unavailable
`URL` global in the tool isolate before making a request. Neither was a server authentication bug.

**Correction:** Stop the token match at the structured log quote, slice the fragment without a URL
parser, exchange it through Synara's existing `/api/auth/bootstrap` endpoint with the exact trusted
Origin, and install the returned secure HttpOnly owner cookie in the same-origin browser profile.
The authenticated browser WebSocket connected without warnings. No credential was printed or
stored in the repository.

### Company catalog and project-root mount

**Observation:** After a three-second catalog fetch, the browser replaced `Folder` with `Company`,
listed all 33 Gitea directories, selected Cue Cloud, and dispatched create. The command then failed
with `Failed to create project directory: /data/gitea-company-projects/cue-cloud`.

**Cause:** The first volume fix initialized only `/data/userdata`. The additive compatibility
workspace root and Synara's `/data/worktrees` root were still absent beneath Railway's root-owned
mount.

**Correction:** A focused entrypoint test first failed on both missing roots. The entrypoint now
creates `/data/worktrees` and `/data/gitea-company-projects` as `node:node` with mode `0750` before
dropping privileges. The focused test passed, and a disposable Docker-volume probe verified that
the unprivileged user can create the Cue Cloud child directory. The probe volume was removed.

### Pi send gate still measured the controller-local CLI

**Observation:** Cue Cloud project creation succeeded after deployment
`b04c2fa8-9cbd-4a74-80f5-7731f00c13bd`, the new-thread composer selected Claude Fable 5, and the
Pi model catalog loaded. Send was still blocked twice with `Provider status is still loading.` No
turn or sandbox was created.

**Cause:** The routed Pi adapter honored `railway-sandbox`, but the independent provider-health
projection omitted Pi when the controller image had no local `pi` CLI status. The browser's shared
send gate correctly blocks a provider absent from the health snapshot. For distributed mode that
was checking the wrong execution target.

**Correction:** Add a focused provider-health regression proving Railway Sandbox Pi is usable even
without a controller-local status. The settings projection now emits a remote-target ready status
only when `executionTarget` is `railway-sandbox`; local mode and disabled-provider behavior remain
unchanged. Sandbox configuration, credentials, and provider availability are still verified
authoritatively by the existing `session.start` path. The focused ProviderHealth and entrypoint
suites pass 96 tests.

### Clean-install Effect patch race

**Observation:** Deployment `82727b17-b4e5-42a1-9a77-f2e11f54db91` failed inside `bun install`
before either application build. The Effect language-service prepare hook reported
`UnableToFindPositionToPatchError` while patching TypeScript.

**Correction:** Run the local patch command against the installed tree, where it confirmed the
same patch version was already present, then retry the identical source without changing code.
Deployment `48be4be4-6755-4dd1-b47c-40a5e526c576` passed the prepare hook and completed. The
identical retry is evidence of a nondeterministic clean-install patch race, not an application
compile defect; no speculative source workaround was added.

### Refreshed bearer was not active in the restarted deployment

**Observation:** The first distributed turn reached `session.start` but Railway returned
`Not Authorized` before creating a sandbox. Updating the refreshed CLI bearer with
`--skip-deploys` and restarting produced the same result.

**Cause:** The variable store contained the refreshed token, but `restart` reused the previous
deployment's environment snapshot. A local Railway SDK probe with the exact stored bearer created
and destroyed a one-minute v3/dev sandbox successfully, proving the credential and SDK call were
valid.

**Correction:** `redeploy` the existing image so current variables are injected without a source
rebuild. Deployment `e97ad339-0771-43ce-8ce5-3ac95399cd39` then created sandbox
`12a3dbc0-fbb9-4d9f-a5dd-04d0f94e18f3` in the configured region. The two local probe sandboxes were
explicitly destroyed.

### Railway safe-git rejected a persistent remote

**Observation:** The first authenticated sandbox was created and then destroyed by the
provisioner's cleanup path before worker launch. Its hydration command failed with
`safe-git: refusing to run 'git remote add'`.

**Cause:** The sparse checkout plan created a persistent `origin` remote even though it only needed
one shallow fetch. Railway's sandbox policy permits the repository operation but rejects that
remote mutation.

**Correction:** Add a failing test that prohibits `remote add` and requires the allowlisted Gitea
URL directly in `git fetch`. The plan still supplies the token only through the environment header,
uses sparse checkout, detaches `FETCH_HEAD`, verifies `company.json`, and records the commit marker.
The checkout, provisioner, and routed-adapter suites pass 14 focused tests.

### Railway safe-git rejected persistent sparse-checkout config

**Observation:** Deployment `9fbb98a0-0b30-425b-a175-f842d0473f08` created sandbox
`0456f80e-8669-4dab-bfcb-74a70eeccae0`, accepted `git init`, and then rejected
`git config core.sparseCheckout true`. The provisioner again destroyed the incomplete sandbox
before worker launch.

**Correction:** Add a failing assertion prohibiting the persistent config command. Sparse behavior
is now enabled only for checkout with `git -c core.sparseCheckout=true checkout --detach
FETCH_HEAD`; the existing sparse pattern remains in `.git/info/sparse-checkout`. The same 14
checkout/provisioner/routing tests pass.

### Invocation-scoped sparse checkout succeeded in a disposable sandbox

**Observation:** A manual probe using the corrected command sequence created a fresh Railway
Sandbox, initialized `/workspace/repository`, fetched the allowlisted Gitea URL without adding a
remote, and checked out only `companies/cue-cloud` with
`git -c core.sparseCheckout=true checkout --detach FETCH_HEAD`.

**Result:** The sandbox resolved commit `5fe13ee20a729671a47dade812298dd3a3d5c51e`, contained
`company.json` and the expected `analysis/` files, and never persisted a repository remote or
credential. The probe sandbox was destroyed by its cleanup trap after inspection.

### Browser-to-Pi-to-sandbox canary completed

**Observation:** From the deployed browser UI, a fresh thread under the Gitea-backed Cue Cloud
project sent `In 2–3 sentences, what does Cue Cloud do? Cite the company files you used.` through
Pi with Claude Fable 5. Railway created sandbox
`bafae207-3f3c-4b1f-93f7-63fac1c6f650` in `us-east4-eqdc4a`.

**Result:** While the turn was running, read-only sandbox inspection proved the worker cwd was
`/workspace/repository/companies/cue-cloud`, the checkout was at commit
`5fe13ee20a729671a47dade812298dd3a3d5c51e`, and `company.json` plus the sparse analysis files were
present. Pi returned a cited answer in 51 seconds. The browser rendered the existing Synara
transcript rows; no distributed-only message type or Electron path was involved.

### Mounted-volume restart rehydrated the thread

**Observation:** Railway service-file download could not inspect `/data/userdata/state.sqlite`
because the CLI required a registered SSH key. Registering an account-level key would have been a
broader mutation than this canary needed.

**Correction:** Redeploy only the additive Synara service, reload the existing browser route, and
query Synara's authenticated RPC read model using a one-time startup pairing credential. After
deployment `4b7800ad-6720-4c8f-82f9-e16b02c816e5`, the same project, thread, user message, assistant
message, and event sequences 24 through 52 rehydrated from the `/data` volume. The persisted
project binding remained `glasswing-admin/glasswing-company-data`, ref `main`, path
`companies/cue-cloud`; settings still reported Pi `executionTarget: railway-sandbox`. The temporary
diagnostic bearer session was logged out after the read.

### Temporary Railway OAuth bearer expired across controller recovery

**Observation:** The successful sandbox remained `RUNNING` across the control-plane redeploy, but
a follow-up in the same thread failed when the new controller attempted `Sandbox.connect` and
Railway returned `Not Authorized`.

**Cause:** The trial service was still using a short-lived Railway CLI OAuth bearer because v3/dev
project-token creation was not authorized through the current OAuth identity. The adapter's durable
binding and reconnect path worked far enough to target the existing sandbox; the external control
plane correctly rejected its expired credential.

**Correction:** Force the Railway CLI to refresh, copy the refreshed opaque bearer into the
service variable without printing it, and redeploy the unchanged image so the new deployment
receives the current environment snapshot. This is deliberately a trial-only correction. The
production requirement remains a revocable, durable v3/dev project token or workload identity;
periodically copying a personal CLI bearer is not an acceptable operating model.

**Recovery result:** Deployment `7c8f4b76-0ea9-45bc-91c2-4e2211905958` activated the refreshed
credential. The failed turn had intentionally quarantined the thread, so a newly submitted message
was durably retained but its provider command was skipped until the existing **Unblock thread**
action was used. Recovery destroyed the old sandbox before reserving replacement sandbox
`9965af6b-dcd7-4676-8d72-9c9382dbf9b4` with lifecycle generation
`533a2e32-d161-4a72-a663-f42785ce5197`; Railway inventory showed only the replacement. The worker
connected, hydrated Cue Cloud, and Pi returned the pricing answer in the same browser thread.

The replacement checkout resolved newer Gitea `main` commit
`07a82d96df504f911e8081cec370b1a968350a73` rather than the original canary's
`5fe13ee20a729671a47dade812298dd3a3d5c51e`. This is expected for a binding to a moving ref and is
why each runtime binding also records the resolved commit. A future immutable-run mode should pin
the prior resolved commit explicitly when reproducibility matters more than refreshing company
data during recovery.

### Independent review hardening

**Observation:** An independent implementation review found several correctness boundaries that
the successful canary did not exercise: controller-restart cleanup consulted only an in-memory
remote map; worker events were checked against the outer transport fence but not the event's inner
provider/thread/generation; duplicate-root UI recovery did not compare repository bindings; and a
new workflow would have deployed the generic `synara` service on pushes to another repository's
main branch.

**Correction:** Focused tests first reproduced the behavioral gaps. Remote `stopSession` and
`stopAll` now recover distributed bindings from `provider_session_runtime`; the broker binds a
worker to the thread named by `session.start` and rejects mismatched Pi events before persistence,
sequence advancement, or acknowledgement; duplicate recovery requires an exact credential-free
binding match; and the unsafe automatic deployment workflow was removed. Deployment remains an
explicit, separately authorized v3/dev operation.

**Observation:** The browser catalog RPC could fail while the dialog silently exposed local-folder
creation, and the same Company UI plus Railway execution-target control was reachable from the
Electron surface even though this feature is browser-only. Per-file catalog HTTP failures were
also caught as if they were malformed JSON.

**Correction:** Browser project creation now stays in Company mode on catalog failure, shows the
actual error with a Retry action, and does not expose Folder as a fallback for that configured
failure path. Electron skips the catalog RPC, retains its Folder/GitHub sources, and hides the
Railway execution-target control. Catalog 404/malformed metadata uses the documented directory
fallback; network, auth, and 5xx failures fail visibly. Configuration now requires the exact
`companies` root that the binding schema can represent.

**Review correction:** The first browser-only gating change left `source=company` when a server
explicitly reported that the catalog was unconfigured, even though the picker correctly hid
Company and exposed Folder. A new browser regression test reproduced the invalid selection. The
resolved unavailable state now selects and focuses Folder; only an actual catalog error stays in
Company mode without the unsafe local fallback.

**Correction to an overclaim:** Inspection of `workerClientSession` proved there is no bounded
request-result replay cache. Earlier documentation claimed one existed. The flow document now
models the actual boundary: event replay is durable until acknowledgement, while a disconnect
after a mutating request takes effect but before its response is an uncertain delivery that needs
provider reconciliation or a new fenced attempt.

### Browser-test invocation used the wrong root

**Observation:** The first focused browser-test command supplied the web config from the monorepo
root. TanStack Router consequently searched for `src/routes` at the monorepo root and Vitest found
no browser tests.

**Correction:** Run the same test from `apps/web`, matching the config's root assumptions. All 7
Create Project browser tests passed, including the new visible-error/retry path.

### Local production-build tool availability

**Observation:** A fresh local web production build completed successfully with Node 24 in 1
minute 8 seconds. Running the server's build entrypoint directly with the same Node runtime reached
its `tsdown` step, then failed with `spawn bun ENOENT` because this desktop worktree's PATH has no
`bun` executable. This is an invocation-environment failure, not a compiler failure.

**Correction:** Do not add a source workaround or silently install a new global runtime. The
repository's Railway Docker build installs and invokes the pinned Bun toolchain and remains the
authoritative combined web/server/provider-worker artifact check for the deployment.

### Final independent review

The first independent review produced the hardening items above. A second review caught the
unconfigured-catalog selection bug; after the regression test and correction, its final narrow
review reported no remaining findings and a merge-ready verdict for this scope.

## Focused verification completed before deployment

- 59 contract tests passed.
- 102 persistence/projection tests passed.
- Migration lineage passed across 73 tags.
- 54 catalog, RPC, and project-creation tests passed.
- 7 browser dialog tests passed from the required `apps/web` Vitest cwd.
- 2 provider-reactor binding tests passed.
- 48 catalog, routing, checkout, provisioner, and workspace-runtime tests passed.
- 4 project-creation tests passed after correcting the Pi default model.

The repository intentionally did not run `bun fmt`, `bun lint`, or `bun typecheck`; the workspace
instructions prohibit those heavyweight checks unless the user explicitly requests them. The clean
Railway Docker build is the production-bundle compilation check for this deployment.

## Final branch verification after recovery

- All 5 changed contract test files passed: 70 tests.
- All 36 changed server test files passed after review hardening: 494 tests.
- All 10 changed web unit-test files passed: 145 tests.
- All 3 changed browser-test files passed: 9 tests, including 7 Create Project dialog tests.
- Migration lineage passed across all 73 released tags from v0.0.16 through v0.6.1.
- Railway deployment `7c8f4b76-0ea9-45bc-91c2-4e2211905958` completed a clean web/server Docker
  build and reached `SUCCESS` before the replacement-sandbox recovery canary.
- `git diff --check` passed for the final documentation changes.

## Reviewed runtime deployment

Reviewed runtime commit `11b270e6` was uploaded only to `v3` / `dev` / `synara-gitea-dev` as
deployment `0466d571-b598-4c4f-b6ef-0ad32265db59`. The pinned Docker toolchain installed 2,583
packages, built the web bundle, server, and provider-worker artifact, exported image digest
`sha256:f9cd8e09a21ecea1d7f86135e4abe22ef3472c458bb3a31e362843c2b087d8de`, and reached `SUCCESS`.

The first attempt to follow build output used `railway logs --build <id> --follow`; Railway CLI
5.15.0 rejected the unsupported `--follow` flag. Bounded `railway logs --build <id>` reads plus
deployment-status polling provided the same non-mutating monitoring without adding a workaround.

Startup mounted the existing `/data` volume, ran no pending migrations, and bootstrapped the
orchestration engine at durable sequence 85. The root and saved thread routes both returned HTTP
200. Reloading the authenticated browser restored Cue Cloud, the existing thread, all three user
messages, and both prior Pi answers. The deployed Add Project dialog listed all 33 Gitea company
directories with Company selected and no Folder source.

After the old controller shut down, `railway sandbox list --json` returned an empty inventory, so
the deployment handoff left no sandbox orphan. The outgoing deployment still had its live binding
in memory, so this inventory does not by itself prove the new persisted-binding fallback; the new
restart-then-stop tests cover that exact empty-map case. No post-deploy provider turn was added
merely to keep a sandbox alive. The earlier initial, replacement, and credential-recovery canaries
already validated provisioning and Pi responses, while focused tests cover the hardened cleanup
and event-fencing delta. The next turn will provision a fresh fenced sandbox generation from the
persisted Gitea binding.

## 2026-08-06 — Chrome browser acceptance canary with SuperTokens

### Native pairing was the wrong browser identity path

**Observation:** The first Chrome load remained on `Loading projects...` and repeatedly failed its
WebSocket connection. Following the native pairing path produced an expired one-time pairing page.

**Cause:** The deployed Synara service contained the completed SuperTokens integration, but none of
its four `SUPERTOKENS_*` runtime settings were present. `/api/auth/session` therefore advertised
only Synara's native bootstrap method. The application code was not missing; the deployment had
silently selected the local/admin fallback by configuration.

**Correction:** Reuse the existing private Railway `supertokens` Core and its API-key service
reference, while setting Synara's own public origin as both the SuperTokens API and website domain.
The next unauthenticated session response advertised `externalProvider: "supertokens"`, and Chrome
redirected to `/auth`. The native pairing implementation remains additive as an administrative and
local-mode fallback; it is no longer the normal browser entry path for this deployment.

### OTP delivery appeared missing because Outlook classified it as junk

**Observation:** Both passwordless code requests returned HTTP 200, but Outlook search initially
showed only older `Login to your account` messages and the Focused/Other inboxes had no new mail.

**Course correction:** The Junk count increased after resend. Opening Junk directly revealed both
current SuperTokens messages from `noreply@supertokens.io`; the newest code completed the Chrome
exchange. Chrome then loaded the saved Cue Cloud project and authenticated WebSocket transcript
without a pairing link. Search indexing lag was not the delivery failure.

### Expired Railway bearer failed before sandbox creation

**Observation:** The first fresh company question was durably appended to the thread, but
`session.start` failed with Railway GraphQL `Not Authorized`. No sandbox was created.

**Cause:** `SYNARA_RAILWAY_SANDBOX_AUTH_TYPE` was still `bearer`, backed by the trial-only copied
Railway CLI OAuth access token. It had expired while the controller continued running.

**Correction:** Force the authenticated Railway CLI to refresh, pipe the new opaque bearer into the
encrypted service variable without printing it, and redeploy the unchanged source. Railway rebuilt
the source-uploaded image again, confirming that this recovery remains operationally expensive.
The failed provider start quarantined the thread as designed: the next user message persisted but
was not dispatched until Chrome used the explicit **Unblock thread** action.

### End-to-end distributed browser result

Unblocking reserved fresh sandbox `02dd7d2a-4fc8-48c5-82d1-8168f57d91d0` in `us-east4-eqdc4a`.
Chrome visibly progressed through `Connecting`, `Working`, and `Thinking`; displayed live `find`,
`rg`, and file-read tool rows rooted at `/workspace/repository/companies/cue-cloud`; and streamed a
partial comparison before the response completed. The partial snapshot ended mid-heading while
`Stop generation` remained active, proving incremental rendering rather than a final-only update.
The terminal transcript showed `Worked for 1m 20s`, a source-linked pricing comparison, and an
analytical conclusion. A full page reload restored the completed answer and composer state from
durable orchestration history while the sandbox remained `RUNNING`.

**Residual boundary:** The canary meets the browser interaction criteria, but the copied personal
OAuth bearer is still not a production credential. Replace it with a durable, revocable project
token or workload identity before treating unattended sandbox provisioning as reliable.

## 2026-08-06 — Distributed Pi first-turn cold-start optimization

### Telemetry isolated infrastructure startup from Pi startup

Three cold starts spent 11.09s, 15.51s, and 16.19s between sandbox creation and worker connection.
Within that interval, the repeated 14,080,396-byte worker upload cost 3.85–4.01s, the private
session-config write cost about 1.9s, and company checkout cost 3.94–9.09s. Once connected, the Pi
worker accepted `session.start` in 120ms and the first `turn.send` about 237ms after connection.
Follow-ups were already fast because they reused the live fenced worker and went directly to
`turn.send`.

**Correction:** Add bounded `runtime.stage` events for sandbox creation, checkout, worker files,
worker process, worker connection, Pi session, and turn dispatch. The web work log collapses each
started/completed pair into one live row. Checkout and worker preparation now run concurrently,
and Gitea first attempts a blobless, no-tags shallow fetch before falling back to the compatible
shallow fetch.

### Railway templates could not contain the local worker artifact

**Attempt:** Use a Railway template as the immutable worker-ready filesystem base.

**Failure:** The SDK template builder accepts shell recipes and packages but has no local artifact
upload seam. Hosting the bundle elsewhere solely for template construction would introduce a new
artifact primitive and credential path.

**Correction:** Use a digest-named Railway filesystem checkpoint containing only the executable
worker artifact and its SHA-256 marker. Per-session credentials remain outside the checkpoint and
are written after sandbox creation. If the checkpoint is absent, creation falls back to a clean
sandbox and the original upload path, preserving compatibility.

### Create handles and local build tooling both required fallbacks

The Railway create handle had already rejected its first file operation in live trials. The client
now makes one fresh connection for the first file write and then reuses that settled handle for
subsequent writes; durable-process launch still uses a fresh connection because its control handle
has different failure behavior.

The normal build and test wrappers could not run because `bun` is absent from this machine. System
Node was also too old for the installed Vitest (`node:util.styleText`). Verification therefore used
the bundled Node 24 runtime to invoke Vitest, tsdown, and Vite directly. The first Vite build took
longer than the tool's initial yield and was polled to completion instead of being restarted.

### Checkpoint credentials failed once, then succeeded with refreshed OAuth

**Attempt:** Prepare the checkpoint from the encrypted deployed `SYNARA_RAILWAY_SANDBOX_TOKEN`.

**Failure:** Both checkpoint listing and clean sandbox creation returned Railway GraphQL
`Not Authorized`; the copied bearer had expired again. Continuing after the list failure proved
that checkpoint-management permission was not the only issue.

**Correction:** Use the Railway CLI's refreshed OAuth access token without printing it, create
checkpoint `synara-provider-worker-2157239894081454096f1f1e`, and update the encrypted dev service
bearer plus `SYNARA_RAILWAY_SANDBOX_WORKER_CHECKPOINT=auto`. The checkpoint contains 14,081,578
artifact bytes and no runtime credentials.

### Browser prewarm is additive and authenticated

Focusing the composer of an empty Pi thread now calls authenticated WebSocket RPC
`provider.prepareThread`. The server derives project checkout and runtime settings from durable
orchestration state, skips non-Pi/local/already-started threads, coalesces racing focus/send calls
with a per-thread lock, starts the normal provider session, and durably binds it to the thread.
No model prompt is sent during prewarm. The existing first-message path remains the fallback when
focus does not happen or preparation fails.

### Chrome exposed a local-draft gap before acceptance

**Attempt:** Reload the deployed bundle, create a new Cue Cloud thread, choose Pi, and rely on the
composer-focus prewarm.

**Failure:** A brand-new browser thread is intentionally only a client-side draft until its first
send, so the initial prewarm implementation skipped it because no durable thread existed for the
authenticated RPC to resolve. It would have accelerated an empty persisted thread but not the
normal new-thread flow this optimization targets.

**Correction:** On focus, and only for an empty Pi draft, promote the draft through Synara's
existing idempotent `thread.create` primitive first, preserve inherited project instructions and
all existing thread environment fields, then invoke the same `provider.prepareThread` RPC. The
first-send promotion remains idempotent if the user sends while preparation is still racing. This
adds no draft/runtime primitive and lets the server continue deriving the repository binding from
durable project state.

### Chrome exposed provider-selection focus timing

**Attempt:** After deploying draft promotion, select Pi from the provider menu and click the
already visible composer to trigger preparation.

**Failure:** The new-thread landing auto-focuses while the default provider is still Codex. The
provider menu keeps the Lexical editor logically focused, so choosing Pi and returning to the
composer does not reliably emit a second DOM focus event. The draft remained local and no provider
preparation telemetry appeared.

**Correction:** Keep focus preparation, and also invoke the same idempotent preparation callback
when the selected provider transitions to Pi. This covers both initial-Pi and user-switches-to-Pi
flows without adding a second preparation implementation; the per-thread guard and server-side
lock continue to coalesce focus, selection, and first-send races.

### Blobless fetch needed transient auth during materialization

**Attempt:** Send the first real Cue Cloud Pi prompt through the checkpoint-backed Railway
Sandbox worker.

**Failure:** The authenticated `--filter=blob:none` fetch completed and reserved a sandbox in
6.906 seconds, but sparse checkout triggered a lazy promisor-remote blob fetch without the
transient Gitea header. Git failed with `could not read Username` and the first turn never reached
Pi.

**Correction:** Pass the same environment-backed `http.extraHeader` to the sparse checkout
command. The credential remains absent from the repository URL and Git config, while the checkout
subprocess can authenticate any lazy blob requests. A focused regression test now requires the
header on both fetch and checkout.

### The default sandbox had no Node runtime

**Attempt:** Prewarm the corrected checkout from a worker-artifact checkpoint and wait for the
fenced worker connection.

**Failure:** Checkout and checkpoint-backed worker-file preparation completed, but the durable
process exited immediately with `/usr/bin/bash: exec: node: not found`. The Railway sandbox base
contains Git and the shell tools needed for checkout, but not Node. Because process detachment does
not report that immediate exit, the broker correctly waited its 30-second connection deadline.

**Correction:** Rebuild the existing digest-named checkpoint with pinned Node `24.13.1` at
`/opt/node/bin/node`, and launch the worker through that absolute path. The preparation command
selects x64 or arm64, verifies the official SHA-256 before extraction, and runs for both checkpoint
and clean-fallback sandboxes; a warm checkpoint returns immediately while a stale or missing base
self-repairs in about 5.6 seconds in the live trial. The rebuilt checkpoint was boot-verified with
`/opt/node/bin/node --version`. Provider-selection preparation is also limited to one automatic
attempt per thread so a failed prewarm cannot create a retry storm; focus or first send remains the
explicit retry path.

### Dev currently has one concurrent sandbox slot

**Attempt:** After a successful prewarmed first turn and warm follow-up, create another empty Cue
Cloud Pi thread while the first thread's fenced worker remains live.

**Failure:** The second thread remained at `Creating sandbox`; Railway listed only the first
running sandbox and did not return a second reservation or an immediate quota error. Releasing the
exact completed-test sandbox removed the occupied lease, but the already pending create did not
self-retry. This is a Railway environment capacity/lifecycle constraint, not Pi inference latency.

**Learning:** The current per-thread sandbox adapter is verified for one active worker, but this dev
environment cannot demonstrate two concurrent thread workers. The next scaling seam is explicit:
either raise the Railway sandbox concurrency allocation, release idle thread workers, or add a
bounded reusable worker pool while retaining the existing fenced session and durable-event
primitives. Until then, an occupied sandbox can make another thread's apparent cold start
unbounded, so this limitation must stay visible in telemetry and rollout notes.

## 2026-08-06 — Five-project concurrency, background UX, and ordered worker events

### Repeated `Creating sandbox` rows came from two independent behaviors

**Observation:** An empty Pi thread briefly stopped looking empty as soon as preparation emitted a
`runtime.stage` activity. The transcript work-log projection treated that infrastructure event as a
normal timeline row, so the centered landing switched to the sent-message layout before the user
had sent anything.

At the same time, the server's per-thread preparation mutex serialized callers but did not share
their result. When a preparation attempt failed, focus, provider selection, and first send could
each acquire the mutex in turn and run another complete sandbox attempt. This made one logical
preparation look like several `Creating sandbox` operations.

**Correction:** Keep durable `runtime.stage` events for diagnostics, but exclude them from the
user-message work log. They no longer make the empty landing nonempty. Replace the queuing mutex
with the existing keyed single-flight cache: simultaneous preparation callers for one thread now
observe one promise and one success or failure. Distinct thread keys remain concurrent. Focused
tests first reproduced a visible stage-only row and two failed starts, then passed with zero
timeline rows and one shared start.

### Railway did not have a one-sandbox capacity limit

**Attempt:** Create five clean sandboxes concurrently from the authenticated Railway CLI, then add
a sixth sequentially.

**Result:** Railway had six `RUNNING` sandboxes in about four seconds. Four concurrent CLI
processes returned success. One process failed locally with `No such file or directory` while
updating Railway's shared active-sandbox config, but remote reconciliation showed that its sandbox
had been created successfully. A sixth sequential create also succeeded. All six exact sandbox IDs
were destroyed afterward.

**Learning:** The earlier apparent one-slot limit was an expired-credential/pending-request symptom,
not a Railway allocation limit. Concurrent CLI processes can race on local bookkeeping even when
the remote operations succeed, so cleanup and accounting must reconcile `railway sandbox list`
rather than trusting individual CLI exit codes.

### The first browser run found the expired bearer before testing concurrency

**Attempt:** Deploy the hidden-stage and single-flight fixes, create three additional small public
GitHub projects beside the two Gitea company projects, and start a Pi thread.

**Failure:** The first real message failed with Railway GraphQL `Not Authorized`. The deployed
`SYNARA_RAILWAY_SANDBOX_AUTH_TYPE` was still `bearer`; its 43-character personal OAuth access token
had expired. This was the same unattended-runtime boundary identified by the earlier canary.

**Correction:** Refresh the Railway CLI OAuth session and pipe the new access token directly into
the encrypted service variable over stdin without printing it. Railway rebuilt the unchanged image
for this variable-only update. This is acceptable for an acceptance run but is not a production
credential strategy; a durable, revocable project token or workload identity remains required.

### Five first turns passed, but warm turns exposed event-frame reordering

With the refreshed bearer, five new Pi threads across five distinct projects produced five
simultaneous `RUNNING` sandboxes. Every empty landing contained zero `Creating sandbox` rows, and all
five first prompts returned their exact requested answers without provider failures.

The warm round then exposed a transport bug. Two workers were rejected with `Expected worker event
sequence 10, received 11`; one later repeated the problem as `Expected worker event sequence 12,
received 13`. Their WebSockets closed and affected follow-ups returned to `Connecting`. The
lossless outbox assigned sequences correctly, but concurrent Effect fibers called the socket writer
without serialization, allowing sequence 11 to complete before sequence 10.

**Correction:** Reuse an Effect semaphore inside the existing worker client session. Outbox push,
registration replay, and the corresponding socket write now share one ordered critical section;
responses use the same serialized writer. A regression socket deliberately delayed event 1. The
test failed with observed completion order `[2, 1]` before the fix and passed with `[1, 2]` after it.

### Corrected five-way result

Deployment `fd38ab83-5d7d-477c-b871-e8e6b2fc3c76` ran image
`sha256:45b7f762d034348aed3c845f561a2ea27d693b0effdc930ae7a524ac8b643417`.
The second browser run created five new threads in Cue Cloud, High Loop Algorithms,
`pressure-hello-world`, `pressure-spoon-knife`, and `pressure-git-consortium`. Railway reported these
five sandboxes simultaneously:

- `5d84375a-5da8-4125-b603-1cc23cb98ee2`
- `9282043b-a323-4e97-8b06-922c1c966a89`
- `9c262939-e1a6-4cde-892a-d86ee35e5713`
- `11967eb5-55b0-40ce-af6e-aade8571b0ce`
- `56e2f25e-883d-436e-b276-1436dadbdbd0`

All five workers connected before send. First-answer observation times were 4.737s, 4.087s,
5.350s, 4.087s, and 4.737s. Warm follow-ups were 4.238s, 4.501s, 4.238s, 3.616s, and 3.616s.
Both rounds had zero provider failures, zero visible `Creating sandbox` rows, and the warm round had
zero `Connecting` regressions. Post-fix Railway logs contained no worker event-sequence gaps and no
worker WebSocket closes. The five exact disposable sandboxes were destroyed after the test and
entered `DESTROYING`.

### Operational tool failures and course corrections

- The normal server build wrapper spawned `bun tsdown`, but Bun is absent locally. Direct tsdown
  invocation with the bundled Node 24 runtime built both the server and provider-worker artifacts.
- A zsh polling loop used `status`, which is read-only in zsh. Renaming it to `deploy_state`
  corrected the local poll; the Railway deployment was unaffected.
- `railway sandbox destroy --yes` is not supported by this CLI version. Re-running the exact-ID
  destroys without that flag succeeded noninteractively.
- A read-only SQLite telemetry query over `railway ssh` could not run because the local SSH agent
  has no key. Browser-visible state, remote sandbox inventory, focused tests, and filtered Railway
  logs supplied the acceptance evidence instead.
- Every source upload and encrypted-variable change triggered a full Docker build, including a
  variable-only credential refresh. This is deployment latency, not Pi latency, but it reinforces
  the need for durable credentials and separately managed worker artifacts.

## 2026-08-07 — Durable v3 identity and automatic dev deployment

### The delayed Pi startup failure was the personal bearer again

**Observation:** After the application had been idle, the browser reported that the Pi adapter
could not start the selected execution target. The deployed service still used
`SYNARA_RAILWAY_SANDBOX_AUTH_TYPE=bearer`. A guarded smoke using the exact encrypted service
variables failed on its first Sandbox inventory request. The locally authenticated Railway CLI
remained healthy, separating the deployed credential from the Railway environment itself.

**Conclusion:** The refreshed 43-character Railway CLI OAuth bearer had expired again. It was a
user-session credential copied from this computer, not service identity. Refreshing it a third time
would only reset the same outage clock.

### Replaced the bearer with one v3/dev project token

**Correction:** Create project token `synara-dev-runtime-ci-2026-08-07`, scoped by Railway to only
project `v3` environment `dev`. Install it as the encrypted
`SYNARA_RAILWAY_SANDBOX_TOKEN`, change the runtime auth type to `project-token`, and store the same
one-time value as GitHub repository secret `RAILWAY_TOKEN`. The temporary mode-`0600` transfer file
was deleted immediately after GitHub accepted the secret. No token value entered Git, logs, the
trial journal, or retained local storage.

Railway variable deployment `052bf80d-927b-478f-b84a-6e8de5a88871` became `SUCCESS`. An exact-token
SDK query then authenticated successfully against the v3/dev environment.

### First project-token smoke exposed an inventory semantic difference

**Attempt:** Run the existing create, command, reconnect, keepalive, destroy smoke with the new
service credential.

**Failure:** Every runtime operation succeeded, but the smoke timed out waiting for the destroyed
sandbox to disappear. The account-authenticated CLI showed no active sandbox. Querying the SDK with
the exact project token explained the mismatch: it retained 39 historical records, all in terminal
`DESTROYED` state.

**Correction:** Teardown verification now accepts either absence or the exact runtime reaching
`destroyed`; it still rejects `running`, `destroying`, `stopped`, and `failed`. A focused regression
retains a destroyed record indefinitely. The corrected live smoke created sandbox
`d1bed6f8-9136-4222-8a76-4dbde60a5f91`, ran both commands, reconnected, kept it alive, destroyed it,
and returned `teardownVerified: true`. Active CLI inventory was empty afterward.

### Dev deployment workflow is explicit and fail closed

The new `.github/workflows/deploy-railway-v3-dev.yml` runs only for pushes to
`codex/v3-gitea-projects` or an explicit manual dispatch. It pins Railway CLI 5.15.0 and targets the
exact v3 project, dev environment, and `synara-gitea-dev` service IDs. It consumes only the encrypted
project token, waits for the deployment bearing the exact GitHub SHA to reach `SUCCESS`, and fails
on a terminal error or timeout. A repository test rejects v4 IDs, production selectors, the generic
`synara` service, detached upload-only behavior, or branch drift.

### Push-triggered deployment and browser acceptance

Branch `codex/v3-gitea-projects` was pushed to `origin` at commit
`f29ad02af9aa2cb0eced9c01b3b587d49cad7a0f`. Push-triggered GitHub Actions run
`31150613718` accepted the v3 project secret, uploaded that exact commit, and completed successfully
in 5m08s. Railway deployment `f272999a-bf75-4147-a74c-a256b380efaf` recorded the exact SHA in its
CLI message, reached `SUCCESS`, and activated image
`sha256:a2db67f469e8c1c5f2b8fc1bd55c6e98ad6072b3695fc41d5f0b5acbe42429b5`. The public health endpoint
returned HTTP 200, while the previous deployment moved to `REMOVED` only after the replacement was
healthy.

The original failed browser thread preserved the nested cause and confirmed the diagnosis:
Railway GraphQL returned `Not Authorized` during `Sandbox.create`. A fresh Cue Cloud browser thread
`1718def7-5a08-49b3-8d52-5c7eec975f28` then sent `Reply with exactly: durable v3 token works` through
Pi and received exactly `durable v3 token works` after 11.4 seconds of total observation. It showed
no provider-start or authorization error. The exact canary sandbox
`faf37243-cb9f-4acb-a09e-69af948febde` was destroyed afterward and disappeared from active
inventory.

## 2026-08-07 — Controller-independent Gitea file previews

### The compatibility workspace path is identity, not controller storage

**Observation:** Clicking `technical_diligence.md` in an Nth thread asked the controller to read
`/data/gitea-company-projects/nth/technical_diligence.md`. That path identifies the canonical
project and remains useful to existing Synara contracts, but no checkout lives there. The actual
company checkout is sparse and disposable inside the Railway provider sandbox at
`/workspace/repository`. `WorkspaceFileSystem.realpath` therefore failed before Preview could
render.

**Correction:** Keep local filesystem reads first, then map the unchanged cwd through the canonical
Gitea company catalog and read from the existing project repository binding. Bare or partial
references retain Synara's unique-suffix behavior, so `technical_diligence.md` resolves to
`analysis/technical_diligence.md`. The same catalog adapter streams allowlisted image and PDF bytes
through the existing authenticated preview route. This adds no new Project, Thread, artifact,
sandbox, or browser protocol primitive, and it keeps provider sandboxes disposable.

### A repository-wide recursive tree worked in the fixture and failed in the real repository

**Attempt:** Cache `git/trees/main?recursive=true` for the full company-data repository, filter the
result to the bound company prefix, then perform exact or unique-suffix selection. The catalog,
text adapter, binary route, browser components, and production builds all passed locally. Railway
deployment `1ddcc686-d3c9-4cf9-bbe1-7a243a26f533` became healthy.

**Failure:** The original browser flow replaced the old `realpath` detail with a generic file-read
failure. A guarded live adapter run with the v3 service configuration exposed the actual boundary:
Gitea returned `truncated: true` for the large multi-company recursive tree. Rejecting that
incomplete index was correct, but requesting unrelated companies was not.

**Correction:** Traverse only the canonical bound company via the Gitea Contents API, with bounded
parallel directory reads, a 50,000-entry safety limit, per-company single-flight coalescing, and the
existing short catalog TTL. A revised red-green test rejects reliance on `/git/trees/`. The exact
adapter then resolved Nth's bare reference to `analysis/technical_diligence.md` with HTTP 200
against the live repository before redeployment.

### A failed Railway upload was retried without changing source

The first deployment attempt for corrected commit `c78699e1` failed in 28 seconds before Railway
associated any build, so there were no application build logs to diagnose and the prior healthy
deployment remained active. Retrying the exact GitHub Actions run without changing source produced
Railway deployment `6f7eff41-2fae-42f8-bf71-c1e18bea3957`, which reached `SUCCESS`; `/health`
reported every readiness flag true.

The original Nth browser thread then rendered the complete `Technical Diligence` markdown in
Preview mode. The final focused evidence was 39 passing server tests, 35 passing web RPC tests, six
passing rendered-preview tests, successful server/web production builds, a live authenticated
Gitea resolution, and the deployed original-flow screenshot.

## 2026-08-08 — Returned first-message delay and prewarmed landing control

### `auto` checkpoint selection still falls back when the exact digest was never prepared

**Observation:** An already-warm thread began answering in about 3.2 seconds, while a genuinely new
thread took about 16.2 seconds. Railway logs accounted for the gap: the provider worker was reserved,
then the controller uploaded the 14,081,891-byte worker artifact into a clean sandbox before the
process could start. Two fresh trials repeated the same reserve, upload, configure, and connect path.

**Failure:** `SYNARA_RAILWAY_SANDBOX_WORKER_CHECKPOINT=auto` correctly derived the current
digest-specific name, but only an older worker checkpoint existed. The runtime intentionally fell
back to a clean sandbox when Railway could not find the derived checkpoint. The deployment workflow
uploaded application source without preparing the matching worker checkpoint, so every worker
artifact change could silently reintroduce the cold upload.

**Correction:** The v3 deployment workflow now builds the exact provider-worker artifact and
prepares its digest-named Railway checkpoint before uploading the application commit. Preparation is
idempotent: it reuses an exact checkpoint rather than deleting and recreating it, so repeated deploys
do not introduce a checkpoint gap. A live idempotency check reused
`synara-provider-worker-2bdce285e61dc122e7a9b534` for the 14,081,891-byte artifact.

### Eager prewarming changed the landing-state representation

**Observation:** The dotted project name in `What should we do in …?` existed only for local draft
threads. Pi prewarming promotes the draft to an empty server thread so it can prepare the provider;
the heading consequently became plain text even though the user had not sent a message.

**Correction:** The project picker is now derived from user-visible landing state rather than draft
storage representation. A local empty draft still moves in place. An empty prewarmed server thread
opens a fresh draft in the selected project, preserving the additive prewarming optimization and the
original project-switch interaction without inventing a second thread primitive.

**Test harness note:** Focused pure regressions and the production Vite build completed locally. The
large `ChatView.browser.tsx` Vitest browser harness launched Chromium but did not begin the selected
tests within 90 seconds on two attempts, so it was terminated instead of being treated as evidence.
The deployed behavior is verified separately in real Chrome.

### The first workflow refresh used the wrong Bun filter seam

**Attempt:** Run each server package script from the repository root with
`bun --filter @synara/cli run …`.

**Failure:** GitHub Actions stopped before checkpoint preparation or deployment with
`No packages matched the filter`. The previous healthy Railway deployment remained active.

**Correction:** Build from `apps/server` directly and run the TypeScript preparation script with the
already-pinned Node runtime under Railway's injected service environment. This removes workspace
filter discovery from the deployment-critical path while preserving the same package scripts and
artifact.
