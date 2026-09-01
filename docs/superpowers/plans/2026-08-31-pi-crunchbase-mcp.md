# Pi Crunchbase MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Glasswing's existing Crunchbase integration as an authenticated MCP server and load it by default in hosted Pi sessions.

**Architecture:** Glasswing retains the Crunchbase client and API key behind a narrow Streamable HTTP MCP endpoint. Synara loads `pi-mcp-adapter@2.31.0` with a host-supplied URL and bearer token, preserving the existing direct tool names without copying any Crunchbase logic into Synara.

**Tech Stack:** Python 3.12, FastAPI/Starlette, MCP Python SDK v2, TypeScript, Pi `0.84.4`, `pi-mcp-adapter@2.31.0`, Railway provider workers, Cloudflare quick tunnels.

**Spec:** `docs/superpowers/specs/2026-08-31-pi-crunchbase-mcp-design.md`

## Global Constraints

- Use the current local checkouts; do not create a worktree.
- Ignore unrelated changes made by the other local agent.
- Do not add unit tests. Validate through the real local Workspace and live Crunchbase data.
- Keep `CRUNCHBASE_API_KEY` inside Glasswing; never forward or log it from Synara/provider workers.
- Enable only the three existing Crunchbase tools.
- Commit and push only to Synara `glasswingos/dev` and Glasswing `dev`; deployment runs through GitHub Actions.

---

### Task 1: Expose Glasswing's existing Crunchbase behavior over MCP

**Files:**
- Modify: `/Users/adityachaudhry/repos/glasswing-ai-2/packages/integrations/crunchbase.py`
- Modify: `/Users/adityachaudhry/repos/glasswing-ai-2/packages/api/chat.py`
- Create: `/Users/adityachaudhry/repos/glasswing-ai-2/packages/api/crunchbase_mcp.py`
- Modify: `/Users/adityachaudhry/repos/glasswing-ai-2/packages/api/app.py`
- Modify: `/Users/adityachaudhry/repos/glasswing-ai-2/pyproject.toml`
- Modify: `/Users/adityachaudhry/repos/glasswing-ai-2/uv.lock`

**Interfaces:**
- Consumes: `CRUNCHBASE_API_KEY` and the existing Crunchbase normalization/rendering functions.
- Produces: authenticated Streamable HTTP MCP endpoint `/mcp/crunchbase/` with the three existing tool names.

- [ ] Move the three Python execution functions from chat-private wrappers into the Crunchbase integration module and keep chat calling those functions.
- [ ] Add a small MCP server module whose handlers offload the synchronous Crunchbase requests from the event loop.
- [ ] Wrap the MCP ASGI application with constant-time bearer authentication and mount it under the existing FastAPI app.
- [ ] Add the official MCP Python SDK dependency and refresh the lockfile.
- [ ] Start the API locally and prove `initialize`, `tools/list`, and one live `tools/call` over HTTP.

### Task 2: Load the MCP adapter in Pi with a contained host configuration

**Files:**
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Create: `apps/server/src/provider/piMcpExtension.ts`
- Modify: `apps/server/src/provider/Layers/PiAdapter.ts`
- Modify: `apps/server/src/providerWorker/distributedRuntimeConfig.ts`

**Interfaces:**
- Consumes: `GLASSWING_CRUNCHBASE_MCP_URL` and `GLASSWING_CRUNCHBASE_MCP_TOKEN`.
- Produces: one Pi extension factory exposing `crunchbase_search`, `crunchbase_company_profile`, and `crunchbase_founder_profile` as direct tools.

- [ ] Upgrade the three Pi packages together to `0.84.4`, then add exact compatible dependencies `pi-mcp-adapter@2.31.0` and `typebox@1.3.3`.
- [ ] Create one lazy-loaded extension factory with an isolated in-memory MCP config, exact tool allowlist, no scripting tool, and no config-file discovery.
- [ ] Add that factory beside `pi-web-access` in the shared Pi session-services path.
- [ ] Forward the two non-secretly-named host variables into distributed provider workers.
- [ ] Build the provider-worker artifact and confirm the adapter is bundled.

### Task 3: Wire the real local hosted path

**Files:**
- Modify: `/Users/adityachaudhry/repos/glasswing-ai-2/scripts/dev-railway-local-synara.sh`

**Interfaces:**
- Consumes: the Glasswing `.env` Crunchbase API key and the local Glasswing API port.
- Produces: an ephemeral public MCP URL plus bearer token forwarded to the remote provider worker.

- [ ] Read and export `CRUNCHBASE_API_KEY` without printing it.
- [ ] Start a second Cloudflare quick tunnel for the local Glasswing API and clean it up with the existing stack.
- [ ] Export the MCP URL/token and add only those names to the worker forwarding list.
- [ ] Restart the affected local stack once after dependency and server changes.

### Task 4: Validate through the real Workspace

**Files:** None.

**Interfaces:**
- Consumes: `http://localhost:13000/app/chipsage?view=agent` and a fresh hosted Pi thread.
- Produces: visible evidence of a real Crunchbase MCP call and live returned data.

- [ ] Send a prompt that explicitly requires `crunchbase_search` for Anthropic.
- [ ] Inspect the rendered tool event, response content, browser console, and network/runtime errors.
- [ ] If the agent does not use the tool, diagnose the live catalog/session behavior rather than adding tests or mocks.
- [ ] Review both repository diffs and confirm no credentials, unrelated files, or other MCP servers were included.

### Task 5: Keep hosted worker launch reliable with the larger adapter bundle

**Files:**
- Modify: `apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- Modify: `apps/web/src/workLog.ts`

**Interfaces:**
- Consumes: the self-contained provider-worker artifact and Railway workspace file transport.
- Produces: a compressed upload, operation-owned launch failure boundaries, and stack-free transcript errors.

- [ ] Gzip the provider-worker artifact once, upload the smaller archive, and expand it with Node before process start.
- [ ] Remove the single 60-second deadline that incorrectly spans checkout, upload, process start, and worker connection.
- [ ] Preserve full diagnostic causes in server logs while projecting only concise error details into the transcript.
- [ ] Scrub stack frames when rendering historical provider-start failures written by older builds.
- [ ] Prove two fresh hosted workers upload, start, connect, and complete real Pi turns without the removed timeout.
