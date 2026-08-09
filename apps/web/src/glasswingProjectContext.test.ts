import { describe, expect, it } from "vitest";

import {
  resolveGlasswingHostProject,
  resolveGlasswingProjectThreadProjection,
  resolveGlasswingSelectedProject,
  toGlasswingProjectOptions,
} from "./glasswingProjectContext";

const projects = [
  { id: "cue-id", name: "Cue Cloud", cwd: "/workspace/cue-cloud" },
  { id: "nth-id", name: "Nth", cwd: "/workspace/nth" },
  { id: "other-id", name: "Renamed locally", cwd: "/workspace/analogical-engines" },
] as const;

describe("resolveGlasswingHostProject", () => {
  it("matches the host company by display name before other identities", () => {
    expect(
      resolveGlasswingHostProject(projects, {
        name: "Nth",
        slug: "not-the-checkout-name",
      }),
    ).toEqual(projects[1]);
  });

  it("matches the exact company slug against the checkout folder", () => {
    expect(
      resolveGlasswingHostProject(projects, {
        name: "Analogical Engines, Inc.",
        slug: "analogical-engines",
      }),
    ).toEqual(projects[2]);
  });

  it("does not expose a different project when the host project is missing", () => {
    expect(
      resolveGlasswingHostProject(projects, {
        name: "Missing Company",
        slug: "missing-company",
      }),
    ).toBeNull();
  });
});

describe("resolveGlasswingSelectedProject", () => {
  it("uses the embedding host identity instead of a stale focused project", () => {
    expect(
      resolveGlasswingSelectedProject(projects, {
        hostProject: { name: "Cue Cloud", slug: "cue-cloud" },
        activeProjectId: "nth-id",
      }),
    ).toEqual(projects[0]);
  });

  it("uses the focused project ID when the standalone mount has no host identity", () => {
    expect(
      resolveGlasswingSelectedProject(projects, {
        hostProject: null,
        activeProjectId: "nth-id",
      }),
    ).toEqual(projects[1]);
  });

  it("does not expose an unrelated standalone project without a focused match", () => {
    expect(
      resolveGlasswingSelectedProject(projects, {
        hostProject: null,
        activeProjectId: "missing-id",
      }),
    ).toBeNull();
  });
});

describe("toGlasswingProjectOptions", () => {
  it("returns stable host selection payloads in project order", () => {
    expect(toGlasswingProjectOptions(projects)).toEqual([
      { id: "cue-id", name: "Cue Cloud", cwd: "/workspace/cue-cloud" },
      { id: "nth-id", name: "Nth", cwd: "/workspace/nth" },
      { id: "other-id", name: "Renamed locally", cwd: "/workspace/analogical-engines" },
    ]);
  });
});

describe("resolveGlasswingProjectThreadProjection", () => {
  const threads = [
    { id: "cue-thread", projectId: "cue-id" },
    { id: "nth-thread-1", projectId: "nth-id" },
    { id: "other-thread", projectId: "other-id" },
    { id: "nth-thread-2", projectId: "nth-id" },
  ] as const;

  it("projects only the selected host project's threads", () => {
    expect(
      resolveGlasswingProjectThreadProjection(projects, threads, {
        name: "Nth",
        slug: "nth",
      }),
    ).toEqual({
      project: projects[1],
      threads: [threads[1], threads[3]],
    });
  });

  it("projects no threads when the host project cannot be matched", () => {
    expect(
      resolveGlasswingProjectThreadProjection(projects, threads, {
        name: "Missing",
        slug: "missing",
      }),
    ).toEqual({ project: null, threads: [] });
  });
});
