import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeEmbedPackage } from "./write-embed-package.mjs";

const tempDirectories: string[] = [];

async function makeFixture(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `synara-react-${name}-`));
  tempDirectories.push(root);
  const buildDir = path.join(root, "build");
  const outputDir = path.join(root, "package");
  await fs.mkdir(buildDir, { recursive: true });
  await fs.writeFile(path.join(buildDir, "index.js"), "export const SynaraApp = {};\n");
  await fs.writeFile(path.join(buildDir, "style.css"), "[data-synara-app-root] {}\n");
  await fs.writeFile(path.join(buildDir, "route-chunk.js"), "export {};\n");
  await fs.writeFile(path.join(buildDir, "favicon.ico"), "standalone");
  await fs.mkdir(path.join(buildDir, "app-icons"));
  await fs.writeFile(path.join(buildDir, "app-icons", "default.png"), "standalone");
  await fs.writeFile(
    path.join(buildDir, "index.d.ts"),
    [
      'import type { RouterHistory } from "@tanstack/react-router";',
      "export interface SynaraRuntimeConfig {",
      "  readonly httpBaseUrl?: string;",
      "  readonly resolveWebSocketUrl?: () => string | Promise<string>;",
      "  readonly project?: { projectId: string; name: string };",
      "}",
      "export interface SynaraAppProps extends SynaraRuntimeConfig {}",
      "export declare function SynaraApp(props: SynaraAppProps): unknown;",
      "export declare function createEmbeddedAppHistory(initialEntry?: string): RouterHistory;",
      "export interface SynaraHostSidebar {}",
      "export interface SynaraHostTheme {}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(buildDir, "internal.d.ts"), "export {};\n");
  const readmePath = path.join(root, "README.md");
  await fs.writeFile(readmePath, "# @synara/react\n");
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
  it("writes deterministic generic package metadata, generated declarations, and provenance", async () => {
    const first = await makeFixture("first");
    const second = await makeFixture("second");
    const input = {
      version: "0.7.3",
      synaraCommit: "synara-sha",
      protocolVersion: 1,
      routerVersion: "^1.160.2",
    };

    await writeEmbedPackage({ ...first, ...input });
    await writeEmbedPackage({ ...second, ...input });

    const expectedNames = [
      "README.md",
      "index.d.ts",
      "index.js",
      "package.json",
      "route-chunk.js",
      "style.css",
      "synara-provenance.json",
    ];
    expect((await fs.readdir(first.outputDir)).sort()).toEqual(expectedNames);
    expect((await fs.readdir(second.outputDir)).sort()).toEqual(expectedNames);
    await expect(fs.access(path.join(first.outputDir, "favicon.ico"))).rejects.toThrow();
    await expect(fs.access(path.join(first.outputDir, "app-icons"))).rejects.toThrow();

    for (const name of expectedNames) {
      expect(await fs.readFile(path.join(first.outputDir, name), "utf8")).toBe(
        await fs.readFile(path.join(second.outputDir, name), "utf8"),
      );
    }

    const manifest = JSON.parse(
      await fs.readFile(path.join(first.outputDir, "package.json"), "utf8"),
    );
    expect(manifest).toEqual({
      name: "@synara/react",
      version: "0.7.3",
      type: "module",
      sideEffects: ["./style.css"],
      exports: {
        ".": { types: "./index.d.ts", import: "./index.js" },
        "./style.css": "./style.css",
        "./provenance": "./synara-provenance.json",
      },
      peerDependencies: {
        "@tanstack/react-router": "^1.160.2",
        react: ">=19 <20",
        "react-dom": ">=19 <20",
      },
    });

    expect(
      JSON.parse(await fs.readFile(path.join(first.outputDir, "synara-provenance.json"), "utf8")),
    ).toEqual({
      packageVersion: "0.7.3",
      synaraCommit: "synara-sha",
      release: "0.7.3",
      commit: "synara-sha",
      protocolVersion: 1,
    });

    const declarations = await fs.readFile(path.join(first.outputDir, "index.d.ts"), "utf8");
    expect(declarations).toContain("export interface SynaraRuntimeConfig");
    expect(declarations).toContain("export interface SynaraAppProps extends SynaraRuntimeConfig");
    expect(declarations).toContain("export declare function createEmbeddedAppHistory");
    expect(declarations).toContain("export interface SynaraHostSidebar");
    expect(declarations).toContain("export interface SynaraHostTheme");
  });

  it("declares every dependency imported by the public declarations", async () => {
    const fixture = await makeFixture("declaration-dependencies");
    await writeEmbedPackage({
      ...fixture,
      version: "0.7.3",
      synaraCommit: "synara-sha",
      protocolVersion: 1,
      routerVersion: "^1.160.2",
    });

    const declarations = await fs.readFile(path.join(fixture.outputDir, "index.d.ts"), "utf8");
    const manifest = JSON.parse(
      await fs.readFile(path.join(fixture.outputDir, "package.json"), "utf8"),
    );
    const bareDeclarationImports = [...declarations.matchAll(/from ["']([^./][^"']*)["']/g)].map(
      (match) => match[1],
    );
    const declaredDependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);

    expect(bareDeclarationImports).toContain("@tanstack/react-router");
    expect(
      bareDeclarationImports.filter((specifier) => !declaredDependencies.has(specifier)),
    ).toEqual([]);
  });

  it("rejects missing provenance instead of reading ambient repository state", async () => {
    const fixture = await makeFixture("missing-provenance");
    await expect(
      writeEmbedPackage({
        ...fixture,
        version: "0.7.3",
        synaraCommit: "",
        protocolVersion: 1,
        routerVersion: "^1.160.2",
      }),
    ).rejects.toThrow("SYNARA_COMMIT");
  });

  it("rejects missing protocol provenance instead of assuming a protocol version", async () => {
    const fixture = await makeFixture("missing-protocol");
    await expect(
      writeEmbedPackage({
        ...fixture,
        version: "0.7.3",
        synaraCommit: "synara-sha",
        protocolVersion: Number(undefined),
        routerVersion: "^1.160.2",
      }),
    ).rejects.toThrow("SYNARA_PROTOCOL_VERSION");
  });

  it("rejects bundled CommonJS modules that dynamically require peer React", async () => {
    const fixture = await makeFixture("dynamic-react");
    await fs.writeFile(
      path.join(fixture.buildDir, "with-selector.js"),
      'import { r as load } from "./rolldown-runtime.js";\nload("react");\n',
    );

    await expect(
      writeEmbedPackage({
        ...fixture,
        version: "0.7.3",
        synaraCommit: "synara-sha",
        protocolVersion: 1,
        routerVersion: "^1.160.2",
      }),
    ).rejects.toThrow("dynamically requires peer React");
  });
});
