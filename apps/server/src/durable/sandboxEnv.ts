/**
 * Pi Durable execution environment backed by one conversation sandbox.
 *
 * The agent loop runs in the controller. File and shell tools reach the sandbox through
 * the workspace runtime's exec and upload calls; nothing runs in the sandbox between calls.
 * Every operation runs as the unprivileged agent user, so permissions match the old worker.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Context } from "@earendil-works/chord";
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  LineScanner,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  err,
  ok,
} from "@earendil-works/pi-durable/env";

export const SANDBOX_AGENT_UID = 10001;
const AGENT_HOME = "/workspace";
const AGENT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin";
const RESULT_MARKER = "@@SYNARA_ENV@@";
/** One `sh -c` argument is capped at 128 KiB by Linux; larger payloads go through an upload. */
const INLINE_PAYLOAD_BYTES = 48 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;

export interface SandboxCommandResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

/** How the environment reaches its sandbox. The adapter binds these to the thread's sandbox lazily. */
export interface SandboxRunner {
  /** Runs `command` as root through `sh -c`. */
  run(command: string, options: { readonly timeoutSeconds?: number }): Promise<SandboxCommandResult>;
  /** Writes bytes to a sandbox path readable by the agent user. */
  upload(filePath: string, data: Uint8Array): Promise<void>;
  /** One transfer for many files (root-owned, mode 0644 unless given); absent when the runtime has no bulk API. */
  uploadMany?(files: ReadonlyArray<{ readonly path: string; readonly data: Uint8Array; readonly mode?: number }>): Promise<void>;
  /** One transfer for many regular files, read as root; missing paths are omitted. */
  downloadMany?(paths: ReadonlyArray<string>): Promise<ReadonlyMap<string, Uint8Array>>;
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Runs as root, drops to the agent user, performs one file operation and prints one result line. */
const HELPER = `
const fs=require("node:fs"),p=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
process.setgroups([]);process.setgid(${SANDBOX_AGENT_UID});process.setuid(${SANDBOX_AGENT_UID});process.env.HOME=${JSON.stringify(AGENT_HOME)};
const a=JSON.parse(Buffer.from(process.argv[1],"base64").toString("utf8"));
const kind=s=>s.isSymbolicLink()?"symlink":s.isDirectory()?"directory":s.isFile()?"file":"other";
const info=(f,s)=>({name:p.basename(f),path:f,kind:kind(s),size:s.size,mtimeMs:s.mtimeMs});
const done=v=>process.stdout.write("\\n${RESULT_MARKER}"+JSON.stringify(v)+"\\n");
const bytes=()=>a.from?fs.readFileSync(a.from):Buffer.from(a.b64||"","base64");
try{let r;switch(a.op){
case "read":{const s=a.noFollow?fs.lstatSync(a.path):fs.statSync(a.path);if(s.isDirectory()){const e=new Error("is a directory");e.code="EISDIR";throw e}if(!s.isFile()){const e=new Error("not a regular file");e.code="EINVALID";throw e}if(s.size>${MAX_READ_BYTES}){const e=new Error("file too large");e.code="EFBIG";throw e}r={info:info(a.path,s),b64:fs.readFileSync(a.path).toString("base64")};break}
case "stat":r=info(a.path,a.noFollow?fs.lstatSync(a.path):fs.statSync(a.path));break;
case "list":r=fs.readdirSync(a.path).flatMap(n=>{const f=p.join(a.path,n);try{const s=fs.lstatSync(f);return kind(s)==="other"?[]:[info(f,s)]}catch{return[]}});break;
case "write":fs.writeFileSync(a.path,bytes());break;
case "append":fs.appendFileSync(a.path,bytes());break;
case "truncate":fs.truncateSync(a.path,a.size);break;
case "flush":{const fd=fs.openSync(a.path,"r+");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}break}
case "rename":fs.renameSync(a.path,a.to);break;
case "exists":try{fs.statSync(a.path);r=true}catch(e){if(e.code==="ENOENT"||e.code==="ENOTDIR")r=false;else throw e}break;
case "mkdir":fs.mkdirSync(a.path,{recursive:!!a.recursive});break;
case "rm":fs.rmSync(a.path,{recursive:!!a.recursive,force:!!a.force});break;
case "realpath":r=fs.realpathSync(a.path);break;
case "mkdtemp":r=fs.mkdtempSync(p.join(os.tmpdir(),a.prefix||"synara-"));break;
case "mktemp":{const f=p.join(os.tmpdir(),(a.prefix||"synara-")+crypto.randomUUID()+(a.suffix||""));fs.writeFileSync(f,"",{flag:"wx"});r=f;break}
default:throw Object.assign(new Error("unknown operation"),{code:"ENOSYS"})}
done({ok:true,value:r===undefined?null:r})}catch(e){done({ok:false,code:e.code||"UNKNOWN",message:String(e.message||e)})}
`;

const fileErrorCode = (code: string): FileErrorCode => {
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "permission_denied";
    case "ENOTDIR":
      return "not_directory";
    case "EISDIR":
      return "is_directory";
    case "EINVALID":
    case "EINVAL":
    case "EFBIG":
    case "ELOOP":
      return "invalid";
    case "ENOSYS":
      return "not_supported";
    default:
      return "unknown";
  }
};

