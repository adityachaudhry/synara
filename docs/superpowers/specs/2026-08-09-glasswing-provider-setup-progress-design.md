# Glasswing Provider Setup Progress

## Goal

Keep the embedded GlasswingOS chat visibly active from message submission until the provider turn starts, including any Railway sandbox and Pi session preparation that happens in between.

## Existing seam

Distributed Pi already emits `runtime.stage` provider events for sandbox creation, repository checkout, worker files, worker startup, worker connection, session startup, and turn dispatch. Provider runtime ingestion persists those events as ordinary `thread.activity-appended` orchestration activities and streams them to the React client over the existing domain-event WebSocket channel.

The generic Synara work-log projection intentionally filters `runtime.stage` activities out of the transcript because they are operational telemetry. The transcript also currently receives `hasLiveTurn` rather than the broader local-send busy state. Together, those choices create a silent interval when a first message has been accepted but the provider turn has not started.

## Design

Add a small web presentation adapter that derives the latest unresolved `runtime.stage` for the active lifecycle generation. It will expose user-facing, provider-neutral copy:

- `sandbox.create`: Preparing secure workspace
- `workspace.checkout`: Syncing project files
- `worker.files`: Restoring agent runtime
- `worker.start`: Starting agent runtime
- `worker.connect`: Connecting agent
- `session.start`: Opening agent session
- `turn.dispatch`: Starting your request

The adapter only returns progress after the thread has a submitted user message. Prewarming an untouched draft remains invisible. A completed or failed stage is no longer active; overlapping stages resolve to the most recently started unresolved phase.

In Glasswing mode, the transcript stays in its existing working state while either the local send is awaiting acknowledgement or a setup stage is active. Its single transient shimmer row updates from `Working...` to the current setup label in place. Once the provider turn starts, the normal live-turn timeline takes over. No setup activity is inserted into the durable conversation work log, so history remains clean and auto-scroll does not receive a new row for every phase.

Outside Glasswing mode, Synara's current rendering is unchanged.

## State and failure behavior

- Durable source: existing provider runtime events and projected orchestration activities in SQLite.
- Transport: existing `orchestration.domainEvent` WebSocket push.
- React state: derived, memoized presentation only; no second progress store.
- Reload/reconnect: projection hydration reconstructs the active setup label from persisted activities.
- Failure: a failed stage stops the transient setup state; the existing thread/provider error surfaces remain authoritative.
- Follow-ups: warm turns usually emit only `turn.dispatch`; they may briefly show `Starting your request`, while normal live-turn state takes over immediately.

## Compatibility boundary

The shared contracts, runtime lifecycle, persistence, and server orchestration remain unchanged. The new behavior is gated by `getGlasswingModeForCurrentPage()` and ships through the React embed package consumed by Glasswing. This preserves upstream Synara behavior and keeps future upstream merges additive.
