// FILE: vite.config.ts
// Purpose: Builds the Synara web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import ts from "typescript";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.SYNARA_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

const CENTRAL_ICON_VARIANTS = ["reversed", "fill"] as const;
type CentralIconVariant = (typeof CENTRAL_ICON_VARIANTS)[number];
const CENTRAL_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const CENTRAL_ICON_ASSET_MODULE_ID = "virtual:synara-central-icon-assets";
const RESOLVED_CENTRAL_ICON_ASSET_MODULE_ID = `\0${CENTRAL_ICON_ASSET_MODULE_ID}`;
const CENTRAL_ICON_CALL_VARIANT_ARGUMENT = new Map([
  ["centralIconWrapper", 1],
  ["createCentralIconComponent", 1],
  ["createCentralIconElement", 2],
  ["getCentralIconUrl", 1],
]);

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result;
}

export async function collectReferencedCentralIcons(
  root: string,
): Promise<Record<CentralIconVariant, string[]>> {
  const availableByVariant = Object.fromEntries(
    await Promise.all(
      CENTRAL_ICON_VARIANTS.map(async (variant) => {
        const directory = path.join(root, "public", `central-icons-${variant}`);
        const names = (await fs.readdir(directory).catch(() => []))
          .filter((name) => name.endsWith(".svg"))
          .map((name) => name.slice(0, -".svg".length));
        return [variant, new Set(names)] as const;
      }),
    ),
  ) as Record<CentralIconVariant, Set<string>>;
  const referencedByVariant: Record<CentralIconVariant, Set<string>> = {
    reversed: new Set(),
    fill: new Set(),
  };
  const dynamicDefaultSources = new Set<string>();
  const sourceFiles = (await listFiles(path.join(root, "src"))).filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  const sourceByFile = new Map<string, string>();

  const stringValue = (node: ts.Node | undefined): string | null =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const addName = (variant: CentralIconVariant, name: string | null) => {
    if (name && CENTRAL_ICON_NAME_PATTERN.test(name)) referencedByVariant[variant].add(name);
  };

  for (const sourceFile of sourceFiles) {
    const source = await fs.readFile(sourceFile, "utf8").catch(() => "");
    sourceByFile.set(sourceFile, source);
    const tree = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const variantArgumentIndex = CENTRAL_ICON_CALL_VARIANT_ARGUMENT.get(node.expression.text);
        if (variantArgumentIndex !== undefined) {
          const name = stringValue(node.arguments[0]);
          const variant = stringValue(node.arguments[variantArgumentIndex]);
          if (name) addName(variant === "fill" ? "fill" : "reversed", name);
          else if (variant !== "fill") dynamicDefaultSources.add(sourceFile);
        }
      }

      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (ts.isIdentifier(node.tagName) && node.tagName.text === "CentralIcon") {
          const attributes = new Map(
            node.attributes.properties.flatMap((attribute) =>
              ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name)
                ? [[attribute.name.text, attribute.initializer] as const]
                : [],
            ),
          );
          const nameInitializer = attributes.get("name");
          const name =
            stringValue(nameInitializer) ??
            (nameInitializer && ts.isJsxExpression(nameInitializer)
              ? stringValue(nameInitializer.expression)
              : null);
          const variantInitializer = attributes.get("variant");
          const variant =
            stringValue(variantInitializer) ??
            (variantInitializer && ts.isJsxExpression(variantInitializer)
              ? stringValue(variantInitializer.expression)
              : null);
          if (name) addName(variant === "fill" ? "fill" : "reversed", name);
          else if (!variantInitializer) dynamicDefaultSources.add(sourceFile);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }

  const addAvailableLiterals = (source: string) => {
    const tree = ts.createSourceFile("dynamic.tsx", source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const value = stringValue(node);
      if (value) addName("reversed", value);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  };
  const resolveImport = (sourceFile: string, specifier: string): string | null => {
    const base = specifier.startsWith("~/")
      ? path.join(root, "src", specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(sourceFile), specifier)
        : null;
    if (!base) return null;
    return (
      sourceFiles.find(
        (candidate) =>
          candidate === base || candidate.slice(0, -path.extname(candidate).length) === base,
      ) ?? null
    );
  };
  for (const sourceFile of dynamicDefaultSources) {
    const source = sourceByFile.get(sourceFile) ?? "";
    addAvailableLiterals(source);
    const tree = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const importedFile = resolveImport(sourceFile, statement.moduleSpecifier.text);
      if (importedFile) addAvailableLiterals(sourceByFile.get(importedFile) ?? "");
    }
  }

  return Object.fromEntries(
    CENTRAL_ICON_VARIANTS.map((variant) => [
      variant,
      [...referencedByVariant[variant]]
        .filter((name) => availableByVariant[variant].has(name))
        .sort(),
    ]),
  ) as Record<CentralIconVariant, string[]>;
}

