import { randomUUID } from "node:crypto";
import { Daytona, DaytonaError, DaytonaFileAccessDeniedError, DaytonaNotFoundError, DaytonaProcessExecutionTimeoutError } from "@daytona/sdk";
import type { Sandbox } from "@daytona/sdk";
import { Duration, Effect, Layer, Schedule } from "effect";

import { RailwaySandboxClientError, RailwaySandboxNotFoundError } from "../Errors.ts";
import { RailwaySandboxClient } from "../Services/RailwaySandboxClient.ts";
import type { RailwaySandboxClientShape, RailwaySandboxStatus, RailwaySandboxFileEntry } from "../Services/RailwaySandboxClient.ts";
import type { DaytonaSandboxRuntimeConfig } from "../daytonaSandboxConfig.ts";
import { availableDaytonaContainerTargets } from "../daytonaRegions.ts";

const MANAGED_LABEL = "synara-managed";
const OPERATION_LABEL = "synara-create-operation-id";
/** Environment and purpose labels separate dev and production inside the one Glasswing Ventures organization. */
const ENV_LABEL = "env";
const PURPOSE_LABEL = "purpose";
const RESERVED_LABELS = new Set([MANAGED_LABEL, OPERATION_LABEL, ENV_LABEL, PURPOSE_LABEL]);
const STAGING_ROOT = "/home/daytona/.synara-control";
const PROBE_TTL_MINUTES = 15;
const BULK_READ_BATCH = 200;
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Caller labels (thread_id, run_id, pack_id) with reserved keys and odd values dropped. */
const extraLabels = (labels: Readonly<Record<string, string>> | undefined) =>
  Object.fromEntries(Object.entries(labels ?? {}).flatMap(([key, value]) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return /^[a-z][a-z0-9_.-]{0,62}$/u.test(key) && !RESERVED_LABELS.has(key) && trimmed && trimmed.length <= 256 ? [[key, trimmed]] : [];
  }));

const normalizedList = (value: string | undefined) =>
  (value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean).toSorted().join(",");
const sameList = (left: string | undefined, right: string) => normalizedList(left) === normalizedList(right);

/** Runs as root: installs staged uploads at their targets, root-owned, like `install -D -m`. */
const INSTALL_STAGED_SCRIPT = `const fs=require("node:fs"),path=require("node:path");
for(const f of JSON.parse(fs.readFileSync(process.argv[1],"utf8"))){fs.mkdirSync(path.dirname(f.to),{recursive:true,mode:0o755});const t=f.to+".synara-"+process.pid;fs.copyFileSync(f.from,t);fs.chownSync(t,0,0);fs.chmodSync(t,f.mode);fs.renameSync(t,f.to)}`;
/** Runs as root: copies readable regular files into a staging directory the toolbox user can read. */
const STAGE_FOR_READ_SCRIPT = `const fs=require("node:fs"),dir=process.argv[1],paths=JSON.parse(Buffer.from(process.argv[2],"base64").toString("utf8")),gid=fs.statSync(dir).gid,present=[];
paths.forEach((p,i)=>{try{if(!fs.statSync(p).isFile())return;const t=dir+"/"+i;fs.copyFileSync(p,t);fs.chownSync(t,0,gid);fs.chmodSync(t,0o640);present.push(i)}catch{}});
process.stdout.write("\\n@@SYNARA_STAGED@@"+JSON.stringify(present)+"\\n")`;

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
  if (cause instanceof RailwaySandboxClientError) return cause;
  return cause instanceof DaytonaNotFoundError && runtimeId
    ? new RailwaySandboxNotFoundError({ operation, runtimeId, cause })
    : new RailwaySandboxClientError({ operation, detail: `Daytona sandbox ${operation} failed.`, ...(runtimeId ? { runtimeId } : {}),
        ...(regionDenied(cause) ? { regionUnavailable: true } : {}), cause });
}

