# Pi Durable runtime (GlasswingOS)

Status: live on `glasswingos/dev` since 7 October 2026. `glasswingos/main` (production) still runs the earlier in-sandbox provider worker until a promotion is decided. Design, measurements and open items: Glasswing repo `docs/superpowers/specs/2026-10-06-pi-durable-runtime-design.md` (§13). Diligence contract: Glasswing `docs/superpowers/specs/2026-10-07-durable-diligence-contract.md`.

## Shape

- **Agent loop in the controller.** Pi 1.0.4 conversations run under Pi Durable (`@earendil-works/pi-durable`) inside the controller process. State is one Harness SQLite file on the controller volume (`<home>/durable/harness.sqlite`), separate from `state.sqlite`.
- **Sandboxes are tool targets.** A Daytona sandbox (US preferred, EU fallback; Docker locally) holds the company checkout, LFS mount and tools. It runs no agent process and holds no credentials. File and shell tools go through the Daytona exec API as uid 10001 with an empty environment (`durable/sandboxEnv.ts`). Sandboxes are disposable: a lost or stopped one is replaced from the same company revision.
- **Sandbox policy.** Every create is `ephemeral` (deleted when stopped), has a TTL by purpose (chat 720 min, diligence 360, eval 120), an outbound `domainAllowList` of the Gitea and LFS S3 hosts only (`workspaceRuntime/sandboxNetwork.ts`), and labels `env`, `purpose`, `thread_id` or `run_id`, and `pack_id` when known. Dev and production share the Glasswing Ventures Daytona organization; the `env` label separates them, and the controller's inventory lists only its own environment. A warm-pool claim is read back and any missing setting is applied before use; a sandbox that cannot be brought to policy is deleted.
- **Context packs.** A company chat's first turn of a session (and any turn once the pack is 30 minutes old) asks Glasswing `POST /internal/context-packs` for the memory that applies (firm, requester, deal) and shows its prompt as a `<glasswing_context>` system section after the profile. Failures leave the turn without a pack (`durable.context-pack.unavailable`). The Glasswing profile applies to every thread whose project is a Glasswing company.
- **Files survive replacement.** The provisioner captures each thread's outbox (`/workspace/.synara/outbox/`) and checkout drafts to controller stores every minute, at turn end and before release, and restores them into a replacement sandbox. "Save to company" promotes selected files through Glasswing's Git writer.
- **Turns start before the sandbox.** Sandbox claims run in the background; a tool call waits for the claim.

## Diligence run threads

