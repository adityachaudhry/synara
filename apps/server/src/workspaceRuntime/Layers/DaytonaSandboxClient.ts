import { randomUUID } from "node:crypto";
import { Daytona, DaytonaFileAccessDeniedError, DaytonaNotFoundError, DaytonaProcessExecutionTimeoutError } from "@daytona/sdk";
import type { Sandbox } from "@daytona/sdk";
import { Effect, Layer } from "effect";

import { RailwaySandboxClientError, RailwaySandboxNotFoundError } from "../Errors.ts";
import { RailwaySandboxClient } from "../Services/RailwaySandboxClient.ts";
import type { RailwaySandboxClientShape, RailwaySandboxStatus, RailwaySandboxFileEntry } from "../Services/RailwaySandboxClient.ts";
import type { DaytonaSandboxRuntimeConfig } from "../daytonaSandboxConfig.ts";

const MANAGED_LABEL = "synara-managed";
const OPERATION_LABEL = "synara-create-operation-id";
const STAGING_ROOT = "/home/daytona/.synara-control";
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function status(sandbox: Sandbox): RailwaySandboxStatus {
  switch (sandbox.state) {
    case "started": return "RUNNING";
    case "creating":
    case "starting":
    case "restoring":
    case "pulling_snapshot": return "CREATING";
    case "destroying": return "DESTROYING";
    case "destroyed": return "DESTROYED";
    case "stopped":
    case "paused":
    case "archived": return "STOPPED";
    default: return "FAILED";
  }
}

function mode(value: string): number {
  if (/^[0-7]{3,4}$/u.test(value)) return Number.parseInt(value, 8);
  const permissions = value.slice(-9);
  if (!/^[rwxstST-]{9}$/u.test(permissions)) return 0;
  return [...permissions].reduce((bits, char, index) =>
    bits | (char !== "-" && char !== "S" && char !== "T" ? 1 << (8 - index) : 0), 0);
}

function failure(operation: string, cause: unknown, runtimeId?: string) {
  return cause instanceof DaytonaNotFoundError && runtimeId
    ? new RailwaySandboxNotFoundError({ operation, runtimeId, cause })
    : new RailwaySandboxClientError({ operation, detail: `Daytona sandbox ${operation} failed.`, ...(runtimeId ? { runtimeId } : {}), cause });
}

