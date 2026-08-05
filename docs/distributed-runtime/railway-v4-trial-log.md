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

