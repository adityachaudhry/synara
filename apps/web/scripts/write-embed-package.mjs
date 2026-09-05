import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scopeEmbeddedCss } from "./scope-embed-css.mjs";

const PUBLIC_DECLARATIONS = new Set([
  "index.d.ts",
  "SynaraApp.d.ts",
  "embeddedHistory.d.ts",
  "hostSidebar.d.ts",
  "synaraRuntimeConfig.d.ts",
]);
const STANDALONE_PUBLIC_ASSETS = [
  "app-icons",
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon.ico",
  "synara.png",
];

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
        `Embed chunk ${entry.name} dynamically requires peer React; use an ESM adapter.`,
      );
    }
  }
}

async function removePrivateDeclarations(directory, root = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return removePrivateDeclarations(entryPath, root);
      if (!entry.isFile() || !entry.name.endsWith(".d.ts")) return;
      const relativePath = path.relative(root, entryPath);
      if (!PUBLIC_DECLARATIONS.has(relativePath)) await fs.rm(entryPath);
    }),
  );
}

export async function writeEmbedPackage(input) {
  const version = requireValue("PACKAGE_VERSION", input.version);
  const synaraCommit = requireValue("SYNARA_COMMIT", input.synaraCommit);
  const routerVersion = requireValue("TANSTACK_ROUTER_VERSION", input.routerVersion);
  const protocolVersion = input.protocolVersion;
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0) {
    throw new Error("SYNARA_PROTOCOL_VERSION must be a positive integer.");
  }

  await assertNoDynamicPeerReactRequire(input.buildDir);
  await fs.rm(input.outputDir, { recursive: true, force: true });
  await fs.mkdir(input.outputDir, { recursive: true });
  await fs.cp(input.buildDir, input.outputDir, { recursive: true });
  await Promise.all(
    STANDALONE_PUBLIC_ASSETS.map((name) =>
      fs.rm(path.join(input.outputDir, name), { force: true, recursive: true }),
    ),
  );

  const declarationPath = path.join(input.outputDir, "index.d.ts");
  try {
    await fs.access(declarationPath);
  } catch {
    const generatedDeclarationPath = path.join(input.outputDir, "embedded.d.ts");
    await fs.rename(generatedDeclarationPath, declarationPath).catch(() => {
      throw new Error("Generated declarations are missing from the embed build.");
    });
  }
  await removePrivateDeclarations(input.outputDir);

  const stylesheetPath = path.join(input.outputDir, "style.css");
  const stylesheet = await fs.readFile(stylesheetPath, "utf8");
  await fs.writeFile(stylesheetPath, await scopeEmbeddedCss(stylesheet));
  await fs.copyFile(input.readmePath, path.join(input.outputDir, "README.md"));

  const manifest = {
    name: "@synara/react",
    version,
    type: "module",
    sideEffects: ["./style.css"],
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
    exports: {
      ".": { types: "./index.d.ts", import: "./index.js" },
      "./style.css": "./style.css",
      "./provenance": "./synara-provenance.json",
    },
    peerDependencies: {
      "@tanstack/react-router": routerVersion,
      react: ">=19 <20",
      "react-dom": ">=19 <20",
    },
  };
  const provenance = {
    packageVersion: version,
    synaraCommit,
    release: version,
    commit: synaraCommit,
    protocolVersion,
  };
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
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageManifest = JSON.parse(
    await fs.readFile(path.join(webDir, "package.json"), "utf8"),
  );
  await writeEmbedPackage({
    buildDir: path.join(webDir, "dist-embed", "build"),
    outputDir: path.join(webDir, "dist-embed", "package"),
    readmePath: path.join(webDir, "README.embed.md"),
    version: packageManifest.version,
    synaraCommit: process.env.SYNARA_COMMIT,
    protocolVersion: Number(process.env.SYNARA_PROTOCOL_VERSION),
    routerVersion: packageManifest.dependencies["@tanstack/react-router"],
    dependencies: {
      // Pin the exact dependency checked by this build, not a floating range.
      "@tabler/icons-react": JSON.parse(
        await fs.readFile(path.join(webDir, "node_modules/@tabler/icons-react/package.json"), "utf8"),
      ).version,
    },
  });
}
