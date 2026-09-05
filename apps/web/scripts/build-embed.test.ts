import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(failTypes = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embed-build-test-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "scripts"));
  await fs.mkdir(path.join(root, "bin"));
  await fs.copyFile(new URL("./build-embed.mjs", import.meta.url), path.join(root, "scripts/build-embed.mjs"));
  await fs.writeFile(path.join(root, "scripts/generate-embed-routes.mjs"), "import fs from 'node:fs'; fs.writeFileSync('routes.ready', '');\n");
  for (const [name, other, directory, filename] of [
    ["vite", "tsc", "build", "index.js"],
    ["tsc", "vite", "types", "embedded.d.ts"],
  ]) {
    await fs.writeFile(path.join(root, "bin", name!), `#!/usr/bin/env node
const fs = require('node:fs');
if (!fs.existsSync('routes.ready')) process.exit(9);
fs.writeFileSync('${name}.started', '');
let attempts = 0;
const timer = setInterval(() => {
  if (!fs.existsSync('${other}.started')) {
    if (++attempts > 100) process.exit(8);
    return;
  }
  clearInterval(timer);
  if (${name === "tsc" && failTypes}) process.exit(2);
  fs.mkdirSync('dist-embed/${directory}', {recursive: true});
  fs.writeFileSync('dist-embed/${directory}/${filename}', 'export {};');
  if ('${name}' === 'tsc') fs.writeFileSync('dist-embed/types/embed.tsbuildinfo', '{}');
}, 10);
`, { mode: 0o755 });
  }
  await fs.writeFile(path.join(root, "scripts/write-embed-package.mjs"), `
import fs from 'node:fs';
if (!fs.existsSync('dist-embed/build/index.js') || !fs.existsSync('dist-embed/build/embedded.d.ts')) throw Error('Missing build output');
if (fs.existsSync('dist-embed/build/embed.tsbuildinfo')) throw Error('Compiler state leaked into package');
fs.writeFileSync('packaged', '');
`);
  return { root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` } };
}

it("builds in parallel and assembles only complete output without compiler state", async () => {
  const { root, env } = await fixture();
  await exec(process.execPath, ["scripts/build-embed.mjs"], { cwd: root, env });
  await expect(fs.access(path.join(root, "packaged"))).resolves.toBeUndefined();
});

it("does not assemble a package when declaration checks fail", async () => {
  const { root, env } = await fixture(true);
  await expect(exec(process.execPath, ["scripts/build-embed.mjs"], { cwd: root, env })).rejects.toThrow();
  await expect(fs.access(path.join(root, "packaged"))).rejects.toThrow();
});
