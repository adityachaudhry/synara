# Gitea-bound File Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render source, markdown, image, and PDF previews for catalog-bound Glasswing projects even though their checkout exists only in a disposable Railway Sandbox.

**Architecture:** Preserve the existing local filesystem path as the first choice. Add a canonical, authenticated Gitea file opener to the existing catalog service, then use it as a fallback from the text-read RPC and authenticated binary preview route when the controller has no local file.

**Tech Stack:** TypeScript, Effect services/streams, Gitea REST API, Vitest, React/Vite browser UI.

## Global Constraints

- Reuse Project repository bindings and the existing `projects.readFile` and `/api/local-image` surfaces; add no new browser protocol primitive.
- Never accept repository identity from the browser; map cwd only through canonical catalog descriptors.
- Preserve local project behavior and local-file priority.
- Preserve the 1,000,000-byte text cap, binary rejection, truncation result, preview extension allowlist, and authenticated route.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` because the repository instructions prohibit them unless explicitly requested in the current conversation.
- Use `bun run test`, never `bun test`.

---

### Task 1: Canonical Gitea workspace file opener

**Files:**
- Modify: `apps/server/src/giteaProjects/Services/GiteaCompanyCatalog.ts`
- Modify: `apps/server/src/giteaProjects/Layers/GiteaCompanyCatalog.ts`
- Test: `apps/server/src/giteaProjects/Layers/GiteaCompanyCatalog.test.ts`

**Interfaces:**
- Consumes: configured catalog descriptors and authenticated Gitea `git/trees/{ref}` plus `raw/{path}` endpoints.
- Produces: `openWorkspaceFile({ cwd, relativePath }): Effect<Option<GiteaWorkspaceFile>, GiteaCompanyCatalogError>`, where `GiteaWorkspaceFile` contains canonical `relativePath`, `fileName`, and a one-shot authenticated `Response`.

- [ ] **Step 1: Write a failing catalog test**

Add a real catalog test with an HTTP fake that exposes `companies/nth/analysis/technical_diligence.md`. Call `openWorkspaceFile` with cwd `/data/gitea-company-projects/nth` and bare reference `technical_diligence.md`; assert that the returned option is `Some`, the canonical relative path is `analysis/technical_diligence.md`, and the response body contains the literal fixture markdown. Also assert an unbound cwd returns `None`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm exec --yes bun@1.3.12 -- run --cwd apps/server test src/giteaProjects/Layers/GiteaCompanyCatalog.test.ts
```

Expected: FAIL because `openWorkspaceFile` does not exist.

- [ ] **Step 3: Implement the opener**

Add the service result/input types and method. In the live implementation:

