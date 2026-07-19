# SuperTokens Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect Railway v4 with the copied Glasswing passwordless email OTP flow and convert every verified `@glasswing.vc` identity into an existing Synara owner session.

**Architecture:** SuperTokens Core and its dedicated Postgres database own identity and OTP state. The Synara server exposes SuperTokens through a non-conflicting `/api/supertokens/*` namespace, verifies the resulting session, and issues the existing Synara browser cookie; all downstream HTTP authorization, revocation, and WebSocket ticket behavior stays unchanged. SuperTokens mode is runtime-configured and absent by default, so local Docker and native pairing keep their current behavior.

**Tech Stack:** TypeScript, Effect HTTP/Layer services, React 19, Vite, `supertokens-node@^24.0.2`, `input-otp@^1.4.2`, Vitest, Bun, Docker, Railway CLI, GitHub Actions.

## Global Constraints

- Only verified lowercase addresses ending in `@glasswing.vc` may receive a Synara owner session.
- SuperTokens APIs live under `/api/supertokens`; existing `/api/auth/*` semantics must not change.
- Copy `/Users/adityachaudhry/repos/glasswing-ai-2/web/public/images/auth-bg.webp` and the source page's duplicate-consume, session-storage, and resend behavior.
- Do not import Glasswing's global design system or its unused SuperTokens frontend SDKs.
- SuperTokens is enabled only when all four runtime settings are present: Core URL, API key, API domain, and website domain; partial configuration fails startup.
- Local Docker without SuperTokens configuration must retain native `/pair` and `/signed-out` behavior.
- Keep `SYNARA_AUTH_TOKEN` configured in Railway v4 as Synara's remote-publication safety secret and administrative pairing fallback.
- Use isolated v4 Postgres and SuperTokens services; do not reuse v3 state or secrets.
- Keep Railway source deployment disconnected; only the existing GitHub Action deploys the Synara service.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless the user explicitly requests them. Never run `bun test`; use package-scoped commands such as `bun run --cwd apps/server test`.
- Retrieve the production OTP from macOS Mail with computer use, never through Gmail.

---

## File Structure

### New server files

- `apps/server/src/auth/Services/SuperTokensAuth.ts`: Effect service contract, normalized cookie/result types, and typed failures.
- `apps/server/src/auth/Layers/SuperTokensAuth.ts`: one-time SDK initialization, Glasswing-domain restriction, custom-framework request/response adapter, identity lookup, and session revocation.
- `apps/server/src/auth/Layers/SuperTokensAuth.test.ts`: pure configuration/domain tests and adapter tests that do not require a running Core.
- `apps/server/src/auth/superTokensEffectRoute.ts`: `/api/supertokens/*` catch-all, authenticated exchange, origin enforcement, and response-cookie composition.
- `apps/server/src/auth/superTokensEffectRoute.test.ts`: route tests with a fake `SuperTokensAuth` service and in-memory Synara session repository.
- `apps/server/src/config.superTokens.test.ts`: disabled, partial, and enabled runtime configuration tests.

### New web files

- `apps/web/src/superTokensBootstrap.ts`: pre-main session check, `/auth` rendering, and redirect behavior.
- `apps/web/src/superTokensBootstrap.test.ts`: bootstrap behavior without mounting the main application.
- `apps/web/src/superTokensAuth/SuperTokensAuthPage.tsx`: copied two-step Glasswing OTP flow.
- `apps/web/src/superTokensAuth/InputOtp.tsx`: `input-otp` slots styled only for the auth page.
- `apps/web/src/superTokensAuth/flow.ts`: persistence parsing, response mapping, and synchronous single-flight gate.
- `apps/web/src/superTokensAuth/flow.test.ts`: race, persistence, and response-state tests.
- `apps/web/src/superTokensAuth/render.tsx`: standalone React root used before Synara initializes.
- `apps/web/src/superTokensAuth/auth.css`: scoped Glasswing auth-page styles.
- `apps/web/public/images/auth-bg.webp`: copied Glasswing artwork.

### Modified files

- `packages/contracts/src/auth.ts`: optional `externalProvider` descriptor and optional post-logout reauthentication path.
- `apps/server/src/config.ts`: discriminated SuperTokens runtime configuration.
- `apps/server/src/main.ts`: read the four SuperTokens environment variables.
- `apps/server/src/auth/Layers/ServerAuthPolicy.ts`: advertise SuperTokens mode to web bootstrap.
- `apps/server/src/http.ts`: register the SuperTokens route and revoke the SuperTokens session during logout.
- `apps/server/src/serverLayers.ts`: provide the SuperTokens service once.
- `apps/server/src/authEffectRoute.test.ts`: provide a fake SuperTokens service and verify dual logout.
- `apps/server/package.json`, `apps/web/package.json`, `bun.lock`: add only the two required dependencies.
- `apps/web/src/bootstrap.ts`, `apps/web/src/bootstrap.test.ts`: sequence signed-out, pairing, SuperTokens, then main app.
- `apps/web/src/authLogout.ts`, `apps/web/src/authLogout.test.ts`: honor `/auth` returned by SuperTokens-mode logout.

