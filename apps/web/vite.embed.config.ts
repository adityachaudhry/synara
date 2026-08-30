import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

import pkg from "./package.json" with { type: "json" };
import { centralIconPrunePlugin } from "./vite.config";

const useSyncExternalStoreWithSelectorAdapter = path.resolve(
  import.meta.dirname,
  "src/lib/useSyncExternalStoreWithSelectorAdapter.ts",
);

export default defineConfig(({ mode }) => ({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    ...(mode === "development"
      ? []
      : [
          babel({
            parserOpts: { plugins: ["typescript", "jsx"] },
            presets: [reactCompilerPreset()],
          }),
        ]),
    tailwindcss(),
    centralIconPrunePlugin(),
  ],
  define: {
    "import.meta.env.VITE_WS_URL": JSON.stringify(""),
    "import.meta.env.VITE_SYNARA_EMBEDDED": JSON.stringify("true"),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    alias: [
      {
        find: /^use-sync-external-store\/shim(?:\/index)?(?:\.js)?$/,
        replacement: useSyncExternalStoreWithSelectorAdapter,
      },
      {
        find: /^use-sync-external-store\/(?:shim\/)?with-selector(?:\.js)?$/,
        replacement: useSyncExternalStoreWithSelectorAdapter,
      },
    ],
    tsconfigPaths: true,
  },
  ...(mode === "development"
    ? {
        worker: {
          format: "es" as const,
          rolldownOptions: { output: { entryFileNames: "assets/[name].js" } },
        },
      }
    : {}),
  build: {
    outDir: "dist-embed/build",
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: false,
    minify: mode === "development" ? false : undefined,
    cssMinify: mode === "development" ? false : undefined,
    reportCompressedSize: mode !== "development",
    lib: {
      entry: path.resolve(import.meta.dirname, "src/embeddedBundle.ts"),
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "style",
    },
    rolldownOptions: {
      external: /^react(?:-dom)?(?:\/.*)?$/,
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.includes("style.css")) return "style.css";
          if (
            mode === "development" &&
            assetInfo.names?.some((name) => name.includes("composerImagePreparation.worker"))
          ) {
            return "assets/composerImagePreparation.worker.js";
          }
          return "assets/[name]-[hash][extname]";
        },
      },
      checks: { pluginTimings: false },
    },
  },
}));
