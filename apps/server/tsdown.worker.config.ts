import { copyFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const piPackage = realpathSync(new URL("./node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const photonWasm = createRequire(join(piPackage, "package.json")).resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm");

export default defineConfig({
  entry: ["src/providerWorker/workerMain.ts"],
  format: ["esm"],
  outDir: "dist/provider-worker",
  external: [/^node:/u, /^bun:/u],
  noExternal: [/.*/u],
  inlineOnly: false,
  outputOptions: { codeSplitting: false },
  // Pi's bundled CommonJS Photon loader resolves its WASM relative to __dirname.
  banner: {
    js: 'import { dirname as __synaraDirname } from "node:path"; import { fileURLToPath as __synaraFileURLToPath } from "node:url"; const __dirname = __synaraDirname(__synaraFileURLToPath(import.meta.url));',
  },
  plugins: [{
    name: "copy-photon-wasm",
    writeBundle() {
      copyFileSync(photonWasm, fileURLToPath(new URL("./dist/provider-worker/photon_rs_bg.wasm", import.meta.url)));
    },
  }],
  clean: true,
});
