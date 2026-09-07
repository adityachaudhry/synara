// Exercise the shipped Node server, not Bun's source loader. No provider credentials required.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const directory = await mkdtemp(path.join(tmpdir(), "synara-node-mcp-"));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("../dist/index.mjs", import.meta.url))],
  {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "production",
      SYNARA_HOME: directory,
      SYNARA_HOST: "127.0.0.1",
      SYNARA_PORT: String(port),
      SYNARA_NO_BROWSER: "1",
      SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
      PI_CODING_AGENT_DIR: path.join(directory, "pi"),
      GLASSWING_CRUNCHBASE_MCP_URL: "http://127.0.0.1:1/mcp/",
      GLASSWING_CRUNCHBASE_MCP_TOKEN: "packaging-smoke-no-real-credential",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stdout.on("data", (data) => {
  logs = (logs + data).slice(-8000);
});
child.stderr.on("data", (data) => {
  logs = (logs + data).slice(-8000);
});
const exited = new Promise((resolve) => child.once("exit", resolve));
let socket;
try {
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, `Built server did not become ready: ${logs}`);
  const negotiated = await (
    await fetch(
      `http://127.0.0.1:${port}/ws/negotiate?x-synara-client-build=packaging-smoke&x-synara-protocol-epoch=1&x-synara-protocol-min-revision=1&x-synara-protocol-max-revision=1`,
    )
  ).json();
  assert(negotiated.serverInstanceId, JSON.stringify(negotiated));
  socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws?x-synara-client-build=packaging-smoke&x-synara-protocol-epoch=1&x-synara-protocol-revision=1&x-synara-server-instance=${negotiated.serverInstanceId}`,
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Model discovery timed out: ${logs}`)),
      30_000,
    );
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("open", () =>
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: "provider.listModels",
          payload: { provider: "pi" },
          headers: [],
        }),
      ),
    );
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message._tag !== "Exit" || message.requestId !== "1") return;
        clearTimeout(timeout);
        assert.equal(message.exit._tag, "Success", JSON.stringify(message.exit));
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
  console.log("PASS: shipped Node server discovers models with the MCP extension enabled");
} finally {
  socket?.terminate();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  await rm(directory, { recursive: true, force: true });
}
