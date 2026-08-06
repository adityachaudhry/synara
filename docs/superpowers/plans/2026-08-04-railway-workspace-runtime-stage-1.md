# Railway Workspace Runtime Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and validate the provider-neutral Railway Sandbox lifecycle substrate required for a future remote Pi adapter, while leaving every existing provider session on the current local path.

**Architecture:** Provider-scoped settings declare the desired execution target, but Stage 1 does not route `ProviderService` remotely. A generic `WorkspaceRuntime` owns lifecycle semantics and delegates Railway API calls through an injectable `RailwaySandboxClient`; the live client is the only module importing Railway's experimental SDK. Real `v4` smoke trials exercise create, exec, detach/reconnect where available, keepalive, and teardown, with every result appended to the engineering journal.

**Tech Stack:** TypeScript, Effect services/layers, Effect Schema, Vitest, Railway TypeScript SDK 3.7.0, Railway CLI 5.15.0, Bun 1.3.12, Node 24.

## Global Constraints

- Browser/server deployment only; Electron and desktop packaging are out of scope.
- Existing provider behavior remains local by default and is not replaced.
- New contracts remain provider-neutral; Railway implementation details stay server-side.
- Railway credentials are environment-only and never enter public server settings.
- Distributed selection fails closed when configuration is incomplete; it never silently runs locally.
- No provider/model call occurs in Stage 1 Railway trials.
- Every external trial has a bounded resource count and verifies teardown.
- Record failed attempts, causes, and corrections in `docs/distributed-runtime/railway-v4-trial-log.md`.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` without explicit user authorization.

---

## File Structure

- `packages/contracts/src/settings.ts`: add the decoded Pi execution target setting.
- `packages/contracts/src/settings.test.ts`: prove backward-compatible defaults and patch decoding.
- `apps/server/src/workspaceRuntime/railwaySandboxConfig.ts`: resolve and redact server-only Railway configuration.
- `apps/server/src/workspaceRuntime/railwaySandboxConfig.test.ts`: cover disabled, complete, and partial configuration.
- `apps/server/src/workspaceRuntime/Errors.ts`: typed lifecycle and configuration failures.
- `apps/server/src/workspaceRuntime/Services/WorkspaceRuntime.ts`: provider-neutral runtime contract.
- `apps/server/src/workspaceRuntime/Services/RailwaySandboxClient.ts`: minimal injectable Railway SDK boundary.
- `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.ts`: lifecycle implementation, state validation, and cleanup semantics.
- `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.test.ts`: fake-client behavioral tests.
- `apps/server/src/workspaceRuntime/Layers/RailwaySandboxClient.ts`: live Railway SDK adapter.
- `apps/server/src/workspaceRuntime/Layers/RailwaySandboxClient.test.ts`: SDK-shape adapter tests with injected constructors.
- `apps/server/src/workspaceRuntime/smoke.ts`: bounded lifecycle smoke program used manually against `v4`.
- `apps/server/package.json`, `bun.lock`: pin Railway SDK 3.7.0.
- `docs/distributed-runtime/railway-v4-trial-log.md`: append every real and local trial result.

### Task 1: Backward-compatible Pi execution setting

**Files:**
- Modify: `packages/contracts/src/settings.ts`
- Create: `packages/contracts/src/settings.test.ts`

**Interfaces:**
- Produces: `ProviderExecutionTarget = "local" | "railway-sandbox"`.
- Produces: `ServerSettings.providers.pi.executionTarget` with decoding default `"local"`.
- Produces: `ServerSettingsPatch.providers.pi.executionTarget` as an optional field.

- [ ] **Step 1: Write the failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ServerSettings, ServerSettingsPatch } from "./settings";

describe("Pi execution target settings", () => {
  it("decodes legacy settings to local execution", () => {
    const decoded = Schema.decodeUnknownSync(ServerSettings)({ providers: { pi: {} } });
    expect(decoded.providers.pi.executionTarget).toBe("local");
  });

  it("accepts railway-sandbox in settings and patches", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      providers: { pi: { executionTarget: "railway-sandbox" } },
    });
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      providers: { pi: { executionTarget: "railway-sandbox" } },
    });
    expect(settings.providers.pi.executionTarget).toBe("railway-sandbox");
    expect(patch.providers?.pi?.executionTarget).toBe("railway-sandbox");
  });

  it("rejects unknown execution targets", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerSettings)({
        providers: { pi: { executionTarget: "shared-vm" } },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun run --cwd packages/contracts test -- src/settings.test.ts`

Expected: FAIL because `executionTarget` is absent after decoding.

- [ ] **Step 3: Add the minimal schema**

