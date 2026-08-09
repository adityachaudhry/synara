# Glasswing Provider Setup Progress Implementation Plan

## Task 1: Specify the setup-progress derivation

- Add focused tests for active, completed, overlapping, unrelated, and pre-message runtime stages.
- Implement a pure Glasswing presentation helper over `OrchestrationThreadActivity`.
- Verify the helper with the focused Vitest file.

## Task 2: Extend the existing transient working row

- Add a focused row-derivation test proving custom status copy updates the one stable working row.
- Thread an optional working label through `ChatTranscriptPane` and `MessagesTimeline`.
- Preserve `Thinking` as the default outside the adapter path.

## Task 3: Gate the behavior in ChatView

- Memoize setup derivation from the active thread's activities and submitted-message state.
- In Glasswing mode only, keep the transcript working during local dispatch or unresolved runtime setup.
- Pass the setup label to the existing transient working row without adding durable timeline entries.

## Task 4: Verify and package

- Run focused web tests with the bundled Node/Vitest runtime.
- Build the Synara web app and React embed package.
- Sync the package into Glasswing and build the Next.js browser app.

## Task 5: Deliver and verify

- Commit and push the additive Synara v3 branch and Glasswing dev branch.
- Wait for both deployment workflows to succeed.
- In Chrome, create a fresh thread, send the first message, and verify immediate Working/setup progress followed by the provider response.
- Confirm the embedded app remains native React and that warm follow-up behavior still works.