1. call `list()` and match cwd to exactly one descriptor `workspaceRoot`;
2. validate and normalize the relative path with `isWorkspaceRelativePathSafe`;
3. cache/coalesce recursive blob paths for the repository/ref using the catalog TTL;
4. choose an exact bound-subdirectory blob first, otherwise a unique suffix match;
5. independently encode every raw URL path segment and fetch it with the configured token;
6. return `Option.none()` only for an unbound cwd and a bounded catalog error for unsafe, missing, ambiguous, or failed bound reads.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all Gitea catalog tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/giteaProjects/Services/GiteaCompanyCatalog.ts apps/server/src/giteaProjects/Layers/GiteaCompanyCatalog.ts apps/server/src/giteaProjects/Layers/GiteaCompanyCatalog.test.ts
git commit -m "feat(server): open bound Gitea workspace files"
```

### Task 2: Text preview fallback

**Files:**
- Create: `apps/server/src/workspace/readWorkspaceFile.ts`
- Create: `apps/server/src/workspace/readWorkspaceFile.test.ts`
- Modify: `apps/server/src/wsRpc.ts`

**Interfaces:**
- Consumes: `WorkspaceFileSystemShape.readFile`, `GiteaCompanyCatalogShape.openWorkspaceFile`, and `ProjectReadFileInput`.
- Produces: `readWorkspaceFileWithRepositoryFallback(input, dependencies)` with the existing `ProjectReadFileResult` contract.

- [ ] **Step 1: Write failing adapter tests**

Cover three observable cases: a successful local result is returned without opening Gitea; a local failure plus a bound Gitea response returns the canonical relative path and truncated literal contents; a local failure plus `Option.none()` fails with the exact original local error. Include a NUL-byte response case that rejects binary text preview.

- [ ] **Step 2: Run the test and verify RED**

```bash
npm exec --yes bun@1.3.12 -- run --cwd apps/server test src/workspace/readWorkspaceFile.test.ts
```

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement the bounded reader and RPC wiring**

Read at most `maxBytes + 1` bytes from the Gitea response stream, cancel the reader after the boundary, reject NUL-containing content, decode UTF-8, and set `truncated` when the extra byte or content length proves remaining data. Change only `projects.readFile` to call the adapter with the existing local service and catalog opener.

- [ ] **Step 4: Run focused adapter, workspace filesystem, and RPC contract tests**

```bash
npm exec --yes bun@1.3.12 -- run --cwd apps/server test src/workspace/readWorkspaceFile.test.ts src/workspace/Layers/WorkspaceFileSystem.test.ts
npm exec --yes bun@1.3.12 -- run --cwd apps/web test src/wsNativeApi.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/workspace/readWorkspaceFile.ts apps/server/src/workspace/readWorkspaceFile.test.ts apps/server/src/wsRpc.ts
git commit -m "fix(server): preview bound Gitea text files"
```

### Task 3: Repository-backed image and PDF route

**Files:**
- Modify: `apps/server/src/http.ts`
- Test: `apps/server/src/localImageRoute.test.ts`

**Interfaces:**
- Consumes: `GiteaCompanyCatalog.openWorkspaceFile`, `isSupportedLocalPreviewFilePath`, and the existing authenticated local-image request.
- Produces: the unchanged `/api/local-image` response contract, streaming remote bytes only after local resolution fails.

- [ ] **Step 1: Write a failing route regression**

Extend the real HTTP route harness with a Gitea catalog fake. Request a safe repository-bound `assets/diagram.png` whose local cwd is absent; assert HTTP 200, the literal PNG fixture bytes, inferred image content type, private cache header, and download filename. Add an unsupported extension assertion returning 404 without opening Gitea.

- [ ] **Step 2: Run the test and verify RED**

```bash
npm exec --yes bun@1.3.12 -- run --cwd apps/server test src/localImageRoute.test.ts
```

Expected: the repository-backed route case returns 404.

- [ ] **Step 3: Implement local-first remote streaming**

Keep `resolveAllowedLocalPreviewFile` first. If it returns null, require a safe relative image/PDF path and cwd, call `openWorkspaceFile`, and stream `response.body` through `Stream.fromReadableStream`. Infer MIME and filename from the canonical relative path, retain auth/CORS/nosniff/SVG/download headers, and return 404 for unbound or unsupported paths.

- [ ] **Step 4: Run the focused route test and verify GREEN**

Run the command from Step 2. Expected: all local image route tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http.ts apps/server/src/localImageRoute.test.ts
git commit -m "fix(server): stream bound Gitea binary previews"
```

### Task 4: Verification, deployment, and original-flow acceptance

**Files:**
- Modify only if an observed regression requires a focused correction.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a healthy v3/dev deployment and browser evidence for the original `Nth -> technical_diligence.md -> Preview` flow.

- [ ] **Step 1: Run relevant regression suites**

```bash
npm exec --yes bun@1.3.12 -- run --cwd apps/server test src/giteaProjects/Layers/GiteaCompanyCatalog.test.ts src/workspace/readWorkspaceFile.test.ts src/workspace/Layers/WorkspaceFileSystem.test.ts src/localImageRoute.test.ts
npm exec --yes bun@1.3.12 -- run --cwd apps/web test src/wsNativeApi.test.ts
npm exec --yes bun@1.3.12 -- run --cwd apps/web test:browser src/components/WorkspaceFilePreview.relocation.browser.tsx src/components/PdfResourceLifecycle.browser.tsx
```

- [ ] **Step 2: Run production builds**

```bash
npm exec --yes bun@1.3.12 -- run --cwd apps/web build
npm exec --yes bun@1.3.12 -- run --cwd apps/server build
```

- [ ] **Step 3: Review and publish exact scope**

Run `git diff --check`, verify the worktree contains only the planned changes, commit any final focused adjustment, and push `codex/v3-gitea-projects` without force.

- [ ] **Step 4: Follow exact v3 deployment**

Watch `.github/workflows/deploy-railway-v3-dev.yml`, record its run and Railway deployment IDs, and require `/health` HTTP 200 with all readiness flags true.

- [ ] **Step 5: Browser-verify the original failure**

The flow under test is: `https://synara-gitea-dev-dev.up.railway.app/<Nth thread>` -> click `technical_diligence.md` -> select Preview -> rendered markdown appears with no `workspaceFileSystem.realpath` error. Also open one repository-bound image or PDF when available, inspect relevant warn/error logs, capture screenshot evidence, and retain the verified app tab.
