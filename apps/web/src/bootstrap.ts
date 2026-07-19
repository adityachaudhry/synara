// FILE: bootstrap.ts
// Purpose: Completes synchronous renderer storage migration before any app store can hydrate.

import "./storageOriginMigration";

import { bootstrapSignedOutScreen } from "./authSignedOut";
import { bootstrapPairingSession } from "./pairingBootstrap";
import { bootstrapSuperTokensAuth } from "./superTokensBootstrap";

if (!bootstrapSignedOutScreen()) {
  void bootstrapPairingSession().then(async (result) => {
    if (result !== "not-pairing") return;
    const superTokensResult = await bootstrapSuperTokensAuth();
    if (superTokensResult === "continue") {
      await import("./main");
    }
  });
}
