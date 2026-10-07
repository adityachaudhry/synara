# Pi Durable runtime (GlasswingOS)

Status: live on `glasswingos/dev` since 7 October 2026. `glasswingos/main` (production) still runs the earlier in-sandbox provider worker until a promotion is decided. Design, measurements and open items: Glasswing repo `docs/superpowers/specs/2026-10-06-pi-durable-runtime-design.md` (§13). Diligence contract: Glasswing `docs/superpowers/specs/2026-10-07-durable-diligence-contract.md`.

## Shape

- **Agent loop in the controller.** Pi 1.0.4 conversations run under Pi Durable (`@earendil-works/pi-durable`) inside the controller process. State is one Harness SQLite file on the controller volume (`<home>/durable/harness.sqlite`), separate from `state.sqlite`.
- **Sandboxes are tool targets.** A Daytona sandbox (US preferred, EU fallback; Docker locally) holds the company checkout, LFS mount and tools. It runs no agent process and holds no credentials. File and shell tools go through the Daytona exec API as uid 10001 with an empty environment (`durable/sandboxEnv.ts`). Sandboxes are disposable: a lost or stopped one is replaced from the same company revision.
- **Files survive replacement.** The provisioner captures each thread's outbox (`/workspace/.synara/outbox/`) and checkout drafts to controller stores every minute, at turn end and before release, and restores them into a replacement sandbox. "Save to company" promotes selected files through Glasswing's Git writer.
- **Turns start before the sandbox.** Sandbox claims run in the background; a tool call waits for the claim.

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

- **Backups:** 2 min after start, then every 10 min, and on shutdown, through Glasswing `POST /internal/controller-backups/grants`. On open, a missing or corrupt Harness is restored from the latest backup (the old file is kept as `.pre-restore`).
- **Restart:** running turns and diligence steps resume under the same request IDs; diligence sandboxes are adopted so startup intent recovery keeps them.
- **Env (controller):** `SYNARA_DAYTONA_*` (API, snapshot), `SYNARA_ARTIFACT_API_URL` + `GLASSWING_ARTIFACT_SERVICE_TOKEN` (Glasswing callbacks, grants, diligence auth), `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `GLASSWING_CRUNCHBASE_MCP_URL`/`_TOKEN`. Deleted on dev: `SYNARA_PI_DURABLE`, `SYNARA_PROVIDER_WORKER_CONTROL_URL`, `SYNARA_PROVIDER_WORKER_FORWARD_ENV_KEYS`, `SYNARA_RAILWAY_SANDBOX_TOKEN`, `SYNARA_DURABLE_RESTORE`.
- **Sandbox image:** tools only, built by `providerWorker/prepareDaytonaTemplate.ts` through `.github/actions/prepare-worker` (name kept for history).
- **Logs:** `[diligence] {json}` and `[sandbox] {json}` lines; Railway parses bare JSON lines into fields, so keep the prefix.
- **Load/readiness trial:** `bun scripts/qa/daytona-readiness.mjs --run-dev --count=25 --models=anthropic/claude-sonnet-5-5 --output=<dir>`.

## Known leftovers

`nodeHttpServer.ts` still sets up a WebSocket server for the removed `/internal/provider-worker` path, and some names still say "provider worker" (`providerWorker/`, `/workspace/.synara-provider-worker`). They are inert; remove them with care, since they sit in the transport and path layers.
