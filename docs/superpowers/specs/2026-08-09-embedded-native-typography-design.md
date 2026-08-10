# Embedded Native Typography Design

## Problem

Glasswing currently passes `displayScale={1.3}` to the embedded Synara React app. CSS `zoom` makes Synara's 12px conversation typography readable, but it also enlarges every layout dimension and the host-owned company sidebar. Live Chrome measurements show the same company heading renders 30% taller in GlasswingOS than in Workspace even though both use the same shared component.

## Decision

Render embedded Synara at native browser scale and raise only Synara's existing typography tokens from the default 12px base to a host-selected 15px base. Expose this as an optional React-only `embeddedBaseFontSizePx` prop on `SynaraApp`; do not change global defaults, persisted user settings, or standalone Synara.

The adapter will derive all UI and chat CSS custom properties from the existing `getAppTypographyScale` function and apply them on the embedded app wrapper. Host-owned React sidebar content keeps its own Glasswing typography and dimensions. Existing `displayScale` support remains available for compatibility, but Glasswing no longer opts into it.

## Rejected alternatives

- Changing `DEFAULT_CHAT_FONT_SIZE_PX` would alter standalone Synara and persisted settings semantics.
- Copying Synara's private CSS variables into Glasswing would duplicate an internal contract and drift when the typography scale changes.
- Keeping CSS zoom and compensating individual dimensions would preserve the underlying geometry bug and require more inverse-scale exceptions.

## Verification

- Unit-test the host typography style as a complete literal CSS-variable map, including invalid-value fallback.
- Test the package declaration exposes the React prop.
- Run focused Vitest suites and production builds without the prohibited heavyweight workspace checks.
- On the deployed GlasswingOS route in Chrome, verify browser zoom is 100%, no Synara display-scale wrapper is active, the host sidebar remains 320px wide, embedded typography resolves from a 15px base, and the app fills the available height without clipping.