export function makeDaytonaSandboxClientLive(config: Extract<DaytonaSandboxRuntimeConfig, { readonly enabled: true }>) {
  return Layer.sync(RailwaySandboxClient, () => {
    const daytona = new Daytona({ apiKey: config.apiKey, apiUrl: config.apiUrl, target: config.target });
    const handles = new Map<string, Sandbox>();
    const get = async (id: string) => {
      const sandbox = handles.get(id) ?? await daytona.get(id);
      handles.set(id, sandbox);
      return sandbox;
    };
    const entry = (file: { name: string; size: number; mode: string; isDir: boolean; modifiedAt: string }): RailwaySandboxFileEntry => ({
      name: file.name, size: file.size, mode: mode(file.mode), isDir: file.isDir, modTime: file.modifiedAt,
    });
    const root = (command: string) => `sudo -n -E sh -lc ${quote(command)}`;
    const execute = async (sandbox: Sandbox, command: string, cwd?: string, timeoutSeconds?: number) =>
      sandbox.process.executeCommand(root(command), cwd, undefined, timeoutSeconds);
    const removeTemporary = async (sandbox: Sandbox, filePath: string) => {
      const removed = await sandbox.process.executeCommand(`rm -f ${quote(filePath)} && test ! -e ${quote(filePath)}`);
      if (removed.exitCode !== 0) throw new Error("Daytona private staging cleanup failed.");
    };
    const rootJson = async (sandbox: Sandbox, script: string, filePath: string) => {
      const result = await execute(sandbox, `node -e ${quote(script)} ${quote(filePath)}`, undefined, 30);
      if (result.exitCode !== 0) throw new Error("Daytona private file metadata failed.");
      return JSON.parse(result.result) as RailwaySandboxFileEntry | RailwaySandboxFileEntry[];
    };
    const statScript = `const fs=require("node:fs"),path=require("node:path"),p=process.argv[1],s=fs.lstatSync(p);console.log(JSON.stringify({name:path.basename(p),size:s.size,mode:s.mode&0o777,isDir:s.isDirectory(),modTime:s.mtime.toISOString()}))`;
    const listScript = `const fs=require("node:fs"),path=require("node:path"),p=process.argv[1];console.log(JSON.stringify(fs.readdirSync(p).map(name=>{const s=fs.lstatSync(path.join(p,name));return{name,size:s.size,mode:s.mode&0o777,isDir:s.isDirectory(),modTime:s.mtime.toISOString()}})))`;

    const client: RailwaySandboxClientShape = {
      create: (input) => Effect.tryPromise({
        try: async () => {
          if (input.region && input.region !== config.target) throw new Error("Daytona target differs from configured region.");
          if (input.networkIsolation !== "ISOLATED") throw new Error("Daytona workspaces cannot join the Railway private network.");
          const sandbox = await daytona.create({
            snapshot: input.checkpointName ?? config.snapshot,
            labels: { [MANAGED_LABEL]: "true", [OPERATION_LABEL]: input.operationId },
            autoStopInterval: input.idleTimeoutMinutes,
            autoDeleteInterval: -1,
          });
          handles.set(sandbox.id, sandbox);
          try {
            if (Object.keys(input.environment).length) await sandbox.updateEnv({ ...input.environment });
            const prepared = await sandbox.process.executeCommand(`mkdir -p -m 700 ${quote(STAGING_ROOT)} && chmod 700 ${quote(STAGING_ROOT)}`);
            if (prepared.exitCode !== 0) throw new Error("Daytona private staging directory could not be prepared.");
            return { id: sandbox.id, status: status(sandbox), region: sandbox.target };
          } catch (cause) {
            await sandbox.delete(60, true);
            handles.delete(sandbox.id);
            throw cause;
          }
        },
        catch: (cause) => failure("create", cause) as RailwaySandboxClientError,
      }),
      connect: (id) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          await sandbox.refreshData();
          return { id, status: status(sandbox), region: sandbox.target };
        },
        catch: (cause) => failure("connect", cause, id),
      }),
      exec: (id, input) => Effect.tryPromise({
        try: async () => {
          try {
            const result = await execute(await get(id), input.command, input.cwd, input.timeoutSeconds);
            return { exitCode: result.exitCode, stdout: result.result, stderr: "", timedOut: false, truncated: false };
          } catch (cause) {
            if (cause instanceof DaytonaProcessExecutionTimeoutError) {
              return { exitCode: null, stdout: "", stderr: "", timedOut: true, truncated: false };
            }
            throw cause;
          }
        },
        catch: (cause) => failure("exec", cause, id),
      }),
      writeFile: (id, input) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          const temporary = `${STAGING_ROOT}/upload-${randomUUID()}`;
          await sandbox.fs.uploadFile(Buffer.from(input.data), temporary);
          try {
            const result = await execute(sandbox, `install -D -m ${(input.mode ?? 0o600).toString(8)} ${quote(temporary)} ${quote(input.path)}`, undefined, 30);
            if (result.exitCode !== 0) throw new Error("Daytona file installation failed.");
          } finally {
            await removeTemporary(sandbox, temporary);
          }
        },
        catch: (cause) => failure("writeFile", cause, id),
      }),
      readFile: (id, filePath) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          try {
            return new Uint8Array(await sandbox.fs.downloadFile(filePath));
          } catch (cause) {
            if (!(cause instanceof DaytonaFileAccessDeniedError)) throw cause;
            const temporary = `${STAGING_ROOT}/read-${randomUUID()}`;
            const staged = await execute(sandbox, `install -m 0640 -g daytona ${quote(filePath)} ${quote(temporary)}`, undefined, 30);
            if (staged.exitCode !== 0) throw new Error("Daytona private file staging failed.");
            try {
              return new Uint8Array(await sandbox.fs.downloadFile(temporary));
            } finally {
              await removeTemporary(sandbox, temporary);
            }
          }
        },
        catch: (cause) => failure("readFile", cause, id),
      }),
      listFiles: (id, filePath) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          try { return (await sandbox.fs.listFiles(filePath)).map(entry); }
          catch (cause) {
            if (!(cause instanceof DaytonaFileAccessDeniedError)) throw cause;
            return await rootJson(sandbox, listScript, filePath) as RailwaySandboxFileEntry[];
          }
        },
        catch: (cause) => failure("listFiles", cause, id),
      }),
      statFile: (id, filePath) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          try { return entry(await sandbox.fs.getFileDetails(filePath)); }
          catch (cause) {
            if (!(cause instanceof DaytonaFileAccessDeniedError)) throw cause;
            return await rootJson(sandbox, statScript, filePath) as RailwaySandboxFileEntry;
          }
        },
        catch: (cause) => failure("statFile", cause, id),
      }),
      startDurableProcess: (id, input) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          const sessionName = `synara-${randomUUID()}`;
          await sandbox.process.createSession(sessionName);
          try {
            await sandbox.process.executeSessionCommand(sessionName, {
              command: root(input.cwd ? `cd ${quote(input.cwd)} && ${input.command}` : input.command),
              runAsync: true,
              suppressInputEcho: true,
            });
            return { sessionName, supervision: "durable" as const };
          } catch (cause) {
            await sandbox.process.deleteSession(sessionName).catch(() => undefined);
            throw cause;
          }
        },
        catch: (cause) => failure("startDurableProcess", cause, id),
      }),
      stopDurableProcess: (id, sessionName) => Effect.tryPromise({
        try: async () => { await (await get(id)).process.deleteSession(sessionName); },
        catch: (cause) => failure("stopDurableProcess", cause, id),
      }),
      checkpoint: (id, name) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          const clean = await sandbox.process.executeCommand(`test -d ${quote(STAGING_ROOT)} && test -z "$(find ${quote(STAGING_ROOT)} -mindepth 1 -print -quit)"`);
          if (clean.exitCode !== 0) throw new Error("Daytona private staging is not empty; refusing to snapshot.");
          await sandbox.createSnapshot(name, 300);
          const snapshot = await daytona.snapshot.get(name);
          return { id: snapshot.id, key: snapshot.name };
        },
        catch: (cause) => failure("checkpoint", cause, id),
      }),
      deleteCheckpoint: (id) => Effect.tryPromise({
        try: async () => { await daytona.snapshot.delete(id); },
        catch: (cause) => failure("deleteCheckpoint", cause, id),
      }),
      listCheckpoints: () => Effect.tryPromise({
        try: async () => {
          const checkpoints: Array<{ id: string; key: string }> = [];
          for (let page = 1;; page += 1) {
            const result = await daytona.snapshot.list({ page, limit: 100 });
            checkpoints.push(...result.items.filter((item) => item.name.startsWith("synara-thread-"))
              .map((item) => ({ id: item.id, key: item.name })));
            if (page >= result.totalPages) return checkpoints;
          }
        },
        catch: (cause) => failure("listCheckpoints", cause),
      }),
      destroy: (id) => Effect.tryPromise({
        try: async () => { await (await get(id)).delete(60, true); handles.delete(id); },
        catch: (cause) => failure("destroy", cause, id),
      }),
      findByCreateOperationId: (operationId) => Effect.tryPromise({
        try: async () => {
          for await (const sandbox of daytona.list({ labels: { [MANAGED_LABEL]: "true", [OPERATION_LABEL]: operationId } })) {
            if (status(sandbox) !== "DESTROYED") return sandbox.id;
          }
          return null;
        },
        catch: (cause) => failure("findByCreateOperationId", cause),
      }),
      list: Effect.tryPromise({
        try: async () => {
          const records = [];
          for await (const sandbox of daytona.list({ labels: { [MANAGED_LABEL]: "true" } })) {
            records.push({ id: sandbox.id, status: status(sandbox), region: sandbox.target });
          }
          return records;
        },
        catch: (cause) => failure("list", cause) as RailwaySandboxClientError,
      }),
    };
    return client;
  });
}
