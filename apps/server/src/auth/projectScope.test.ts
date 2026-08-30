import { ProjectId } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { authorizeProjectScopedRpc, filterShellSnapshotByProjectScope } from "./projectScope";

const allowed = ProjectId.makeUnsafe("allowed-project");
const denied = ProjectId.makeUnsafe("denied-project");

describe("external project scope", () => {
  const query = {
    getThreadShellById: (threadId: string) =>
      Effect.succeed(
        threadId === "allowed-thread"
          ? Option.some({ projectId: allowed } as never)
          : Option.some({ projectId: denied } as never),
      ),
    getActiveProjectByWorkspaceRoot: (cwd: string) =>
      Effect.succeed(
        Option.some({ id: cwd === "/allowed" ? allowed : denied } as never),
      ),
    getShellSnapshot: () => Effect.die("not needed"),
  };

  it("denies empty scope and cross-project direct, thread, and file/provider inputs", async () => {
    for (const [method, payload] of [
      ["orchestration.dispatch", { projectId: denied }],
      ["terminal.open", { threadId: "denied-thread" }],
      ["projects.readFile", { cwd: "/denied" }],
      ["provider.listModels", { cwd: "/denied" }],
    ] as const) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({ method, payload, scope: new Set([allowed]), query }),
        ),
      ).toBe(false);
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({ method, payload, scope: new Set(), query }),
        ),
      ).toBe(false);
    }
  });

  it("allows scoped resources and only the global surfaces that filter their output", async () => {
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "terminal.open",
          payload: { threadId: "allowed-thread" },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatch",
          payload: { projectId: allowed, threadId: "denied-thread" },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "server.getConfig",
          payload: {},
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.getShellSnapshot",
          payload: {},
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
  });

  it("omits projects and threads outside the scope", () => {
    const snapshot = {
      snapshotSequence: 1,
      spaces: [{ id: "private-space" }],
      projects: [{ id: allowed }, { id: denied }],
      threads: [
        { id: "allowed-thread", projectId: allowed },
        { id: "denied-thread", projectId: denied },
      ],
      updatedAt: "2026-08-29T00:00:00.000Z",
    } as never;
    expect(filterShellSnapshotByProjectScope(snapshot, new Set([allowed]))).toMatchObject({
      spaces: [],
      projects: [{ id: allowed }],
      threads: [{ id: "allowed-thread", projectId: allowed }],
    });
  });
});
