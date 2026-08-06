# SuperTokens Authentication for Railway v4

**Date:** 2026-07-18
**Status:** Approved design

## Goal

Protect the public Railway v4 Synara deployment with the same passwordless email OTP experience used by Glasswing AI. Any verified `@glasswing.vc` account receives a Synara owner session. Keep the change isolated and preserve Synara's existing session, authorization, and WebSocket behavior.

## Constraints

- Copy the Glasswing authentication page, its `auth-bg.webp` artwork, and its important flow behavior rather than redesigning it.
- Keep Synara's local Docker and native pairing behavior unchanged when SuperTokens is not configured.
- Avoid the existing `/api/auth/*` namespace, which belongs to Synara's native auth control plane.
- Keep the current single-container Synara runtime and its known local-state limitations.
- Continue deploying the Synara service only through the existing GitHub Actions workflow.
- Provision isolated v4 infrastructure; do not reuse v3's database or API key.
- Verify the production OTP using macOS Mail, not Gmail.

## Current System

Synara currently authenticates devices rather than user accounts. A short-lived, one-use pairing credential is exchanged for a signed Synara browser session. That session is persisted in Synara's SQLite database and is used to obtain short-lived WebSocket tickets. Sessions have `owner` or `client` roles and can be listed and revoked.

The current system has no user directory, email delivery, OTP generation, or external identity provider. It remains the authorization and application-session layer after this change.

## Considered Approaches

### Replace Synara auth with SuperTokens

Make SuperTokens sessions authoritative for every HTTP and WebSocket operation. This removes the duplicate session but requires broad changes across Synara's mature request, revocation, and WebSocket paths.

### Put an auth proxy in front of Synara

Gate the public HTTP service outside the application. This does not naturally supply Synara's owner identity or fit its WebSocket ticket lifecycle.

### Bridge SuperTokens into Synara sessions

Use SuperTokens only to verify the Glasswing identity, then issue the existing Synara owner cookie. This is the selected approach because it leaves downstream authorization, revocation, and WebSocket code unchanged.

## Architecture

The integration is enabled only when the required SuperTokens runtime configuration is present.

1. An unauthenticated visitor opens v4.
2. The web bootstrap checks the existing Synara session endpoint.
3. If no Synara session exists and SuperTokens mode is enabled, the browser navigates to `/auth`.
4. The copied Glasswing page starts and consumes the passwordless code through `/api/supertokens/*`.
5. SuperTokens creates its cookie session after a valid OTP.
6. The page calls a narrow exchange endpoint.
7. The server verifies the SuperTokens session and issues a normal 30-day Synara owner cookie whose subject is the verified lowercase email address.
8. The browser navigates to `/`; existing Synara startup and WebSocket behavior continues unchanged.

SuperTokens routes use `/api/supertokens/*`. Synara's existing `/api/auth/*` routes retain their current meanings.

## Backend Design

Add a small SuperTokens integration module to the server that:

- initializes `supertokens-node` once with the custom framework adapter;
- configures Passwordless with email-only `USER_INPUT_CODE` flow;
- rejects code creation unless the normalized address ends in `@glasswing.vc`;
- uses cookie token transfer;
- exposes the SDK endpoints under `/api/supertokens`;
- exposes an exchange operation that requires a valid SuperTokens session, extracts its verified email, and calls Synara's existing session issuance service with `role: "owner"`;
- attaches the resulting Synara session cookie using the existing cookie name and security rules;
- revokes the SuperTokens session when the corresponding Synara browser logs out.

Failures must not grant a Synara session. Invalid domains are rejected before an email is sent. Authentication endpoints remain same-origin and inherit Synara's request-size and origin safeguards where applicable.

## Web Design

Copy the Glasswing page behavior:

