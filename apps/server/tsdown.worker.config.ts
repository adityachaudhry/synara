import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/providerWorker/workerMain.ts"],
  format: ["esm"],
  outDir: "dist/provider-worker",
  external: [/^node:/u, /^bun:/u],
  noExternal: [/.*/u],
  inlineOnly: false,
  outputOptions: { codeSplitting: false },
  clean: true,
});
