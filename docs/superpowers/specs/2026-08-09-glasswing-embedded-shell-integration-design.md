# Glasswing Embedded Shell Integration Design

## Goal

Make the vendorable Synara React surface feel native inside Glasswing while leaving standalone Synara behavior unchanged.

## Decisions

- Embedded mode is identified by a host project supplied through `SynaraRuntimeConfig`; Glasswing presentation mode alone is not enough.
- New Glasswing company threads default to Pi with `anthropic/claude-opus-5` and `thinkingLevel: high`. Existing started-thread selections remain authoritative.
- The embedded project name is static in both the sidebar header and empty landing. The landing keeps an underline but uses Glasswing red.
- New-thread creation is idempotent while the active thread has no user message. This covers both local drafts and already-persisted/prewarmed empty threads.
- The right-dock launcher is independent of environment controls. Glasswing can hide Environment and project actions without losing the panels button.
- Glasswing supplies a small host-navigation adapter to Synara: navigate to Workspace plus profile identity/sign-out. Synara renders GlasswingOS, Workspace, and Profile in its own footer while embedded.
- The Glasswing host suppresses its outer left rail only on the GlasswingOS route. Workspace continues to use the existing host workspace and host rail, so the workspace implementation is not duplicated inside Synara.

## Compatibility

All new host fields are optional. Standalone Synara receives no host adapter and keeps its project picker, interactive landing project picker, settings footer, and existing shell behavior.

## Verification

Focused unit/browser regressions cover model defaults, runtime contract packaging, empty durable-thread reuse, the independent dock launcher, and embedded landing behavior. Both standalone and embedded builds must succeed, followed by Railway deployment and live Chrome verification.