- email step followed by six-digit OTP step;
- `@glasswing.vc` messaging and validation errors;
- automatic submission after six digits;
- synchronous guards against duplicate consume requests;
- session-storage restoration of an in-progress flow;
- 30-second resend cooldown;
- change-email and resend controls;
- successful exchange followed by `window.location.replace("/")`.

Copy `web/public/images/auth-bg.webp` to Synara's public assets. Reproduce only the page-local typography, colors, card, and OTP styling needed for visual fidelity; do not import Glasswing's global design system. The existing image already contains the Glasswing Ventures mark.

Render `/auth` before Synara's main application and WebSocket initialization. When SuperTokens is disabled, preserve the current `/pair`, `/signed-out`, and normal bootstrap paths.

## Runtime Configuration

The Synara service receives:

- `SUPERTOKENS_CORE_URL`: private Railway URL for the v4 SuperTokens service;
- `SUPERTOKENS_API_KEY`: a new v4-only random key;
- `SUPERTOKENS_API_DOMAIN`: the v4 Synara public origin;
- `SUPERTOKENS_WEBSITE_DOMAIN`: the same v4 public origin.

The exact enablement check is the presence of a valid Core URL. Partial configuration fails closed at startup with a clear error rather than silently disabling public authentication.

`SYNARA_AUTH_TOKEN` remains configured because the current remote-access safety policy requires it and native pairing remains available as an administrative fallback. It is not exposed to the OTP page.

## Railway v4 Infrastructure

Provision two services in the existing v4 production environment:

- a Railway Postgres service dedicated to SuperTokens;
- a SuperTokens Core service using the same PostgreSQL image family as v3.

Wire the Core's PostgreSQL connection URI from the v4 Postgres service, configure a new API key, disable telemetry if supported by the mirrored v3 configuration, and keep the Core private unless a public domain is required for diagnostics. The Synara container connects over Railway's private network.

No source repository trigger is added to Railway. The existing GitHub Action continues to deploy the Synara service when `glasswingos/main` is pushed; the database and Core remain independent infrastructure services.

## Storage and Scaling Boundary

SuperTokens users and OTP/session state persist in its v4 Postgres database. Synara threads, Synara browser-session records, and Synara's signing secret remain in the single container's local state. A Synara redeploy can therefore require users to authenticate again, and this change does not make Synara horizontally scalable.

Moving Synara state and session signing to shared storage is explicitly deferred to a later stage.

## Verification

Implementation follows test-first development with focused checks:

- allowed and rejected email-domain behavior;
- disabled, partially configured, and enabled runtime modes;
- authenticated exchange issues an owner session with the verified email subject;
- unauthenticated exchange fails without issuing a cookie;
- logout revokes both authentication layers;
- web bootstrap redirects only in SuperTokens mode;
- OTP UI preserves the duplicate-consume, refresh recovery, resend, and success behaviors;
- the existing native pairing tests continue to pass.

After local verification:

1. Provision v4 Postgres and SuperTokens Core.
2. Configure the v4 Synara environment variables.
3. Commit and push the implementation to `glasswingos/main` so GitHub Actions deploys it.
4. Confirm Railway health and inspect service logs.
5. Open the public v4 URL, request an OTP for the authorized Glasswing account, retrieve the code from macOS Mail using computer control, and complete sign-in.
6. Confirm the Synara interface loads, its WebSocket connects, refresh preserves access, logout revokes access, and a new sign-in succeeds.

## Acceptance Criteria

- Unauthenticated v4 visitors see the copied Glasswing OTP page and artwork.
- Non-`@glasswing.vc` addresses cannot receive a code or create a session.
- A valid Glasswing OTP grants a Synara owner session without a pairing link.
- The authenticated Synara interface and WebSocket work normally.
- Logout prevents reuse of both the SuperTokens and Synara sessions.
- Local Docker without SuperTokens configuration behaves exactly as before.
- v4 has isolated, healthy SuperTokens and Postgres services.
- Deployment remains GitHub-Actions-driven.
- Production success is verified with a real OTP from macOS Mail.
