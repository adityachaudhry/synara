import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { runProviderWorkerArtifactSmoke } from "./artifactSmoke";

describe("server release archive", () => {
  it("extracts the shipped worker entrypoint and probes that exact installed artifact", async () => {
    const releaseRoot = mkdtempSync(path.join(tmpdir(), "synara-server-release-"));
    execFileSync(process.execPath, ["scripts/cli.ts", "pack", "--out", releaseRoot], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
    });
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { readonly version: string };
    const archivePath = path.join(
      releaseRoot,
      `synara-server-${packageJson.version}.tar.gz`,
    );
    const installedPackageDir = path.join(releaseRoot, "installed");
    execFileSync("mkdir", ["-p", installedPackageDir]);
    execFileSync("tar", ["-xzf", archivePath, "-C", installedPackageDir]);

    const workerPath = path.join(
      installedPackageDir,
      "dist",
      "provider-worker",
      "workerMain.mjs",
    );
    expect(existsSync(workerPath)).toBe(true);
    expect(readFileSync(workerPath, "utf8").length).toBeGreaterThan(1_000);

    const result = await runProviderWorkerArtifactSmoke({ artifactPath: workerPath });
    expect(result).toMatchObject({
      registered: true,
      retired: true,
      exitCode: 0,
      artifactPath: workerPath,
      credentialFileConsumed: true,
    });
  }, 30_000);
});
