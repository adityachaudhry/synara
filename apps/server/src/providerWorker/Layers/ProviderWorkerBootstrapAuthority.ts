import { createHash, randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";

import { ProviderWorkerAuthError } from "../Errors";
import { providerWorkerFenceKey } from "../fence";
import {
  ProviderWorkerBootstrapAuthority,
  type ProviderWorkerBootstrapAuthorityShape,
} from "../Services/ProviderWorkerBootstrapAuthority";

interface CredentialRecord {
  readonly fence: Parameters<ProviderWorkerBootstrapAuthorityShape["issue"]>[0];
}

const digestCredential = (credential: string) =>
  createHash("sha256").update(credential, "utf8").digest();

export const makeProviderWorkerBootstrapAuthority = () => Effect.sync(() => {
  const credentials = new Map<string, CredentialRecord>();
  const credentialByFence = new Map<string, string>();

  const issue: ProviderWorkerBootstrapAuthorityShape["issue"] = (fence) =>
    Effect.sync(() => {
      const credential = randomBytes(32).toString("base64url");
      const fenceKey = providerWorkerFenceKey(fence);
      const priorCredential = credentialByFence.get(fenceKey);
      if (priorCredential) credentials.delete(priorCredential);
      const credentialKey = digestCredential(credential).toString("hex");
      credentials.set(credentialKey, { fence });
      credentialByFence.set(fenceKey, credentialKey);
      return credential;
    });

  const authorize: ProviderWorkerBootstrapAuthorityShape["authorize"] = (credential) =>
    Effect.gen(function* () {
      const receivedDigest = digestCredential(credential);
      const record = credentials.get(receivedDigest.toString("hex"));
      if (!record) {
        return yield* new ProviderWorkerAuthError({
          operation: "authorize",
          detail: "Provider worker bootstrap credential is invalid or revoked.",
        });
      }
      return record.fence;
    });

  const revoke: ProviderWorkerBootstrapAuthorityShape["revoke"] = (fence) =>
    Effect.sync(() => {
      const fenceKey = providerWorkerFenceKey(fence);
      const credentialKey = credentialByFence.get(fenceKey);
      if (credentialKey) credentials.delete(credentialKey);
      credentialByFence.delete(fenceKey);
    });

  return { issue, authorize, revoke } satisfies ProviderWorkerBootstrapAuthorityShape;
});

export const ProviderWorkerBootstrapAuthorityLive = Layer.effect(
  ProviderWorkerBootstrapAuthority,
  makeProviderWorkerBootstrapAuthority(),
);
