# @synara/react

Reusable React entrypoint for embedding Synara. Import `@synara/react/style.css` once in the host.

Glasswing releases are built by `publish-glasswing-embed.yml`, independently of
the server deployment. `glasswingos/dev` publishes the dev channel;
`glasswingos/main` publishes the production channel. Each successful package is
an immutable prerelease named `synara-react-<channel>-<run number>-<source SHA>`.
The highest run number in a channel is its latest successful package; rerunning
an older workflow cannot move the channel backwards.

Glasswing resolves the channel during its web build, verifies the GitHub asset
SHA-256 and package provenance, and publishes `/synara-react/provenance.json`.
No lock-file or vendored-package commit is needed to update a deployed consumer.
Local checkouts may retain a vendored fallback for offline work.

After publication, CI dispatches Glasswing's `deploy.yml` with `web_only=true`
on the matching branch. Configure `GLASSWING_ACTIONS_TOKEN` in this repository
with **Actions: read and write** permission restricted to `glasswing-ai-2`.
It does not need repository contents write permission. A missing/expired token
fails the dispatch job visibly; the published package remains available and can
be consumed by the next Glasswing web build or a manual web-only dispatch.

The embed build generates routes first, then runs bundling and checked declaration
emit concurrently in separate directories. Incremental declarations and per-file
React Compiler results are cached under `dist-embed`; changed source or compiler
inputs invalidate the relevant entries. Compiler failures never produce a package.
CI also reuses a fully checked package when its build inputs are unchanged, while
refreshing the release provenance and README. Cold builds still do the full work.
