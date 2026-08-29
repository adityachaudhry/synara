import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureSynaraRuntime,
  readSynaraRuntimeConfig,
  resetSynaraRuntimeConfigForTest,
  resolveSynaraHttpUrl,
} from "./synaraRuntimeConfig";

describe("Synara runtime configuration", () => {
  afterEach(() => {
    resetSynaraRuntimeConfigForTest();
  });

  it("routes server HTTP paths through an embedding host prefix", () => {
    configureSynaraRuntime({ httpBaseUrl: "/api/synara/proxy" });

    expect(resolveSynaraHttpUrl("/api/attachments/file-1", "https://host.example")).toBe(
      "https://host.example/api/synara/proxy/api/attachments/file-1",
    );
  });

  it("preserves a generic project descriptor and WebSocket resolver", async () => {
    const resolveWebSocketUrl = vi.fn(async () => "wss://synara.example/ws?token=fresh");
    const project = { projectId: "project-1", name: "Example project" };

    configureSynaraRuntime({ project, resolveWebSocketUrl });

    expect(readSynaraRuntimeConfig().project).toEqual(project);
    await expect(readSynaraRuntimeConfig().resolveWebSocketUrl?.()).resolves.toContain(
      "token=fresh",
    );
    expect(resolveWebSocketUrl).toHaveBeenCalledOnce();
  });
});
