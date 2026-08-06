# v3 Gitea Company Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a browser-only Synara deployment in Railway v3/dev list company folders from the existing private Gitea repository, create ordinary projects and threads from a selected company, and answer company questions through the existing distributed Pi/Railway Sandbox runtime.

**Architecture:** Add a validated `gitea-subdirectory` binding to Synara's existing project aggregate. A server-side catalog adapter exposes safe company descriptors without exposing Gitea credentials. The existing provider command reactor carries the binding into `ProviderSessionStartInput`; the existing Railway worker provisioner sparse-checks out the configured repository into each disposable sandbox and starts Pi with the selected company directory as its cwd. SQLite and orchestration events remain durable controller truth; the Gitea checkout and Pi process remain disposable generation-scoped runtime state.

**Tech Stack:** TypeScript, Effect Schema/RPC/Layer, SQLite migrations/projections, React/Vite, Vitest, Railway v4 CLI and Sandbox API, Gitea HTTP API and Git smart HTTP.

## Global Constraints

- Work only in `/Users/adityachaudhry/repos/synara/.worktrees/distributed-runtime-railway` on `codex/v3-gitea-projects`.
- Preserve local and GitHub project flows. Company projects are an additive source and browser default only when the catalog is configured.
- Reuse `Project -> Thread -> Turn -> provider session -> sandbox generation`; do not create replacement project, thread, queue, or provider primitives.
- Never persist, return to the browser, or log Gitea credentials. Validate every project binding against configured origin/owner/repository/ref/root before using it.
- Company-bound Pi sessions must fail closed when distributed execution or checkout configuration is unavailable; never answer from an empty controller directory.
- Deploy a new v3/dev service and volume only. Do not mutate existing Glasswing services or production.
- Use focused tests while iterating. Per `AGENTS.md`, do not run `bun fmt`, `bun lint`, or `bun typecheck` unless the user explicitly requests them; never run `bun test`.

---

## Task 1: Define the Gitea project and catalog contracts

**Files:**