---

### Task 1: Runtime Mode and Public Auth Descriptor

**Files:**
- Create: `apps/server/src/config.superTokens.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `packages/contracts/src/auth.ts`
- Modify: `apps/server/src/auth/Layers/ServerAuthPolicy.ts`

**Interfaces:**
- Produces: `SuperTokensRuntimeConfig`, `resolveSuperTokensRuntimeConfig(input)`, and `ServerAuthDescriptor.externalProvider?: "supertokens"`.
- Consumes: existing `ServerConfig`, `ServerAuthPolicy`, and Effect `Config` parsing.

- [ ] **Step 1: Write the failing runtime-configuration tests**

Create `apps/server/src/config.superTokens.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";

import { resolveSuperTokensRuntimeConfig } from "./config";

describe("resolveSuperTokensRuntimeConfig", () => {
  it("keeps SuperTokens disabled when every setting is absent", () => {
    expect(resolveSuperTokensRuntimeConfig({})).toEqual({ enabled: false });
  });

  it("fails closed when configuration is partial", () => {
    expect(() =>
      resolveSuperTokensRuntimeConfig({ coreUrl: new URL("http://supertokens:3567") }),
    ).toThrow(/SUPERTOKENS_API_KEY/);
  });

  it("normalizes complete configuration", () => {
    const resolved = resolveSuperTokensRuntimeConfig({
      coreUrl: new URL("http://supertokens:3567"),
      apiKey: "v4-secret",
      apiDomain: new URL("https://synara.example.test"),
      websiteDomain: new URL("https://synara.example.test"),
    });

    expect(resolved).toEqual({
      enabled: true,
      coreUrl: "http://supertokens:3567",
      apiKey: "v4-secret",
      apiDomain: "https://synara.example.test",
      websiteDomain: "https://synara.example.test",
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing export fails**

Run:

```bash
bun run --cwd apps/server test src/config.superTokens.test.ts
```

Expected: FAIL because `resolveSuperTokensRuntimeConfig` is not exported.

- [ ] **Step 3: Add the discriminated runtime configuration**

Add to `apps/server/src/config.ts`:

```ts
export type SuperTokensRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly coreUrl: string;
      readonly apiKey: string;
      readonly apiDomain: string;
      readonly websiteDomain: string;
    };

export function resolveSuperTokensRuntimeConfig(input: {
  readonly coreUrl?: URL;
  readonly apiKey?: string;
  readonly apiDomain?: URL;
  readonly websiteDomain?: URL;
}): SuperTokensRuntimeConfig {
  const entries = [
    ["SUPERTOKENS_CORE_URL", input.coreUrl],
    ["SUPERTOKENS_API_KEY", input.apiKey?.trim()],
    ["SUPERTOKENS_API_DOMAIN", input.apiDomain],
    ["SUPERTOKENS_WEBSITE_DOMAIN", input.websiteDomain],
  ] as const;
  if (entries.every(([, value]) => value === undefined || value === "")) {
    return { enabled: false };
  }
  const missing = entries.filter(([, value]) => value === undefined || value === "").map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Incomplete SuperTokens configuration; missing ${missing.join(", ")}.`);
  }
  return {
    enabled: true,
    coreUrl: input.coreUrl!.origin,
    apiKey: input.apiKey!.trim(),
    apiDomain: input.apiDomain!.origin,
    websiteDomain: input.websiteDomain!.origin,
  };
}
```

Add `readonly superTokens: SuperTokensRuntimeConfig` to `ServerConfigShape`. In `apps/server/src/main.ts`, parse these optional values:

```ts
superTokensCoreUrl: Config.url("SUPERTOKENS_CORE_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
superTokensApiKey: Config.string("SUPERTOKENS_API_KEY").pipe(Config.option, Config.map(Option.getOrUndefined)),
superTokensApiDomain: Config.url("SUPERTOKENS_API_DOMAIN").pipe(Config.option, Config.map(Option.getOrUndefined)),
superTokensWebsiteDomain: Config.url("SUPERTOKENS_WEBSITE_DOMAIN").pipe(Config.option, Config.map(Option.getOrUndefined)),
```

Resolve them inside `ServerConfigLive` with `Effect.try`, wrapping a partial-configuration error in `StartupError`, and attach the result as `superTokens` on the final `ServerConfig` object.

- [ ] **Step 4: Advertise the external provider without changing native methods**

Extend `ServerAuthDescriptor` in `packages/contracts/src/auth.ts`:

```ts
externalProvider: Schema.optionalKey(Schema.Literal("supertokens")),
```

In `ServerAuthPolicy.ts`, add only this optional property:

```ts
...(config.superTokens.enabled ? { externalProvider: "supertokens" as const } : {}),
```

Do not remove `one-time-token`, browser cookies, bearer sessions, or pairing behavior.

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun run --cwd apps/server test src/config.superTokens.test.ts src/config.remoteAccess.test.ts src/auth/Layers/ServerAuth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the runtime slice**

```bash
git add apps/server/src/config.superTokens.test.ts apps/server/src/config.ts apps/server/src/main.ts packages/contracts/src/auth.ts apps/server/src/auth/Layers/ServerAuthPolicy.ts
git commit -m "Add optional SuperTokens auth mode"
```

---

### Task 2: SuperTokens SDK Adapter

**Files:**
- Create: `apps/server/src/auth/Services/SuperTokensAuth.ts`
- Create: `apps/server/src/auth/Layers/SuperTokensAuth.ts`
- Create: `apps/server/src/auth/Layers/SuperTokensAuth.test.ts`
- Modify: `apps/server/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `ServerConfig.superTokens`, Effect `HttpServerRequest`, and Effect `HttpServerResponse` cookie APIs.
- Produces: `SuperTokensAuth` with `enabled`, `handleApiRequest`, `verifyRequestSession`, and `revokeRequestSession`.

- [ ] **Step 1: Add the backend SDK dependency**

Run:

```bash
bun add --cwd apps/server supertokens-node@^24.0.2
```

Expected: `apps/server/package.json` and `bun.lock` contain `supertokens-node` without adding any SuperTokens React/browser package.

- [ ] **Step 2: Write failing domain and adapter tests**

Create `apps/server/src/auth/Layers/SuperTokensAuth.test.ts` covering exact-domain matching and cookie conversion:

```ts
import { describe, expect, it } from "vitest";

import {
  isAllowedGlasswingEmail,
  toEffectCookieTuples,
} from "./SuperTokensAuth";

describe("SuperTokensAuth", () => {
  it("accepts Glasswing addresses case-insensitively and rejects suffix tricks", () => {
    expect(isAllowedGlasswingEmail("Person@Glasswing.VC")).toBe(true);
    expect(isAllowedGlasswingEmail("person@glasswing.vc.evil.test")).toBe(false);
    expect(isAllowedGlasswingEmail("glasswing.vc@example.test")).toBe(false);
  });

  it("preserves every cookie attribute returned by SuperTokens", () => {
    expect(
      toEffectCookieTuples([
        {
          key: "sAccessToken",
          value: "token",
          domain: undefined,
          secure: true,
          httpOnly: true,
          expires: 1_800_000_000_000,
          path: "/",
          sameSite: "lax",
        },
      ]),
    ).toEqual([
      [
        "sAccessToken",
        "token",
        {
          secure: true,
          httpOnly: true,
          expires: new Date(1_800_000_000_000),
          path: "/",
          sameSite: "lax",
        },
      ],
    ]);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail on missing modules**

```bash
bun run --cwd apps/server test src/auth/Layers/SuperTokensAuth.test.ts
```

Expected: FAIL because the layer and helpers do not exist.

- [ ] **Step 4: Define the service contract**

Create `apps/server/src/auth/Services/SuperTokensAuth.ts` with these public types:

```ts
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { Cookies, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export type EffectCookieTuple = readonly [
  name: string,
  value: string,
  options?: Cookies.Cookie["options"],
];

export class SuperTokensAuthError extends Data.TaggedError("SuperTokensAuthError")<{
  readonly message: string;
  readonly status: 400 | 401 | 403 | 500 | 503;
  readonly cause?: unknown;
}> {}

export interface VerifiedSuperTokensIdentity {
  readonly email: string;
  readonly responseCookies: ReadonlyArray<EffectCookieTuple>;
}

export interface SuperTokensAuthShape {
  readonly enabled: boolean;
  readonly handleApiRequest: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, SuperTokensAuthError>;
  readonly verifyRequestSession: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<VerifiedSuperTokensIdentity, SuperTokensAuthError>;
  readonly revokeRequestSession: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<ReadonlyArray<EffectCookieTuple>, never>;
}

export class SuperTokensAuth extends ServiceMap.Service<SuperTokensAuth, SuperTokensAuthShape>()(
  "synara/auth/Services/SuperTokensAuth",
) {}
```

- [ ] **Step 5: Implement the live adapter**

Create `apps/server/src/auth/Layers/SuperTokensAuth.ts`. Initialize `supertokens-node` once when `ServerConfig.superTokens.enabled` is true with:

```ts
SuperTokens.init({
  framework: "custom",
  supertokens: {
    connectionURI: config.coreUrl,
    apiKey: config.apiKey,
  },
  appInfo: {
    appName: "Glasswing",
    apiDomain: config.apiDomain,
    websiteDomain: config.websiteDomain,
    apiBasePath: "/api/supertokens",
    websiteBasePath: "/auth",
  },
  recipeList: [
    Passwordless.init({
      contactMethod: "EMAIL",
      flowType: "USER_INPUT_CODE",
      override: {
        apis: (original) => ({
          ...original,
          createCodePOST: async (input) => {
            const email = "email" in input ? input.email : undefined;
            if (!email || !isAllowedGlasswingEmail(email)) {
              return {
                status: "GENERAL_ERROR",
                message: "Access is limited to @glasswing.vc accounts.",
              };
            }
            return original.createCodePOST!(input);
          },
        }),
      },
    }),
    Session.init({ getTokenTransferMethod: () => "cookie" }),
  ],
});
```

Implement `handleApiRequest` with `PreParsedRequest`, `CollectingResponse`, and `middleware()` from `supertokens-node/framework/custom`. Convert the Effect request URL, method, headers, cookies, query, and bounded JSON body into `PreParsedRequest`; convert the collected status, headers, body, and every cookie into `HttpServerResponse`.

Implement `verifyRequestSession` with `Session.getSession(preParsedRequest, collectingResponse)`, `SuperTokens.getUser(session.getUserId())`, `user.emails[0]?.trim().toLowerCase()`, and a second `isAllowedGlasswingEmail` check. Return the response cookies collected during verification.

Implement `revokeRequestSession` with `Session.getSession(..., { sessionRequired: false })`; call `session?.revokeSession()` and return the resulting expired SuperTokens cookies. In disabled mode, API handling and verification return 404/503 typed failures while revocation returns an empty array.

The exported helpers must be exact:

```ts
export const ALLOWED_EMAIL_DOMAIN = "glasswing.vc";

export function isAllowedGlasswingEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at > 0 && normalized.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}

export function toEffectCookieTuples(
  cookies: ReadonlyArray<CookieInfo>,
): ReadonlyArray<EffectCookieTuple> {
  return cookies.map((cookie) => [
    cookie.key,
    cookie.value,
    {
      ...(cookie.domain ? { domain: cookie.domain } : {}),
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expires: new Date(cookie.expires),
      path: cookie.path,
      sameSite: cookie.sameSite,
    },
  ] as const);
}
```

- [ ] **Step 6: Run focused adapter tests and build the server**

```bash
bun run --cwd apps/server test src/auth/Layers/SuperTokensAuth.test.ts
bun run --cwd apps/server build
```

Expected: PASS and a successful server build.

- [ ] **Step 7: Commit the adapter slice**

```bash
git add apps/server/package.json bun.lock apps/server/src/auth/Services/SuperTokensAuth.ts apps/server/src/auth/Layers/SuperTokensAuth.ts apps/server/src/auth/Layers/SuperTokensAuth.test.ts
git commit -m "Add SuperTokens server adapter"
```

---

### Task 3: OTP Exchange, Synara Owner Cookie, and Dual Logout

**Files:**
- Create: `apps/server/src/auth/superTokensEffectRoute.ts`
- Create: `apps/server/src/auth/superTokensEffectRoute.test.ts`
- Modify: `apps/server/src/http.ts`
- Modify: `apps/server/src/serverLayers.ts`
- Modify: `apps/server/src/authEffectRoute.test.ts`
- Modify: `packages/contracts/src/auth.ts`

**Interfaces:**
- Consumes: `SuperTokensAuth`, `SessionCredentialService.issue`, `deriveAuthClientMetadata`, and `ServerConfig.publicUrl`.
- Produces: `POST /api/supertokens/exchange`, proxied SuperTokens recipe routes, and `AuthLogoutResult.reauthPath?: "/auth"`.

- [ ] **Step 1: Write failing route tests with a fake identity provider**

In `apps/server/src/auth/superTokensEffectRoute.test.ts`, construct an Effect HTTP server with fake `SuperTokensAuth`, real in-memory `SessionCredentialService`, and `ServerConfig`. Cover these assertions:

```ts
expect((await fetch(`${origin}/api/supertokens/exchange`, {
  method: "POST",
  headers: { Origin: origin },
})).status).toBe(401);

expect((await fetch(`${origin}/api/supertokens/exchange`, {
  method: "POST",
  headers: { Origin: "https://evil.example.test" },
})).status).toBe(403);

const response = await fetch(`${origin}/api/supertokens/exchange`, {
  method: "POST",
  headers: { Origin: origin, Cookie: "sAccessToken=valid" },
});
expect(response.status).toBe(200);
expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("synara_session="))).toBe(true);
expect(await response.json()).toMatchObject({
  authenticated: true,
  role: "owner",
  subject: "person@glasswing.vc",
});
```

Also assert that a disabled provider returns 404 for `/api/supertokens/signinup/code` and that a fake handled recipe route preserves multiple `Set-Cookie` headers.

- [ ] **Step 2: Run the route test and confirm the missing layer fails**

```bash
bun run --cwd apps/server test src/auth/superTokensEffectRoute.test.ts
```

Expected: FAIL because `superTokensEffectRouteLayer` does not exist.

- [ ] **Step 3: Implement the SuperTokens catch-all and exchange**

Create `apps/server/src/auth/superTokensEffectRoute.ts` as one `HttpRouter.add("*", "/api/supertokens/*", ...)` layer. Route `/api/supertokens/exchange` before forwarding other paths.

The exchange implementation must:

```ts
const identity = yield* superTokens.verifyRequestSession(request);
const issued = yield* sessions.issue({
  method: "browser-session-cookie",
  subject: identity.email,
  role: "owner",
  client: deriveAuthClientMetadata({
    headers: request.headers,
    remoteAddress: request.remoteAddress ?? null,
  }),
});

const response = HttpServerResponse.jsonUnsafe({
  authenticated: true,
  role: "owner",
  subject: identity.email,
  expiresAt: DateTime.toUtc(issued.expiresAt),
});

return HttpServerResponse.setCookiesUnsafe(response, [
  ...identity.responseCookies,
  [
    sessions.cookieName,
    issued.token,
    {
      expires: DateTime.toDate(issued.expiresAt),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: config.publicUrl !== undefined,
    },
  ],
]);
```

Require a trusted same-origin `Origin` before calling `verifyRequestSession`. Map `SuperTokensAuthError.status` to the HTTP response and never issue a Synara session after a provider failure.

- [ ] **Step 4: Register and provide the route**

Add `superTokensEffectRouteLayer` before `authEffectRouteLayer` in `makeEffectHttpRouteLayer`. Add `SuperTokensAuthLive` to `authServicesLayer` in `serverLayers.ts`, providing `ServerConfig` through the existing runtime layer.

- [ ] **Step 5: Write the failing dual-logout test**

Extend `apps/server/src/authEffectRoute.test.ts` so its fake `SuperTokensAuth.revokeRequestSession` increments a counter and returns an expired `sAccessToken` cookie. Assert:

```ts
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ revoked: true, reauthPath: "/auth" });
expect(superTokensRevocations.count).toBe(1);
expect(response.headers.getSetCookie()).toEqual(
  expect.arrayContaining([
    expect.stringContaining("synara_session="),
    expect.stringContaining("sAccessToken="),
  ]),
);
```

Retain the existing expectation for native mode: `{ revoked: true }` and only the Synara cookie is cleared.

- [ ] **Step 6: Implement dual logout and its contract**

Extend `AuthLogoutResult` in `packages/contracts/src/auth.ts`:

```ts
reauthPath: Schema.optionalKey(Schema.Literal("/auth")),
```

In `/api/auth/logout`, call `superTokens.revokeRequestSession(request)` only when enabled, revoke the Synara session, and set all expired cookies in one Effect response. Return:

```ts
{
  revoked,
  ...(superTokens.enabled ? { reauthPath: "/auth" as const } : {}),
}
```

- [ ] **Step 7: Run focused server auth tests**

```bash
bun run --cwd apps/server test src/auth/superTokensEffectRoute.test.ts src/authEffectRoute.test.ts src/auth/Layers/ServerAuth.test.ts src/wsRpc.auth.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the route and bridge slice**

