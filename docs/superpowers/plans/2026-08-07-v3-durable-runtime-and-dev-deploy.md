# v3 durable runtime and dev deployment implementation plan

**Goal:** Replace the expiring v3 Sandbox bearer and deploy the distributed Synara branch to
v3/dev automatically from GitHub Actions.

**Architecture:** Reuse Synara's existing `project-token` Sandbox SDK path. Store the same
environment-scoped Railway project token in Railway and GitHub secret stores. Add a v3-only source
deployment workflow protected by a repository regression test.

---

### Task 1: Prove and replace the failing runtime credential

1. Run the guarded Sandbox smoke with the exact deployed variables and record the failing list.
2. Create a v3/dev project token in Railway settings.
3. Change the service auth type to `project-token` and replace the encrypted token value.
4. Store the same value as GitHub repository secret `RAILWAY_TOKEN`.
5. Remove all temporary credential material.
6. After the Railway redeploy succeeds, rerun the guarded Sandbox smoke and verify teardown.

### Task 2: Add the v3-only workflow regression first

**Create:** `scripts/railway-dev-deploy-workflow.test.ts`

1. Assert that `.github/workflows/deploy-railway-v3-dev.yml` exists.
2. Assert the branch, v3 project ID, dev environment ID, and exact service ID.
3. Assert the workflow consumes `secrets.RAILWAY_TOKEN`, pins Railway CLI 5.15.0, and waits for
   deployment completion.
4. Assert v4 identifiers, `production`, and generic service selectors are absent.
5. Run the focused test and observe it fail because the workflow does not exist.

### Task 3: Implement automatic v3/dev deployment

**Create:** `.github/workflows/deploy-railway-v3-dev.yml`

1. Trigger on `codex/v3-gitea-projects` pushes and manual dispatch.
2. Use read-only repository permissions and a v3/dev concurrency group.
3. Install repository Node and Railway CLI 5.15.0.
4. Validate that `RAILWAY_TOKEN` is set without printing it.
5. Deploy with explicit project, environment, and service IDs using `railway up --ci`.
6. Attach the GitHub SHA to the deployment message.
7. Run the focused workflow regression and confirm it passes.

### Task 4: Publish and verify the automatic deployment

1. Append the credential and CI trials to the v3 trial log without secrets.
2. Run focused tests, `git diff --check`, and the final required format/lint/typecheck pass.
3. Commit intentional changes and push `codex/v3-gitea-projects` to `origin`.
4. Watch the push-triggered Actions run through completion.
5. Verify Railway's active deployment and public health endpoint.
6. Send a fresh browser Pi message, verify the answer, and destroy the exact disposable sandbox.

