/** Actual SDK/session-file checks in a disposable directory; no provider or model calls. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractLegacyPiResumeSessionFile, extractResumeSessionFile, validatePiResumeSessionFile } from "../../apps/server/src/provider/Layers/PiAdapter.ts";
import { legacyPiSessionCopyCommand } from "../../apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner.ts";

assert(process.argv.includes("--run-local"), "Pass --run-local for the disposable filesystem check");
const { SessionManager, CURRENT_SESSION_VERSION } = await import("../../apps/server/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js");
if (process.argv.includes("--uid-child")) {
  try { if (process.getuid() !== 10001) { process.setgroups([10001]); process.setgid(10001); process.setuid(10001); } }
  catch { console.log("UID_DROP_BLOCKED: local process cannot assume UID10001"); process.exit(77); }
  assert.equal(process.getuid(), 10001);
  const file = process.argv.at(-1)!;
  const identity = await validatePiResumeSessionFile(file, CURRENT_SESSION_VERSION);
  const resumed = SessionManager.open(file, undefined, "/workspace");
  assert.equal(resumed.getSessionId(), identity);
  assert(JSON.stringify(resumed.buildSessionContext().messages).includes("qa-history-marker"));
  console.log("PASS: actual SDK history resumed as UID10001");
  process.exit(0);
}
const root = await realpath(await mkdtemp(path.join(tmpdir(), "synara-pi-history-")));
try {
  const sourceRoot = path.join(root, "source"), targetRoot = path.join(root, "target");
  const sessionDir = path.join(sourceRoot, ".pi/agent/sessions/company");
  await mkdir(sessionDir, { recursive: true });
  const original = SessionManager.create("/workspace/repository/companies/qa", sessionDir);
  original.appendMessage({ role: "user", content: "qa-history-marker", timestamp: Date.now() });
  original.appendMessage({ role: "assistant", content: [{ type: "text", text: "remembered" }], api: "openai-responses", provider: "openai", model: "qa", timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const source = original.getSessionFile()!;
  const legacy = `/root${source.slice(sourceRoot.length)}`;
  const target = `${targetRoot}${legacy.slice("/root".length)}`;
  const command = legacyPiSessionCopyCommand(legacy).replaceAll("/root", sourceRoot).replaceAll("/workspace", targetRoot);
  const copy = () => spawnSync("sh", ["-c", command], { encoding: "utf8" });
  assert.equal(extractLegacyPiResumeSessionFile({ sessionFile: legacy, custom: true }), legacy);
  assert.equal(extractResumeSessionFile({ nativeHandle: "/custom/history.jsonl" }), "/custom/history.jsonl");
  for (const value of ["/custom/history.jsonl", "/root/.pi/agent/sessions/../escape.jsonl", "/root/.pi/agent/sessions//file.jsonl", { unknown: legacy }]) assert.equal(extractLegacyPiResumeSessionFile(value), undefined);
  assert.equal(copy().status, 0);
  const bytes = await readFile(source);
  assert.deepEqual(await readFile(target), bytes);
  await rm(target); await link(source, target);
  assert.notEqual(copy().status, 0, "A shared inode must not mutate the retained source during SDK migration/chown");
  await assert.rejects(validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION));
  assert.deepEqual(await readFile(source), bytes);
  await rm(target); assert.equal(copy().status, 0);
  const escape = path.join(root, "escape"), targetPi = path.join(targetRoot, ".pi");
  await mkdir(escape); await rm(targetPi, { recursive: true }); await symlink(escape, targetPi);
  assert.notEqual(copy().status, 0, "Destination ancestors must be checked before copying as root");
  assert.deepEqual(await readdir(escape), [], "Rejected copy must not write through a symlink ancestor");
  await rm(targetPi); assert.equal(copy().status, 0);
  assert.equal(await validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION), original.getSessionId());
  const resumed = SessionManager.open(target, undefined, "/workspace/repository/companies/qa");
  assert.equal(resumed.getSessionId(), original.getSessionId());
  assert.deepEqual(resumed.buildSessionContext().messages, original.buildSessionContext().messages);
  const v1 = bytes.toString().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  v1[0].version = 1;
  await writeFile(target, `${v1.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  assert.equal(await validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION), original.getSessionId());
  assert.deepEqual(SessionManager.open(target, undefined, "/workspace").buildSessionContext().messages, original.buildSessionContext().messages);
  assert.deepEqual(await readFile(source), bytes, "SDK migration must retain the authoritative source");
  await writeFile(target, bytes);
  assert.equal(copy().status, 0, "Identical copies are reusable");
  await writeFile(target, `${bytes.toString()}${JSON.stringify({ type: "custom", id: "new-edit", parentId: null })}\n`);
  assert.notEqual(copy().status, 0, "Conflicting copies must not overwrite either side");
  assert.deepEqual(await readFile(source), bytes);
  await writeFile(target, ""); await assert.rejects(validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION));
  await writeFile(target, `${bytes.toString()}broken-json\n`); await assert.rejects(validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION));
  await writeFile(target, JSON.stringify({ type: "session", id: original.getSessionId(), cwd: "/workspace", version: CURRENT_SESSION_VERSION + 1 })); await assert.rejects(validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION));
  await writeFile(target, bytes); await chmod(target, 0); await assert.rejects(validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION)); await chmod(target, 0o600);
  await rm(target); await assert.rejects(validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION));
  await symlink(source, target); await assert.rejects(validatePiResumeSessionFile(target, CURRENT_SESSION_VERSION));
  await rm(target); await writeFile(target, bytes); await chmod(root, 0o755); await chmod(target, 0o666);
  const child = spawnSync(process.execPath, [path.resolve(process.argv[1]!), "--run-local", "--uid-child", target], { encoding: "utf8", env: { ...process.env, HOME: "/workspace" } });
  assert([0, 77].includes(child.status!), child.stderr);
  console.log(child.stdout.trim());
  await rm(source); assert.notEqual(copy().status, 0, "Missing authoritative history must block copying");
  console.log("PASS: actual SDK identity/history, copy conflict, missing/empty/malformed/future-version/symlink history, custom cursor preservation");
} finally { await rm(root, { recursive: true, force: true }); }
