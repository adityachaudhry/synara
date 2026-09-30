# Model and workspace rollout

Authorized September 30, 2026: upgrade Pi, expose only the latest Fable, Opus,
Sonnet, Sol and Astra, prepare sandboxes when a workspace opens, prove the
release in dev and an isolated production rehearsal, then promote through CI.
Production data and its rollback copies must survive every step. No unit tests.

## Verified dev release: September 30, 2026

Canonical `glasswingos/dev` application `a7f73f3783e3db83774e56c1215ddad72d3c18d4`
is live and healthy through [Actions 36784508540](https://github.com/adityachaudhry/synara/actions/runs/36784508540).
Glasswing `dev` picker `86dbdb7cae66cba9be08e853dd0ad81a9d6698ae` shipped through
[Actions 36780559190](https://github.com/adityachaudhry/glasswing-ai-2/actions/runs/36780559190).
Pi is pinned to 0.99.2, MCP adapter 4.0.0, web access 0.34.0.
The actual Edge dev journey signed in with a delivered email code, displayed
exactly the five requested models, and began hydration on Workspace navigation
without a model call. Its unsent draft worker expired and returned direct ID 404.

The complete trial passed 26 model turns across five simultaneous conversations
and four companies, including two conversations within ChipSage. All five models
read real company material, wrote and read separate private markers, and called
the real Crunchbase tool. Native UID, root/sudo/credential/company isolation,
private previews and cross-project403 passed. First send used each exact prepared
worker. A detached writer's latest observed state survived stop/preparation/resume.
All five owned worker IDs were directly confirmed destroyed after ordinary cleanup.

Prepared first-send readiness was 1.811–3.546 seconds (five samples); prepared
stopped resume was 1.422 seconds. Warm readiness has 15 samples and a maximum of
5.743 seconds. These are readiness times, not total answer times or production
parity. The older two full 25-conversation passes remain useful baseline evidence;
there is no new successful 50/98 or soak claim. See
[structured results](model-workspace-evidence.json).

The real trial exposed two defects and verified their correction. Workers now
provide Debian's standard `python` to Python3 alias. Incoming worker frames reserve
arrival order before Effect forks handlers; replay reads the latest retained frames
under the send lock. Transport failures retain output for reconnect. The complete
repeat had **zero worker frame rejections**, while strict sequence validation and
persist-before-ack remain in place. No unit tests were added or run.

## Production preparation and remaining gates

Production remains Synara `98183771a69ab9e0f7d97c505401ba3faca90755` and Glasswing
`f5645a615abb046772fe469ea5c66b417feaf4f9`, with Railway agent execution.
The consistent controller copy verified 49 table counts and 80 auxiliary file
hashes. It boots in the real new container with network disabled, no forwarded
provider credentials, unchanged chat/project/runtime rows and all 64 provider rows
still stopped. This proves copied controller startup, not private conversation
resume. Production Gitea uses its separate `Postgres-mIAq` service and **local LFS**;
its full database restores with all 116 table counts and 364,333 rows matching.
Original source backups and native recovery resources remain intact.

The production inventory has64 persisted Railway runtimes:43 matching checkpoint
pointers and 10 portable archives. Eleven older archived conversations have no
pointer in the current controller home and no matching hashed checkpoint in the
native inventory. Their saved chat records remain backed up. Classify/recover their
private state rather than silently starting empty sessions. One running native
worker maps to a stopped provider row; native writer fencing remains necessary.

The separate **Glasswing Production** Daytona organization currently has Tier 1,
no payment method and no wallet funding. The requested Tier 3 capacity requires
a one-time $500 wallet top-up; spending approval is pending and automatic top-ups
are disabled. No production key or runtime switch has been made. Keep this separate
from the dev organization's shared quota and recovery inventory.

Complete native/private-state forward and reverse restoration, isolated runtime
resources, bounded higher-load/fault/queue/restart trials, the full release review,
and final writer-drained copies before promotion. The dev refresh preflight passes
with distinct databases, Git/LFS and S3 stores; actual replacement still requires a
verified stopped controller/native-writer cohort. Conditional rollout authorization
persists. All app shipping must use canonical branches and GitHub Actions.

The authenticated provider catalogs and official documentation currently identify
`anthropic/claude-fable-5-1`, `anthropic/claude-opus-5-5`,
`anthropic/claude-sonnet-5-5`, `openai/gpt-6.1-sol` and `openai/gpt-6-astra`.
Pin Pi's three runtime packages to 0.99.2 and its existing MCP/web extensions to
compatible versions. Reuse the embedded host's existing model allowlist.

Rivet is absent from these repositories. Its actor ownership and durable state
would duplicate Synara's persisted per-conversation bindings, lifecycle epochs,
durable event delivery and capacity queue. Retain the existing coordinator;
adding another control plane would not shorten company checkout. Revisit actors
when controller sharding becomes a measured requirement.

Prepare the company checkout and connected worker for the draft conversation's
ID, without starting a model turn or publishing an empty chat. The controller
derives repository coordinates from the authorized project. The same per-thread
lifecycle lock serializes preparation, first send and expiry. First send adopts
the prepared generation and routes to that exact worker. Recheck company source
revision before every turn. Prepared workers remain exclusive to one project
and conversation, expire after five minutes and have a bounded speculative
admission limit. Persist preparation metadata for restart cleanup; never erase
an uncertain disk or recovery pointer. Speculation must yield when real work is
queued.

Real acceptance: all five models read actual company material, use tools and
resume private state; actual UI picker and workspace navigation; cold versus
prepared first-send timing; simultaneous conversations within/across companies;
abandoned preparations, source updates, queue/cancel, worker/controller loss,
backup failure and US/EU recovery. Cap trial output and spend; do not repeat the
earlier shared Anthropic usage incident.

Production preparation includes consistent controller/private-writer exports,
verified copied stores, a bridge capable of decoding both runtimes, original
Railway history migration and a reverse migration containing the newest Daytona
state. Rehearse against isolated copies, preserve source inventories, then ship
only the reviewed successful dev revision through production Actions. Keep old
resources throughout the rollback window. Current evidence and open gates remain
in `daytona-readiness-validation.md` and the Glasswing side-panel desk.

Sources: [Claude models](https://platform.claude.com/docs/en/models/overview),
[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Pi release](https://pi.dev/changelog),
[Rivet architecture](https://rivet.dev/docs/architecture/).
