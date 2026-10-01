# Workspace loading CAPA — October 1, 2026

The recurring controller freeze was captured in Claude Agent SDK libc detection: synchronous `process.report.getReport()` spent 35 seconds on network discovery. The shared SDK loader now excludes report network operations, retaining libc metadata. Running report checks took 2 ms in dev and 7 ms in production.

The canonical incident, deployment and browser evidence is in [Glasswing's workspace-loading CAPA](https://github.com/adityachaudhry/glasswing-ai-2/blob/main/docs/operations/workspace-loading-capa.md). Controller releases: dev `e9a9bd709`, production `40493653a`; both deployed through GitHub Actions. Later QA/documentation commits do not change the running application.

Run `node scripts/qa/workspace-loading.mjs` for real dev acceptance; add `--production` explicitly for production. This refreshes provider health, exercises the previously blocking SDK path, then checks the authorized company shell and model catalog. Repeat while observing HTTP responsiveness after SDK/Node upgrades, alongside a browser response, temporary-artifact preview and existing-file preview. Keep runtime SDK imports on the shared loader. No unit tests are required or run.
