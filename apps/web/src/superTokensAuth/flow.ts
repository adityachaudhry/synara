export type AuthDevice = {
  readonly deviceId: string;
  readonly preAuthSessionId: string;
};

export type PersistedAuthFlow = {
  readonly step: "code";
  readonly email: string;
  readonly device: AuthDevice;
};

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
    ) {
      return null;
    }
    return { step: "code", email: value.email, device: value.device as AuthDevice };
  } catch {
    return null;
  }
}

export function verificationErrorMessage(status: string): string {
  if (status === "INCORRECT_USER_INPUT_CODE_ERROR") return "That code isn't right. Try again.";
  if (status === "EXPIRED_USER_INPUT_CODE_ERROR") {
    return "That code expired — request a new one.";
  }
  if (status === "RESTART_FLOW_ERROR") {
    return "This sign-in session expired — we'll send a fresh code.";
  }
  return "Couldn't verify the code.";
}
