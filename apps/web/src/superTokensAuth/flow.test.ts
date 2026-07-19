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
    expect(
      parsePersistedFlow(
        '{"step":"code","email":"person@glasswing.vc","device":{"deviceId":"d","preAuthSessionId":"p"}}',
      ),
    ).toEqual({
      step: "code",
      email: "person@glasswing.vc",
      device: { deviceId: "d", preAuthSessionId: "p" },
    });
    expect(parsePersistedFlow("not-json")).toBeNull();
    expect(parsePersistedFlow('{"step":"code"}')).toBeNull();
  });

  it("maps verification failures to the copied Glasswing messages", () => {
    expect(verificationErrorMessage("INCORRECT_USER_INPUT_CODE_ERROR")).toBe(
      "That code isn't right. Try again.",
    );
    expect(verificationErrorMessage("EXPIRED_USER_INPUT_CODE_ERROR")).toBe(
      "That code expired — request a new one.",
    );
    expect(verificationErrorMessage("RESTART_FLOW_ERROR")).toBe(
      "This sign-in session expired — we'll send a fresh code.",
    );
  });
});
