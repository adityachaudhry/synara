import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Effect, Layer } from "effect";

import { ProviderWorkerAuthError } from "../Errors";
import { providerWorkerFenceKey, sameProviderWorkerFence } from "../fence";
import {
  ProviderWorkerBootstrapAuthority,
  type ProviderWorkerBootstrapAuthorityShape,
} from "../Services/ProviderWorkerBootstrapAuthority";

interface CredentialRecord {
  readonly fence: Parameters<ProviderWorkerBootstrapAuthorityShape["issue"]>[0];
  readonly digest: Buffer;
}

const digestCredential = (credential: string) =>
  createHash("sha256").update(credential, "utf8").digest();

export const makeProviderWorkerBootstrapAuthority = () => Effect.sync(() => {
  const credentials = new Map<string, CredentialRecord>();

  const issue: ProviderWorkerBootstrapAuthorityShape["issue"] = (fence) =>
    Effect.sync(() => {
      const credential = randomBytes(32).toString("base64url");
      credentials.set(providerWorkerFenceKey(fence), {
        fence,
        digest: digestCredential(credential),
      });
      return credential;
    });

  const authorize: ProviderWorkerBootstrapAuthorityShape["authorize"] = (
    fence,
    credential,
  ) =>
    Effect.gen(function* () {
      const record = credentials.get(providerWorkerFenceKey(fence));
      const receivedDigest = digestCredential(credential);
      if (
        !record ||
        !sameProviderWorkerFence(record.fence, fence) ||
        record.digest.byteLength !== receivedDigest.byteLength ||
        !timingSafeEqual(record.digest, receivedDigest)
      ) {
        return yield* new ProviderWorkerAuthError({
          operation: "authorize",
          detail: "Provider worker bootstrap credential is invalid or revoked.",
          sandboxId: fence.sandboxId,
        });
      }
    });

  const revoke: ProviderWorkerBootstrapAuthorityShape["revoke"] = (fence) =>
    Effect.sync(() => {
      credentials.delete(providerWorkerFenceKey(fence));
    });

  return { issue, authorize, revoke } satisfies ProviderWorkerBootstrapAuthorityShape;
});

export const ProviderWorkerBootstrapAuthorityLive = Layer.effect(
  ProviderWorkerBootstrapAuthority,
  makeProviderWorkerBootstrapAuthority(),
);
