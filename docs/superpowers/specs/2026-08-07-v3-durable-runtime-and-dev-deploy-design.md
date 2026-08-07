# v3 durable runtime credential and automatic dev deployment

## Goal

Make Railway project `v3`, environment `dev`, the only live distributed Synara target. Replace
the expiring personal OAuth bearer used by `synara-gitea-dev` with a durable project token and
automatically deploy this branch to that exact service from GitHub Actions.

## Root cause

The deployed service used `SYNARA_RAILWAY_SANDBOX_AUTH_TYPE=bearer` with a personal Railway CLI
OAuth access token. The exact deployed configuration can no longer list sandboxes, reproducing the
same failure that previously recovered immediately after refreshing the laptop CLI login. The
credential is therefore an expiring user session, not durable service identity.

## Options considered

1. **v3/dev project token (selected).** Railway scopes it to one project environment, supports it
   as `RAILWAY_TOKEN` in CI, and the Sandbox SDK already supports `authType=project-token`.
2. **Workspace or account token.** It would be durable but grants unnecessary access outside
   v3/dev.
3. **Keep refreshing the OAuth bearer.** This remains tied to an interactive computer session and
   recreates the reported outage.

## Runtime credential design

One newly issued v3/dev project token is stored only in encrypted secret stores:

- Railway service variable `SYNARA_RAILWAY_SANDBOX_TOKEN` for Sandbox SDK requests.
- GitHub Actions repository secret `RAILWAY_TOKEN` for source deployments.

The running service sets `SYNARA_RAILWAY_SANDBOX_AUTH_TYPE=project-token`. No token is committed,
logged, placed in workflow YAML, or retained in a local file. Rotation means issuing a replacement,
updating both secret stores, verifying runtime and deployment paths, then revoking the old token.

## Automatic deployment design

`.github/workflows/deploy-railway-v3-dev.yml` runs on pushes to
`codex/v3-gitea-projects` and by manual dispatch. It:

- checks out the exact pushed commit;
- installs pinned Node and Railway CLI versions;
- requires the encrypted `RAILWAY_TOKEN` secret;
- runs `railway up` with the explicit v3 project ID, dev environment ID, and
  `synara-gitea-dev` service ID;
- waits for Railway's build/deployment result rather than treating upload acceptance as success;
- uses one v3/dev concurrency group so a newer push supersedes an older queued deployment.

The workflow contains no v4 project, production environment, generic `synara` service, or source
connection to another repository. A repository test locks those invariants.

## Failure behavior and verification

Missing or rejected project tokens fail the workflow before a successful deployment claim.
Railway build or health failures make the job fail. Completion requires:

1. the exact service credential passes a bounded Sandbox create/use/destroy smoke;
2. the branch is present on `origin`;
3. the push-triggered GitHub Actions job succeeds;
4. Railway reports the deployed commit healthy on `synara-gitea-dev`;
5. a fresh browser Pi thread completes a cold first turn and its disposable sandbox is cleaned up.