const aborted = (context: Context) => context.abortSignal?.aborted === true;

type HelperReply = { ok: true; value: unknown } | { ok: false; code: string; message: string };

export class SandboxExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #runner: SandboxRunner;

  constructor(input: { readonly id: string; readonly cwd: string; readonly runner: SandboxRunner }) {
    this.id = input.id;
    this.cwd = input.cwd;
    this.#runner = input.runner;
  }

  async #op(
    args: Record<string, unknown>,
    context: Context,
    payload?: Uint8Array,
  ): Promise<Result<unknown, FileError>> {
    const target = typeof args.path === "string" ? args.path : undefined;
    if (aborted(context)) return err(new FileError("aborted", "Operation aborted", target));
    let staged: string | undefined;
    try {
      const request = { ...args };
      if (payload !== undefined) {
        if (payload.byteLength > INLINE_PAYLOAD_BYTES) {
          staged = `/tmp/synara-env-${randomUUID()}`;
          await this.#runner.upload(staged, payload);
          request.from = staged;
        } else {
          request.b64 = Buffer.from(payload).toString("base64");
        }
      }
      const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
      const command = `node -e ${shellQuote(HELPER)} ${encoded}${staged ? `; rm -f ${shellQuote(staged)}` : ""}`;
      const result = await this.#runner.run(command, { timeoutSeconds: 120 });
      const line = result.output.split("\n").findLast((candidate) => candidate.startsWith(RESULT_MARKER));
      if (!line) {
        return err(new FileError("unknown", `Sandbox file operation failed: ${result.output.slice(-400) || "no output"}`, target));
      }
      const reply = JSON.parse(line.slice(RESULT_MARKER.length)) as HelperReply;
      if (!reply.ok) return err(new FileError(fileErrorCode(reply.code), reply.message, target));
      return ok(reply.value);
    } catch (cause) {
      return err(new FileError("unknown", cause instanceof Error ? cause.message : String(cause), target, cause instanceof Error ? cause : undefined));
    }
  }

  async #void(args: Record<string, unknown>, context: Context, payload?: Uint8Array): Promise<Result<void, FileError>> {
    const result = await this.#op(args, context, payload);
    return result.ok ? ok(undefined) : result;
  }

  #resolve(filePath: string) {
    return path.posix.resolve(this.cwd, filePath);
  }

  async absolutePath(filePath: string): Promise<Result<string, FileError>> {
    return ok(this.#resolve(filePath));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(path.posix.join(...parts));
  }

  async #readBytes(
    filePath: string,
    context: Context,
    noFollow = false,
  ): Promise<Result<{ info: FileInfo; bytes: Uint8Array }, FileError>> {
    const result = await this.#op({ op: "read", path: this.#resolve(filePath), noFollow }, context);
    if (!result.ok) return result;
    const value = result.value as { info: FileInfo; b64: string };
    return ok({ info: value.info, bytes: new Uint8Array(Buffer.from(value.b64, "base64")) });
  }

  async readTextFile(filePath: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.#readBytes(filePath, context);
    return result.ok ? ok(new TextDecoder().decode(result.value.bytes)) : result;
  }

  async readBinaryFile(filePath: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const result = await this.#readBytes(filePath, context);
    return result.ok ? ok(result.value.bytes) : result;
  }

  async readTextLines(
    filePath: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(filePath, context);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async openTextLineReader(filePath: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(filePath, context);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    let index = 0;
    return ok({
      readLine: async () => {
        if (index >= lines.length) return ok(undefined);
        const terminated = index < lines.length - 1;
        const line = lines[index++]!;
        if (!terminated && line.length === 0) return ok(undefined);
        return ok({ text: line, terminated });
      },
      close: async () => {},
    });
  }

  async openBinaryReader(
    filePath: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const result = await this.#readBytes(filePath, context, options?.noFollow === true);
    if (!result.ok) return result;
    const { info, bytes } = result.value;
    return ok({
      info: async () => ok(info),
      read: async (offset, length) => ok(bytes.subarray(offset, Math.min(bytes.byteLength, offset + length))),
      scanLines: async (scan): Promise<Result<LineScan, FileError>> => {
        const scanner = new LineScanner(scan.startLine, scan.endLine);
        scanner.push(bytes);
        return ok(scanner.finish());
      },
      close: async () => {},
    });
  }

  writeFile(filePath: string, content: string | Uint8Array, context: Context) {
    const payload = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return this.#void({ op: "write", path: this.#resolve(filePath) }, context, payload);
  }

  appendFile(filePath: string, content: string | Uint8Array, context: Context) {
    const payload = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return this.#void({ op: "append", path: this.#resolve(filePath) }, context, payload);
  }

  truncateFile(filePath: string, size: number, context: Context) {
    return this.#void({ op: "truncate", path: this.#resolve(filePath), size }, context);
  }

  flushFile(filePath: string, context: Context) {
    return this.#void({ op: "flush", path: this.#resolve(filePath) }, context);
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context) {
    return this.#void({ op: "rename", path: this.#resolve(sourcePath), to: this.#resolve(destinationPath) }, context);
  }

  async fileInfo(filePath: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const result = await this.#op({ op: "stat", path: this.#resolve(filePath) }, context);
    return result.ok ? ok(result.value as FileInfo) : result;
  }

  async listDir(filePath: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const result = await this.#op({ op: "list", path: this.#resolve(filePath) }, context);
    return result.ok ? ok(result.value as FileInfo[]) : result;
  }

  async openDirReader(filePath: string, context: Context): Promise<Result<DirReader, FileError>> {
    const listed = await this.listDir(filePath, context);
    if (!listed.ok) return listed;
    let position = 0;
    return ok({
      next: async (maxEntries) => {
        const entries = listed.value.slice(position, position + maxEntries);
        position += entries.length;
        return ok({ entries, done: position >= listed.value.length });
      },
      close: async () => {},
    });
  }

  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError("not_supported", "Sandbox environments do not watch files."));
  }

  async canonicalPath(filePath: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.#op({ op: "realpath", path: this.#resolve(filePath) }, context);
    return result.ok ? ok(result.value as string) : result;
  }

  async exists(filePath: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.#op({ op: "exists", path: this.#resolve(filePath) }, context);
    return result.ok ? ok(result.value as boolean) : result;
  }

  createDir(filePath: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.#void({ op: "mkdir", path: this.#resolve(filePath), recursive: options?.recursive === true }, context);
  }

  remove(filePath: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    return this.#void(
      { op: "rm", path: this.#resolve(filePath), recursive: options?.recursive === true, force: options?.force === true },
      context,
    );
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const result = await this.#op({ op: "mkdtemp", prefix }, context);
    return result.ok ? ok(result.value as string) : result;
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const result = await this.#op({ op: "mktemp", prefix: options?.prefix, suffix: options?.suffix }, context);
    return result.ok ? ok(result.value as string) : result;
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (aborted(context)) return err(new ExecutionError("aborted", "Command aborted"));
    const script = typeof command === "string" ? command : command.map(shellQuote).join(" ");
    const cwd = options?.cwd ?? this.cwd;
    const extraEnv = Object.entries(options?.env ?? {})
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    // A clean environment: the sandbox process env may hold controller credentials.
    const wrapped = [
      `cd ${shellQuote(cwd)} &&`,
      `exec setpriv --reuid=${SANDBOX_AGENT_UID} --regid=${SANDBOX_AGENT_UID} --clear-groups`,
      `env -i HOME=${AGENT_HOME} PATH=${AGENT_PATH} LANG=C.UTF-8 TERM=dumb`,
      "GIT_CONFIG_GLOBAL=/opt/synara/agent-gitconfig",
      extraEnv,
      `bash -c ${shellQuote(script)} 2>&1`,
    ].filter(Boolean).join(" ");
    const timeoutSeconds = options?.timeout === undefined ? 3600 : Math.max(1, Math.ceil(options.timeout));
    let result: SandboxCommandResult;
    try {
      result = await raceAbort(this.#runner.run(wrapped, { timeoutSeconds }), context);
    } catch (cause) {
      if (aborted(context)) return err(new ExecutionError("aborted", "Command aborted"));
      return err(new ExecutionError("unknown", cause instanceof Error ? cause.message : String(cause)));
    }
    if (result.output.length > 0) {
      try {
        options?.onOutput?.(result.output, context, { stream: "stdout" });
      } catch (cause) {
        return err(new ExecutionError("callback_error", "Output callback failed", cause instanceof Error ? cause : undefined));
      }
    }
    if (result.timedOut) return err(new ExecutionError("timeout", `Command timed out after ${timeoutSeconds} seconds`));
    return ok({ exitCode: result.exitCode ?? 1 });
  }

  async cleanup(): Promise<void> {}
}

const raceAbort = <T>(promise: Promise<T>, context: Context): Promise<T> => {
  const signal = context.abortSignal;
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
};