```bash
git add apps/server/src/auth/superTokensEffectRoute.ts apps/server/src/auth/superTokensEffectRoute.test.ts apps/server/src/http.ts apps/server/src/serverLayers.ts apps/server/src/authEffectRoute.test.ts packages/contracts/src/auth.ts
git commit -m "Bridge SuperTokens into Synara sessions"
```

---

### Task 4: Copied Glasswing Authentication Page and Bootstrap

**Files:**
- Create: `apps/web/src/superTokensBootstrap.ts`
- Create: `apps/web/src/superTokensBootstrap.test.ts`
- Create: `apps/web/src/superTokensAuth/SuperTokensAuthPage.tsx`
- Create: `apps/web/src/superTokensAuth/InputOtp.tsx`
- Create: `apps/web/src/superTokensAuth/flow.ts`
- Create: `apps/web/src/superTokensAuth/flow.test.ts`
- Create: `apps/web/src/superTokensAuth/render.tsx`
- Create: `apps/web/src/superTokensAuth/auth.css`
- Create: `apps/web/public/images/auth-bg.webp`
- Modify: `apps/web/src/bootstrap.ts`
- Modify: `apps/web/src/bootstrap.test.ts`
- Modify: `apps/web/src/authLogout.ts`
- Modify: `apps/web/src/authLogout.test.ts`
- Modify: `apps/web/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `GET /api/auth/session`, SuperTokens code endpoints, `POST /api/supertokens/exchange`, and `AuthLogoutResult.reauthPath`.
- Produces: `bootstrapSuperTokensAuth()`, standalone `/auth` rendering, and the copied email/code flow.

- [ ] **Step 1: Add the OTP dependency and copy the artwork**

Run:

```bash
bun add --cwd apps/web input-otp@^1.4.2
mkdir -p apps/web/public/images
cp /Users/adityachaudhry/repos/glasswing-ai-2/web/public/images/auth-bg.webp apps/web/public/images/auth-bg.webp
```

Expected: only `input-otp` is added to the web package, and the copied image has the same SHA-256 digest as the source:

```bash
shasum -a 256 /Users/adityachaudhry/repos/glasswing-ai-2/web/public/images/auth-bg.webp apps/web/public/images/auth-bg.webp
```

- [ ] **Step 2: Write failing flow tests**

Create `apps/web/src/superTokensAuth/flow.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createConsumeGate, parsePersistedFlow, verificationErrorMessage } from "./flow";

