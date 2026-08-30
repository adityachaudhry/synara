import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseProviderWorkerConfigFile,
  readAndConsumeProviderWorkerConfigFile,
  resolveProviderWorkerConfig,
} from "./workerConfig";

const valid = {
  controlUrl: "http://synara.railway.internal:3773/internal/provider-worker",
  bootstrapCredential: "bootstrap-secret",
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
  cwd: "/workspace",
};

describe("resolveProviderWorkerConfig", () => {
  it("normalizes the private HTTP control URL to WebSocket", () => {
    const config = resolveProviderWorkerConfig(valid);

    expect(config.controlUrl).toBe(
      "ws://synara.railway.internal:3773/internal/provider-worker",
    );
    expect(config.cwd).toBe("/workspace");
  });

  it("rejects partial or invalid worker identity", () => {
    expect(() =>
      resolveProviderWorkerConfig({ ...valid, workerId: "not-a-uuid" }),
    ).toThrow(/workerId/);
    expect(() =>
      resolveProviderWorkerConfig({ ...valid, bootstrapCredential: "" }),
    ).toThrow(/bootstrapCredential/);
  });

  it("never includes the bootstrap credential in its safe description", () => {
    const config = resolveProviderWorkerConfig(valid);

    expect(JSON.stringify(config.safeDescription)).not.toContain("bootstrap-secret");
  });

  it("loads the private JSON bootstrap file without weakening field validation", () => {
    expect(parseProviderWorkerConfigFile(JSON.stringify(valid))).toMatchObject({
      bootstrapCredential: "bootstrap-secret",
      sandboxId: valid.sandboxId,
    });
    expect(() => parseProviderWorkerConfigFile('{"controlUrl":7}')).toThrow(
      /configuration file/,
    );
  });

  it("deletes the bootstrap file immediately after reading it into worker memory", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "synara-worker-config-"));
    const configPath = path.join(directory, "worker.json");
    writeFileSync(configPath, JSON.stringify(valid), { mode: 0o600 });

    const config = readAndConsumeProviderWorkerConfigFile(configPath);

    expect(config.bootstrapCredential).toBe("bootstrap-secret");
    expect(() => readFileSync(configPath, "utf8")).toThrow();
  });

  it("deletes malformed bootstrap material before reporting the parse failure", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "synara-worker-config-"));
    const configPath = path.join(directory, "worker.json");
    writeFileSync(configPath, '{"bootstrapCredential":"secret",', { mode: 0o600 });

    expect(() => readAndConsumeProviderWorkerConfigFile(configPath)).toThrow(/valid JSON/);
    expect(() => readFileSync(configPath, "utf8")).toThrow();
  });
});
