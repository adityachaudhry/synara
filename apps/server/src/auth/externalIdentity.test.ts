import { ProjectId } from "@synara/contracts";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  authorizeExternalServiceRequest,
  makeExternalIdentityExchange,
} from "./externalIdentity";

const projectId = ProjectId.makeUnsafe("external-project-1");

describe("external identity exchange", () => {
  it("issues one short-lived scoped bearer session and rejects nonce replay", async () => {
    const issued: Array<Record<string, unknown>> = [];
    const exchange = await Effect.runPromise(
      makeExternalIdentityExchange({
        secret: "shared-secret",
        issueSession: (input) =>
          Effect.sync(() => {
            issued.push(input);
            return { token: "session-token", expiresAt: DateTime.makeUnsafe(Date.parse(input.expiresAt)) };
          }),
      }),
    );
    const assertion = {
      subject: "glasswing:user-123",
      email: "person@example.com",
      allowedProjectIds: [projectId],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "nonce-1234567890",
    };

    const result = await Effect.runPromise(
      exchange.exchange({ authorization: "Bearer shared-secret", payload: assertion }),
    );
    expect(result.token).toBe("session-token");
    expect(issued).toEqual([
      expect.objectContaining({
        subject: assertion.subject,
        email: assertion.email,
        allowedProjectIds: [projectId],
      }),
    ]);

    const replay = await Effect.runPromise(
      Effect.flip(
        exchange.exchange({ authorization: "Bearer shared-secret", payload: assertion }),
      ),
    );
    expect(replay.status).toBe(409);
  });

  it("rejects wrong secrets, expired/invalid assertions, and identity repository coordinates", async () => {
    const exchange = await Effect.runPromise(
      makeExternalIdentityExchange({
        secret: "shared-secret",
        issueSession: () => Effect.die("must not issue"),
      }),
    );
    const base = {
      subject: "glasswing:user-123",
      email: "person@example.com",
      allowedProjectIds: [projectId],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "nonce-1234567890",
    };
    for (const input of [
      { authorization: undefined, payload: base },
      { authorization: "Bearer wrong", payload: base },
      { authorization: "Bearer shared-secret", payload: { ...base, subject: " " } },
      { authorization: "Bearer shared-secret", payload: { ...base, email: "invalid" } },
      {
        authorization: "Bearer shared-secret",
        payload: { ...base, expiresAt: new Date(Date.now() - 1).toISOString() },
      },
      {
        authorization: "Bearer shared-secret",
        payload: { ...base, repositoryBinding: { repository: "secret/repo" } },
      },
    ]) {
      await expect(Effect.runPromise(exchange.exchange(input))).rejects.toBeDefined();
    }
  });

  it("uses constant-shape bearer authorization and disables the seam without a secret", () => {
    expect(authorizeExternalServiceRequest("shared-secret", "Bearer shared-secret")).toBe(true);
    expect(authorizeExternalServiceRequest("shared-secret", "Bearer wrong")).toBe(false);
    expect(authorizeExternalServiceRequest(undefined, "Bearer shared-secret")).toBe(false);
  });

  it("derives the same opaque session id after an exchange service restart", async () => {
    const sessionIds: unknown[] = [];
    const makeExchange = () =>
      Effect.runPromise(
        makeExternalIdentityExchange({
          secret: "shared-secret",
          issueSession: (input) =>
            Effect.sync(() => {
              sessionIds.push((input as Record<string, unknown>).sessionId);
              return "session-token";
            }),
        }),
      );
    const assertion = {
      subject: "glasswing:user-123",
      email: "person@example.com",
      allowedProjectIds: [projectId],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "nonce-restart-123456",
    };

    await Effect.runPromise(
      (await makeExchange()).exchange({ authorization: "Bearer shared-secret", payload: assertion }),
    );
    await Effect.runPromise(
      (await makeExchange()).exchange({ authorization: "Bearer shared-secret", payload: assertion }),
    );

    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).toMatch(/^external:/);
    expect(sessionIds[1]).toBe(sessionIds[0]);
  });
});
