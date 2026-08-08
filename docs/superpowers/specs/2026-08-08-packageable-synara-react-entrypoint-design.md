# Packageable Synara React Entrypoint Design

## Goal

Expose the complete browser Synara application as a packageable React component, make the existing v3 Synara web deployment mount that component, and consume the same component inside the Glasswing Next.js company shell without an iframe or separately navigated frontend.

## Non-negotiable behavior

- The existing Synara browser remains fully functional and visually equivalent.
- Glasswing and standalone Synara render the same route tree, transcript, composer, provider, tool, approval, artifact, diff, terminal, settings, project, and thread implementations.
- The integration is additive: the standalone defaults remain valid and upstream Synara changes continue to merge into the fork.
- Glasswing owns its Next.js application shell and SuperTokens login. Embedded Synara does not create another React root or show another login page.
- Gitea remains durable company-file storage. Synara's existing Project, Thread, Turn, provider session, event journal, and Railway Sandbox primitives remain authoritative.
- No iframe, duplicate chat implementation, direct shared-database coupling, or browser-exposed Gitea credential is introduced.

## Component boundary

`apps/web/src/SynaraApp.tsx` becomes the reusable application root. It owns a TanStack Router instance and renders `RouterProvider`, but it does not call `ReactDOM.createRoot`. It accepts a host configuration containing:

```ts
export interface SynaraAppProps {
  readonly history?: RouterHistory;
  readonly connection?: SynaraConnectionOptions;
  readonly className?: string;
}

export interface SynaraConnectionOptions {
  readonly resolveWebSocketUrl: () => Promise<string>;
  readonly httpBaseUrl: string;
}
```

`apps/web/src/main.tsx` remains the standalone browser bootstrap and mounts `<SynaraApp history={appHistory} />`. The package entry `apps/web/src/embedded.ts` exports `SynaraApp`, a memory-history factory, public prop types, and the package stylesheet.

Glasswing lazy-loads the compiled package into its existing `AppShell`. The Glasswing page chooses the agent view and renders the component as ordinary React children. Synara uses memory history in this host so its internal thread/settings navigation never mutates Next.js routing.

## Additive host adapters

The current application-global history and endpoint defaults remain compatibility fallbacks. New providers make them host-specific:

- `AppHistoryProvider` supplies the TanStack history used by navigation buttons and shortcuts. Existing helpers retain their optional history parameters and default to standalone `appHistory`.
- `configureWebRuntime` supplies an async WebSocket URL resolver and HTTP base URL before the Native API is created. Standalone mode retains the current window-origin and `VITE_WS_URL` defaults.
- `WsTransport` resolves a fresh URL for every connection generation. This is necessary because authenticated WebSocket tickets are one-use and reconnects must receive a new ticket.
- `resolveWsHttpUrl` prefixes attachment, upload, favicon, export, and other HTTP routes with the configured host proxy base.

Only the small number of components that call application-history helpers directly receive the history adapter. The route tree and feature components remain shared.

## Authentication and transport

Glasswing continues to issue and verify the user-facing SuperTokens session. The bridge uses existing Synara bearer-session and WebSocket-ticket primitives:

1. The embedded component requests `/api/synara/session` from Glasswing.
2. The Next route verifies the current Glasswing SuperTokens session.
3. If no valid proxied Synara bearer exists, it forwards the SuperTokens cookies to Synara's new `/api/supertokens/exchange/bearer` adapter.
4. Synara verifies the SuperTokens session against the already configured shared core and returns an existing `bearer-session-token` session.
5. Glasswing stores that bearer in an HTTP-only, same-site cookie scoped to `/api/synara`.
6. Glasswing exchanges the bearer for a one-use Synara WebSocket ticket and returns the direct WSS URL to the component.
7. The component connects directly by WSS. On reconnect it repeats the same session call and receives a new ticket.
8. Non-WebSocket browser requests use `/api/synara/proxy/*`; the Next proxy adds the HTTP-only bearer and forwards binary or JSON responses to Synara.

Synara gains a validated `SYNARA_TRUSTED_APP_ORIGINS` list for browser WebSocket origins and external-auth exchange mutations. The v3 dev service admits only the exact Glasswing dev origin in addition to its own existing public origin.

## Package artifact

Vite library mode builds `@glasswing/synara-react` from the same web source. React and React DOM are peer dependencies; the remaining Synara browser dependencies are compiled into the package with code splitting. The artifact contains ESM JavaScript, chunks, assets, TypeScript declarations, package metadata, provenance containing both Synara and upstream SHAs, and compiled CSS.

Until a private package registry is configured, the exact built package is vendored under `glasswing-ai-2/web/vendor/synara-react` and installed with a `file:` dependency. A deterministic sync script replaces the vendor directory from a built Synara artifact and records its provenance. Switching to a registry later changes only the dependency locator.

## Glasswing presentation

Glasswing adds an `agent` company view alongside its existing diligence workspace. `AppShell` retains the Glasswing top bar and company rail. The embedded Synara component fills the content inset and is loaded only when selected. Existing Glasswing workspace behavior is unchanged.

Glasswing mode continues to hide Synara Kanban, pull requests, and Handoff presentation while leaving those features available in standalone Synara mode. The shared transcript, composer, settings, providers, tools, approvals, files, terminal, and thread concurrency remain enabled.

## Styling

The package publishes the compiled Synara stylesheet as an explicit external stylesheet. Glasswing imports it after its own base stylesheet and mounts the application beneath a stable `data-synara-app` root. The first integration preserves Synara's existing global portal behavior so dialogs, menus, tooltips, and toasts continue working. Any selector collisions found by the integrated browser suite are fixed at the narrowest shared selector rather than by forking component CSS.

## Verification

Completion requires:

1. Red-green unit tests for history injection, HTTP base resolution, fresh WebSocket URL resolution on reconnect, bearer exchange, trusted-origin admission, Glasswing session/proxy behavior, and agent-view selection.
2. The existing standalone Synara web unit and focused browser suites remain green.
3. The standalone production web build and the library package build both succeed.
4. The vendored package is reproducible from the Synara build output and the Glasswing Next production build succeeds.
5. Browser acceptance in v3 dev proves the direct Synara page still hydrates, creates/opens a company project, sends a first Pi message, receives streaming output, supports a follow-up, reloads persisted history, and reconnects.
6. Browser acceptance in Glasswing dev proves a signed-in company page opens the native embedded agent view, uses the same project/thread data, streams a response, reconnects, and returns to the normal Glasswing views without a second login or full-page application handoff.
7. Deployment evidence records the exact Synara and Glasswing commits, health endpoints, and rendered browser state.

## Upstream merge discipline

The reusable entrypoint, runtime configuration, history provider, and build configuration are additive files. Existing-file edits preserve current exports and standalone defaults. Upstream merges are resolved semantically in this small host seam; feature code is never copied into Glasswing. Generic host abstractions should be proposed upstream where practical so the fork delta shrinks over time.
