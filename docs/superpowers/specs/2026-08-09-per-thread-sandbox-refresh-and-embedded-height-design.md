# Per-thread sandbox refresh and embedded height design

## Goal

Every distributed Gitea-backed thread must see the selected company's latest repository state before each turn. The common no-change case must avoid recreating the sandbox or fetching file contents. The checkout must contain the complete company subtree, including nested directories. Embedded Synara must fill its React host container without sizing itself beyond that container, while standalone Synara keeps viewport sizing.

## Existing seams to preserve

- `RoutedPiAdapter` owns local-versus-distributed Pi routing and keeps one runtime binding per thread.
- `ProviderWorkerProvisioner` owns sandbox workspace operations and already emits `workspace.checkout` runtime stages.
- `ProjectRepositoryBinding` identifies the one allowed Gitea repository and company subdirectory.
- `ProviderWorkerRuntimeBinding.repositoryCheckout` durably records the binding and immutable checked-out commit.
- `SynaraApp.hostProject` is the existing additive signal that the React app is embedded by Glasswing.

No new orchestration, storage, repository, or progress primitives are required.

## Sandbox freshness flow

Before `RoutedPiAdapter` sends every remote turn, it asks `ProviderWorkerProvisioner.refresh` to refresh that thread's existing runtime binding.

For Gitea-backed bindings, refresh performs the following inside the existing sandbox:

1. Reconnect to the existing workspace.
2. Resolve the configured ref's remote commit with authenticated `git ls-remote`.
3. Compare it with the local `HEAD` and verify that the company checkout sentinel (`company.json`) still exists.
4. If both match, report `unchanged` and return immediately. There is no sandbox recreation, fetch, checkout, or worker restart.
5. If they differ, fetch the configured ref shallowly, reapply the company sparse checkout, detach at `FETCH_HEAD`, verify `company.json`, and persist the new immutable commit.
6. If refresh cannot prove a valid company checkout, fail the turn before any provider request rather than letting the agent use stale or incomplete material.

The existing `workspace.checkout` runtime-stage stream wraps refresh with `cold: false`, so the transcript can show the same “Syncing project files” progress used during cold setup. Non-Gitea runtime bindings return immediately without a stage or remote repository call.

When a persisted runtime must be recreated, `RoutedPiAdapter.startSession` derives the repository binding from `previous.repositoryCheckout.binding` if the caller no longer has it. This closes the current recovery gap and guarantees the replacement sandbox is hydrated with the same company subtree.

## Recursive company materialization

Initial checkout and updates use Git sparse-checkout cone mode with the company directory as the selected cone. Cone mode materializes every tracked descendant below `companies/<slug>` while excluding unrelated companies. A real-Git test creates nested company files, proves they appear after initial checkout, advances the remote repository, proves a later refresh updates nested content, and then proves the next refresh takes the unchanged path.

## Embedded layout

The clipping is caused by Synara's chat route using `min-h-svh` and `h-svh` inside a host whose available content height is smaller than the browser viewport. In embedded mode, the route's sidebar wrapper and main content shell will instead use `h-full min-h-0`. Standalone mode keeps the existing viewport classes.

This decision stays inside Synara's React adapter signal (`hostProject`) and does not require Glasswing to patch Synara DOM or duplicate layout logic.

## Verification

- Focused unit and real-Git integration tests for checkout, refresh parsing, nested files, and unchanged/update behavior.
- Routed-adapter tests proving refresh-before-turn, persistence after a changed commit, no controller fallback, and repository-binding recovery.
- Focused web test proving embedded/container classes and standalone/viewport classes.
- Server and embeddable-package builds.
- Dev deployments of Synara v3 and Glasswing.
- Chrome verification on the embedded Glasswing agent route, including geometry proving the bottom navigation is inside the host and a live distributed thread turn showing refresh activity.