describe("SuperTokens auth flow", () => {
  it("admits only one consume until the current request finishes", () => {
    const gate = createConsumeGate();
    expect(gate.enter()).toBe(true);
    expect(gate.enter()).toBe(false);
    gate.leave();
    expect(gate.enter()).toBe(true);
    gate.markConsumed();
    gate.leave();
    expect(gate.enter()).toBe(false);
  });

  it("restores only a complete code flow", () => {
    expect(parsePersistedFlow('{"step":"code","email":"person@glasswing.vc","device":{"deviceId":"d","preAuthSessionId":"p"}}')).toEqual({
      step: "code",
      email: "person@glasswing.vc",
      device: { deviceId: "d", preAuthSessionId: "p" },
    });
    expect(parsePersistedFlow("not-json")).toBeNull();
    expect(parsePersistedFlow('{"step":"code"}')).toBeNull();
  });

  it("maps SuperTokens verification failures to Glasswing copy", () => {
    expect(verificationErrorMessage("INCORRECT_USER_INPUT_CODE_ERROR")).toBe("That code isn't right. Try again.");
    expect(verificationErrorMessage("EXPIRED_USER_INPUT_CODE_ERROR")).toBe("That code expired — request a new one.");
    expect(verificationErrorMessage("RESTART_FLOW_ERROR")).toBe("This sign-in session expired — we'll send a fresh code.");
  });
});
```

- [ ] **Step 3: Run the flow test and confirm missing helpers fail**

```bash
bun run --cwd apps/web test src/superTokensAuth/flow.test.ts
```

Expected: FAIL because `flow.ts` does not exist.

- [ ] **Step 4: Implement deterministic flow helpers**

Create `flow.ts` with the exact gate used by the component:

```ts
export type AuthStep = "email" | "code";
export type AuthDevice = { readonly deviceId: string; readonly preAuthSessionId: string };
export type PersistedAuthFlow = { readonly step: "code"; readonly email: string; readonly device: AuthDevice };

