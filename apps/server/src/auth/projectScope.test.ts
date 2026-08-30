import { ProjectId } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  authorizeProjectScopedRpc,
  filterProviderStatusesByProjectScope,
  filterShellSnapshotByProjectScope,
  projectScopePayloadForEvent,
} from "./projectScope";

const allowed = ProjectId.makeUnsafe("allowed-project");
const denied = ProjectId.makeUnsafe("denied-project");

describe("external project scope", () => {
  const query = {
    getThreadShellById: (threadId: string) =>
      Effect.succeed(
        threadId === "missing-thread"
          ? Option.none()
          : threadId === "allowed-thread"
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
          method: "projects.readFile",
          payload: { cwd: "/allowed" },
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

  it("authorizes the decoded dispatch command payload seen by RPC middleware", async () => {
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: { type: "thread.update", projectId: allowed, threadId: "allowed-thread" },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
  });

  it("allows only sanitized provider readiness for scoped sessions", async () => {
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "server.subscribeProviderStatuses",
          payload: {},
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);

    const statuses = [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        authType: "oauth",
        authLabel: "private@example.com",
        voiceTranscriptionAvailable: true,
        supportsAutoRuntimeMode: true,
        autoRuntimeModeBinaryPath: "/private/bin/codex",
        version: "1.2.3",
        checkedAt: "2026-08-30T00:00:00.000Z",
        message: "private controller detail",
        updateState: {
          status: "failed",
          startedAt: null,
          finishedAt: null,
          message: "private update detail",
          output: "private command output",
        },
      },
    ] as never;

    expect(filterProviderStatusesByProjectScope(statuses, undefined)).toBe(statuses);
    expect(filterProviderStatusesByProjectScope(statuses, new Set([allowed]))).toEqual([
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        voiceTranscriptionAvailable: true,
        supportsAutoRuntimeMode: true,
        checkedAt: "2026-08-30T00:00:00.000Z",
      },
    ]);
  });

  it("requires every thread mention in a turn start to belong to the scoped project", async () => {
    const turnStartPayload = (mentionPath: string) => ({
      command: {
        type: "thread.turn.start",
        commandId: "cmd-scoped-mention",
        threadId: "allowed-thread",
        message: {
          messageId: "message-scoped-mention",
          role: "user",
          text: "Review the mentioned thread",
          attachments: [],
          mentions: [{ name: "Referenced thread", path: mentionPath }],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    });

    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: turnStartPayload("thread://allowed-thread"),
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
    for (const mentionPath of [
      "thread://denied-thread",
      "thread://missing-thread",
      "thread://",
    ]) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method: "orchestration.dispatchCommand",
            payload: turnStartPayload(mentionPath),
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(false);
    }
  });

  it("rejects scoped turn skills that would inline an arbitrary controller file", async () => {
    const command = {
      type: "thread.turn.start",
      commandId: "cmd-scoped-skill",
      threadId: "allowed-thread",
      message: {
        messageId: "message-scoped-skill",
        role: "user",
        text: "Use this skill",
        attachments: [],
        skills: [{ name: "private", path: "/private/controller-file.md" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-08-29T00:00:00.000Z",
    };

    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: { command },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: { command: { ...command, message: { ...command.message, skills: [] } } },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
  });

  it("rejects scoped provider executable overrides while allowing a plain model selection", async () => {
    const command = {
      type: "thread.turn.start",
      commandId: "cmd-scoped-model",
      threadId: "allowed-thread",
      message: {
        messageId: "message-scoped-model",
        role: "user",
        text: "Use the selected model",
        attachments: [],
      },
      modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-08-29T00:00:00.000Z",
    };

    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: {
            command: {
              ...command,
              providerOptions: { codex: { binaryPath: "/private/attacker-codex" } },
            },
          },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: {
            command: {
              ...command,
              modelSelection: {
                provider: "codex",
                model: "gpt-5.6-sol",
                options: { reasoningEffort: "high" },
              },
            },
          },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: { command },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
  });

  it("applies scoped provider override restrictions to edit and resend", async () => {
    const command = {
      type: "thread.message.edit-and-resend",
      commandId: "cmd-scoped-edit-resend",
      threadId: "allowed-thread",
      messageId: "message-scoped-edit-resend",
      text: "Edited prompt",
      modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-08-29T00:00:00.000Z",
    };

    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: {
            command: {
              ...command,
              providerOptions: { codex: { binaryPath: "/private/attacker-codex" } },
            },
          },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.dispatchCommand",
          payload: { command },
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

  it("denies filesystem browse for scoped sessions even inside an allowed cwd", async () => {
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "filesystem.browse",
          payload: { cwd: "/allowed", partialPath: "/allowed/subdirectory" },
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

  it("denies provider methods that can inspect controller-local executables or catalogs", async () => {
    for (const [method, payload] of [
      ["provider.compactThread", { threadId: "allowed-thread" }],
      ["provider.listCommands", { threadId: "allowed-thread", serverUrl: "http://private" }],
      ["provider.listSkills", { threadId: "allowed-thread", agentDir: "/private/agents" }],
      ["provider.listSkillsCatalog", { threadId: "allowed-thread" }],
      ["provider.listPlugins", { threadId: "allowed-thread" }],
      ["provider.readPlugin", { threadId: "allowed-thread", marketplacePath: "/private" }],
      ["provider.listModels", { threadId: "allowed-thread", binaryPath: "/private/bin" }],
      ["provider.listAgents", { threadId: "allowed-thread", binaryPath: "/private/bin" }],
    ] as const) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({ method, payload, scope: new Set([allowed]), query }),
        ),
      ).toBe(false);
    }
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "provider.getComposerCapabilities",
          payload: {},
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(true);
  });

  it("denies scoped provider-history imports", async () => {
    expect(
      await Effect.runPromise(
        authorizeProjectScopedRpc({
          method: "orchestration.importThread",
          payload: {
            projectId: allowed,
            threadId: "allowed-thread",
            cwd: "/allowed",
            externalId: "provider-history-id",
          },
          scope: new Set([allowed]),
          query,
        }),
      ),
    ).toBe(false);
  });

  it("denies every device RPC for scoped sessions", async () => {
    for (const method of [
      "device.list",
      "device.boot",
      "device.shutdown",
      "device.attach",
      "device.detach",
      "device.getThreadState",
      "device.tap",
      "device.swipe",
      "device.typeText",
      "device.keyEvent",
      "device.pressButton",
      "device.installApp",
      "device.launchApp",
      "device.openUrl",
      "device.screenshot",
      "device.startRecording",
      "device.stopRecording",
      "device.describeUi",
      "device.scrollToElement",
      "device.subscribeEvents",
    ]) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method,
            payload: {
              projectId: allowed,
              threadId: "allowed-thread",
              cwd: "/allowed",
              udid: "arbitrary-device",
            },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(false);
    }
  });

  it("denies client-controlled thread workspace paths but allows pathless create and update", async () => {
    const create = {
      type: "thread.create",
      commandId: "cmd-create-scoped-thread",
      threadId: "new-thread",
      projectId: allowed,
      title: "Scoped thread",
      modelSelection: { provider: "codex", model: "gpt-test" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    const update = {
      type: "thread.meta.update",
      commandId: "cmd-update-scoped-thread",
      threadId: "allowed-thread",
    };
    for (const [command, field] of [
      [create, "worktreePath"],
      [create, "workingDirectory"],
      [create, "associatedWorktreePath"],
      [update, "worktreePath"],
      [update, "workingDirectory"],
      [update, "associatedWorktreePath"],
    ] as const) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method: "orchestration.dispatchCommand",
            payload: { command: { ...command, [field]: "/attacker-controlled" } },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(false);
    }
    for (const command of [create, update]) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method: "orchestration.dispatchCommand",
            payload: { command },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(true);
    }

    for (const command of [create, update]) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method: "orchestration.dispatchCommand",
            payload: { command: { ...command, parentThreadId: "denied-thread" } },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(false);
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method: "orchestration.dispatchCommand",
            payload: { command: { ...command, parentThreadId: "allowed-thread" } },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(true);
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method: "orchestration.dispatchCommand",
            payload: { command: { ...command, parentThreadId: null } },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(true);
    }
  });

  it("allows only minimal model selections on scoped thread create and metadata update", async () => {
    const create = {
      type: "thread.create",
      commandId: "cmd-create-scoped-model",
      threadId: "new-thread",
      projectId: allowed,
      title: "Scoped thread",
      modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    const update = {
      type: "thread.meta.update",
      commandId: "cmd-update-scoped-model",
      threadId: "allowed-thread",
      modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
    };

    for (const command of [create, update]) {
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method: "orchestration.dispatchCommand",
            payload: {
              command: {
                ...command,
                modelSelection: {
                  provider: "codex",
                  model: "gpt-5.6-sol",
                  options: { reasoningEffort: "high" },
                },
              },
            },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(false);
      expect(
        await Effect.runPromise(
          authorizeProjectScopedRpc({
            method: "orchestration.dispatchCommand",
            payload: { command },
            scope: new Set([allowed]),
            query,
          }),
        ),
      ).toBe(true);
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
