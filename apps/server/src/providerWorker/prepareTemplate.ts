/** Prepare a credential-free Railway disk once per worker artifact. Run only with explicit provisioning authority. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { Sandbox } from "railway";
import { resolveDistributedPiRuntimeConfig } from "./distributedRuntimeConfig.ts";

export async function prepareProviderWorkerTemplate(artifactPath: string) {
  const config = resolveDistributedPiRuntimeConfig({ environment: process.env });
  if (!config.enabled || !config.railway.enabled) throw new Error("Railway runtime is not configured.");
  const { token, authType, environmentId, region } = config.railway;
  const connection = { token, authType, environmentId };
  const artifact = await readFile(artifactPath);
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const name = `synara-worker-tools-v1-${sha256}`;
  const existing = (await Sandbox.checkpoints(connection)).find((checkpoint) => checkpoint.key === name);
  if (existing) return { ...existing, sha256, reused: true };
  const template = await Sandbox.template()
    .withPackages("git-lfs", "poppler-utils", "python3-openpyxl")
    .run("node --version && dpkg-query -W git-lfs && git config --get filter.lfs.process && pdftotext -v && python3 -c 'import openpyxl' && mkdir -p /opt/synara /workspace")
    .build(connection);
  const sandbox = await Sandbox.create(template, {
    ...connection,
    ...(region ? { region } : {}),
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes: 10,
  });
  try {
    await sandbox.files.write("/opt/synara/provider-worker.mjs.gz", gzipSync(artifact), { mode: 0o400 });
    const result = await sandbox.exec(
      `gzip -df /opt/synara/provider-worker.mjs.gz && chmod 500 /opt/synara/provider-worker.mjs && printf '%s  %s\n' '${sha256}' '/opt/synara/provider-worker.mjs' | sha256sum --check --status && sync`,
      { timeoutSec: 30 },
    );
    if (result.exitCode !== 0 || result.timedOut) throw new Error("Prepared worker digest verification failed.");
    return { ...(await sandbox.checkpoint(name)), sha256, reused: false };
  } finally {
    await sandbox.destroy();
  }
}

if (import.meta.main) {
  if (process.env.SYNARA_PREPARE_WORKER_TEMPLATE !== "1") {
    throw new Error("Set SYNARA_PREPARE_WORKER_TEMPLATE=1 to authorize Railway template provisioning.");
  }
  const artifactPath = process.argv[2];
  if (!artifactPath) throw new Error("Pass the built provider-worker/workerMain.mjs path.");
  console.log(JSON.stringify(await prepareProviderWorkerTemplate(artifactPath), null, 2));
}
