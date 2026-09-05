import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const typesDir = path.join(webRoot, "dist-embed/types");
const buildDir = path.join(webRoot, "dist-embed/build");

function run(command, args) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: webRoot,
      stdio: "inherit",
      shell: process.platform === "win32" && !path.isAbsolute(command),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      console.log(`[embed] ${command}: ${((performance.now() - started) / 1000).toFixed(1)}s`);
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

// Generate shared inputs before either consumer starts reading the route tree.
await run(process.execPath, ["scripts/generate-embed-routes.mjs"]);

// Separate output directories prevent Vite's cleanup from racing declaration
// emit. Both checks must finish successfully before the package is assembled.
const results = await Promise.allSettled([
  run("vite", ["build", "--config", "vite.embed.config.ts"]),
  run("tsc", ["-p", "tsconfig.embed.json"]),
]);
for (const result of results) {
  if (result.status === "rejected") throw result.reason;
}
await fs.cp(typesDir, buildDir, {
  recursive: true,
  filter: (source) => !source.endsWith(".tsbuildinfo"),
});
await run(process.execPath, ["scripts/write-embed-package.mjs"]);
