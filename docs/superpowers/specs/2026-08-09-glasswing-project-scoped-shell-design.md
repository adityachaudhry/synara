# Glasswing Project-Scoped Shell Design

## Goal

Make the embedded GlasswingOS agent surface feel native to the selected Glasswing company: the Synara sidebar header becomes a project picker, the rail shows only that project's threads, and general-purpose Synara controls that do not belong in this embedded workflow disappear.

## Boundary

Use a hybrid adapter boundary.

- Glasswing's React host passes the selected company name and slug to the embedded package and owns navigation when a different project is selected.
- Synara's existing Glasswing mode owns project matching, project-thread projection, and semantic control visibility because those behaviors depend on Synara state.
- Standalone Synara behavior is unchanged. No provider, orchestration, persistence, or protocol primitive changes.

## Host Contract

Extend the embeddable runtime config with an optional `hostProject` object:

```ts
interface SynaraHostProject {
  name: string;
  slug: string;
  onSelectProject?: (project: { name: string; cwd: string }) => void;
}
```

Glasswing passes its current company and converts a selected Synara project's checkout-folder basename, falling back to its normalized name, into `/app/<slug>?view=agent` navigation.

## Sidebar Behavior

In Glasswing mode with `hostProject` configured:

- Replace the surface picker label with the matched/current company name.
- Populate the dropdown with Synara projects, not Synara surfaces.
- Match the current project by normalized display name first, then company slug against project name and checkout-folder basename.
- Render only the matched project's thread rows; do not render Spaces, pinned cross-project threads, project headers, unrelated projects, or standalone Chats.
- Keep one `New thread` action, explicitly bound to the matched project.
- Hide Search, Activity, and Automations controls.
- If hydration has not found the project yet, retain the host-provided label and show a small loading/empty state rather than leaking other projects.

Outside this host context, retain the existing Synara/Studio surface picker and complete sidebar.

## Chat Chrome Behavior

Extend the existing `GlasswingChromePresentation` policy rather than using CSS selectors. In Glasswing mode:

- Hide project actions (`Add action`).
- Hide Environment and related panel launchers in the chat header.
- Hide the composer runtime-access selector (`Full access` / `Ask for approval`). The current runtime mode remains unchanged internally.
- Hide the voice-note button.
- Hide the empty-landing workspace tray containing project/folder, Local, branch, and Temporary options.
- Keep attachments, model/reasoning selection, context meter, plan controls, send/stop, and the restored underlined project name in the empty-state heading.

## Failure Behavior

- A missing project match never falls back to showing another company's threads.
- A project selection without a host callback is inert rather than mutating the wrong host route.
- Provider dispatch and saved runtime settings are unaffected by hidden controls.

## Testing

- Pure tests cover host-project normalization/matching and project-picker option derivation.
- Glasswing-mode policy tests cover every hidden control while non-Glasswing mode retains all controls.
- Focused sidebar/chat rendering tests assert the controls are absent and only the selected project's threads are projected.
- Build both standalone and embedded Synara packages, sync the package into Glasswing, build Glasswing, deploy dev, and verify the selected-project dropdown, thread scoping, new-thread targeting, and hidden controls in Chrome.

