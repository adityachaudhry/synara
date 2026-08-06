import type { ProjectRepositoryBinding } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceRuntime, type WorkspaceRuntimeBinding } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { ProviderWorkerBootstrapAuthority } from "../Services/ProviderWorkerBootstrapAuthority";
import { ProviderWorkerBroker } from "../Services/ProviderWorkerBroker";
import type { ProviderWorkerRuntimeBinding } from "../runtimeBinding";
import { makeProviderWorkerProvisioner } from "./ProviderWorkerProvisioner";

const workspaceBinding: WorkspaceRuntimeBinding = {
  runtimeKind: "railway-sandbox",
  runtimeId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  lifecycleGeneration: "generation-1",
  status: "running",
  region: "us-west2",
};

function makeHarness(options?: { readonly failConnection?: boolean }) {
  const calls: string[] = [];
  const workspace = {
    create: vi.fn(() => Effect.succeed(workspaceBinding)),
    connect: vi.fn(() => Effect.succeed(workspaceBinding)),
    exec: vi.fn(() =>
      Effect.succeed({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
      }),
    ),
    writeFile: vi.fn((_binding, input: { readonly path: string }) =>
      Effect.sync(() => calls.push(`write:${input.path}`)),
    ),
    startDurableProcess: vi.fn(() =>
      Effect.sync(() => {
        calls.push("start");
        return { sessionName: "provider-worker-1", supervision: "durable" };
      }),
    ),
    stopDurableProcess: vi.fn(() => Effect.sync(() => calls.push("stop-process"))),
    keepAlive: vi.fn(() => Effect.void),
    destroy: vi.fn(() => Effect.sync(() => calls.push("destroy"))),
    list: Effect.succeed([]),
  };
  const broker = {
    expectWorker: vi.fn(() => Effect.sync(() => calls.push("expect"))),
    register: vi.fn(),
    waitForConnection: vi.fn(() =>
      options?.failConnection
        ? Effect.fail(new Error("connection timed out") as never)
        : Effect.sync(() => calls.push("connected")),
    ),
    request: vi.fn(),
    accept: vi.fn(),
    disconnect: vi.fn(() => Effect.void),
    retire: vi.fn(() => Effect.sync(() => calls.push("retire"))),
    streamEvents: undefined as never,
  };
  const authority = {
    issue: vi.fn(() => Effect.succeed("bootstrap-secret")),
    authorize: vi.fn(),
    revoke: vi.fn(() => Effect.sync(() => calls.push("revoke"))),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceRuntime, workspace as never),
    Layer.succeed(ProviderWorkerBroker, broker as never),
    Layer.succeed(ProviderWorkerBootstrapAuthority, authority as never),
  );
  return { calls, workspace, broker, authority, layer };
}

