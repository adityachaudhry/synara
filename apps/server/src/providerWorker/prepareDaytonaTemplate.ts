import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { Daytona, DaytonaNotFoundError, SnapshotState } from "@daytona/sdk";

import { WORKER_TOOLCHAIN_CHECK_COMMAND, WORKER_TOOLCHAIN_INSTALL_COMMAND } from "./workerToolchain.ts";

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export async function prepareDaytonaWorkerTemplate(input: {
  readonly artifactPath: string;
  readonly apiKey: string;
  readonly target: string;
}) {
  const artifact = await readFile(input.artifactPath);
  const photonWasm = await readFile(join(dirname(input.artifactPath), "photon_rs_bg.wasm"));
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const photonSha256 = createHash("sha256").update(photonWasm).digest("hex");
  const digest = createHash("sha256").update(artifact).update(photonWasm).digest("hex");
  const name = `synara-daytona-worker-${input.target}-${digest}`;
  const daytona = new Daytona({ apiKey: input.apiKey, target: input.target });
  const requireReady = (snapshot: Awaited<ReturnType<typeof daytona.snapshot.get>>) => {
    if (snapshot.state !== SnapshotState.ACTIVE ||
        (snapshot.regionIds && !snapshot.regionIds.includes(input.target))) {
      throw new Error(`Daytona worker snapshot '${name}' is unavailable in ${input.target}.`);
    }
    return snapshot;
  };
  try {
    const snapshot = requireReady(await daytona.snapshot.get(name));
    return { key: snapshot.name, id: snapshot.id, sha256, photonSha256, reused: true };
  } catch (cause) {
    if (!(cause instanceof DaytonaNotFoundError)) throw cause;
  }

  const sandbox = await daytona.create({ snapshot: "daytona-medium", name: `synara-template-${randomUUID()}` });
  try {
    const root = (command: string) => `sudo -n -E sh -lc ${quote(command)}`;
    const check = await sandbox.process.executeCommand(root(WORKER_TOOLCHAIN_CHECK_COMMAND), undefined, undefined, 20);
    if (check.exitCode !== 0) {
      const installed = await sandbox.process.executeCommand(root(WORKER_TOOLCHAIN_INSTALL_COMMAND), undefined, undefined, 240);
      if (installed.exitCode !== 0) throw new Error("Daytona worker tool installation failed.");
    }
    const verified = await sandbox.process.executeCommand(root(WORKER_TOOLCHAIN_CHECK_COMMAND), undefined, undefined, 20);
    if (verified.exitCode !== 0) throw new Error("Daytona worker tool verification failed.");

    const archivePath = `/tmp/synara-worker-${randomUUID()}.gz`;
    const wasmPath = `/tmp/synara-photon-${randomUUID()}.wasm`;
    await sandbox.fs.uploadFile(gzipSync(artifact), archivePath);
    await sandbox.fs.uploadFile(Buffer.from(photonWasm), wasmPath);
    const installed = await sandbox.process.executeCommand(root([
      "mkdir -p /opt/synara",
      `gzip -dc ${quote(archivePath)} > /opt/synara/provider-worker.mjs`,
      "chmod 500 /opt/synara/provider-worker.mjs",
      `install -m 0444 ${quote(wasmPath)} /opt/synara/photon_rs_bg.wasm`,
      `printf '%s  %s\\n%s  %s\\n' ${quote(sha256)} /opt/synara/provider-worker.mjs ${quote(photonSha256)} /opt/synara/photon_rs_bg.wasm | sha256sum --check --status`,
      `rm -f ${quote(archivePath)} ${quote(wasmPath)}`,
      "sync",
    ].join(" && ")), undefined, undefined, 60);
    if (installed.exitCode !== 0) throw new Error("Daytona worker artifact verification failed.");
    await sandbox.createSnapshot(name, 180);
    const snapshot = requireReady(await daytona.snapshot.get(name));
    return { key: snapshot.name, id: snapshot.id, sha256, photonSha256, reused: false };
  } finally {
    await sandbox.delete(60, true);
  }
}
