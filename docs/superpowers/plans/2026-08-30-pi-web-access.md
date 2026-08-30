# Pi Web Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add always-on Perplexity web search to Pi, prove it locally, then deploy every accumulated Synara and Glasswing change to dev and prove it there.

**Architecture:** Synara bundles `pi-web-access` into the existing provider-worker artifact and injects its extension factory through the shared Pi session-services path. Perplexity is the only configured search provider. Glasswing's local launcher reads only the named secret from the primary checkout `.env`; Railway dev owns the deployed value and forwards it into each isolated provider worker.

**Tech Stack:** TypeScript, Pi SDK, `pi-web-access@0.27.0`, Bash/Python dotenv parsing, Railway Sandboxes, Glasswing Next.js shell.

**Spec:** `docs/superpowers/specs/2026-08-30-pi-web-access-design.md`

## Global Constraints

- Web access is unconditional for Pi and has no UX or feature flag.
- Credentials remain environment-only and must never be printed.
- Use real browser conversations as the primary verification; do not add unit tests.
- Deploy only to Railway `dev`; do not touch production.
- Preserve and ship the existing accumulated changes in both worktrees.

---

### Task 1: Record the failing local acceptance test

**Files:** None.

**Interfaces:**
- Consumes: the existing local Glasswing app at `http://localhost:13000/app/chipsage?view=agent`.
- Produces: browser evidence that `web_search` is not currently available.

- [ ] Open a fresh Pi/Sonnet thread and request an explicit web search.
- [ ] Confirm the response or event stream contains no successful `web_search` tool call.

### Task 2: Bundle and load the extension in every Pi session

**Files:**
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Modify: `apps/server/src/provider/Layers/PiAdapter.ts`
- Modify: `apps/server/src/providerWorker/distributedRuntimeConfig.ts`

**Interfaces:**
- Consumes: `pi-web-access` default extension factory and Pi's `resourceLoaderOptions.extensionFactories`.
- Produces: all Pi session-service creation paths with `web_search`, `source_check`, `fetch_content`, and `get_search_content`; worker forwarding for `PERPLEXITY_API_KEY`.

- [ ] Add the pinned package dependency.
- [ ] Add one shared lazy loader and one session-services wrapper that injects the extension factory.
- [ ] Route all four `createAgentSessionServices` call sites through that wrapper.
- [ ] Add the Perplexity secret name to the distributed worker's default forwarding allowlist.
- [ ] Build the provider-worker artifact and run its artifact smoke check.

### Task 3: Bridge local Glasswing credentials without exposing them

**Files:**
- Modify: `/private/tmp/glasswing-local-synara.crC093/scripts/dev-railway-local-synara.sh`

**Interfaces:**
- Consumes: `PERPLEXITY_API_KEY` from the primary Glasswing checkout `.env`.
- Produces: that variable in the local Synara process and its Railway worker forwarding list.

- [ ] Resolve the primary checkout from git's common directory when the active worktree has no `.env`.
- [ ] Parse and export only the named value without printing it.
- [ ] Append the name to `SYNARA_PROVIDER_WORKER_FORWARD_ENV_KEYS` without duplicates.
- [ ] Restart the local stack and confirm worker creation receives both variables by behavior, not by logging values.

### Task 4: Prove web access locally

**Files:** None.

**Interfaces:**
- Consumes: the rebuilt local stack and Pi/Sonnet 5.
- Produces: a successful Perplexity `web_search` event with a cited answer.

- [ ] Run one explicit Perplexity search in a fresh thread and inspect the rendered tool event and answer.
- [ ] Check page identity, meaningful DOM, framework overlays, console health, interaction state, and screenshot evidence.

### Task 5: Verify and deploy the accumulated dev changes

**Files:** All already modified files in both worktrees plus Tasks 2-3.

**Interfaces:**
- Consumes: locally verified Synara and Glasswing trees.
- Produces: pushed `glasswingos/dev` and `dev` commits, successful Railway dev deployments, and a deployed web-search proof.

- [ ] Review both complete diffs for secrets and unrelated edits.
- [ ] Run Synara's permitted final checks and Glasswing's production build/E2E checks.
- [ ] Commit and push Synara to `origin/glasswingos/dev`.
- [ ] Set `PERPLEXITY_API_KEY` on Railway dev `synara-gitea-dev`, and include its name in the worker forwarding list.
- [ ] Commit Glasswing's accumulated changes and push the commit to `origin/dev`.
- [ ] Wait for GitHub Actions and Railway dev deployments to succeed.
- [ ] Repeat the browser web-search acceptance test on `https://glasswing-web-dev.up.railway.app/app/chipsage?view=agent` and inspect console health.
