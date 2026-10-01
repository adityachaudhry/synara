# Model and workspace rollout

Authorized September 30, 2026: upgrade Pi, expose only the latest Fable, Opus,
Sonnet, Sol and Astra, prepare sandboxes when a workspace opens, prove the
release in dev and an isolated production rehearsal, then promote through CI.
Production data and its rollback copies must survive every step. No unit tests.

## Verified dev release: October 1, 2026

Canonical `glasswingos/dev` application `fbfb692dfc8bf53dab45d8b35c2ba7e14d04f374`
is live and healthy through [Actions36810203135](https://github.com/adityachaudhry/synara/actions/runs/36810203135). Dev now uses a verified copy of production business data and chats; original dev recovery copies and home remain retained.
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

The hardened repeat passed another26 turns. Prepared first-send readiness was
1.981–3.481 seconds (five samples); prepared stopped resume was3.050 seconds.
Warm readiness has15 samples, median1.264 seconds and p95 5.550 seconds. Native
UID10001 rename/write checks protect repository parents, Git metadata and the root
launcher log. The real364-byte HubFlow LFS body downloads and remounts with exact
SHA256. The initial hardening rejected the native clone's format1/noextensions;
that failed trial is retained and the shared guard was corrected. These are readiness times, not total answer times or production
parity. The older two full 25-conversation passes remain useful baseline evidence;
there is no new successful 50/98 or soak claim. See
[structured results](model-workspace-evidence.json).

**Current release checkpoint, October 1, 04:50 UTC:** production has **not** been deployed. Dev Synara `fbfb692df` is live through canonical [Actions36810203135](https://github.com/adityachaudhry/synara/actions/runs/36810203135). The latest real run passed **25 concurrent conversations across four companies, 102 successful model turns**, native private-file/credential/company isolation, previews, cross-project403, stopped-writer restoration, an actual interrupted turn and a successful following turn. All25 owned native disks returned404. Cold readiness median12.662s/p95 20.492s; warm median2.535s/p95 7.406s. These unprepared25-chat timings are separate from the five-model prepared first-send1.981–3.481s evidence.

The earlier repeat completed96/100 turns and exposed OpenAI TPM429 plus premature Pi turn cleanup. The shared adapter now keeps ownership until the native prompt promise settles. The passing repeat had no actual429 records, so it proves the normal/reuse/cancellation path, not retry success under429. Earlier failed trials remain retained. Six verified superseded release pool definitions were set to zero, releasing12 unclaimed spares while retaining definitions, checkpoints and every business disk. Actual US disk quota is300GiB; production US/EU capacity remains to be verified.

**The requested dev browser acceptance passed at04:25 UTC:** real email-code sign-in, the exact five-model picker, Workspace navigation dispatching hydration before a message, a Sol reply reading the real deck, temporary Markdown and PDF artifacts rendered in the side panel, source-deck preview, reopening the chat and an Opus follow-up reading the retained note. The actual Download click returned the1260-byte PDF with its registered SHA256. Nothing was published to company files. This observes the hydration request/start; exact first-send adoption of prepared workers is separately proved by the five-model API trial.

**The original-chat reverse rehearsal passed** through canonical [Actions36816066674](https://github.com/adityachaudhry/synara/actions/runs/36816066674), attempt2, with Railway execution, PRIVATE networking and production-style local LFS. Both copied chats kept the same native Pi session IDs; all177,285 original history bytes, all prior UI messages, the newest private markers and the original Outbox PDF hash verified as UID10001. Native histories now have31 and57 records. Both sessions were parked and source recovery resources retained. Attempt1 stopped before deployment because the Daytona ISOLATED setting conflicted with Railway private hosts; matching production PRIVATE networking corrected it. Dev Daytona restoration is now queued through canonical CI.

All65 persisted dev sessions were stopped before changing providers. Fresh native label lookups found no disk for either of the two aged failed DEV QA creation intents; both uncertain intents are retained, with no direct database deletion or active creation moved. The remaining production steps are isolated account/key/funding and verified US/EU capacity, the final writer-drained backup, canonical CI promotion, and a live production browser check. The specific production key and one-time$500 funding approvals remain pending; conditional deployment itself is already authorized. Production stays unchanged. This checkpoint supersedes older current-state and running-trial statements below.

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

Dev browser acceptance, the five-model prepared trial, the25-conversation repeat,
and original-history forward/reverse restoration have passed. Finish isolated
production resources and capacity checks, final writer-drained copies, canonical
CI promotion and the live production browser check. The dev business refresh completed through canonical Actions36800889286 and
verified all28 business tables, Git refs, S3 manifests and19 full artifact/archive
bodies. All43 native exports registered in dev with independent full GET/SHA
verification. The copied controller home activated through canonical CI and
retains all70 chat rows,235 message rows,69 session rows and53 private pointers,
while keeping dev authentication/signing identity and rebinding81 projects to dev
Gitea. Two original production-native conversations now resume in dev with the same
native session IDs, every original history byte unchanged, all prior UI messages
and a private Outbox PDF retained, plus new private markers. Reverse migration
and the latest25-conversation/cancellation repeat passed. Conditional rollout authorization
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

Privileged Git format handling follows [Git's repository-version contract](https://git-scm.com/docs/repository-version): formats0/1 without extensions share a layout. Unknown extensions remain rejected; imported configuration stays inert recovery data before root Git runs.
