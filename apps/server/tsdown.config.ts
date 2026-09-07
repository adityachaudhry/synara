// FILE: tsdown.config.ts
// Purpose: Builds the Synara server CLI and controls diagnostic source maps.
// Layer: Server build config
// Depends on: tsdown.

import { defineConfig, type UserConfig } from "tsdown";

const sourcemapEnv = process.env.SYNARA_SERVER_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";

export default defineConfig(
  ["src/index.ts", "src/restoreMigrationBackup.ts"].map(
    (entry): UserConfig => ({
      entry: [entry],
      format: ["esm", "cjs"],
      checks: {
        legacyCjs: false,
      },
      outDir: "dist",
      // Bun builtins only resolve at runtime under Bun; MigrationBackup.ts guards
      // the import behind a `process.versions.bun` check.
      external: [/^bun:/u],
      sourcemap: buildSourcemap,
      // The CLI cleans once before these independent entry builds run in parallel.
      clean: false,
      noExternal: (id) =>
        id.startsWith("@synara/") ||
        id === "pi-web-access" ||
        id.startsWith("pi-web-access/") ||
        id === "pi-mcp-adapter" ||
        id.startsWith("pi-mcp-adapter/"),
      inlineOnly: false,
      // Keep TS-only Pi extensions and their shared Markdown classes in initialization order.
      outputOptions: { codeSplitting: false },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
    }),
  ),
);
