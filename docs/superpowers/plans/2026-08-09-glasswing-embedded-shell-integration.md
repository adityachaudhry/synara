# Glasswing Embedded Shell Integration Implementation Plan

1. Add failing regressions for Opus 5 high defaults, persisted empty-thread reuse, embedded project locking, host navigation typing, and the dock launcher.
2. Extend the additive React embed adapter with optional navigation/profile callbacks.
3. Apply embedded-only sidebar and landing presentation while preserving standalone behavior.
4. Make new-thread bootstrapping reuse an active zero-user-message server thread.
5. Update the Glasswing host to hide its duplicate agent rail, pass navigation/profile adapters, and reuse its existing Workspace route.
6. Run focused tests and builds, sync the vendored package, deploy both dev surfaces, and verify end to end in Chrome.
7. Record attempted approaches, failures, corrections, and final evidence in the distributed embed learnings log.
