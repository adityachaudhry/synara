# Pi Web Access Design

## Goal

Give every Pi session web search through `pi-web-access`, with Perplexity credentials supplied by the hosting environment.

## Decisions

- Web access is always enabled for Pi; there is no feature flag or UI setting.
- `pi-web-access@0.27.0` is bundled into Synara's provider-worker artifact and loaded as an inline Pi extension.
- The extension's headless behavior is used as-is: no curator browser opens, and the active Anthropic model synthesizes the returned search results.
- Perplexity is the only configured search provider.
- `PERPLEXITY_API_KEY` remains an environment variable. The local Glasswing launcher reads only that name from the primary checkout `.env`. Railway dev stores it as a service variable.
- The distributed worker forwards only that web-search credential. No credentials are written to source, config files, logs, or git.
- Deployment scope is dev only. Production is untouched.

## Acceptance

1. Before implementation, a local Pi/Sonnet conversation cannot invoke `web_search`.
2. After implementation, a local Pi/Sonnet conversation invokes `web_search` and returns a cited current result.
3. An explicit Perplexity search succeeds locally.
4. Both repositories' accumulated changes are committed and pushed to their dev branches.
5. Railway dev receives both credentials, deploys successfully, and the same browser conversation succeeds at the dev URL.
