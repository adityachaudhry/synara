import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { writeEmbedPackage } from "./write-embed-package.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(
  await fs.readFile(path.join(webDir, "package.json"), "utf8"),
);
const protocolSource = await fs.readFile(
  path.resolve(webDir, "../../packages/contracts/src/wsCompatibility.ts"),
  "utf8",
);
const protocolVersion = Number(
  protocolSource.match(/WS_PROTOCOL_EPOCH\s*=\s*(\d+)/)?.[1],
);
const synaraCommit = `${execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: webDir,
  encoding: "utf8",
}).trim()}-local`;
const packageDir = process.env.SYNARA_EMBED_OUTPUT_DIR
  ? path.resolve(process.env.SYNARA_EMBED_OUTPUT_DIR)
  : path.join(webDir, "dist-embed", "package");
const stylesheetOutput = process.env.SYNARA_EMBED_STYLESHEET_OUTPUT
  ? path.resolve(process.env.SYNARA_EMBED_STYLESHEET_OUTPUT)
  : null;
const nextPackageDir = `${packageDir}-next`;
const previousPackageDir = `${packageDir}-previous`;

let packaging = Promise.resolve();
const packageBuild = () => {
  packaging = packaging
    .catch(() => undefined)
    .then(async () => {
      await writeEmbedPackage({
        buildDir: path.join(webDir, "dist-embed", "build"),
        outputDir: nextPackageDir,
        readmePath: path.join(webDir, "README.embed.md"),
        version: packageManifest.version,
        synaraCommit,
        protocolVersion,
        routerVersion: packageManifest.dependencies["@tanstack/react-router"],
      });
      await fs.rm(previousPackageDir, { recursive: true, force: true });
      await fs.rename(packageDir, previousPackageDir).catch(() => undefined);
      await fs.rename(nextPackageDir, packageDir);
      await fs.rm(previousPackageDir, { recursive: true, force: true });
      if (stylesheetOutput) {
        await fs.mkdir(path.dirname(stylesheetOutput), { recursive: true });
        await fs.copyFile(path.join(packageDir, "style.css"), stylesheetOutput);
      }
      process.stdout.write("Synara embed package updated\n");
    })
    .catch((error) => {
      console.error("Failed to update Synara embed package", error);
    });
};

const watcher = await build({
  configFile: path.join(webDir, "vite.embed.config.ts"),
  mode: "development",
  build: {
    emptyOutDir: false,
    watch: {},
  },
});

if (!("on" in watcher)) {
  throw new Error("Vite did not start the Synara embed watcher.");
}

watcher.on("event", (event) => {
  if (event.code === "END") packageBuild();
});

const stop = async () => {
  await packaging;
  await watcher.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
