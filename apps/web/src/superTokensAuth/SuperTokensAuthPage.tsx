import { useEffect, useRef, useState } from "react";

import { InputOtp, InputOtpSlots } from "./InputOtp";
import {
  createConsumeGate,
  parsePersistedFlow,
  verificationErrorMessage,
  type AuthDevice,
} from "./flow";

type Step = "email" | "code";
const STORAGE_KEY = "gw_auth_flow";
const RESEND_COOLDOWN_S = 30;

export function SuperTokensAuthPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [device, setDevice] = useState<AuthDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [exchangePending, setExchangePending] = useState(false);
  const gateRef = useRef(createConsumeGate());
  const exchangeInFlightRef = useRef(false);
  const exchangePendingRef = useRef(false);

  useEffect(() => {
    const saved = parsePersistedFlow(sessionStorage.getItem(STORAGE_KEY));
    if (saved) {
      setEmail(saved.email);
      setDevice(saved.device);
      setStep("code");
    }

    // A valid SuperTokens cookie can outlive Synara's local container state.
    // Reissue the local owner session silently before asking for another code.
    void exchangeSession({ silentUnauthorized: true });
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function persist(next: { email: string; device: AuthDevice } | null) {
    try {
      if (next) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, step: "code" }));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage is a recovery aid; the in-memory flow remains valid without it.
    }
  }

  async function exchangeSession(input: { readonly silentUnauthorized?: boolean } = {}) {
    if (exchangeInFlightRef.current) return;
    exchangeInFlightRef.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/supertokens/exchange", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        if (input.silentUnauthorized && response.status === 401) return;
        throw new Error("Glasswing AI session exchange failed.");
      }
      exchangePendingRef.current = false;
      setExchangePending(false);
      persist(null);
      window.location.replace("/");
    } catch {
      if (!input.silentUnauthorized) {
        setError("Your code was verified, but sign-in did not finish. Try again.");
      }
    } finally {
      exchangeInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault();
    if (cooldown > 0 || !gateRef.current.enter()) return;
    const address = email.trim();
    if (!address) {
      gateRef.current.leave();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/supertokens/signinup/code", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", rid: "passwordless" },
        body: JSON.stringify({ email: address }),
      });
      const data = (await response.json()) as {
        readonly status: string;
        readonly deviceId?: string;
        readonly preAuthSessionId?: string;
        readonly message?: string;
      };
      if (data.status === "OK" && data.deviceId && data.preAuthSessionId) {
        const nextDevice = {
          deviceId: data.deviceId,
          preAuthSessionId: data.preAuthSessionId,
        };
        gateRef.current.reset();
        exchangePendingRef.current = false;
        setExchangePending(false);
        setDevice(nextDevice);
        setCode("");
        setStep("code");
        setCooldown(RESEND_COOLDOWN_S);
        persist({ email: address, device: nextDevice });
      } else {
        setError(data.message ?? "Couldn't send a code — check the address and try again.");
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      gateRef.current.leave();
      setBusy(false);
    }
  }

  async function verify(codeValue?: string) {
    if (exchangePendingRef.current) {
      await exchangeSession();
      return;
    }
    const otp = (codeValue ?? code).trim();
    if (!device || otp.length < 6 || !gateRef.current.enter()) return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/supertokens/signinup/code/consume", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", rid: "passwordless" },
        body: JSON.stringify({
          preAuthSessionId: device.preAuthSessionId,
          deviceId: device.deviceId,
          userInputCode: otp,
        }),
      });
      const data = (await response.json()) as { readonly status: string; readonly message?: string };
      if (data.status === "OK") {
        gateRef.current.markConsumed();
        exchangePendingRef.current = true;
        setExchangePending(true);
        await exchangeSession();
        return;
      }
      setError(data.message ?? verificationErrorMessage(data.status));
      setCode("");
      if (data.status === "RESTART_FLOW_ERROR") {
        setStep("email");
        persist(null);
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      gateRef.current.leave();
      setBusy(false);
    }
  }

  return (
    <main className="gw-auth">
      <div className="gw-auth__background" aria-hidden="true" />
      <section className="gw-auth__card" aria-labelledby="gw-auth-title">
        <header className="gw-auth__header">
          <h1 id="gw-auth-title">Welcome to Glasswing AI</h1>
          <p>
            {step === "email"
              ? "Login with your Glasswing account"
              : `Enter the 6-digit code sent to ${email}.`}
          </p>
        </header>
        <div className="gw-auth__content">
          {step === "email" ? (
            <form onSubmit={sendCode} className="gw-auth__form">
              <input
                type="email"
                autoComplete="email"
                required
                autoFocus
                placeholder="you@glasswing.vc"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="gw-auth__email"
              />
              {error ? <p className="gw-auth__error">{error}</p> : null}
              <button type="submit" disabled={busy || !email.trim()} className="gw-auth__primary">
                {busy ? "Sending…" : "Send code"}
              </button>
            </form>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
              className="gw-auth__form"
            >
              <InputOtp
                maxLength={6}
                value={code}
                onChange={setCode}
                onComplete={(value) => void verify(value)}
                autoFocus
              >
                <InputOtpSlots />
              </InputOtp>
              {error ? <p className="gw-auth__error gw-auth__error--center">{error}</p> : null}
              <button
                type="submit"
                disabled={busy || (!exchangePending && code.length < 6)}
                className="gw-auth__primary"
              >
                {busy ? "Verifying…" : exchangePending ? "Finish sign in" : "Verify & sign in"}
              </button>
              <div className="gw-auth__secondary-actions">
                <button
                  type="button"
                  onClick={() => {
                    gateRef.current.reset();
                    exchangePendingRef.current = false;
                    setExchangePending(false);
                    setStep("email");
                    setError(null);
                    setCode("");
                    persist(null);
                  }}
                >
                  ← Change email
                </button>
                <button
                  type="button"
                  onClick={() => void sendCode()}
                  disabled={busy || cooldown > 0 || exchangePending}
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
