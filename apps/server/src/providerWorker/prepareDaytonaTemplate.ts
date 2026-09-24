import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Daytona, DaytonaNotFoundError, Image, SnapshotState } from "@daytona/sdk";
import { WORKER_TOOLCHAIN_INSTALL_COMMAND } from "./workerToolchain.ts";

export const DAYTONA_MOUNTPOINT_INSTALL = "curl -fsSL https://s3.amazonaws.com/mountpoint-s3-release/1.24.0/x86_64/mount-s3-1.24.0-x86_64.tar.gz -o /tmp/mount-s3.tar.gz && echo 'a99bea20510eaabaf9d7cbfe95ab221a11005cacaa77cfc311a2912bbbdbfd72  /tmp/mount-s3.tar.gz' | sha256sum -c - && mkdir -p /opt/aws/mountpoint-s3 && tar -xzf /tmp/mount-s3.tar.gz -C /opt/aws/mountpoint-s3 && ln -sf /opt/aws/mountpoint-s3/bin/mount-s3 /usr/local/bin/mount-s3 && rm /tmp/mount-s3.tar.gz";
const BASE_IMAGE = "node:24.13.1-bookworm-slim";
const BASE_SETUP = "apt-get update -qq && apt-get install -y -qq --no-install-recommends git git-lfs s3fs poppler-utils python3 python3-openpyxl procps coreutils curl ca-certificates sudo && useradd -m -s /bin/bash daytona && echo 'daytona ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/daytona && chmod 440 /etc/sudoers.d/daytona";

/** CI builds a native image snapshot; no running builder sandbox or thread credentials. */
export async function prepareDaytonaWorkerTemplate(input: { artifactPath: string; apiKey: string; target: string }) {
  const artifact = await readFile(input.artifactPath);
  const photonPath = join(dirname(input.artifactPath), "photon_rs_bg.wasm");
  const photon = await readFile(photonPath);
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const photonSha256 = createHash("sha256").update(photon).digest("hex");
  const recipe = `${BASE_IMAGE}\n${BASE_SETUP}\n${WORKER_TOOLCHAIN_INSTALL_COMMAND}\n${DAYTONA_MOUNTPOINT_INSTALL}`;
  const digest = createHash("sha256").update(artifact).update(photon).update(recipe).digest("hex");
  const name = `synara-native-worker-${input.target}-${digest}`;
  const daytona = new Daytona({ apiKey: input.apiKey, target: input.target });
  let reused = true;
  try { await daytona.snapshot.get(name); }
  catch (cause) {
    if (!(cause instanceof DaytonaNotFoundError)) throw cause;
    reused = false;
    const image = Image.base(BASE_IMAGE).dockerfileCommands(["USER root"])
      .runCommands(BASE_SETUP, WORKER_TOOLCHAIN_INSTALL_COMMAND, "git lfs install --system", DAYTONA_MOUNTPOINT_INSTALL,
        "apt-get clean && rm -rf /var/lib/apt/lists/*")
      .addLocalFile(input.artifactPath, "/opt/synara/provider-worker.mjs")
      .addLocalFile(photonPath, "/opt/synara/photon_rs_bg.wasm")
      .runCommands("chmod 500 /opt/synara/provider-worker.mjs && chmod 444 /opt/synara/photon_rs_bg.wasm",
        `echo '${sha256}  /opt/synara/provider-worker.mjs' | sha256sum -c -`,
        `echo '${photonSha256}  /opt/synara/photon_rs_bg.wasm' | sha256sum -c -`)
      .dockerfileCommands(["USER daytona"]);
    await daytona.snapshot.create({ name, image, regionId: input.target, resources: { cpu: 2, memory: 4, disk: 8 } }, { timeout: 600 });
  }
  const deadline = Date.now() + 600_000;
  for (;;) {
    const snapshot = await daytona.snapshot.get(name);
    if (snapshot.state === SnapshotState.ACTIVE && snapshot.regionIds?.includes(input.target))
      return { key: snapshot.name, id: snapshot.id, sha256, photonSha256, reused };
    if (snapshot.errorReason || Date.now() >= deadline) throw new Error(`Daytona image snapshot is ${snapshot.state}; inspect its build before retrying.`);
    await delay(2000);
  }
}
