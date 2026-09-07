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
  const name = `synara-worker-tools-v1-${region ?? "default"}-${sha256}`;
  const existing = (await Sandbox.checkpoints(connection)).find((checkpoint) => checkpoint.key === name);
  if (existing) return { ...existing, sha256, reused: true };
  // Recipe builds currently land in us-west2; prepare the disk in its actual runtime region.
  const sandbox = await Sandbox.create({
    ...connection,
    ...(region ? { region } : {}),
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes: 10,
  });
  try {
    const tools = await sandbox.exec("command -v pdftotext && python3 -c 'import openpyxl' && git config --get filter.lfs.process", { timeoutSec: 15 });
    if (tools.exitCode !== 0) {
      const installed = await sandbox.exec("if [ \"$(id -u)\" = 0 ]; then apt-get update -qq && apt-get install -y -qq --no-install-recommends git-lfs poppler-utils python3-openpyxl; else sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends git-lfs poppler-utils python3-openpyxl; fi", { timeoutSec: 180 });
      if (installed.exitCode !== 0 || installed.timedOut) throw new Error("Prepared runtime tool installation failed.");
    }
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
