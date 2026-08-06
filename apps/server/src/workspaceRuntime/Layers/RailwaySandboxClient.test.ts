import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { RailwaySandboxNotFoundError } from "../Errors";
import type { RailwaySandboxRuntimeConfig } from "../railwaySandboxConfig";
import {
  makeRailwaySandboxClient,
  type RailwaySdkFacade,
  type RailwaySdkSandbox,
} from "./RailwaySandboxClient";

const config: Extract<RailwaySandboxRuntimeConfig, { readonly enabled: true }> = {
  enabled: true,
  token: "railway-token",
  authType: "project-token",
  environmentId: "environment-1",
  region: "us-east4-eqdc4a",
  idleTimeoutMinutes: 30,
};

function makeSdkSandbox(
  overrides: Partial<RailwaySdkSandbox> = {},
): RailwaySdkSandbox {
  return {
    id: "sandbox-1",
    status: "RUNNING",
    region: "us-east4-eqdc4a",
    refresh: async function () {
      return this;
    },
    exec: async () => ({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      timedOut: false,
      truncated: false,
    }) as never,
    files: { write: async () => undefined },
    destroy: async () => undefined,
    ...overrides,
  };
}

describe("RailwaySandboxClient", () => {
  it("maps configuration and create options into the SDK", async () => {
    let received: Parameters<RailwaySdkFacade["create"]>[0] | undefined;
    const sandbox = makeSdkSandbox();
    const sdk: RailwaySdkFacade = {
      create: async (input) => {
        received = input;
        return sandbox;
      },
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    const record = await Effect.runPromise(
      client.create({
        networkIsolation: "PRIVATE",
        idleTimeoutMinutes: 30,
        region: "us-east4-eqdc4a",
        environment: { WORKER_TOKEN: "scoped" },
      }),
    );

    expect(received).toEqual({
      token: "railway-token",
      authType: "project-token",
      environmentId: "environment-1",
      networkIsolation: "PRIVATE",
      idleTimeoutMinutes: 30,
      region: "us-east4-eqdc4a",
      env: { WORKER_TOKEN: "scoped" },
    });
    expect(record).toEqual({
      id: "sandbox-1",
      status: "RUNNING",
      region: "us-east4-eqdc4a",
      baseSource: "clean",
    });
  });

  it("boots from a worker checkpoint and reports the immutable base source", async () => {
    let received: Parameters<RailwaySdkFacade["create"]>[0] | undefined;
    const sandbox = makeSdkSandbox();
    const sdk: RailwaySdkFacade = {
      create: async (input) => {
        received = input;
        return sandbox;
      },
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    const record = await Effect.runPromise(
      client.create({
        checkpointName: "synara-provider-worker-deadbeef",
        networkIsolation: "PRIVATE",
        idleTimeoutMinutes: 30,
        environment: {},
      }),
    );

    expect(received).toMatchObject({
      checkpointName: "synara-provider-worker-deadbeef",
    });
    expect(record.baseSource).toBe("checkpoint");
  });

  it("falls back to a clean sandbox when the configured checkpoint is absent", async () => {
    const sandbox = makeSdkSandbox();
    const createInputs: unknown[] = [];
    const sdk: RailwaySdkFacade = {
      create: async (input) => {
        createInputs.push(input);
        if ("checkpointName" in input) throw new Error("checkpoint not found");
        return sandbox;
      },
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    const record = await Effect.runPromise(
      client.create({
        checkpointName: "synara-provider-worker-missing",
        networkIsolation: "PRIVATE",
        idleTimeoutMinutes: 30,
        environment: {},
      }),
    );

    expect(createInputs).toHaveLength(2);
    expect(createInputs[1]).not.toHaveProperty("checkpointName");
    expect(record.baseSource).toBe("clean");
  });

  it("preserves the complete exec result", async () => {
    const sandbox = makeSdkSandbox({
      exec: async () => ({
        exitCode: null,
        stdout: "partial",
        stderr: "signal",
        timedOut: true,
        truncated: true,
      }),
    });
    const sdk: RailwaySdkFacade = {
      create: async () => sandbox,
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    const result = await Effect.runPromise(
      client.exec("sandbox-1", { command: "sleep 30", timeoutSeconds: 1 }),
    );

    expect(result).toEqual({
      exitCode: null,
      stdout: "partial",
      stderr: "signal",
      timedOut: true,
      truncated: true,
    });
  });

  it("refreshes a connected sandbox before reporting its status", async () => {
    let status: RailwaySdkSandbox["status"] = "CREATING";
    const sandbox = makeSdkSandbox({
      refresh: async function () {
        status = "RUNNING";
        return this;
      },
    });
    Object.defineProperty(sandbox, "status", { get: () => status });
    const sdk: RailwaySdkFacade = {
      create: async () => sandbox,
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    const record = await Effect.runPromise(client.connect("sandbox-1"));

    expect(record.status).toBe("RUNNING");
  });

  it("classifies SDK not-found errors separately", async () => {
    const notFound = new Error("gone");
    const sdk: RailwaySdkFacade = {
      create: async () => makeSdkSandbox(),
      connect: async () => {
        throw notFound;
      },
      list: async () => [],
      isNotFoundError: (cause) => cause === notFound,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    const result = await Effect.runPromise(client.connect("missing").pipe(Effect.result));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(RailwaySandboxNotFoundError);
    }
  });

  it("uploads a worker artifact through the sandbox files API", async () => {
    const writes: Array<{ path: string; data: string; mode: number | undefined }> = [];
    const sandbox = makeSdkSandbox({
      files: {
        write: async (path, data, options) => {
          writes.push({ path, data: String(data), mode: options?.mode });
        },
      },
    });
    const sdk: RailwaySdkFacade = {
      create: async () => sandbox,
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    await Effect.runPromise(
      client.writeFile("sandbox-1", {
        path: "/opt/synara/pi-worker.mjs",
        data: "console.log('worker')",
        mode: 0o644,
      }),
    );

    expect(writes).toEqual([
      {
        path: "/opt/synara/pi-worker.mjs",
        data: "console.log('worker')",
        mode: 0o644,
      },
    ]);
  });

  it("uploads through a freshly connected sandbox instead of the create handle", async () => {
    const createdSandbox = makeSdkSandbox({
      files: {
        write: async () => {
          throw new Error("create handle file transport did not settle");
        },
      },
    });
    const writes: string[] = [];
    const connectedSandbox = makeSdkSandbox({
      files: {
        write: async (path) => {
          writes.push(path);
        },
      },
    });
    let connectCount = 0;
    const sdk: RailwaySdkFacade = {
      create: async () => createdSandbox,
      connect: async () => {
        connectCount += 1;
        return connectedSandbox;
      },
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);
    await Effect.runPromise(
      client.create({
        networkIsolation: "PRIVATE",
        idleTimeoutMinutes: 30,
        environment: {},
      }),
    );

    await Effect.runPromise(
      client.writeFile("sandbox-1", {
        path: "/opt/synara/provider-worker.mjs",
        data: "worker",
      }),
    );

    expect(connectCount).toBe(1);
    expect(writes).toEqual(["/opt/synara/provider-worker.mjs"]);
  });

  it("reuses the first settled file handle for subsequent writes", async () => {
    const createdSandbox = makeSdkSandbox();
    const writes: string[] = [];
    const connectedSandbox = makeSdkSandbox({
      files: { write: async (path) => void writes.push(path) },
    });
    let connectCount = 0;
    const sdk: RailwaySdkFacade = {
      create: async () => createdSandbox,
      connect: async () => {
        connectCount += 1;
        return connectedSandbox;
      },
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);
    await Effect.runPromise(
      client.create({ networkIsolation: "PRIVATE", idleTimeoutMinutes: 30, environment: {} }),
    );

    await Effect.runPromise(
      client.writeFile("sandbox-1", { path: "/opt/synara/worker.mjs", data: "worker" }),
    );
    await Effect.runPromise(
      client.writeFile("sandbox-1", { path: "/opt/synara/config.json", data: "{}" }),
    );

    expect(connectCount).toBe(1);
    expect(writes).toEqual(["/opt/synara/worker.mjs", "/opt/synara/config.json"]);
  });

  it("starts a direct durable command and detaches by session name", async () => {
    const calls: unknown[] = [];
    const sandbox = makeSdkSandbox({
      exec: (target, options) => {
        calls.push({ target, options });
        return makeExecHandle("durable-worker-1");
      },
    });
    const sdk: RailwaySdkFacade = {
      create: async () => sandbox,
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    const process = await Effect.runPromise(
      client.startDurableProcess("sandbox-1", {
        command: "node /opt/synara/pi-worker.mjs",
        cwd: "/workspace",
      }),
    );

    expect(process).toEqual({
      sessionName: "durable-worker-1",
      supervision: "durable",
    });
    expect(calls).toEqual([
      {
        target: "node /opt/synara/pi-worker.mjs",
        options: { cwd: "/workspace" },
      },
    ]);
  });

  it("waits for a project-token durable session instead of falling back while exec connects", async () => {
    const durableSession = new Promise<string>((resolve) => {
      setTimeout(() => resolve("durable-worker-delayed"), 10);
    });
    const result = new Promise<never>(() => undefined);
    const handle = Object.assign(result, {
      sessionName: durableSession,
      detach: async () => durableSession,
      kill: async () => true,
    });
    const sandbox = makeSdkSandbox({ exec: () => handle as never });
    const sdk: RailwaySdkFacade = {
      create: async () => sandbox,
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk, {
      durableSessionWaitMs: 1,
      createProcessId: () => "must-not-fallback",
    });

    const process = await Effect.runPromise(
      client.startDurableProcess("sandbox-1", {
        command: "node /opt/synara/pi-worker.mjs",
      }),
    );

    expect(process).toEqual({
      sessionName: "durable-worker-delayed",
      supervision: "durable",
    });
  });

  it("starts the worker from a freshly connected sandbox instead of the create handle", async () => {
    const createdSandbox = makeSdkSandbox({
      exec: () => {
        throw new Error("create handle cannot establish exec");
      },
    });
    const connectedSandbox = makeSdkSandbox({
      exec: () => makeExecHandle("durable-worker-reconnected"),
    });
    let connectCount = 0;
    const sdk: RailwaySdkFacade = {
      create: async () => createdSandbox,
      connect: async () => {
        connectCount += 1;
        return connectedSandbox;
      },
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);
    await Effect.runPromise(
      client.create({
        networkIsolation: "PRIVATE",
        idleTimeoutMinutes: 30,
        environment: {},
      }),
    );

    const process = await Effect.runPromise(
      client.startDurableProcess("sandbox-1", {
        command: "node /opt/synara/pi-worker.mjs",
      }),
    );

    expect(connectCount).toBe(1);
    expect(process).toEqual({
      sessionName: "durable-worker-reconnected",
      supervision: "durable",
    });
  });

  it("keeps a live exec attached when Railway does not assign a durable session", async () => {
    let settleResult: ((result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      truncated: boolean;
    }) => void) | undefined;
    const result = new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      truncated: boolean;
    }>((resolve) => {
      settleResult = resolve;
    });
    const handle = Object.assign(result, {
      sessionName: new Promise<string>(() => undefined),
      detach: async () => {
        throw new Error("attached fallback must not detach");
      },
      kill: async () => {
        settleResult?.({
          exitCode: -1,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
        });
        return true;
      },
    });
    const sandbox = makeSdkSandbox({ exec: () => handle as never });
    const sdk: RailwaySdkFacade = {
      create: async () => sandbox,
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient({ ...config, authType: "bearer" }, sdk, {
      durableSessionWaitMs: 1,
      createProcessId: () => "worker-1",
    });

    const process = await Effect.runPromise(
      client.startDurableProcess("sandbox-1", {
        command: "node /opt/synara/pi-worker.mjs",
      }),
    );

    expect(process).toEqual({
      sessionName: "attached:worker-1",
      supervision: "attached",
    });
    await Effect.runPromise(client.stopDurableProcess("sandbox-1", process.sessionName));
  });

  it("reattaches and terminates an exact durable session", async () => {
    const calls: unknown[] = [];
    const handle = makeExecHandle("durable-worker-1", {
      kill: async (signal) => {
        calls.push({ signal });
        return true;
      },
    });
    const sandbox = makeSdkSandbox({
      exec: (target, options) => {
        calls.push({ target, options });
        return handle;
      },
    });
    const sdk: RailwaySdkFacade = {
      create: async () => sandbox,
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    await Effect.runPromise(client.stopDurableProcess("sandbox-1", "durable-worker-1"));

    expect(calls).toEqual([
      {
        target: { sessionName: "durable-worker-1" },
        options: { resumeFromLastRead: true },
      },
      { signal: "TERM" },
    ]);
  });

  it("does not wait forever for a remote exit frame after signaling a process", async () => {
    const pendingResult = new Promise<never>(() => undefined);
    const handle = Object.assign(pendingResult, {
      sessionName: Promise.resolve("durable-worker-1"),
      detach: async () => "durable-worker-1",
      kill: async () => true,
    });
    const sandbox = makeSdkSandbox({ exec: () => handle as never });
    const sdk: RailwaySdkFacade = {
      create: async () => sandbox,
      connect: async () => sandbox,
      list: async () => [],
      isNotFoundError: () => false,
    };
    const client = makeRailwaySandboxClient(config, sdk);

    await expect(
      Promise.race([
        Effect.runPromise(
          client.stopDurableProcess("sandbox-1", "durable-worker-1"),
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("stop remained unbounded")), 20),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});

function makeExecHandle(
  sessionName: string,
  overrides: {
    readonly kill?: (signal?: "TERM" | "KILL") => Promise<boolean>;
  } = {},
) {
  const result = Promise.resolve({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
  });
  return Object.assign(result, {
    sessionName: Promise.resolve(sessionName),
    detach: async () => sessionName,
    kill: overrides.kill ?? (async () => true),
  });
}