describe("ProviderWorkerProvisioner", () => {
  it("sparse-checks out a bound Gitea company before starting the worker", async () => {
    const harness = makeHarness();
    harness.workspace.exec.mockImplementation(() =>
      Effect.sync(() => {
        harness.calls.push("checkout");
        return {
          exitCode: 0,
          stdout:
            "__SYNARA_CHECKOUT_COMMIT__=0123456789abcdef0123456789abcdef01234567\n",
          stderr: "",
          timedOut: false,
          truncated: false,
        };
      }),
    );
    const repositoryBinding: ProjectRepositoryBinding = {
      kind: "gitea-subdirectory",
      origin: "https://glasswing-gitea-dev.up.railway.app",
      owner: "glasswing-admin",
      repository: "glasswing-company-data",
      ref: "main",
      path: "companies/cue-cloud",
    };
    const provisioner = await Effect.runPromise(
      makeProviderWorkerProvisioner({
        artifact: new TextEncoder().encode("worker"),
        controlUrl: "ws://synara.railway.internal:3000/internal/provider-worker",
        giteaCheckout: {
          origin: repositoryBinding.origin,
          owner: repositoryBinding.owner,
          repository: repositoryBinding.repository,
          ref: repositoryBinding.ref,
          companiesRoot: "companies",
          readToken: "gitea-secret",
        },
      }).pipe(Effect.provide(harness.layer)),
    );

    const binding = await Effect.runPromise(
      provisioner.start({
        lifecycleGeneration: "generation-1",
        repositoryBinding,
      }),
    );

    expect(harness.workspace.create).toHaveBeenCalledWith({
      lifecycleGeneration: "generation-1",
      environment: { SYNARA_GITEA_CHECKOUT_TOKEN: "gitea-secret" },
    });
    const checkoutCommand = harness.workspace.exec.mock.calls[0]?.[1]?.command;
    expect(checkoutCommand).toContain("$SYNARA_GITEA_CHECKOUT_TOKEN");
    expect(checkoutCommand).not.toContain("gitea-secret");
    expect(binding).toMatchObject({
      cwd: "/workspace/repository/companies/cue-cloud",
      repositoryCheckout: {
        binding: repositoryBinding,
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
    });
    expect(harness.calls).toEqual([
      "checkout",
      "expect",
      "write:/opt/synara/provider-worker.mjs",
      "write:/opt/synara/provider-worker.json",
      "start",
      "connected",
    ]);
  });

  it("destroys the sandbox when a Gitea checkout fails before worker launch", async () => {
    const harness = makeHarness();
    harness.workspace.exec.mockReturnValue(
      Effect.succeed({
        exitCode: 128,
        stdout: "",
        stderr: "repository unavailable",
        timedOut: false,
        truncated: false,
      }),
    );
    const repositoryBinding: ProjectRepositoryBinding = {
      kind: "gitea-subdirectory",
      origin: "https://glasswing-gitea-dev.up.railway.app",
      owner: "glasswing-admin",
      repository: "glasswing-company-data",
      ref: "main",
      path: "companies/cue-cloud",
    };
    const provisioner = await Effect.runPromise(
      makeProviderWorkerProvisioner({
        artifact: new TextEncoder().encode("worker"),
        controlUrl: "ws://synara.railway.internal:3000/internal/provider-worker",
        giteaCheckout: {
          origin: repositoryBinding.origin,
          owner: repositoryBinding.owner,
          repository: repositoryBinding.repository,
          ref: repositoryBinding.ref,
          companiesRoot: "companies",
          readToken: "gitea-secret",
        },
      }).pipe(Effect.provide(harness.layer)),
    );

    await expect(
      Effect.runPromise(
        provisioner.start({ lifecycleGeneration: "generation-1", repositoryBinding }),
      ),
    ).rejects.toMatchObject({ operation: "checkout.exec" });
    expect(harness.calls).toEqual(["destroy"]);
  });

  it("uploads an atomic worker and private config before waiting for its fenced connection", async () => {
    const harness = makeHarness();
    const provisioner = await Effect.runPromise(
      makeProviderWorkerProvisioner({
        artifact: new TextEncoder().encode("worker"),
        controlUrl: "ws://synara.railway.internal:3000/internal/provider-worker",
      }).pipe(Effect.provide(harness.layer)),
    );

    const binding = await Effect.runPromise(
      provisioner.start({ lifecycleGeneration: "generation-1", cwd: "/workspace/repo" }),
    );

    expect(binding).toMatchObject({
      schemaVersion: 1,
      runtimeKind: "railway-sandbox-pi",
      workspace: workspaceBinding,
      durableSessionName: "provider-worker-1",
      processSupervision: "durable",
      cwd: "/workspace/repo",
    });
    expect(binding.fence.sandboxId).toBe(workspaceBinding.runtimeId);
    expect(harness.calls).toEqual([
      "expect",
      "write:/opt/synara/provider-worker.mjs",
      "write:/opt/synara/provider-worker.json",
      "start",
      "connected",
    ]);
    const configWrite = harness.workspace.writeFile.mock.calls[1]?.[1];
    expect(configWrite?.mode).toBe(0o600);
    expect(String(configWrite?.data)).toContain("bootstrap-secret");
    expect(harness.workspace.startDurableProcess).toHaveBeenCalledWith(workspaceBinding, {
      command:
        "mkdir -p '/workspace/.synara-provider-worker/state/logs' && exec node '/opt/synara/provider-worker.mjs' >> '/workspace/.synara-provider-worker/state/logs/worker.log' 2>&1",
    });
  });

  it("retires credentials and destroys the exact sandbox when startup cannot connect", async () => {
    const harness = makeHarness({ failConnection: true });
    const provisioner = await Effect.runPromise(
      makeProviderWorkerProvisioner({
        artifact: new TextEncoder().encode("worker"),
        controlUrl: "ws://synara.railway.internal:3000/internal/provider-worker",
      }).pipe(Effect.provide(harness.layer)),
    );

    await expect(
      Effect.runPromise(provisioner.start({ lifecycleGeneration: "generation-1" })),
    ).rejects.toBeDefined();
    expect(harness.calls).toEqual([
      "expect",
      "write:/opt/synara/provider-worker.mjs",
      "write:/opt/synara/provider-worker.json",
      "start",
      "retire",
      "stop-process",
      "revoke",
      "destroy",
    ]);
  });

  it("replaces the sandbox on restart so a stale worker cannot survive recovery", async () => {
    const harness = makeHarness();
    const replacementWorkspace = {
      ...workspaceBinding,
      runtimeId: "f02b6838-4614-4988-93b0-ab3253c589b7",
      lifecycleGeneration: "generation-2",
    } as const;
    harness.workspace.connect.mockImplementation(() =>
      Effect.sync(() => {
        harness.calls.push("connect-old");
        return workspaceBinding;
      }),
    );
    harness.workspace.create.mockImplementation(() =>
      Effect.sync(() => {
        harness.calls.push("create-replacement");
        return replacementWorkspace;
      }),
    );
    const provisioner = await Effect.runPromise(
      makeProviderWorkerProvisioner({
        artifact: new TextEncoder().encode("worker"),
        controlUrl: "ws://synara.railway.internal:3000/internal/provider-worker",
      }).pipe(Effect.provide(harness.layer)),
    );
    const previous: ProviderWorkerRuntimeBinding = {
      schemaVersion: 1,
      runtimeKind: "railway-sandbox-pi",
      workspace: workspaceBinding,
      fence: {
        sandboxId: workspaceBinding.runtimeId,
        workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
        lifecycleGeneration: "generation-1",
      },
      durableSessionName: "provider-worker-old",
      processSupervision: "durable",
      cwd: "/workspace/repo",
      homeDir: "/workspace/.synara-provider-worker",
    };

    const binding = await Effect.runPromise(
      provisioner.restart(previous, {
        lifecycleGeneration: "generation-2",
        cwd: "/workspace/repo",
      }),
    );

    expect(binding.workspace).toEqual(replacementWorkspace);
    expect(harness.calls).toEqual([
      "retire",
      "revoke",
      "connect-old",
      "stop-process",
      "destroy",
      "create-replacement",
      "expect",
      "write:/opt/synara/provider-worker.mjs",
      "write:/opt/synara/provider-worker.json",
      "start",
      "connected",
    ]);
  });
});
