import { ProjectId } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  authorizeProjectScopedRpc,
  filterShellSnapshotByProjectScope,
  projectScopePayloadForEvent,
} from "./projectScope";

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
      [
        "orchestration.dispatchCommand",
        { command: { type: "project.update", projectId: denied } },
      ],
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
          method: "provider.listModels",
          payload: { threadId: "allowed-thread" },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: {
            command: { type: "thread.update", projectId: allowed, threadId: "denied-thread" },
          },
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

  it("authorizes the nested dispatch command wire payload", async () => {
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: {
            command: { type: "thread.update", projectId: allowed, threadId: "allowed-thread" },
          },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
  });

  it("requires every locator at dev-server, terminal, and provider discovery sinks", async () => {
    for (const [method, payload] of [
      ["projects.runDevServer", { projectId: allowed, cwd: "/denied" }],
      ["terminal.open", { threadId: "allowed-thread", cwd: "/denied" }],
      ["provider.listModels", { threadId: "allowed-thread", cwd: "/denied" }],
    ] as const) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({ method, payload, scope: new Set([allowed]), query }),
        ),
      ).toBe(false);
    }
  });

  it("rejects filesystem browse targets outside the authorized cwd", async () => {
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "filesystem.browse",
          payload: { cwd: "/allowed", partialPath: "/denied/private" },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
  });

  it("denies scoped repository provisioning and path-bearing worktree mutations", async () => {
    for (const method of [
      "projects.provisionFromGitHub",
      "git.createWorktree",
      "git.createDetachedWorktree",
      "git.removeWorktree",
      "git.handoffThread",
    ]) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method,
            payload: { projectId: allowed, threadId: "allowed-thread", cwd: "/allowed" },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(false);
    }
  });

  it("denies scoped terminal and dev-server execution even for allowed resources", async () => {
    for (const method of [
      "terminal.open",
      "terminal.write",
      "terminal.resize",
      "terminal.clear",
      "terminal.restart",
      "terminal.close",
      "projects.runDevServer",
      "projects.stopDevServer",
    ]) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method,
            payload: { projectId: allowed, threadId: "allowed-thread", cwd: "/allowed" },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(false);
    }
  });

  it("denies scoped automation management", async () => {
    for (const method of [
      "automation.list",
      "automation.getMemory",
      "automation.create",
      "automation.update",
      "automation.delete",
      "automation.runNow",
      "automation.cancelRun",
      "automation.markRunRead",
      "automation.archiveRun",
      "automation.resolveProposal",
    ]) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method,
            payload: { projectId: allowed, automationId: "other-automation" },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(false);
    }
  });

  it("uses deletion event ownership without looking up the already-deleted thread", async () => {
    const ownDeletion = {
      type: "thread.deleted",
      aggregateKind: "thread",
      aggregateId: "deleted-thread",
      payload: { threadId: "deleted-thread", projectId: allowed },
    } as never;
    const otherDeletion = {
      ...ownDeletion,
      payload: { threadId: "deleted-thread", projectId: denied },
    } as never;

    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.event",
          payload: projectScopePayloadForEvent(ownDeletion),
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.event",
          payload: projectScopePayloadForEvent(otherDeletion),
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
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