```ts
export const ProviderExecutionTarget = Schema.Literals(["local", "railway-sandbox"]);
export type ProviderExecutionTarget = typeof ProviderExecutionTarget.Type;

export const PiServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "pi")),
  agentDir: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  executionTarget: ProviderExecutionTarget.pipe(
    Schema.withDecodingDefault(() => "local"),
  ),
});
```

Add `executionTarget: Schema.optionalKey(ProviderExecutionTarget)` to the Pi patch schema.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `bun run --cwd packages/contracts test -- src/settings.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Prove persisted server-settings round trip**

Add an assertion to `apps/server/src/serverSettings.test.ts` that updates Pi to `railway-sandbox`, reads the persisted JSON, and reloads the setting through `ServerSettingsLive`.

Run: `bun run --cwd apps/server test -- src/serverSettings.test.ts`

Expected: existing settings tests and the new round-trip assertion pass.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts apps/server/src/serverSettings.test.ts
git commit -m "feat: add Pi execution target setting"
```

### Task 2: Server-only Railway configuration

**Files:**
- Create: `apps/server/src/workspaceRuntime/railwaySandboxConfig.ts`
- Create: `apps/server/src/workspaceRuntime/railwaySandboxConfig.test.ts`

**Interfaces:**
- Produces: `RailwaySandboxRuntimeConfig`, a disabled/enabled discriminated union.
- Produces: `resolveRailwaySandboxRuntimeConfig(input)`.
- Produces: `describeRailwaySandboxRuntimeConfig(config)` with no token.

- [ ] **Step 1: Write failing configuration tests**

```ts
describe("resolveRailwaySandboxRuntimeConfig", () => {
  it("disables the runtime when all values are absent", () => {
    expect(resolveRailwaySandboxRuntimeConfig({})).toEqual({ enabled: false });
  });

  it("normalizes a complete configuration", () => {
    expect(
      resolveRailwaySandboxRuntimeConfig({
        token: " secret ",
        environmentId: " env-1 ",
        region: " us-east4-eqdc4a ",
        idleTimeoutMinutes: "30",
      }),
    ).toEqual({
      enabled: true,
      token: "secret",
      environmentId: "env-1",
      region: "us-east4-eqdc4a",
      idleTimeoutMinutes: 30,
    });
  });

  it("fails closed for partial configuration", () => {
    expect(() =>
      resolveRailwaySandboxRuntimeConfig({ environmentId: "env-1" }),
    ).toThrow(/SYNARA_RAILWAY_SANDBOX_TOKEN/);
  });

  it("redacts the token from diagnostics", () => {
    const config = resolveRailwaySandboxRuntimeConfig({
      token: "secret",
      environmentId: "env-1",
    });
    expect(JSON.stringify(describeRailwaySandboxRuntimeConfig(config))).not.toContain("secret");
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun run --cwd apps/server test -- src/workspaceRuntime/railwaySandboxConfig.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict resolution**

Implement a pure resolver with these exact rules:

```ts
export type RailwaySandboxRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly token: string;
      readonly environmentId: string;
      readonly region?: string;
      readonly idleTimeoutMinutes: number;
    };
```

- Empty token and environment ID together produce `{ enabled: false }`.
- Exactly one missing required value throws and names the missing environment key.
- Idle timeout defaults to 30 and must be an integer from 1 through 120.
- Blank region becomes `undefined`.
- Diagnostic description returns `enabled`, `environmentId`, `region`, and `idleTimeoutMinutes`, never `token`.

- [ ] **Step 4: Run and verify GREEN**

Run: `bun run --cwd apps/server test -- src/workspaceRuntime/railwaySandboxConfig.test.ts`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/workspaceRuntime/railwaySandboxConfig.ts apps/server/src/workspaceRuntime/railwaySandboxConfig.test.ts
git commit -m "feat: resolve Railway sandbox configuration"
```

### Task 3: Provider-neutral workspace lifecycle

