import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");

export async function cachedReactCompilerPlugin({
  cacheDirectory = path.join(webRoot, "dist-embed/react-compiler-cache"),
} = {}) {
  const version = hash((await Promise.all([
    fs.readFile(path.join(webRoot, "../../bun.lock"), "utf8"),
    fs.readFile(path.join(webRoot, "vite.embed.config.ts"), "utf8"),
    fs.readFile(fileURLToPath(import.meta.url), "utf8"),
  ])).join("\n") + process.versions.node);
  const plugin = await babel({
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [reactCompilerPreset()],
  });
  const transform = plugin.transform.handler;
  await fs.mkdir(cacheDirectory, { recursive: true });
  let hits = 0;
  let misses = 0;
  // Babel here has babelrc/configFile disabled and does module-local analysis.
  // Preserve the original hook/filter/context; only memoize its exact result.
  plugin.transform.handler = async function (code, id, options) {
    const key = hash(JSON.stringify([version, id, code, options, this.environment?.name,
      this.environment?.config?.mode, process.env.NODE_ENV, process.env.BABEL_ENV]));
    const file = path.join(cacheDirectory, `${key}.json`);
    try {
      const result = JSON.parse(await fs.readFile(file, "utf8"));
      hits++;
      return result;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    misses++;
    const started = performance.now();
    const result = await transform.call(this, code, id, options);
    const elapsed = performance.now() - started;
    if (elapsed > 1000) console.log(`[react-compiler] ${path.relative(webRoot, id)}: ${(elapsed / 1000).toFixed(1)}s`);
    if (result != null) {
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(result));
      await fs.rename(temporary, file);
    }
    return result;
  };
  plugin.buildEnd = () => console.log(`[react-compiler] ${hits} cached, ${misses} compiled`);
  return plugin;
}
