# Per-thread sandbox refresh and embedded height implementation plan

> Execute in `/Users/adityachaudhry/repos/synara/.worktrees/distributed-runtime-railway` unless a step explicitly names the Glasswing embed worktree.

## Task 1: Lock the repository behavior with failing tests

**Files:**
- Modify: `apps/server/src/providerWorker/giteaCheckout.test.ts`

1. Add assertions that initial checkout uses cone sparse-checkout for the selected company.
2. Add a real local-Git test repository containing `company.json` and nested files.
3. Prove initial checkout recursively materializes nested files.
4. Add a remote commit and prove refresh updates the company subtree.
5. Run refresh again and prove it reports `unchanged` without fetching or checking out.
6. Run the focused test and confirm it fails because refresh support does not exist yet.

## Task 2: Implement recursive initial checkout and fast refresh

**Files:**
- Modify: `apps/server/src/providerWorker/giteaCheckout.ts`

1. Replace the hand-written sparse pattern with `git sparse-checkout init --cone` and `git sparse-checkout set <company path>`.
2. Add a credential-safe refresh plan that checks the remote ref first.
3. Emit explicit immutable commit, checkout mode, and `unchanged`/`updated` markers.
4. Add strict parsing for refresh output.
5. Run the focused checkout test until green.

## Task 3: Refresh every bound thread before its turn

**Files:**
- Modify: `apps/server/src/providerWorker/Services/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.test.ts`
- Modify: `apps/server/src/provider/Layers/RoutedPiAdapter.ts`

1. Add failing routed-adapter tests for refresh-before-turn, changed-binding persistence, and persisted repository binding reuse during restart.
2. Add `refresh` to the provisioner service contract and disabled implementation.
3. Implement refresh by reconnecting to the existing workspace, executing the refresh plan, validating its result, and returning an updated runtime binding.
4. Emit `workspace.checkout` with `cold: false` around bound refreshes.
5. Refresh in `sendTurn`, update the per-thread map, persist only a changed binding, and then dispatch the provider turn.
6. Derive the effective repository binding from the persisted runtime during restart recovery.
7. Run focused adapter and provisioner tests.

## Task 4: Fix embedded container height without changing standalone

**Files:**
- Modify: `apps/web/src/routes/_chat.tsx`
- Add or modify: focused web layout test

1. Add a failing test for viewport versus embedded-container layout classes.
2. Read the existing runtime config once in `ChatRouteLayout`.
3. Use `h-full min-h-0` for the root sidebar wrapper and main shell only when `hostProject` is present.
4. Keep current `min-h-svh`/`h-svh` behavior in standalone mode.
5. Run the focused web test.

## Task 5: Focused verification and documentation

**Files:**
- Modify: distributed-runtime and React-embed trial logs

1. Run all focused tests touched by the change.
2. Build server and web/embeddable package with the bundled Node runtime.
3. Record attempted approaches, failures, corrections, timings, and evidence in the existing trial logs.
4. Inspect the diff and verify no unrelated or standalone behavior changed.

## Task 6: Package, deploy, and verify end to end

**Repositories:**
- Synara worktree branch `codex/v3-gitea-projects`
- Glasswing worktree `/private/tmp/glasswing-ai-2-synara-react-embed`, branch `codex/synara-react-embed`

1. Commit and push the Synara change; wait for the v3 dev deployment to succeed.
2. Build the Synara React package with provenance and sync it into Glasswing.
3. Commit/push the Glasswing feature branch and fast-forward dev; wait for deployment.
4. In Chrome, verify the embedded agent route loads, the lower navigation is fully visible, and measured footer bounds are inside the host container.
5. Send a message in a company thread and verify the refresh progress and response path end to end.
6. Inspect browser errors and deployment logs, then finalize the browser tab as the deliverable.

