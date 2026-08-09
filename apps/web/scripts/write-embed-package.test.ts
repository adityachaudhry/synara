// FILE: write-embed-package.test.ts
// Purpose: Verifies deterministic metadata for the vendorable React package.
// Layer: Web package build tests

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeEmbedPackage } from "./write-embed-package.mjs";

const tempDirectories: string[] = [];

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-embed-package-"));
  tempDirectories.push(root);
  const buildDir = path.join(root, "build");
  const outputDir = path.join(root, "package");
  await fs.mkdir(buildDir, { recursive: true });
  await fs.writeFile(path.join(buildDir, "index.js"), "export const SynaraApp = {};\n");
  await fs.writeFile(path.join(buildDir, "style.css"), ".synara {}\n");
  await fs.writeFile(path.join(buildDir, "route-chunk.js"), "export {};\n");
  const readmePath = path.join(root, "README.md");
  await fs.writeFile(readmePath, "# Embedded Synara\n");
  return { buildDir, outputDir, readmePath };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("writeEmbedPackage", () => {
  it("writes a deterministic React-peer package with provenance", async () => {
    const fixture = await makeFixture();
    await writeEmbedPackage({
      ...fixture,
      version: "0.6.6",
      synaraCommit: "synara-sha",
      upstreamCommit: "upstream-sha",
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(fixture.outputDir, "package.json"), "utf8"),
    );
    const provenance = JSON.parse(
      await fs.readFile(path.join(fixture.outputDir, "synara-provenance.json"), "utf8"),
    );
    const declarations = await fs.readFile(
      path.join(fixture.outputDir, "index.d.ts"),
      "utf8",
    );

    expect(manifest).toMatchObject({
      name: "@glasswing/synara-react",
      type: "module",
      exports: {
        ".": { types: "./index.d.ts", import: "./index.js" },
        "./style.css": "./style.css",
        "./provenance": "./synara-provenance.json",
      },
      peerDependencies: { react: ">=19 <20", "react-dom": ">=19 <20" },
    });
    expect(provenance).toEqual({
      packageVersion: "0.6.6",
      synaraCommit: "synara-sha",
      upstreamCommit: "upstream-sha",
    });
    expect(declarations).toContain("export interface SynaraHostProjectSelection");
    expect(declarations).toContain("readonly hostProject?: SynaraHostProject;");
    expect(declarations).toContain("export interface SynaraHostNavigation");
    expect(declarations).toContain("readonly hostNavigation?: SynaraHostNavigation;");
    expect(declarations).toContain("readonly displayScale?: number;");
    await expect(fs.stat(path.join(fixture.outputDir, "route-chunk.js"))).resolves.toBeDefined();
  });

  it("rejects missing provenance instead of guessing from the environment", async () => {
    const fixture = await makeFixture();
    await expect(
      writeEmbedPackage({
        ...fixture,
        version: "0.6.6",
        synaraCommit: "",
        upstreamCommit: "upstream-sha",
      }),
    ).rejects.toThrow("SYNARA_COMMIT");
  });

  it("rejects bundled CommonJS modules that dynamically require peer React", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(
      path.join(fixture.buildDir, "with-selector.js"),
      'import { r as load } from "./rolldown-runtime.js";\nload("react");\n',
    );

    await expect(
      writeEmbedPackage({
        ...fixture,
        version: "0.6.6",
        synaraCommit: "synara-sha",
        upstreamCommit: "upstream-sha",
      }),
    ).rejects.toThrow("dynamically requires peer React");
  });
});