export function createConsumeGate() {
  let inFlight = false;
  let consumed = false;
  return {
    enter() {
      if (inFlight || consumed) return false;
      inFlight = true;
      return true;
    },
    leave() {
      inFlight = false;
    },
    markConsumed() {
      consumed = true;
    },
    reset() {
      inFlight = false;
      consumed = false;
    },
  };
}

export function parsePersistedFlow(raw: string | null): PersistedAuthFlow | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedAuthFlow>;
    if (
      value.step !== "code" ||
      typeof value.email !== "string" ||
      typeof value.device?.deviceId !== "string" ||
      typeof value.device.preAuthSessionId !== "string"
    ) return null;
    return { step: "code", email: value.email, device: value.device as AuthDevice };
  } catch {
    return null;
  }
}

export function verificationErrorMessage(status: string): string {
  if (status === "INCORRECT_USER_INPUT_CODE_ERROR") return "That code isn't right. Try again.";
  if (status === "EXPIRED_USER_INPUT_CODE_ERROR") return "That code expired — request a new one.";
  if (status === "RESTART_FLOW_ERROR") return "This sign-in session expired — we'll send a fresh code.";
  return "Couldn't verify the code.";
}
```

- [ ] **Step 5: Write failing bootstrap and logout tests**

Create `superTokensBootstrap.test.ts` using injected `fetch`, `location`, and `renderAuth` dependencies. Assert:

```ts
expect(await bootstrapSuperTokensAuth(authRouteDependencies)).toBe("handled");
expect(renderAuth).toHaveBeenCalledTimes(1);

