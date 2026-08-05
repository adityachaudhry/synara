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
    }),
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
    });
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
});