Plan files and outputs move in one bulk transfer each way (Daytona `uploadFiles`/`downloadFiles`). Plan files under `memory/` (the context pack) are root-owned, files `0444` and directories `0555`; the run root is root-owned and sticky (`1777`), so the agent writes `outbox/` and its own scratch files but cannot change, remove or swap `memory/`. `complete` reports `planSha256` (sha256 of the plan's canonical JSON: sorted keys, no whitespace, UTF-8) and `packId`.

Each accepted run gets a top-level thread `diligence-run-<runId>` in the company's project (created by the accept route through `ExternalProjectResolver` + `thread.create`). The run holds one long turn on that thread: an opening note, a `durable_workflow` task that the workflow card renders (phases, one row per step), and a closing summary. Each step's conversation is attached to the engine as a child (`subagent:<runThread>:step:<stepId>`): its events are published on the run thread with `providerRefs.providerThreadId = step:<stepId>`, so ingestion shows them in the nested child thread, and a `collab_agent_tool_call` item names it and links the card row. A message in a step thread reaches `steerSubagent` → `DiligenceRunner.steer` (steers a running step, or starts a follow-up on a finished one, reclaiming the run sandbox; released after 30 quiet minutes). Stop on the run thread cancels the run; stop on a step aborts that step. The run thread is also an ordinary company chat; its sandbox is claimed when someone writes in it. Costs are never shown.

## Modules (`apps/server/src/`)

| Module | Role |
| --- | --- |
| `durable/DurablePiEngine.ts` | Opens the Harness; extensions (`synara-tools`, `synara-chat-profile`, `synara-research`, `synara-gateway`); thread lifecycle; Pi event → Synara runtime event mapping; legacy session import; backups |
| `durable/sandboxEnv.ts` | Pi `ExecutionEnv` over the sandbox exec API |
| `durable/extensionTools.ts`, `durable/perplexityTools.ts` | Web access, Crunchbase (MCP client), Perplexity tools |
| `durable/backup.ts` | Harness backup (VACUUM INTO → gzip → Glasswing signed grant) and restore-if-missing |
| `durable/diligence.ts`, `durable/diligenceRoute.ts` | `DiligenceRunner`: runs a Glasswing diligence plan as durable conversations in one sandbox; `/internal/diligence/runs` (accept / cancel / status), private network + bearer token only |
| `provider/Layers/DurablePiAdapter.ts` | The Pi `ProviderAdapterShape`; sandbox binding, background claims, checkpoints, save-to-company reads |
| `providerWorker/Layers/SandboxProvisioner.ts` | Claim (checkout, LFS, agent user, restore), capture, release, adopt, legacy import |

## Operations

- **Backups:** through Glasswing `POST /internal/controller-backups/grants`, every key under `controller-backups/<env>/<kind>/` (`<env>` = `SYNARA_ENVIRONMENT`, else `RAILWAY_ENVIRONMENT_NAME`). `durable-harness`: 2 min after start, then every 10 min, and on shutdown. `state` (`state.sqlite`, SQLite online backup through its own exclusive connection): hourly. `attachments` and `drafts` (the Outbox/draft checkpoint store), tar.gz: hourly when changed. On open, a missing or corrupt Harness is restored from the newest `<env>` backup, else from the old `controller-backups/durable-harness/` key (the old file is kept as `.pre-restore`). Until Glasswing grants env-prefixed keys, only the Harness is uploaded (to its old key).
- **Restart:** running turns and diligence steps resume under the same request IDs; diligence sandboxes are adopted so startup intent recovery keeps them.
- **Env (controller):** `SYNARA_DAYTONA_*` (API, snapshot), `SYNARA_ARTIFACT_API_URL` + `GLASSWING_ARTIFACT_SERVICE_TOKEN` (Glasswing callbacks, grants, context packs, diligence auth), `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `GLASSWING_CRUNCHBASE_MCP_URL`/`_TOKEN`. Sandbox policy: the allow-list derives from `SYNARA_GITEA_ORIGIN`, `SYNARA_EXTERNAL_REPOSITORY_ALLOWED_ORIGINS` and `SYNARA_GITEA_LFS_S3_ENDPOINT`; `SYNARA_DAYTONA_EXTRA_ALLOWED_DOMAINS` adds hosts, `SYNARA_DAYTONA_DOMAIN_ALLOW_LIST` replaces the list (`off` disables it); `SYNARA_DAYTONA_TTL_MINUTES_{CHAT,DILIGENCE,EVAL}` override TTLs; `SYNARA_ENVIRONMENT` overrides the Railway environment name. Deleted on dev: `SYNARA_PI_DURABLE`, `SYNARA_PROVIDER_WORKER_CONTROL_URL`, `SYNARA_PROVIDER_WORKER_FORWARD_ENV_KEYS`, `SYNARA_RAILWAY_SANDBOX_TOKEN`, `SYNARA_DURABLE_RESTORE`.
- **Sandbox image:** tools only, built by `providerWorker/prepareDaytonaTemplate.ts` through `.github/actions/prepare-worker` (name kept for history).
- **Logs:** `[diligence] {json}` and `[sandbox] {json}` lines; Railway parses bare JSON lines into fields, so keep the prefix.
- **Load/readiness trial:** `bun scripts/qa/daytona-readiness.mjs --run-dev --count=25 --models=anthropic/claude-sonnet-5-5 --output=<dir>`.

## Known leftovers

`nodeHttpServer.ts` still sets up a WebSocket server for the removed `/internal/provider-worker` path, and some names still say "provider worker" (`providerWorker/`, `/workspace/.synara-provider-worker`). They are inert; remove them with care, since they sit in the transport and path layers.