- Create: `packages/contracts/src/giteaProjects.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/provider.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ws.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Test: `packages/contracts/src/giteaProjects.test.ts`
- Test: `packages/contracts/src/orchestration.test.ts`
- Test: `packages/contracts/src/provider.test.ts`

1. Write failing schema tests for a valid company catalog descriptor and `GiteaSubdirectoryProjectBinding`, including rejection of absolute/traversal paths, credential-bearing origins, malformed owner/repository/ref values, and unknown binding kinds.
2. Add schemas for `GiteaSubdirectoryProjectBinding`, `ProjectRepositoryBinding`, `GiteaCompanyProjectDescriptor`, and `GiteaCompanyCatalogSnapshot`. Keep bindings non-secret and make the canonical path `companies/<slug>`.
3. Write failing compatibility tests showing historical project events/snapshots/start inputs decode without a binding, while a bound `project.create` round-trips unchanged.
4. Add optional `repositoryBinding` to `ProjectCreateCommand`, `ProjectCreatedPayload`, `OrchestrationProject`, `OrchestrationProjectShell`, and `ProviderSessionStartInput`. Keep the binding immutable by omitting it from `project.meta.update`.
5. Add a unary `projects.listGiteaCompanies` RPC and `NativeApi.projects.listGiteaCompanies()` method returning the catalog snapshot.
6. Run `bun run test packages/contracts/src/giteaProjects.test.ts packages/contracts/src/orchestration.test.ts packages/contracts/src/provider.test.ts` and commit `feat(contracts): add Gitea company project binding`.

## Task 2: Persist and project the immutable repository binding

**Files:**

- Create: `apps/server/src/persistence/Migrations/089_ProjectionProjectsRepositoryBinding.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/persistence/Services/ProjectionProjects.ts`
- Modify: `apps/server/src/persistence/Layers/ProjectionProjects.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- Test: `apps/server/src/persistence/Migrations.test.ts`
- Test: `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`
- Test: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`

1. Write a failing migration test proving migration 89 idempotently adds nullable `repository_binding_json` and preserves existing project rows.
2. Add migration 89 and register it once with the canonical name `ProjectionProjectsRepositoryBinding`.
3. Write failing projector and snapshot tests proving a `project.created` binding is stored, replayed, and returned in both full and shell snapshots, while old rows return `null`.
4. Extend `ProjectionProject`, SQL insert/upsert/select statements, row decoding, and shell/full mappers with nullable JSON-decoded `ProjectRepositoryBinding`.
5. Update the project-created projection only; metadata updates retain the original binding.
6. Run the three focused test files and commit `feat(server): persist project repository bindings`.

## Task 3: Add the validated server-side Gitea company catalog

**Files:**

- Create: `apps/server/src/giteaProjects/config.ts`
- Create: `apps/server/src/giteaProjects/Errors.ts`
- Create: `apps/server/src/giteaProjects/Services/GiteaCompanyCatalog.ts`
- Create: `apps/server/src/giteaProjects/Layers/GiteaCompanyCatalog.ts`
- Modify: `apps/server/src/serverLayers.ts`
- Modify: `apps/server/src/wsRpc.ts`
- Test: `apps/server/src/giteaProjects/config.test.ts`
- Test: `apps/server/src/giteaProjects/Layers/GiteaCompanyCatalog.test.ts`
- Test: `apps/server/src/wsRpc.test.ts`

1. Write failing config tests for disabled-by-default behavior, complete environment parsing, HTTPS-only origin, credential-free URL, safe owner/repository/ref/root identifiers, and incomplete-config startup failure.
2. Implement `resolveGiteaCompanyCatalogConfig` using `SYNARA_GITEA_ORIGIN`, `SYNARA_GITEA_OWNER`, `SYNARA_GITEA_REPOSITORY`, `SYNARA_GITEA_REF`, `SYNARA_GITEA_COMPANIES_ROOT`, `SYNARA_GITEA_READ_USER`, `SYNARA_GITEA_READ_TOKEN`, and `SYNARA_GITEA_PROJECT_ROOT`.
3. Write fake-fetch tests for listing `companies/`, reading each `company.json` with bounded concurrency, sorting by company name, skipping malformed/non-directory entries with diagnostics, short-lived cache reuse, refresh after TTL, and redacted errors.
4. Implement a catalog service with `list()` and `validateBinding()`. Return `available: false` when disabled. Construct every returned binding server-side from the configured repository; never trust a browser origin/repository/path.
5. Wire the catalog layer into the application and implement `projects.listGiteaCompanies` in `wsRpc.ts`.
6. Before dispatching a bound `project.create`, validate it via `validateBinding()`, replace the submitted binding with the canonical configured binding, create the controller compatibility directory under `/data/gitea-company-projects/<slug>`, and reject all invalid/unconfigured bindings.
7. Run focused config/catalog/RPC tests and commit `feat(server): expose validated Gitea company catalog`.

## Task 4: Expose company selection in the browser project dialog

**Files:**

- Modify: `apps/web/src/wsNativeApi.ts`
- Modify: `apps/web/src/components/ProjectSourceSegmentedPicker.tsx`
- Modify: `apps/web/src/components/CreateProjectDialog.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/Sidebar.logic.ts`
- Test: `apps/web/src/wsNativeApi.test.ts`
- Test: `apps/web/src/components/CreateProjectDialog.browser.test.tsx`
- Test: `apps/web/src/components/Sidebar.logic.test.ts`

1. Write a failing WebSocket adapter test proving the catalog RPC is available through `NativeApi.projects`.
2. Write browser dialog tests proving a configured catalog defaults to Company, renders searchable company name/slug choices, never asks for a local path, reports unavailable/empty/error states, and submits the selected canonical binding plus destination Space.
3. Extend the segmented source picker with `company`, showing only sources available on the current surface. Preserve Folder/GitHub in Electron and legacy browser deployments.
4. Load the catalog when the dialog opens. Add a compact searchable company selector that reuses existing dialog controls and no bespoke disclosure animation.
5. Extend `CreateProjectSubmitValue` with a company variant containing the descriptor/binding and deterministic controller workspace root returned by the server catalog.
6. Extend `createOrRecoverProjectFromPath` to accept optional title, default model selection, and repository binding. Preserve duplicate-root recovery and existing defaults.
7. In `Sidebar.handleCreateProjectSubmit`, create/recover a normal project with company name, Pi default model selection, binding, and selected Space; then reuse the existing project-open/draft-thread/first-send flow.
8. Run focused web tests and commit `feat(web): create projects from Gitea companies`.

## Task 5: Carry project bindings into provider startup

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- Test: `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`

1. Write a failing reactor test proving a company project start passes its repository binding to `ProviderService.startSession`, while an ordinary project omits it.
2. Reuse `resolveThreadWorkspaceProject()` and add `repositoryBinding` to the provider session options without altering turn/event semantics.
3. Run the focused reactor test and commit `feat(orchestration): route project binding to providers`.

## Task 6: Sparse-check out the company into each Railway sandbox generation

**Files:**

- Create: `apps/server/src/providerWorker/giteaCheckout.ts`
- Modify: `apps/server/src/providerWorker/distributedRuntimeConfig.ts`
- Modify: `apps/server/src/providerWorker/Services/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/providerWorker/runtimeBinding.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.ts`
- Test: `apps/server/src/providerWorker/giteaCheckout.test.ts`
- Test: `apps/server/src/providerWorker/distributedRuntimeConfig.test.ts`
- Test: `apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner.test.ts`
- Test: `apps/server/src/provider/Layers/RoutedPiAdapter.test.ts`

1. Write command-builder tests proving the checkout uses a credential-free repository URL in command text/loggable state, receives credentials only through sandbox environment, shell-quotes all configured identifiers, performs depth-one sparse checkout of exactly `companies/<slug>`, and emits a parseable resolved commit SHA.
2. Add Gitea read credentials to the distributed worker environment only when catalog config is complete. Keep them out of runtime bindings, worker config JSON, logs, provider inputs sent over broker, and browser contracts.
3. Extend provision input with optional repository binding. Before uploading/starting the worker, initialize `/workspace/repository`, sparse-fetch the configured ref, checkout `FETCH_HEAD`, verify the company directory and `company.json`, and capture `git rev-parse HEAD`.
4. Extend the non-secret runtime binding with optional checkout metadata `{ origin, owner, repository, ref, path, resolvedCommit, cwd }` and start Pi at `/workspace/repository/companies/<slug>`.
5. Ensure replacement generations destroy the old sandbox first, then repeat checkout in the new sandbox. Do not reuse sandbox files as durable truth.
6. In `RoutedPiAdapter`, pass the binding to provision/restart, replace `session.start.cwd` with the provisioned sandbox cwd, and fail closed if a company-bound project targets local Pi or lacks distributed checkout configuration.
7. Run the four focused test files and commit `feat(runtime): hydrate Gitea companies in Railway sandboxes`.

## Task 7: Make sandbox networking configurable without changing defaults

**Files:**

- Modify: `apps/server/src/workspaceRuntime/railwaySandboxConfig.ts`
- Modify: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.ts`
- Test: `apps/server/src/workspaceRuntime/railwaySandboxConfig.test.ts`
- Test: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.test.ts`

1. Write failing tests for `SYNARA_RAILWAY_SANDBOX_NETWORK_ISOLATION=PRIVATE|ISOLATED`, rejection of other values, and current `PRIVATE` default.
2. Thread the parsed setting into `client.create({ networkIsolation })`.
3. Run focused workspace-runtime tests and commit `feat(runtime): configure sandbox network isolation`.

## Task 8: Build and deploy an additive browser-only Synara service to v3/dev

**Files:**

- Create: `deploy/railway/v3-gitea-dev.md`
- Modify: deployment files only if the existing server image/start command requires an additive Railway definition.

1. Run repository-provided focused build/package tests required to produce the web/server/provider-worker artifacts. Record every failure, cause, and correction in `deploy/railway/v3-gitea-dev.md` as it happens.
2. Create a new Railway service named `synara-gitea-dev` in project `v3`, environment `dev`, with one replica, its own persistent volume mounted at `/data`, and a public HTTPS domain. Do not modify existing services.
3. Configure browser-only server startup, Pi as the default enabled provider, distributed execution target, v3/dev Railway Sandbox environment, public WSS worker control URL, isolated sandbox networking, the existing Gitea read configuration, and the existing Anthropic credential needed by Pi. Generate new Synara-internal secrets rather than borrowing unrelated service secrets.
4. Deploy from `codex/v3-gitea-projects`; wait for the deployment and health endpoint to become healthy. Inspect logs for migration 89, catalog startup, broker readiness, and absence of secret values.
5. Record the exact service/domain/volume/deployment identifiers and sanitized environment names in the deployment document. Commit `docs: record v3 Gitea deployment learnings`.

## Task 9: Verify the complete browser and distributed-runtime flow

**Files:**

- Modify: `deploy/railway/v3-gitea-dev.md`
- Modify: `docs/distributed-pi-runtime.md`
- Create: `docs/gitea-company-project-flow.md`

1. Open the new public domain in a real browser with a clean browser profile. Confirm the company catalog contains the current Gitea folders and local-folder selection is not required.
2. Select `Cue Cloud`, create its project, create/promote a thread through first send, and ask a question whose answer is directly verifiable from `companies/cue-cloud/company.json` or a small analysis file.
3. Verify the streamed answer is grounded in that company content and appears after reconnect/reload from the durable projection.
4. Inspect controller SQLite and sanitized diagnostics to correlate and document every durable object: project command/event/projection with repository binding, draft-to-thread promotion, user message, turn, provider delivery/runtime events, provider session directory binding, sandbox lease/runtime binding, worker fence/generation, checkout commit/cwd, Pi session/items, assistant deltas/completion, and final projection.
5. Verify via Railway Sandbox inventory/logs that the worker used a fresh disposable sandbox, the exact company cwd, isolated networking, a fenced generation, and no credential leakage. Stop/restart the session once and prove the old sandbox is destroyed before the replacement generation is acknowledged.
6. Add a Mermaid end-to-end sequence and storage ownership table to `docs/gitea-company-project-flow.md`; update the distributed runtime doc with Gitea hydration and failure behavior.
7. Run the focused tests for all changed modules plus build/smoke tests proportionate to deployment risk. Do not claim full `fmt`/`lint`/`typecheck` because those checks were not authorized.
8. Commit `docs: explain Gitea company distributed flow`, leave the branch unpushed unless separately authorized, and report the live v3/dev URL, verified company/question/answer evidence, object/storage map, tests run, trial-and-error log, and remaining risks.
