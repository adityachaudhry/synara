import type { ClientOrchestrationCommand, GiteaCompanyProjectDescriptor } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { canonicalizeGiteaProjectCreate } from "./projectCreateAdmission";

const descriptor: GiteaCompanyProjectDescriptor = {
  companyId: "company-cue-cloud",
  companyName: "Cue Cloud",
  companySlug: "cue-cloud",
  workspaceRoot: "/data/gitea-company-projects/cue-cloud",
  binding: {
    kind: "gitea-subdirectory",
    origin: "https://glasswing-gitea-dev.up.railway.app",
    owner: "glasswing-admin",
    repository: "glasswing-company-data",
    ref: "main",
    path: "companies/cue-cloud",
  },
};

const boundCommand: Extract<ClientOrchestrationCommand, { type: "project.create" }> = {
  type: "project.create",
  commandId: "cmd-project-create" as never,
  projectId: "project-cue-cloud" as never,
  title: "Browser supplied title",
  workspaceRoot: "/tmp/browser-supplied",
  repositoryBinding: descriptor.binding,
  createdAt: "2026-08-06T12:00:00.000Z",
};

describe("canonicalizeGiteaProjectCreate", () => {
  it("replaces browser-controlled project metadata with the catalog descriptor", async () => {
    const result = await Effect.runPromise(
      canonicalizeGiteaProjectCreate(boundCommand, () => Effect.succeed(descriptor)),
    );

    expect(result).toMatchObject({
      title: "Cue Cloud",
      workspaceRoot: "/data/gitea-company-projects/cue-cloud",
      createWorkspaceRootIfMissing: true,
      repositoryBinding: descriptor.binding,
    });
  });

  it("leaves ordinary local projects unchanged", async () => {
    const localCommand = { ...boundCommand, repositoryBinding: null };
    const result = await Effect.runPromise(
      canonicalizeGiteaProjectCreate(localCommand, () =>
        Effect.die(new Error("ordinary projects must not query the catalog")),
      ),
    );
    expect(result).toEqual(localCommand);
  });
});
