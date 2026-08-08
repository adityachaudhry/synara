import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Sandbox } from "railway";

import {
  workerArtifactDigest,
  workerCheckpointName,
} from "../src/providerWorker/workerArtifactBase.ts";
import {
  makeProviderWorkerNodeRuntimeCommand,
  PROVIDER_WORKER_NODE_VERSION,
} from "../src/providerWorker/workerNodeRuntime.ts";
import {
  planWorkerCheckpointPreparation,
} from "../src/providerWorker/workerCheckpointPreparation.ts";

const WORKER_ARTIFACT_PATH = "/opt/synara/provider-worker.mjs";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const token = requiredEnvironment("SYNARA_RAILWAY_SANDBOX_TOKEN");
  const environmentId = requiredEnvironment("SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID");
  const authType = process.env.SYNARA_RAILWAY_SANDBOX_AUTH_TYPE?.trim() || "bearer";
  if (authType !== "bearer" && authType !== "project-token") {
    throw new Error("SYNARA_RAILWAY_SANDBOX_AUTH_TYPE must be bearer or project-token.");
  }
  const artifactPath =
    process.env.SYNARA_PROVIDER_WORKER_ARTIFACT_PATH?.trim() ||
    fileURLToPath(new URL("../dist/provider-worker/workerMain.mjs", import.meta.url));
  const artifact = await readFile(artifactPath);
  const digest = workerArtifactDigest(artifact);
  const checkpointName = workerCheckpointName(digest);
  const connection = { token, authType, environmentId } as const;

  let canManageCheckpoints = true;
  const existing = await Sandbox.checkpoints(connection).catch(() => {
    canManageCheckpoints = false;
    process.stderr.write(
      "Checkpoint listing is not authorized; continuing with the digest-unique name.\n",
    );
    return [];
  });
  const plan = planWorkerCheckpointPreparation(existing, checkpointName);
  if (plan.kind === "reuse") {
    process.stdout.write(
      `${JSON.stringify({
        checkpointId: plan.checkpoint.id,
        checkpointName: plan.checkpoint.key,
        artifactDigest: digest,
        artifactBytes: artifact.byteLength,
        nodeVersion: PROVIDER_WORKER_NODE_VERSION,
        reused: true,
        checkpointManagementAuthorized: canManageCheckpoints,
      })}\n`,
    );
    return;
  }

  const seed = await Sandbox.create({
    ...connection,
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes: 5,
    env: {},
  });
  let connected: Sandbox | undefined;
  try {
    // The Railway create handle has intermittently rejected its first file
    // operation in live trials. A fresh connection is the reliable file seam.
    connected = await Sandbox.connect(seed.id, connection);
    const runtime = await connected.exec(makeProviderWorkerNodeRuntimeCommand(), {
      timeoutSec: 90,
    });
    if (runtime.exitCode !== 0 || runtime.timedOut) {
      throw new Error(runtime.stderr || runtime.stdout || "Node runtime preparation failed.");
    }
    await connected.files.write(WORKER_ARTIFACT_PATH, artifact, { mode: 0o500 });
    await connected.files.write(`${WORKER_ARTIFACT_PATH}.sha256`, `${digest}\n`, {
      mode: 0o444,
    });
    const checkpoint = await connected.checkpoint(checkpointName);
    process.stdout.write(
      `${JSON.stringify({
        checkpointId: checkpoint.id,
        checkpointName: checkpoint.key,
        artifactDigest: digest,
        artifactBytes: artifact.byteLength,
        nodeVersion: PROVIDER_WORKER_NODE_VERSION,
        reused: false,
        checkpointManagementAuthorized: canManageCheckpoints,
      })}\n`,
    );
  } finally {
    await (connected ?? seed).destroy().catch(() => undefined);
  }
}

await main();
