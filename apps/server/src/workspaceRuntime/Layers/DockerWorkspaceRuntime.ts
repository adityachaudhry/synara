import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer } from "effect";
import { MAX_PROVIDER_PERSISTENCE_FILE_BYTES } from "../../providerPersistence";
import { WorkspaceCreationIntentRepository } from "../../persistence/Services/WorkspaceCreationIntents";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime";
import { decodeProviderWorkerRuntimeBinding } from "../../providerWorker/runtimeBinding";
import { WorkspaceRuntimeError } from "../Errors";
import {
  WorkspaceRuntime,
  type WorkspaceRuntimeBinding,
  type WorkspaceExecResult,
  type WorkspaceRuntimeShape,
} from "../Services/WorkspaceRuntime";

export interface DockerWorkspaceConfig {
  readonly image: string;
  readonly instance: string;
  readonly diagnosticsDirectory?: string;
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

// The Docker CLI owns transport to OrbStack; never expose its socket or host files to workers.
function docker(
  args: string[],
  input?: string | Uint8Array,
  maxOutputBytes = 8 * 1024 * 1024,
  timeoutMs = 30_000,
): Promise<WorkspaceExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) target.push(chunk);
      else truncated = true;
    };
    child.stdout.on("data", collect(output));
    child.stderr.on("data", collect(errors));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(output).toString(),
        stderr: Buffer.concat(errors).toString(),
        timedOut: timedOut || exitCode === 124,
        truncated,
      });
    });
    child.stdin.end(input);
  });
}

