import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { PROVIDER_WORKER_PROTOCOL_VERSION } from "@synara/contracts";

const GUARD = "SYNARA_PROVIDER_WORKER_ARTIFACT_SMOKE";

function workerArtifactPath(): string {
  const configured = process.env.SYNARA_PROVIDER_WORKER_ARTIFACT_PATH?.trim();
  if (configured) return resolve(configured);
  return fileURLToPath(new URL("../../dist/provider-worker/workerMain.mjs", import.meta.url));
}

export async function runProviderWorkerArtifactSmoke(input: {
  readonly artifactPath: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), "synara-provider-worker-smoke-"));
  const artifactPath = resolve(input.artifactPath);
  const configPath = join(directory, "worker.json");
  const homeDir = join(directory, "home");
  const cwd = join(directory, "workspace");
  const sandboxId = randomUUID();
  const workerId = randomUUID();
  const lifecycleGeneration = `smoke-${Date.now().toString(36)}`;
  const bootstrapCredential = randomBytes(32).toString("base64url");
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/internal/provider-worker" ||
      request.headers.authorization !== `Bearer ${bootstrapCredential}` ||
      request.headers.origin !== undefined
    ) {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Smoke server has no TCP port.");
  await writeFile(
    configPath,
    JSON.stringify({
      controlUrl: `ws://127.0.0.1:${String(address.port)}/internal/provider-worker`,
      bootstrapCredential,
      sandboxId,
      workerId,
      lifecycleGeneration,
      cwd,
      homeDir,
    }),
    { mode: 0o600 },
  );

  let registered = false;
  const registration = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker registration timed out.")), 15_000);
    webSocketServer.once("connection", (client) => {
      client.once("message", (data) => {
        try {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (
            frame.type !== "register" ||
            frame.protocolVersion !== PROVIDER_WORKER_PROTOCOL_VERSION ||
            frame.sandboxId !== sandboxId ||
            frame.workerId !== workerId ||
            frame.lifecycleGeneration !== lifecycleGeneration ||
            "bootstrapCredential" in frame
          ) {
            throw new Error("Worker registration did not match its fenced configuration.");
          }
          if (existsSync(configPath)) {
            throw new Error("Worker did not consume its bootstrap credential file before connecting.");
          }
          registered = true;
          client.send(
            JSON.stringify({
              protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
              sandboxId,
              workerId,
              lifecycleGeneration,
              type: "registered",
              acknowledgedSequence: 0,
            }),
          );
          client.send(
            JSON.stringify({
              protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
              sandboxId,
              workerId,
              lifecycleGeneration,
              type: "retire",
              reason: "artifact smoke complete",
            }),
          );
          clearTimeout(timeout);
          resolve();
        } catch (cause) {
          clearTimeout(timeout);
          reject(cause);
        }
      });
    });
  });

  const child = spawn(process.execPath, [artifactPath], {
    env: { ...process.env, SYNARA_PROVIDER_WORKER_CONFIG_PATH: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-8_192);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  const childExit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  try {
    const startup = await Promise.race([
      registration.then(() => ({ type: "registered" as const })),
      childExit.then((exitCode) => ({ type: "exited" as const, exitCode })),
    ]);
    if (startup.type === "exited") {
      throw new Error(
        `Provider worker exited before registration with ${String(startup.exitCode)}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    const exitCode = await Promise.race([
      childExit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Worker did not exit after retirement.")), 15_000),
      ),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Provider worker exited with ${String(exitCode)}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    return {
      registered,
      retired: true,
      exitCode,
      protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
      artifactPath,
      credentialFileConsumed: !existsSync(configPath),
    } as const;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "Artifact smoke failed.";
    throw new Error(
      `${detail}${stdout ? `; stdout: ${stdout}` : ""}${stderr ? `; stderr: ${stderr}` : ""}`,
      { cause },
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    for (const client of webSocketServer.clients) client.terminate();
    webSocketServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env[GUARD] !== "1") {
    throw new Error(`Set ${GUARD}=1 to run the bounded provider worker artifact smoke.`);
  }
  const result = await runProviderWorkerArtifactSmoke({ artifactPath: workerArtifactPath() });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause: unknown) => {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : "Provider worker artifact smoke failed."}\n`,
    );
    process.exitCode = 1;
  });
}