**Files:**
- Create: `apps/server/src/workspaceRuntime/Errors.ts`
- Create: `apps/server/src/workspaceRuntime/Services/WorkspaceRuntime.ts`
- Create: `apps/server/src/workspaceRuntime/Services/RailwaySandboxClient.ts`
- Create: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.ts`
- Create: `apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.test.ts`

**Interfaces:**
- Consumes: `RailwaySandboxRuntimeConfig` from Task 2.
- Produces: `WorkspaceRuntimeShape.create`, `.connect`, `.exec`, `.keepAlive`, `.destroy`, and `.list`.
- Produces: `RailwaySandboxClientShape` with the same low-level lifecycle operations but Railway-native IDs/status.

- [ ] **Step 1: Write failing behavior tests with a stateful fake client**

Cover these behaviors separately:

```ts
it.effect("creates a private sandbox with bounded idle timeout", () => /* assert create input */);
it.effect("connects only to a running sandbox", () => /* stopped status fails */);
it.effect("keepAlive executes a side-effect-free true command", () => /* assert exec */);
it.effect("destroy is idempotent when Railway reports not found", () => /* no failure */);
it.effect("destroys a created sandbox when initialization fails", () => /* cleanup asserted */);
it.effect("refuses all calls when runtime configuration is disabled", () => /* typed error */);
```

The production change that makes each test pass is the `WorkspaceRuntime` lifecycle implementation; do not assert only that mocks were called. The fake must transition sandbox records through `CREATING`, `RUNNING`, and `DESTROYED` so tests observe state.

- [ ] **Step 2: Run and verify RED**

Run: `bun run --cwd apps/server test -- src/workspaceRuntime/Layers/WorkspaceRuntime.test.ts`

Expected: FAIL because the services and layer do not exist.

- [ ] **Step 3: Define the minimal provider-neutral contract**

```ts
export interface WorkspaceRuntimeBinding {
  readonly runtimeKind: "railway-sandbox";
  readonly runtimeId: string;
  readonly lifecycleGeneration: string;
  readonly status: "creating" | "running" | "destroyed";
  readonly region: string;
}

