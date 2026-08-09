# Glasswing Standalone Project Scope Convergence Design

## Goal

Make the standalone Railway v3 GlasswingOS surface and the embedded Glasswing React surface expose the same project picker, one-project thread rail, and simplified chat chrome while retaining the correct navigation owner in each host.

## Correction to the Earlier Boundary

The first project-scoped shell required both Glasswing mode and an embedded `hostProject`. That kept standalone Synara unchanged, but it also made the v3 GlasswingOS UI diverge from the embedded UI even though both ship the same `SynaraApp` feature graph.

Project scoping is now a Glasswing-mode presentation capability. `hostProject` chooses the selection adapter; it no longer enables the capability itself.

## Selection Adapters

- Embedded Glasswing remains host-controlled. The host project identifies the selected project, and `onSelectProject` changes the outer `/app/<company>?view=agent` route after Synara activates the matching native draft.
- Standalone v3 is Synara-controlled. The currently focused ordinary project identifies the selection, and choosing another project activates or restores that project's native Synara draft without an outer route callback.
- If the focused standalone route does not resolve to an ordinary project, the existing new-thread target resolution selects the same ordinary project Synara would use for a new chat. Until a valid project exists, the rail exposes no unrelated thread rows.

No duplicate selected-project store is added. The active draft/thread remains the standalone source of truth, preventing picker state from drifting from the composer.

## Shared Presentation

When Glasswing mode is active on either mount:

- The sidebar header is the project picker and displays the selected project.
- Only the selected project's threads are rendered.
- New thread targets the selected project.
- Search, Activity, Automations, Add action, Environment launchers, runtime approval controls, workspace/runtime tray, and microphone are absent from the rendered tree.
- The underlined project selector in the empty composer remains and reflects the same active project.

When Glasswing mode is disabled, existing general-purpose Synara behavior remains unchanged.

## Failure Behavior

- Embedded project mismatch retains the host label and shows a loading/unavailable state; it never falls back to another company.
- Standalone mode never presents a label for one project while rendering another project's threads.
- Selecting a project activates the Synara draft before calling an optional outer host callback.
- Provider, orchestration, persistence, authentication, and WebSocket behavior are unchanged.

## Testing and Delivery

- Pure tests cover standalone active-project selection, host-project precedence, and missing-selection isolation.
- Presentation tests prove Glasswing mode applies the simplified chrome with and without `hostProject`, while non-Glasswing mode retains all controls.
- A rendered chat test proves the standalone mount hides the requested controls.
- Build standalone and embedded Synara, refresh the vendored Glasswing package, build Glasswing, deploy both exact commits, and verify both live URLs in Chrome.