export const makeDockerWorkspaceRuntimeLive = (config: DockerWorkspaceConfig) => {
  if (!/^[a-z0-9-]{1,48}$/.test(config.instance) || !config.image || config.image.startsWith("-")) {
    throw new Error("Invalid local Docker instance or image.");
  }
  const prefix = `synara-${config.instance}-`;
  const intentPrefix = `docker:${config.instance}:`;
  const name = (binding: WorkspaceRuntimeBinding) => {
    if (binding.runtimeKind !== "docker-container" || !/^[0-9a-f-]{36}$/.test(binding.runtimeId)) {
      throw new Error("Refusing non-Docker workspace binding.");
    }
    return `${prefix}${binding.runtimeId}`;
  };
  const run = <A>(operation: string, body: () => Promise<A>) =>
    Effect.tryPromise({
      try: body,
      // Do not surface command arguments or Docker environment values in errors.
      catch: () =>
        new WorkspaceRuntimeError({ operation, detail: `Local Docker ${operation} failed.` }),
    });
  const checked = async (args: string[], input?: string | Uint8Array, maxOutputBytes?: number) => {
    const result = await docker(args, input, maxOutputBytes);
    if (result.exitCode !== 0 || result.truncated) throw new Error("Docker command failed");
    return result.stdout;
  };
  const owned = async (binding: WorkspaceRuntimeBinding) => {
    const container = name(binding);
    const owner = await checked([
      "inspect",
      "--format",
      '{{index .Config.Labels "synara.local.instance"}}',
      container,
    ]);
    if (owner.trim() !== config.instance) throw new Error("Container ownership mismatch");
    return container;
  };
  const exists = async (binding: WorkspaceRuntimeBinding) =>
    Boolean(
      (
        await checked(["ps", "-a", "--filter", `name=^/${name(binding)}$`, "--format", "{{.ID}}"])
      ).trim(),
    );
  const removeContainer = async (binding: WorkspaceRuntimeBinding) => {
    if (!(await exists(binding))) return;
    const result = await docker(["rm", "-f", await owned(binding)]);
    if (result.exitCode !== 0 && (await exists(binding)))
      throw new Error("Container removal failed");
  };
  const node = async (
    binding: WorkspaceRuntimeBinding,
    script: string,
    args: string[],
    input?: string | Uint8Array,
    maxOutputBytes?: number,
  ) =>
    checked(
      ["exec", "-i", await owned(binding), "node", "-e", script, "--", ...args],
      input,
      maxOutputBytes,
    );
  const statScript = `const f=require('node:fs'),p=require('node:path');const entry=x=>{const s=f.lstatSync(x);return {name:p.basename(x),size:s.size,mode:s.mode,isDir:s.isDirectory(),modTime:s.mtime.toISOString()}};`;
  return Layer.effect(
    WorkspaceRuntime,
    Effect.gen(function* () {
      const intents = yield* WorkspaceCreationIntentRepository;
      const sessions = yield* ProviderSessionRuntimeRepository;
      const persistence = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError(
            () =>
              new WorkspaceRuntimeError({
                operation: "creation-intent",
                detail: "Local Docker creation ownership could not be persisted.",
              }),
          ),
        );
      const runtime: WorkspaceRuntimeShape = {
        create: (input) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const id = randomUUID();
              const container = `${prefix}${id}`;
              const binding: WorkspaceRuntimeBinding = {
                runtimeKind: "docker-container",
                runtimeId: id,
                lifecycleGeneration: input.lifecycleGeneration,
                status: "running",
                region: "local",
                creationOperationId: `${intentPrefix}${id}`,
              };
              yield* persistence(
                intents.put({
                  operationId: binding.creationOperationId!,
                  createdAt: new Date().toISOString(),
                }),
              );
              // Reserve the exact Docker name durably BEFORE asking the engine to create it.
              yield* persistence(
                intents.bindRuntime({ operationId: binding.creationOperationId!, runtimeId: id }),
              );
              return yield* run("create", async () => {
                const env = Object.entries({
                  ...input.environment,
                  SYNARA_LOCAL_DEBUG: "1",
                  SYNARA_LOCAL_DOCKER: "1",
                })
                  .map(([key, value]) => {
                    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value))
                      throw new Error("Invalid worker environment");
                    return `${key}=${value}`;
                  })
                  .join("\n");
                await checked(
                  [
                    "create",
                    "--name",
                    container,
                    "--label",
                    `synara.local.instance=${config.instance}`,
                    "--label",
                    `synara.local.generation=${input.lifecycleGeneration}`,
                    "--init",
                    "--memory",
                    "2g",
                    "--cpus",
                    "2",
                    "--pids-limit",
                    "256",
                    "--security-opt",
                    "no-new-privileges",
                    "--env-file",
                    "/dev/stdin",
                    config.image,
                  ],
                  env,
                );
                await checked(["start", container]);
                input.onCapacityAdmitted?.();
                return binding;
              }).pipe(
                Effect.flatMap((created) => restore(Effect.succeed(created))),
                Effect.onError(() => runtime.destroy(binding).pipe(Effect.orDie)),
              );
            }),
          ),
        connect: (binding) =>
          run("connect", async () => {
            await checked(["start", await owned(binding)]);
            return { ...binding, status: "running" as const };
          }),
        adopt: (binding) =>
          run("adopt", async () => {
            await owned(binding);
          }).pipe(
            Effect.andThen(
              binding.creationOperationId?.startsWith(intentPrefix)
                ? persistence(intents.remove(binding.creationOperationId))
                : Effect.void,
            ),
          ),
        exec: (binding, input) =>
          run("exec", async () =>
            docker(
              [
                "exec",
                "--workdir",
                input.cwd ?? "/workspace",
                await owned(binding),
                "timeout",
                "--kill-after=5",
                String(input.timeoutSeconds ?? 120),
                "bash",
                "-lc",
                input.command,
              ],
              undefined,
              undefined,
              ((input.timeoutSeconds ?? 120) + 10) * 1000,
            ),
          ),
        writeFile: (binding, input) =>
          run("writeFile", async () => {
            await node(
              binding,
              `const f=require('node:fs'),p=require('node:path');const target=process.argv[1];f.mkdirSync(p.dirname(target),{recursive:true});f.writeFileSync(target,f.readFileSync(0),{mode:Number(process.argv[2])});f.chmodSync(target,Number(process.argv[2]));`,
              [input.path, String(input.mode ?? 0o600)],
              input.data,
            );
          }),
        readFile: (binding, path) =>
          run("readFile", async () =>
            Buffer.from(
              await node(
                binding,
                `const f=require('node:fs');const p=process.argv[1];if(f.statSync(p).size>${MAX_PROVIDER_PERSISTENCE_FILE_BYTES})throw new Error('File exceeds persistence limit');process.stdout.write(f.readFileSync(p).toString('base64'))`,
                [path],
                undefined,
                Math.ceil(MAX_PROVIDER_PERSISTENCE_FILE_BYTES / 3) * 4 + 64 * 1024,
              ),
              "base64",
            ),
          ),
        listFiles: (binding, path) =>
          run("listFiles", async () =>
            JSON.parse(
              await node(
                binding,
                `${statScript}process.stdout.write(JSON.stringify(f.readdirSync(process.argv[1]).map(n=>entry(p.join(process.argv[1],n)))))`,
                [path],
              ),
            ),
          ),
        statFile: (binding, path) =>
          run("statFile", async () =>
            JSON.parse(
              await node(
                binding,
                `${statScript}process.stdout.write(JSON.stringify(entry(process.argv[1])))`,
                [path],
              ),
            ),
          ),
        startDurableProcess: (binding, input) =>
          run("startDurableProcess", async () => {
            const sessionName = `worker-${randomUUID()}`;
            await checked([
              "exec",
              await owned(binding),
              "tmux",
              "new-session",
              "-d",
              "-s",
              sessionName,
              "-c",
              input.cwd ?? "/workspace",
              `bash -lc ${quote(input.command)}`,
            ]);
            return { sessionName, supervision: "durable" as const };
          }),
        stopDurableProcess: (binding, sessionName) =>
          run("stopDurableProcess", async () => {
            if (!/^worker-[0-9a-f-]{36}$/.test(sessionName))
              throw new Error("Invalid worker session");
            const container = await owned(binding);
            const exists = await docker([
              "exec",
              container,
              "tmux",
              "has-session",
              "-t",
              sessionName,
            ]);
            if (exists.exitCode === 0)
              await checked(["exec", container, "tmux", "kill-session", "-t", sessionName]);
          }),
        keepAlive: (binding) =>
          run("keepAlive", async () => {
            const state = await checked([
              "inspect",
              "--format",
              "{{.State.Running}}",
              await owned(binding),
            ]);
            if (state.trim() !== "true") throw new Error("Container stopped");
          }),
        destroy: (binding) =>
          run("destroy", async () => {
            if (config.diagnosticsDirectory && (await exists(binding))) {
              const container = await owned(binding);
              try {
                const logs = await docker([
                  "exec",
                  container,
                  "bash",
                  "-lc",
                  "find /workspace -name worker.log -exec tail -c 65536 {} \\;",
                ]);
                await mkdir(config.diagnosticsDirectory, { recursive: true, mode: 0o700 });
                await writeFile(
                  path.join(config.diagnosticsDirectory, `${binding.runtimeId}.log`),
                  logs.stdout,
                  { mode: 0o600 },
                );
              } catch {
                console.warn(
                  "Could not retain local Docker diagnostics; continuing container cleanup.",
                );
              }
            }
            await removeContainer(binding);
          }).pipe(
            Effect.andThen(
              binding.creationOperationId?.startsWith(intentPrefix)
                ? persistence(intents.remove(binding.creationOperationId))
                : Effect.void,
            ),
          ),
        list: run("list", async () => {
          const lines = await checked([
            "ps",
            "-a",
            "--filter",
            `label=synara.local.instance=${config.instance}`,
            "--format",
            "{{.Names}} {{.State}}",
          ]);
          return lines
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [container, state] = line.split(" ");
              return {
                runtimeKind: "docker-container" as const,
                runtimeId: container!.slice(prefix.length),
                status: state === "running" ? ("running" as const) : ("stopped" as const),
                region: "local",
              };
            });
        }),
      };
      // Recover interrupted creates on startup. Never delete a workspace already bound to a session.
      const persisted = yield* persistence(sessions.list());
      const bound = new Set(
        persisted.flatMap((session) => {
          const payload = session.runtimePayload as { distributedPiRuntime?: unknown } | null;
          const binding = decodeProviderWorkerRuntimeBinding(payload?.distributedPiRuntime);
          return binding?.workspace.runtimeKind === "docker-container"
            ? [binding.workspace.runtimeId]
            : [];
        }),
      );
      for (const intent of yield* persistence(intents.list())) {
        if (!intent.operationId.startsWith(intentPrefix)) continue;
        const runtimeId = intent.runtimeId ?? intent.operationId.slice(intentPrefix.length);
        if (bound.has(runtimeId)) yield* persistence(intents.remove(intent.operationId));
        else
          yield* runtime.destroy({
            runtimeKind: "docker-container",
            runtimeId,
            creationOperationId: intent.operationId,
            lifecycleGeneration: "recovery",
            status: "creating",
            region: "local",
          });
      }
      return runtime;
    }),
  );
};
