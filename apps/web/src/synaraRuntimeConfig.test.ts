// FILE: synaraRuntimeConfig.test.ts
// Purpose: Verifies host-owned HTTP routing and runtime configuration.
// Layer: Web runtime adapter tests
// Depends on: synaraRuntimeConfig pure URL resolution

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

    expect(resolveSynaraHttpUrl("/api/attachments/file-1", "https://app.glasswing.vc")).toBe(
      "https://app.glasswing.vc/api/synara/proxy/api/attachments/file-1",
    );
  });

  it("preserves the host WebSocket URL resolver", async () => {
    const resolveWebSocketUrl = vi.fn(async () => "wss://synara.example/ws?wsToken=fresh");
    configureSynaraRuntime({ resolveWebSocketUrl });

    await expect(readSynaraRuntimeConfig().resolveWebSocketUrl?.()).resolves.toContain(
      "wsToken=fresh",
    );
    expect(resolveWebSocketUrl).toHaveBeenCalledTimes(1);
  });

  it("preserves optional embedded shell navigation and profile adapters", () => {
    const onSelectWorkspace = vi.fn();
    const onSignOut = vi.fn();

    configureSynaraRuntime({
      hostNavigation: {
        onSelectWorkspace,
        profile: {
          email: "jane.doe@glasswing.vc",
          onSignOut,
        },
      },
    });

    expect(readSynaraRuntimeConfig().hostNavigation).toEqual({
      onSelectWorkspace,
      profile: {
        email: "jane.doe@glasswing.vc",
        onSignOut,
      },
    });
  });
});