async function createCentralIconAssetModule(root: string): Promise<string> {
  const icons = await collectReferencedCentralIcons(root);
  const mappings = Object.fromEntries(
    await Promise.all(
      CENTRAL_ICON_VARIANTS.map(async (variant) => [
        variant,
        Object.fromEntries(
          await Promise.all(
            icons[variant].map(async (name) => {
              const source = await fs.readFile(
                path.join(root, "public", `central-icons-${variant}`, `${name}.svg`),
              );
              return [name, `data:image/svg+xml;base64,${source.toString("base64")}`];
            }),
          ),
        ),
      ]),
    ),
  );
  return `export const CENTRAL_ICON_ASSET_URLS=${JSON.stringify(mappings)};\n`;
}

// Bundles referenced public icons as data URLs, then removes both copied icon trees.
export function centralIconPrunePlugin(): Plugin {
  let resolvedRoot = process.cwd();
  let resolvedOutDir = "dist";
  return {
    name: "synara-central-icon-prune",
    configResolved(config) {
      resolvedRoot = config.root;
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    resolveId(id) {
      return id === CENTRAL_ICON_ASSET_MODULE_ID ? RESOLVED_CENTRAL_ICON_ASSET_MODULE_ID : null;
    },
    async load(id) {
      return id === RESOLVED_CENTRAL_ICON_ASSET_MODULE_ID
        ? createCentralIconAssetModule(resolvedRoot)
        : null;
    },
    async closeBundle() {
      await Promise.all(
        CENTRAL_ICON_VARIANTS.map((variant) =>
          fs.rm(path.join(resolvedOutDir, `central-icons-${variant}`), {
            force: true,
            recursive: true,
          }),
        ),
      );
    },
  };
}

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);

const PRECOMPRESS_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".map"]);
// Below this size, compression savings don't beat the extra header bytes and
// the sidecar file overhead.
const PRECOMPRESS_MIN_BYTES = 1024;

// Emits .gz and .br sidecars next to compressible build outputs so the server
// can serve precompressed bytes by Accept-Encoding instead of compressing on
// the request path (apps/server/src/http.ts static route).
function precompressPlugin(): Plugin {
  let resolvedOutDir = "dist";
  return {
    name: "synara-precompress",
    apply: "build",
    // Run after central-icon pruning so removed files don't get sidecars.
    enforce: "post",
    configResolved(config) {
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = (await listFiles(resolvedOutDir)).filter((file) =>
        PRECOMPRESS_EXTENSIONS.has(path.extname(file)),
      );
      // A sidecar whose source shrank below threshold or stopped compressing
      // smaller must be removed, not just skipped: emptyOutDir protects full
      // builds, but partial/watch builds would otherwise serve a stale
      // compressed body under a current filename.
      const removeStale = (sidecarPath: string) => fs.rm(sidecarPath, { force: true });
      // Write to a temp file and rename: a watch-build server reading a
      // sidecar mid-write would otherwise get a truncated compressed stream.
      // Rename is atomic within a directory, so readers see either the old
      // sidecar or the complete new one.
      let tempSequence = 0;
      const writeSidecarAtomically = async (sidecarPath: string, data: Buffer) => {
        // Unique per write so concurrent builds against one outDir cannot
        // clobber each other's staging file.
        tempSequence += 1;
        const tempPath = `${sidecarPath}.${process.pid}.${tempSequence}.tmp`;
        await fs.writeFile(tempPath, data);
        await fs.rename(tempPath, sidecarPath);
      };
      let sidecarCount = 0;
      await Promise.all(
        files.map(async (file) => {
          const source = await fs.readFile(file);
          if (source.byteLength < PRECOMPRESS_MIN_BYTES) {
            await Promise.all([removeStale(`${file}.gz`), removeStale(`${file}.br`)]);
            return;
          }
          // Max-quality brotli on thousands of small files dominates plugin
          // wall-clock; below 16 KiB quality 9 is byte-for-byte competitive.
          const brotliQuality =
            source.byteLength < 16 * 1024 ? 9 : zlib.constants.BROTLI_MAX_QUALITY;
          const [gzipped, brotlied] = await Promise.all([
            gzip(source, { level: zlib.constants.Z_BEST_COMPRESSION }),
            brotliCompress(source, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
              },
            }),
          ]);
          await Promise.all([
            gzipped.byteLength < source.byteLength
              ? writeSidecarAtomically(`${file}.gz`, gzipped)
              : removeStale(`${file}.gz`),
            brotlied.byteLength < source.byteLength
              ? writeSidecarAtomically(`${file}.br`, brotlied)
              : removeStale(`${file}.br`),
          ]);
          sidecarCount += 1;
        }),
      );
      console.info(`[precompress] emitted gzip+brotli sidecars for ${sidecarCount} files.`);
    },
  };
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    babel({
      // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
      // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
      // whereas the previous version of the plugin parsed all files with a .ts extension.
      // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
    centralIconPrunePlugin(),
    precompressPlugin(),
  ],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "react-icons/gr",
    ],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    // The largest chunks are intentionally lazy-loaded editor grammars,
    // terminal runtime code, and the chat route—not initial-load bundles.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      checks: {
        // React Compiler is expected to dominate transform time in this app.
        pluginTimings: false,
      },
    },
  },
});