expect(await bootstrapSuperTokensAuth(unauthenticatedExternalDependencies)).toBe("redirecting");
expect(location.replace).toHaveBeenCalledWith("/auth");

expect(await bootstrapSuperTokensAuth(nativePairingDependencies)).toBe("continue");
expect(location.replace).not.toHaveBeenCalled();
```

Extend `authLogout.test.ts` so `{ revoked: true, reauthPath: "/auth" }` navigates to `/auth`, while `{ revoked: true }` still navigates to `/signed-out`.

- [ ] **Step 6: Implement bootstrap sequencing**

`bootstrapSuperTokensAuth` returns `"continue" | "handled" | "redirecting"`. On `/auth`, dynamically import `./superTokensAuth/render` and render immediately. On other paths, fetch `/api/auth/session` with `credentials: "same-origin"`; redirect only when `authenticated === false` and `auth.externalProvider === "supertokens"`.

Update `bootstrap.ts` to preserve this exact order:

```ts
if (!bootstrapSignedOutScreen()) {
  void bootstrapPairingSession().then(async (pairingResult) => {
    if (pairingResult !== "not-pairing") return;
    const superTokensResult = await bootstrapSuperTokensAuth();
    if (superTokensResult === "continue") {
      await import("./main");
    }
  });
}
```

Update `bootstrap.test.ts` to assert the SuperTokens bootstrap appears after pairing and before `import("./main")`.

Update `logoutCurrentBrowserSession` to read the logout result:

```ts
const result = (await input.logout()) as { readonly reauthPath?: string };
input.navigate(result.reauthPath ?? AUTH_SIGNED_OUT_PATH);
```

- [ ] **Step 7: Implement the copied auth page**

Port the source page from `/Users/adityachaudhry/repos/glasswing-ai-2/web/src/app/auth/[[...path]]/page.tsx` into `SuperTokensAuthPage.tsx`, changing only these integration points:

```ts
const STORAGE_KEY = "gw_auth_flow";
const RESEND_COOLDOWN_S = 30;
const CREATE_CODE_PATH = "/api/supertokens/signinup/code";
const CONSUME_CODE_PATH = "/api/supertokens/signinup/code/consume";
const EXCHANGE_PATH = "/api/supertokens/exchange";
```

After consume returns `status: "OK"`, synchronously mark the gate consumed, then require a successful exchange before navigating:

```ts
gate.markConsumed();
const exchange = await fetch(EXCHANGE_PATH, {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
});
if (!exchange.ok) throw new Error("Synara session exchange failed.");
sessionStorage.removeItem(STORAGE_KEY);
window.location.replace("/");
```

Use `InputOTP`, six slots, `onComplete`, and the source race semantics. Keep the source heading, explanatory copy, placeholder, resend cooldown, change-email control, and errors.

`render.tsx` must call `ReactDOM.createRoot(document.getElementById("root")!).render(<SuperTokensAuthPage />)` and import `auth.css`. `auth.css` must be fully scoped under `.gw-auth` except the temporary `html.gw-auth-document` overscroll/background rule applied and removed by the renderer. Reproduce the warm `#f4f2f0` canvas, red `#d90a2e` action color, translucent white card, backdrop blur, serif heading, six OTP slots, focus rings, and `/images/auth-bg.webp` full-bleed image.

