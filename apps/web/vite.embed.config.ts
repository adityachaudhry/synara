// FILE: vite.embed.config.ts
// Purpose: Builds the shared Synara React root as a vendorable ESM package.
// Layer: Web package build

import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

import pkg from "./package.json" with { type: "json" };
import { centralIconPrunePlugin } from "./vite.config";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    babel({
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
    centralIconPrunePlugin(),
  ],
  define: {
    "import.meta.env.VITE_WS_URL": JSON.stringify(""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: { tsconfigPaths: true },
  build: {
    outDir: "dist-embed/build",
    emptyOutDir: true,
    copyPublicDir: true,
    cssCodeSplit: false,
    lib: {
      entry: "src/embedded.ts",
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "style",
    },
    rolldownOptions: {
      external: /^react(?:-dom)?(?:\/.*)?$/,
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names?.includes("style.css") ? "style.css" : "assets/[name]-[hash][extname]",
      },
      checks: { pluginTimings: false },
    },
  },
});
