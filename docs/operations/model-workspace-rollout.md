# Model and workspace rollout

Authorized September 30, 2026: upgrade Pi, expose only the latest Fable, Opus,
Sonnet, Sol and Astra, prepare sandboxes when a workspace opens, prove the
release in dev and an isolated production rehearsal, then promote through CI.
Production data and its rollback copies must survive every step. No unit tests.

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