- [ ] **Step 8: Run focused web tests and build**

```bash
bun run --cwd apps/web test src/superTokensAuth/flow.test.ts src/superTokensBootstrap.test.ts src/bootstrap.test.ts src/authLogout.test.ts
bun run --cwd apps/web build
```

Expected: PASS and a successful Vite build containing `dist/images/auth-bg.webp`.

- [ ] **Step 9: Commit the web slice**

```bash
git add apps/web/package.json bun.lock apps/web/src/bootstrap.ts apps/web/src/bootstrap.test.ts apps/web/src/authLogout.ts apps/web/src/authLogout.test.ts apps/web/src/superTokensBootstrap.ts apps/web/src/superTokensBootstrap.test.ts apps/web/src/superTokensAuth apps/web/public/images/auth-bg.webp
git commit -m "Add Glasswing passwordless auth page"
```

---

### Task 5: Local Regression and Container Verification

**Files:**
- Verify: `Dockerfile`
- Verify: `docker-compose.yml`
- Verify: all files changed in Tasks 1–4

**Interfaces:**
- Consumes: the completed runtime, server adapter, exchange route, and web page.
- Produces: a locally verified image with native auth unchanged when SuperTokens variables are absent.

- [ ] **Step 1: Run the complete focused auth suite once**

```bash
bun run --cwd apps/server test src/config.superTokens.test.ts src/auth/Layers/SuperTokensAuth.test.ts src/auth/superTokensEffectRoute.test.ts src/authEffectRoute.test.ts src/auth/Layers/ServerAuth.test.ts src/auth/Layers/BootstrapCredentialService.test.ts src/auth/Layers/SessionCredentialService.test.ts src/wsRpc.auth.test.ts
bun run --cwd apps/web test src/superTokensAuth/flow.test.ts src/superTokensBootstrap.test.ts src/bootstrap.test.ts src/pairingBootstrap.test.ts src/authLogout.test.ts src/authSignedOut.test.ts
```

Expected: PASS. Do not substitute `bun test`.

- [ ] **Step 2: Build both packages**

```bash
bun run --cwd apps/web build
bun run --cwd apps/server build
```

Expected: both builds succeed.

- [ ] **Step 3: Build the production container**

```bash
docker build --tag synara:supertokens-v4 .
```

Expected: frozen Bun install and both application builds succeed; the final image is created.

- [ ] **Step 4: Confirm native local behavior without host volumes or SuperTokens settings**

Run the image with a fresh Docker-managed writable layer and only the existing Anthropic key injection method. Do not mount the repository or host state. Verify:

```bash
curl --fail http://localhost:3773/health
curl --fail http://localhost:3773/api/auth/session
curl --fail http://localhost:3773/images/auth-bg.webp
```

Expected: health is 200, auth descriptor has no `externalProvider`, native session behavior remains available, and the copied image is served.

- [ ] **Step 5: Review the diff for scope and secrets**

```bash
git diff HEAD~4 --stat
git diff --check
git status --short
rg -n "SUPERTOKENS_API_KEY=|API_KEYS=" . --glob '!docs/superpowers/plans/**' --glob '!bun.lock'
```

Expected: no committed secret values, no unrelated code, and no whitespace errors.

- [ ] **Step 6: Route any corrective edit back through its owning test cycle**

If verification exposes a defect, return to the Task 1–4 test that owns the behavior, add or strengthen the failing regression test, implement the correction, rerun that task's listed test command, and amend that task with a new focused commit. If no corrective edit is needed, create no empty commit.

---

### Task 6: Railway v4 Infrastructure, GitHub Deployment, and Real OTP Verification