export interface WorkspaceRuntimeCreateInput {
  readonly lifecycleGeneration: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface WorkspaceRuntimeShape {
  readonly create: (input: WorkspaceRuntimeCreateInput) => Effect.Effect<WorkspaceRuntimeBinding, WorkspaceRuntimeError>;
  readonly connect: (binding: WorkspaceRuntimeBinding) => Effect.Effect<WorkspaceRuntimeBinding, WorkspaceRuntimeError>;
  readonly exec: (binding: WorkspaceRuntimeBinding, input: { command: string; cwd?: string; timeoutSeconds?: number }) => Effect.Effect<WorkspaceExecResult, WorkspaceRuntimeError>;
  readonly keepAlive: (binding: WorkspaceRuntimeBinding) => Effect.Effect<void, WorkspaceRuntimeError>;
  readonly destroy: (binding: WorkspaceRuntimeBinding) => Effect.Effect<void, WorkspaceRuntimeError>;
  readonly list: Effect.Effect<ReadonlyArray<WorkspaceRuntimeBinding>, WorkspaceRuntimeError>;
}
```

Keep `threadId`, `provider`, and provider command concepts out of this interface. They belong to the remote adapter in Stage 2.

- [ ] **Step 4: Implement lifecycle behavior**

- Always create with `networkIsolation: "PRIVATE"`.
- Pass configured environment ID, region, and idle timeout.
- Map Railway status values into the generic binding.
- Implement keepalive as `exec("true", { timeoutSeconds: 10 })` and require exit code 0.
- Make destroy idempotent only for the client's typed not-found result.
- Use `Effect.acquireUseRelease` or an equivalent scoped cleanup around initialization work so partial creation cannot orphan a sandbox.

- [ ] **Step 5: Run and verify GREEN**

Run: `bun run --cwd apps/server test -- src/workspaceRuntime/Layers/WorkspaceRuntime.test.ts`

Expected: all six lifecycle tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/workspaceRuntime
git commit -m "feat: add workspace runtime lifecycle boundary"
```

### Task 4: Railway SDK adapter

**Files:**
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Create: `apps/server/src/workspaceRuntime/Layers/RailwaySandboxClient.ts`
- Create: `apps/server/src/workspaceRuntime/Layers/RailwaySandboxClient.test.ts`

**Interfaces:**
- Consumes: `RailwaySandboxClientShape` from Task 3.
- Produces: `RailwaySandboxClientLive` backed by `railway@3.7.0`.
- Produces: `makeRailwaySandboxClient` with an injected SDK constructor for deterministic tests.

- [ ] **Step 1: Add the exact SDK dependency**

Run: `bun add --cwd apps/server railway@3.7.0`

Inspect the installed declarations for `Sandbox.create`, `Sandbox.connect`, `Sandbox.list`, `exec`, `refresh`, and `destroy`. Record any differences from Railway's current documentation in the trial journal before adapting the plan's wrapper.

- [ ] **Step 2: Write failing adapter tests**

Use an injected SDK facade and verify observable mapping:

```ts
it.effect("maps create options and returns the Railway id and region", () => /* create result */);
it.effect("preserves stdout stderr exitCode timeout and truncation from exec", () => /* result */);
it.effect("refreshes before reporting connection status", () => /* refreshed state */);
it.effect("classifies SDK not-found separately from transport failures", () => /* typed tags */);
```

- [ ] **Step 3: Run and verify RED**

Run: `bun run --cwd apps/server test -- src/workspaceRuntime/Layers/RailwaySandboxClient.test.ts`

Expected: FAIL because the live adapter does not exist.

- [ ] **Step 4: Implement the thin SDK wrapper**

Only this file imports `Sandbox` from `railway`. Do not expose SDK instances through the service interface. Translate SDK exceptions once into tagged client errors containing operation, sandbox ID when known, safe detail, and cause. Never include configuration or environment maps in an error message.

- [ ] **Step 5: Run adapter and lifecycle tests**

Run: `bun run --cwd apps/server test -- src/workspaceRuntime/Layers/RailwaySandboxClient.test.ts src/workspaceRuntime/Layers/WorkspaceRuntime.test.ts`

Expected: adapter mapping and generic lifecycle tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json bun.lock apps/server/src/workspaceRuntime/Layers/RailwaySandboxClient.ts apps/server/src/workspaceRuntime/Layers/RailwaySandboxClient.test.ts
git commit -m "feat: adapt Railway sandbox SDK"
```

### Task 5: Bounded smoke runner and real v4 lifecycle trial

**Files:**
- Create: `apps/server/src/workspaceRuntime/smoke.ts`
- Modify: `apps/server/package.json`
- Modify: `docs/distributed-runtime/railway-v4-trial-log.md`

**Interfaces:**
- Consumes: `RailwaySandboxClientLive` and `WorkspaceRuntimeLive`.
- Produces: package script `smoke:railway-sandbox`.
- Produces: sanitized JSON summary containing sandbox ID, region, command exit codes, reconnect result, and teardown verification.

- [ ] **Step 1: Write a failing smoke-policy test**

Create `apps/server/src/workspaceRuntime/smoke.test.ts` and assert that the smoke program:

- refuses to run without `SYNARA_RAILWAY_SANDBOX_SMOKE=1`;
- creates at most one sandbox;
- registers cleanup immediately after creation;
- attempts teardown after an intermediate command failure;
- redacts environment values from its summary.

Run: `bun run --cwd apps/server test -- src/workspaceRuntime/smoke.test.ts`

Expected: FAIL because the smoke policy does not exist.

- [ ] **Step 2: Implement the smoke sequence**

The exact sequence is:

```text
list baseline sandboxes
create one PRIVATE sandbox with 5-minute idle timeout
exec uname -a
exec node --version
exec pi --version
exec a detached 20-second shell command if the SDK exposes detach/session APIs
reconnect by sandbox ID
exec true as keepalive
destroy sandbox in finalizer
list sandboxes and assert the created ID is absent
```

If the SDK does not expose detached-session control, record that gap and exercise detach/reattach once with Railway CLI instead; do not add raw CLI parsing to the production runtime.

- [ ] **Step 3: Run and verify the policy test GREEN**

Run: `bun run --cwd apps/server test -- src/workspaceRuntime/smoke.test.ts`

Expected: all smoke safety tests pass without accessing Railway.

- [ ] **Step 4: Inspect external state before mutation**

Run: `railway status` and `railway sandbox list --json`.

Record the linked project/environment and baseline sandbox IDs without recording secrets.

- [ ] **Step 5: Run one real smoke trial**

Run the smoke program with the explicit guard and server-only credentials. If local SDK credentials are unavailable but Railway CLI authentication works, run the equivalent bounded CLI sequence and record that credential-path difference as a failed SDK attempt and a CLI fallback observation.

No model prompt or provider API call is allowed.

- [ ] **Step 6: Verify teardown independently**

Run: `railway sandbox list --json`.

Expected: the trial sandbox ID is absent. If it remains, destroy that exact ID and repeat the list check before doing any further work.

- [ ] **Step 7: Append the trial journal**

Record exact timestamps, revision, hypothesis, observed SDK/CLI behavior, resource ID, command exit results, teardown evidence, failures, corrections, and architectural consequences.

- [ ] **Step 8: Run the Stage 1 focused verification**

Run:

```bash
bun run --cwd packages/contracts test -- src/settings.test.ts
bun run --cwd apps/server test -- src/serverSettings.test.ts src/workspaceRuntime
bun run --cwd packages/contracts build
bun run --cwd apps/server build
```

Expected: all focused tests and both builds exit 0. Do not infer repository-wide health from this focused gate.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/workspaceRuntime/smoke.ts apps/server/src/workspaceRuntime/smoke.test.ts apps/server/package.json docs/distributed-runtime/railway-v4-trial-log.md
git commit -m "test: validate Railway sandbox lifecycle"
```

## Stage 1 Completion Evidence

- Legacy/empty settings decode to local Pi execution.
- Partial Railway configuration fails before any SDK call.
- Generic lifecycle behavior is covered independently of Railway.
- The experimental SDK is isolated to one adapter file.
- One real `v4` sandbox is created, inspected, reconnected, kept alive, and destroyed without a provider call.
- Independent post-trial listing proves no sandbox orphan remains.
- The journal contains both bootstrap failures and Railway trial outcomes.
- No `ProviderService`, orchestration event, browser transcript, or existing local adapter behavior changes in Stage 1.
