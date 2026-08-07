import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(repoRoot, ".github/workflows/deploy-railway-v3-dev.yml");

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

describe("Railway v3 dev deployment workflow", () => {
  it("exists as a dedicated workflow", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it("deploys only this branch to the exact v3 dev service", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("codex/v3-gitea-projects");
    expect(workflow).toContain("7bf8f727-f0a8-4aea-b1b4-4266aecc49f0");
    expect(workflow).toContain("51f1e0e3-5714-4b56-8214-03e69b0c6afc");
    expect(workflow).toContain("ad3904fc-9b54-460d-b147-d87a4f0956c6");
    expect(workflow).toContain("railway-v3-dev-synara-gitea-dev");
  });

  it("uses the durable secret, pinned CLI, and blocking deployment mode", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}");
    expect(workflow).toContain("@railway/cli@5.15.0");
    expect(workflow).toContain("railway up");
    expect(workflow).toContain("--ci");
    expect(workflow).not.toContain("--detach");
  });

  it("cannot drift back to v4, production, or the generic Synara service", () => {
    const workflow = readWorkflow();

    expect(workflow).not.toContain("70cd8885-7ac3-49eb-81e0-7f07da44e633");
    expect(workflow).not.toMatch(/--environment\s+production/u);
    expect(workflow).not.toMatch(/--service\s+synara(?:\s|$)/u);
    expect(workflow).not.toContain("railway-v4-production");
  });
});
