# Embedded Shared Company Sidebar Design

## Goal

Make the GlasswingOS embedded Synara rail feel like the same company workspace shell: it has the same fixed 320px screen width, the same company identity block, and the same bottom navigation as the Workspace tab. Synara continues to own only the thread-specific middle section. Standalone Synara remains unchanged.

## Architecture

The Synara React package will add an optional, React-only `hostSidebar` adapter prop. It carries host-rendered header and footer slots, a screen-pixel width, and a `lockedOpen` policy. A small React context transports these values through the TanStack Router boundary without putting React nodes into Synara's serializable runtime configuration.

When the adapter is absent, the current standalone wordmark, footer, width persistence, resize rail, and collapse behavior remain exactly as they are. When `lockedOpen` is enabled, the chat route renders its sidebar as non-collapsible, disables resizing, omits the seam rail, and normalizes the requested screen-pixel width by the embedded display scale so a 320px host rail remains 320px on screen even when the rest of Synara is zoomed.

## Glasswing component reuse

Glasswing will extract two components from `AppShell`:

- `CompanySidebarIdentity`, containing the current company name and location, stage, sector, or not-yet-diligenced state.
- `CompanySidebarFooter`, containing the current GlasswingOS, Workspace, and Profile navigation.

`LeftSidebar` will render those components, preserving the existing Workspace experience. `SynaraWorkspaceRuntime` will pass those same component types as Synara's host sidebar slots. The existing `20rem` width becomes a single exported 320px constant used by both the Workspace shell and the embedded adapter.

The embedded header slot replaces Synara's logo and collapse controls. The embedded footer slot replaces Synara's approximate host-navigation footer. Synara's project/thread list remains the scrolling middle content.

## Data and navigation

The agent page passes the same company display fields already available to the Workspace layout into the embedded runtime. The shared footer continues using Next navigation and the existing `ProfileMenu`, so route changes, active-state styling, and sign-out behavior have one implementation. No new durable objects, API calls, or storage are introduced.

## Failure and compatibility behavior

The host sidebar adapter is optional. Missing slots fall back to Synara's existing header/footer. Invalid or absent widths fall back to Synara's current width. The legacy `hostNavigation` adapter remains supported so existing embedders do not break.

## Verification

Focused tests will prove that:

1. a locked host sidebar resolves to a fixed normalized width with no collapse, resize, or seam rail;
2. standalone mode keeps its current collapsible, resizable presentation;
3. the Glasswing Workspace and agent paths render the same exported company identity and footer components;
4. production builds of both repositories succeed; and
5. live Chrome measurements show the Workspace and embedded rails have the same screen width, the embedded logo/collapse control is absent, and the shared company/footer UI remains functional.
