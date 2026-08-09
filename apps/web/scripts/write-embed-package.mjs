// FILE: write-embed-package.mjs
// Purpose: Creates deterministic package metadata around the Vite embed build.
// Layer: Web package build

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DECLARATIONS = `import type { ReactElement } from "react";

export interface SynaraHistory {
  readonly location: { readonly pathname: string };
  push(path: string): void;
  replace(path: string): void;
  back(): void;
  forward(): void;
  flush(): void;
}

export type SynaraWebSocketUrlResolver = () => string | Promise<string>;

export interface SynaraHostProjectSelection {
  readonly name: string;
  readonly cwd: string;
}

export interface SynaraHostProject {
  readonly name: string;
  readonly slug: string;
  readonly onSelectProject?: (project: SynaraHostProjectSelection) => void;
}

export interface SynaraRuntimeConfig {
  readonly httpBaseUrl?: string;
  readonly resolveWebSocketUrl?: SynaraWebSocketUrlResolver;
  readonly hostProject?: SynaraHostProject;
}

export interface SynaraAppProps extends SynaraRuntimeConfig {
  readonly history?: SynaraHistory;
}

export declare function SynaraApp(props: SynaraAppProps): ReactElement;
export declare function createEmbeddedAppHistory(initialPath?: string): SynaraHistory;
`;

function requireValue(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required to write Synara package provenance.`);
  }
  return value.trim();
}

async function assertNoDynamicPeerReactRequire(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoDynamicPeerReactRequire(entryPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = await fs.readFile(entryPath, "utf8");
    if (
      source.includes("rolldown-runtime") &&
      /\b[A-Za-z_$][\w$]*\(["']react["']\)/.test(source)
    ) {
      throw new Error(
        `Embed chunk ${entry.name} dynamically requires peer React; alias the CommonJS dependency to an ESM adapter.`,
      );
    }
  }
}

export async function writeEmbedPackage(input) {
  const version = requireValue("PACKAGE_VERSION", input.version);
  const synaraCommit = requireValue("SYNARA_COMMIT", input.synaraCommit);
  const upstreamCommit = requireValue("SYNARA_UPSTREAM_COMMIT", input.upstreamCommit);

  await assertNoDynamicPeerReactRequire(input.buildDir);

  await fs.rm(input.outputDir, { recursive: true, force: true });
  await fs.mkdir(input.outputDir, { recursive: true });
  await fs.cp(input.buildDir, input.outputDir, { recursive: true });
  await fs.copyFile(input.readmePath, path.join(input.outputDir, "README.md"));
  await fs.writeFile(path.join(input.outputDir, "index.d.ts"), DECLARATIONS);

  const manifest = {
    name: "@glasswing/synara-react",
    version,
    private: true,
    type: "module",
    sideEffects: ["./style.css"],
    exports: {
      ".": { types: "./index.d.ts", import: "./index.js" },
      "./style.css": "./style.css",
      "./provenance": "./synara-provenance.json",
    },
    peerDependencies: { react: ">=19 <20", "react-dom": ">=19 <20" },
  };
  const provenance = { packageVersion: version, synaraCommit, upstreamCommit };
  await Promise.all([
    fs.writeFile(
      path.join(input.outputDir, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    fs.writeFile(
      path.join(input.outputDir, "synara-provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    ),
  ]);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(scriptDir, "..");
  const packageManifest = JSON.parse(await fs.readFile(path.join(webDir, "package.json"), "utf8"));
  await writeEmbedPackage({
    buildDir: path.join(webDir, "dist-embed", "build"),
    outputDir: path.join(webDir, "dist-embed", "package"),
    readmePath: path.join(webDir, "README.embed.md"),
    version: packageManifest.version,
    synaraCommit: process.env.SYNARA_COMMIT,
    upstreamCommit: process.env.SYNARA_UPSTREAM_COMMIT,
  });
}
