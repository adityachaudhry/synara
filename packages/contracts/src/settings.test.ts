import { Schema } from "effect";
import { describe, expect, it } from "vitest";

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