**Files:**
- Verify unchanged: `.github/workflows/deploy-railway.yml`
- External state: Railway project `70cd8885-7ac3-49eb-81e0-7f07da44e633`, production environment, Synara service `60bc8a2e-430f-4b67-b410-e172096d4643`

**Interfaces:**
- Consumes: committed implementation, Railway CLI authentication, existing project-scoped GitHub Actions token, and macOS Mail.
- Produces: isolated v4 Postgres/Core services and a production-verified Glasswing login.

- [ ] **Step 1: Reconfirm deployment target and disconnected source**

```bash
railway status --json
railway service list --json
```

Expected: project name `v4`, production environment, and service `synara`. Stop if the project or environment differs.

- [ ] **Step 2: Provision isolated database and Core services**

First list services and create only missing names:

```bash
railway add --database postgres --json
railway add --image registry.supertokens.io/supertokens/supertokens-postgresql:latest --service supertokens --json
```

Expected: one v4 Postgres service and one v4 `supertokens` service. Do not create a second service if a prior interrupted run already created it.

- [ ] **Step 3: Configure private service wiring and a new v4 key**

Generate one new 32-byte hexadecimal value locally without printing it, send it to Railway over stdin, and remove the temporary file immediately:

```bash
supertokens_v4_secret_file="$(mktemp -t synara-v4-supertokens-key.XXXXXX)"
openssl rand -hex 32 > "$supertokens_v4_secret_file"
railway variable set --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --service supertokens --skip-deploys --stdin API_KEYS < "$supertokens_v4_secret_file"
rm -f "$supertokens_v4_secret_file"
unset supertokens_v4_secret_file
```

Set the remaining Core variables with `--skip-deploys`:

```bash
railway variable set --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --service supertokens --skip-deploys 'POSTGRESQL_CONNECTION_URI=${{Postgres.DATABASE_URL}}' DISABLE_TELEMETRY=true SUPERTOKENS_PORT=3567
```

Reference the same Core key from Synara rather than copying it into a second plaintext command:

```bash
railway variable set --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --service synara --skip-deploys 'SUPERTOKENS_CORE_URL=http://${{supertokens.RAILWAY_PRIVATE_DOMAIN}}:3567' 'SUPERTOKENS_API_KEY=${{supertokens.API_KEYS}}' SUPERTOKENS_API_DOMAIN=https://synara-production-23db.up.railway.app SUPERTOKENS_WEBSITE_DOMAIN=https://synara-production-23db.up.railway.app
```

Expected: Railway stores references, not duplicated database credentials or API-key literals. Do not output raw variable JSON.

- [ ] **Step 4: Start and verify the Core**

```bash
railway redeploy --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --service supertokens --yes --json
railway service status --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --service supertokens --json
railway logs --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --service supertokens --lines 100
```

Expected: latest SuperTokens deployment is `SUCCESS`, connects to Postgres, and has no startup errors.

- [ ] **Step 5: Confirm GitHub Actions remains the only Synara deployment trigger**

Inspect the Synara service status and source. Expected: no Railway GitHub repository source is attached. Do not modify `.github/workflows/deploy-railway.yml` because it already deploys pushes to `glasswingos/main` with the project token.

- [ ] **Step 6: Push implementation and watch GitHub Actions**

```bash
git status --short --branch
git push origin glasswingos/main
github_run_id="$(gh run list --workflow deploy-railway.yml --branch glasswingos/main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$github_run_id" --exit-status
unset github_run_id
```

Expected: push succeeds and the newest `Deploy to Railway` run concludes `success` for the pushed commit.

- [ ] **Step 7: Verify live service health and logs**

```bash
curl --fail https://synara-production-23db.up.railway.app/health
railway service status --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --service synara --json
railway logs --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --service synara --lines 150
```

Expected: Synara is healthy, logs show SuperTokens mode initialized, and no Core-connection or route errors appear.

- [ ] **Step 8: Complete real browser and Mail OTP verification**

Before GUI interaction, read and follow the `computer-use:computer-use` skill in full. Open the public v4 URL and verify:

1. An unauthenticated browser is redirected to `/auth`.
2. The copied butterfly background and Glasswing card render correctly at desktop and narrow widths.
3. A non-Glasswing email receives the domain error and no code.
4. Request a code for the authorized `@glasswing.vc` account.
5. Use computer control to open macOS Mail, locate the newest SuperTokens message, read the six-digit code, and enter it in the browser.
6. Confirm the browser reaches `/`, the Synara interface loads, and its WebSocket stays connected after refresh.
7. Log out and confirm `/auth` is shown and the prior Synara session cannot reopen the app.
8. Request one fresh code and confirm a second login succeeds.

- [ ] **Step 9: Final repository and deployment evidence**

```bash
git status --short --branch
git log --oneline --decorate -8
railway service status --project 70cd8885-7ac3-49eb-81e0-7f07da44e633 --environment production --json
```

Expected: working tree clean, `glasswingos/main` matches its remote, and Synara, SuperTokens, and Postgres are healthy.

Record the production URL, deployed commit, GitHub Actions run URL, Railway service statuses, and the verified OTP/login/logout outcome in the final handoff. Never include the OTP or any secret value.
