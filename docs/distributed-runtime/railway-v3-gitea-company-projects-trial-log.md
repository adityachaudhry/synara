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
