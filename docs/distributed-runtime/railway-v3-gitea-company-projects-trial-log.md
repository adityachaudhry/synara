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

Each valid directory must have a safe slug and a readable `company.json`. Invalid directories are
returned as diagnostics, not silently converted into projects. Project creation revalidates the
descriptor server-side and canonicalizes title, compatibility workspace root, repository origin,
owner, repository, ref, and path before dispatching Synara's existing `project.create` command.

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

## Focused verification completed before deployment

- 59 contract tests passed.
- 102 persistence/projection tests passed.
- Migration lineage passed across 73 tags.
- 54 catalog, RPC, and project-creation tests passed.
- 5 browser dialog tests passed from the required `apps/web` Vitest cwd.
- 2 provider-reactor binding tests passed.
- 48 catalog, routing, checkout, provisioner, and workspace-runtime tests passed.
- 4 project-creation tests passed after correcting the Pi default model.

The repository intentionally did not run `bun fmt`, `bun lint`, or `bun typecheck`; the workspace
instructions prohibit those heavyweight checks unless the user explicitly requests them. The clean
Railway Docker build is the production-bundle compilation check for this deployment.