const regionDenied = (cause: unknown) => cause instanceof DaytonaError && cause.statusCode === 403 &&
  /^Region [a-z0-9-]+ is not available to the organization for class container$/u.test(cause.message);

export function makeDaytonaSandboxClientLive(config: Extract<DaytonaSandboxRuntimeConfig, { readonly enabled: true }>) {
  return Layer.effect(RailwaySandboxClient, Effect.gen(function* () {
    const daytona = new Daytona({ apiKey: config.apiKey, apiUrl: config.apiUrl, target: config.target });
    const targets = [config.target, ...(config.fallbackTarget ? [config.fallbackTarget] : [])];
    const allocators = new Map(targets.map((target) => [target, new Daytona({ apiKey: config.apiKey, apiUrl: config.apiUrl, target })]));
    const snapshotFor = (target: string) => target === config.target ? config.snapshot : config.fallbackSnapshot!;
    let eligibleTargets = config.fallbackTarget ? [] as string[] : [config.target];
    const blockedTargets = new Set<string>();
    const activatedTargets = new Set<string>();
    const pendingProbes = new Map<string, { id: string; startedAt: number }>();
    const refreshRegions = async () => {
      const available = await availableDaytonaContainerTargets(config);
      const next: string[] = [];
      const pools = config.warmPoolSize > 0 ? await daytona.warmPool.list() : [];
      for (const target of targets) {
        if (!available.has(target)) { blockedTargets.add(target); continue; }
        try {
        const allocator = allocators.get(target)!;
        const snapshot = await allocator.snapshot.get(snapshotFor(target));
        if (snapshot.state !== "active" || !snapshot.regionIds?.includes(target)) continue;
        // Probe uncertain regions off the conversation path. Empty probes never receive company credentials.
        if (blockedTargets.has(target)) {
          let probe;
          const pending = pendingProbes.get(target);
          const operationId = pending?.id ?? randomUUID();
          try {
            if (pending) {
              let found = false;
              for await (const owned of daytona.list({ labels: { "synara-region-probe": operationId } })) { found = true; await owned.delete(30, true); }
              // Empty probes auto-stop/delete. An uncertain probe may only delay another
              // empty probe; it never permits duplicate conversation allocation.
              if (!found && Date.now() - pending.startedAt < 5 * 60_000) continue;
              pendingProbes.delete(target);
            }
            pendingProbes.set(target, { id: operationId, startedAt: Date.now() });
            probe = await allocator.create({
              snapshot: snapshotFor(target),
              labels: { "synara-region-probe": operationId, [ENV_LABEL]: config.environmentName, [PURPOSE_LABEL]: "probe" },
              autoStopInterval: 1, ephemeral: true, ttlMinutes: PROBE_TTL_MINUTES,
              ...(config.domainAllowList ? { domainAllowList: config.domainAllowList } : {}),
            }, { timeout: 30 });
            await probe.delete(30, true);
            pendingProbes.delete(target);
            blockedTargets.delete(target);
          } catch (cause) { if (regionDenied(cause)) pendingProbes.delete(target); continue; }
        }
        if (config.warmPoolSize > 0) {
          let pool = pools.find((candidate) => candidate.target === target && candidate.snapshot === snapshotFor(target));
          pool ??= await daytona.warmPool.create({ snapshot: snapshotFor(target), target, pool: config.warmPoolSize });
          if (pool.pool !== config.warmPoolSize) pool = await daytona.warmPool.update(pool.id, { pool: config.warmPoolSize });
          if (pool.errorReason || (!activatedTargets.has(target) && pool.currentSize < 1)) continue;
          activatedTargets.add(target);
        }
        next.push(target);
        } catch { /* A failing preferred region cannot suppress a ready fallback. */ }
      }
      if (eligibleTargets.join(",") !== next.join(",")) console.info(JSON.stringify({ event: "daytona.regions.ready", targets: next }));
      eligibleTargets = next;
    };
    if (config.fallbackTarget || config.warmPoolSize > 0) {
      const refresh = Effect.tryPromise({ try: refreshRegions, catch: () => new Error("Daytona regional readiness refresh failed.") }).pipe(
        Effect.catch(() => Effect.logWarning("Daytona regional readiness refresh failed; retaining last known selection")),
      );
      yield* refresh;
      yield* Effect.forkScoped(Effect.sleep("15 seconds").pipe(Effect.andThen(refresh.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(15)))))));
    }
    /**
     * Warm-pool members are created before anyone claims them, so the settings asked for at
     * create are checked on the claimed sandbox and applied when missing. A sandbox that cannot
     * be brought to policy is deleted by the caller; none is handed out without its allow-list.
     */
    const enforceCreateSettings = async (sandbox: Sandbox, expected: { readonly labels: Record<string, string>; readonly ttlMinutes: number }) => {
      await sandbox.refreshData();
      const applied: string[] = [];
      if (config.domainAllowList && !sameList(sandbox.domainAllowList, config.domainAllowList)) {
        await sandbox.updateNetworkSettings({ domainAllowList: config.domainAllowList });
        applied.push("domainAllowList");
      }
      if (typeof sandbox.autoDeleteInterval === "number" && sandbox.autoDeleteInterval !== 0) {
        await sandbox.setAutoDeleteInterval(0);
        applied.push("ephemeral");
      }
      if (expected.ttlMinutes > 0 && !sandbox.autoDestroyAt) {
        await sandbox.setTtl(expected.ttlMinutes);
        applied.push("ttlMinutes");
      }
      if (Object.entries(expected.labels).some(([key, value]) => sandbox.labels?.[key] !== value)) {
        await sandbox.setLabels({ ...sandbox.labels, ...expected.labels });
        applied.push("labels");
      }
      if (applied.length) console.warn(JSON.stringify({ event: "daytona.create.settings-applied", sandboxId: sandbox.id, applied }));
    };
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
          if ((input.region && input.region !== config.target) || input.networkIsolation !== "ISOLATED" ||
              (input.checkpointName && input.checkpointName !== config.snapshot)) throw new RailwaySandboxClientError({
            operation: "create", detail: "Daytona allocation requires configured regional snapshots and isolated networking.", createRejected: true,
          });
          const candidates = eligibleTargets.filter((target) => !blockedTargets.has(target));
          if (!candidates.length) throw new RailwaySandboxClientError({ operation: "create", detail: "No prepared Daytona region is ready; retry after regional recovery.", createRejected: true });
          const purpose = input.purpose ?? "chat";
          const ttlMinutes = config.ttlMinutes[purpose];
          const labels = {
            ...extraLabels(input.labels),
            [MANAGED_LABEL]: "true", [OPERATION_LABEL]: input.operationId,
            [ENV_LABEL]: config.environmentName, [PURPOSE_LABEL]: purpose,
          };
          let sandbox: Sandbox | undefined;
          for (const target of candidates) {
            try {
              sandbox = await allocators.get(target)!.create({
                snapshot: snapshotFor(target),
                labels,
                // Provider idle retirement is earlier; the periodic outbox read renews activity during live turns.
                autoStopInterval: input.idleTimeoutMinutes,
                // Disposable: a stopped sandbox is deleted (it is replaced, never resumed) and none outlives its TTL.
                ephemeral: true,
                ttlMinutes,
                ...(config.domainAllowList ? { domainAllowList: config.domainAllowList } : {}),
              });
              break;
            } catch (cause) {
              if (config.fallbackTarget || config.warmPoolSize > 0) blockedTargets.add(target);
              // A readiness/transport failure may own a disk: keep its intent, never allocate twice.
              if (!regionDenied(cause)) throw cause;
              if (target === candidates.at(-1)) throw new RailwaySandboxClientError({ operation: "create", detail: "Daytona rejected sandbox creation in all prepared regions.", createRejected: true, regionUnavailable: true, cause });
            }
          }
          if (!sandbox) throw new Error("Daytona allocation did not return a sandbox.");
          handles.set(sandbox.id, sandbox);
          try {
            await enforceCreateSettings(sandbox, { labels, ttlMinutes });
            if (Object.keys(input.environment).length) await sandbox.updateEnv({ ...input.environment });
            const prepared = await sandbox.process.executeCommand(`mkdir -p -m 700 ${quote(STAGING_ROOT)} && chmod 700 ${quote(STAGING_ROOT)}`);
            if (prepared.exitCode !== 0) throw new Error("Daytona private staging directory could not be prepared.");
            return { id: sandbox.id, status: status(sandbox), region: sandbox.target };
          } catch (cause) {
            await sandbox.delete(60, true);
            handles.delete(sandbox.id);
            throw new RailwaySandboxClientError({ operation: "create", detail: "Daytona sandbox setup failed; its disk was deleted.", createRejected: true, cause });
          }
        },
        catch: (cause) => {
          const vendor = cause instanceof RailwaySandboxClientError ? cause.cause : cause;
          console.warn(JSON.stringify({ event: "daytona.create.failed", operationId: input.operationId,
            ...(cause instanceof RailwaySandboxClientError ? { stage: cause.detail } : {}),
            ...(vendor instanceof DaytonaError ? { error: vendor.name, statusCode: vendor.statusCode, code: vendor.code,
              source: vendor.source, detail: vendor.message.replace(/https?:\/\/\S+/gu, "[url]").slice(0, 1000) } : { error: "unknown" }) }));
          return failure("create", cause) as RailwaySandboxClientError;
        },
      }),
      connect: (id) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          await sandbox.refreshData();
          return { id, status: status(sandbox), region: sandbox.target };
        },
        catch: (cause) => failure("connect", cause, id),
      }),
      start: (id, environment) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          await sandbox.refreshData();
          if (status(sandbox) === "STOPPED") await sandbox.start();
          // updateEnv changes the running daemon only; stop/start discards it.
          if (environment && Object.keys(environment).length) await sandbox.updateEnv({ ...environment });
          await sandbox.refreshData();
          return { id, status: status(sandbox), region: sandbox.target };
        },
        catch: (cause) => failure("start", cause, id),
      }),
      stop: (id) => Effect.tryPromise({
        try: async () => {
          const sandbox = await get(id);
          await sandbox.refreshData();
          if (status(sandbox) === "RUNNING") await sandbox.stop();
          await sandbox.refreshData();
          return { id, status: status(sandbox), region: sandbox.target };
        },
        catch: (cause) => failure("stop", cause, id),
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
          let cleaned = false;
          try {
            await sandbox.fs.uploadFile(Buffer.from(input.data), temporary);
            const result = await execute(sandbox, `install -D -m ${(input.mode ?? 0o600).toString(8)} ${quote(temporary)} ${quote(input.path)} && rm -f ${quote(temporary)} && test ! -e ${quote(temporary)}`, undefined, 30);
            if (result.exitCode !== 0) throw new Error("Daytona file installation failed.");
            cleaned = true;
          } finally {
            if (!cleaned) await removeTemporary(sandbox, temporary);
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
            try {
              const staged = await execute(sandbox, `install -m 0640 -g daytona ${quote(filePath)} ${quote(temporary)}`, undefined, 30);
              if (staged.exitCode !== 0) throw new Error("Daytona private file staging failed.");
              return new Uint8Array(await sandbox.fs.downloadFile(temporary));
            } finally {
              await removeTemporary(sandbox, temporary);
            }
          }
        },
        catch: (cause) => failure("readFile", cause, id),
      }),
      writeFiles: (id, files) => Effect.tryPromise({
        try: async () => {
          if (files.length === 0) return;
          const sandbox = await get(id);
          const staging = `${STAGING_ROOT}/bulk-${randomUUID()}`;
          const made = await sandbox.process.executeCommand(`mkdir -m 700 ${quote(staging)}`);
          if (made.exitCode !== 0) throw new Error("Daytona bulk staging directory could not be prepared.");
          try {
            const manifest = files.map((file, index) => ({ from: `${staging}/${index}`, to: file.path, mode: file.mode ?? 0o600 }));
            await sandbox.fs.uploadFiles([
              ...files.map((file, index) => ({ source: Buffer.from(file.data), destination: `${staging}/${index}` })),
              { source: Buffer.from(JSON.stringify(manifest)), destination: `${staging}/manifest.json` },
            ], 300);
            const installed = await execute(sandbox, `node -e ${quote(INSTALL_STAGED_SCRIPT)} ${quote(`${staging}/manifest.json`)}`, undefined, 120);
            if (installed.exitCode !== 0) throw new Error("Daytona bulk file installation failed.");
          } finally {
            const removed = await sandbox.process.executeCommand(`rm -rf ${quote(staging)} && test ! -e ${quote(staging)}`);
            if (removed.exitCode !== 0) console.warn(JSON.stringify({ event: "daytona.bulk.cleanup-failed", sandboxId: id }));
          }
        },
        catch: (cause) => failure("writeFiles", cause, id),
      }),
      readFiles: (id, paths) => Effect.tryPromise({
        try: async () => {
          const read = new Map<string, Uint8Array>();
          if (paths.length === 0) return read;
          const sandbox = await get(id);
          for (let start = 0; start < paths.length; start += BULK_READ_BATCH) {
            const batch = paths.slice(start, start + BULK_READ_BATCH);
            const staging = `${STAGING_ROOT}/bulk-${randomUUID()}`;
            try {
              const encoded = Buffer.from(JSON.stringify(batch)).toString("base64");
              const staged = await execute(sandbox, `install -d -m 0750 -g daytona ${quote(staging)} && node -e ${quote(STAGE_FOR_READ_SCRIPT)} ${quote(staging)} ${encoded}`, undefined, 120);
              const marker = staged.result.split("\n").findLast((line) => line.startsWith("@@SYNARA_STAGED@@"));
              if (staged.exitCode !== 0 || !marker) throw new Error("Daytona bulk file staging failed.");
              const present = JSON.parse(marker.slice("@@SYNARA_STAGED@@".length)) as number[];
              if (present.length === 0) continue;
              const results = await sandbox.fs.downloadFiles(present.map((index) => ({ source: `${staging}/${index}` })), 300);
              for (const result of results) {
                const index = Number(result.source.slice(staging.length + 1));
                // An empty file may come back without a body.
                const data = result.result ?? Buffer.alloc(0);
                if (result.error || !Buffer.isBuffer(data) || !Number.isInteger(index) || batch[index] === undefined)
                  throw new Error(`Daytona bulk download failed: ${result.error ?? "unexpected result"}`);
                read.set(batch[index]!, new Uint8Array(data));
              }
              if (results.length !== present.length) throw new Error("Daytona bulk download returned an incomplete result.");
            } finally {
              await execute(sandbox, `rm -rf ${quote(staging)}`, undefined, 30).catch(() => undefined);
            }
          }
          return read;
        },
        catch: (cause) => failure("readFiles", cause, id),
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
          // This environment's sandboxes only: the organization also holds the other environment's.
          for await (const sandbox of daytona.list({ labels: { [MANAGED_LABEL]: "true", [ENV_LABEL]: config.environmentName } })) {
            records.push({ id: sandbox.id, status: status(sandbox), region: sandbox.target });
          }
          return records;
        },
        catch: (cause) => failure("list", cause) as RailwaySandboxClientError,
      }),
    };
    return client;
  }));
}
