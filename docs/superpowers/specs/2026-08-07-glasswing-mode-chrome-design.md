# Glasswing Mode Chrome Design

## Goal

Make the browser UI read as GlasswingOS when Glasswing mode is active without changing Synara mode or removing any underlying routes and capabilities.

## Behavior

- The threads surface title in the left sidebar is `GlasswingOS` in Glasswing mode and remains `Synara` otherwise.
- The left sidebar does not render the `Kanban` or `Pull requests` primary actions in Glasswing mode. Their routes and implementation remain available; this change only removes the sidebar entry points.
- The chat top bar does not render the Handoff provenance badge or Handoff menu in Glasswing mode.
- Provider usage remains visible when it would otherwise be visible. It is not a Handoff control and should not disappear as a side effect.
- Existing terminal-workspace and editor-rail rules for hiding the complete Handoff control cluster remain unchanged.

## Architecture

Reuse `getGlasswingModeForCurrentPage()` as the only mode source. `Sidebar` resolves the mode once and passes the mode-specific threads title to `SidebarSurfacePicker`, while conditionally omitting the two primary navigation actions. `ChatView` passes an explicit `hideHandoffAction` presentation prop to `ChatHeader`; `ChatHeader` uses it only for the Handoff badge and menu.

No CSS-only hiding, new settings, route guards, persistence changes, or server contracts are introduced.

## Testing

- Render `SidebarSurfacePicker` with both titles to prove the visible brand is controlled explicitly.
- Render `ChatHeader` with and without `hideHandoffAction` to prove Glasswing presentation removes Handoff while normal Synara presentation retains it.
- Cover the sidebar primary-action policy with a small pure helper so both hidden Glasswing actions and unchanged Synara actions are regression tested.
- Run focused web tests, a production web build, `git diff --check`, the v3/dev deployment workflow, and a live browser acceptance check.

