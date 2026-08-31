import type { ThreadId } from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { useAppSettings } from "../../appSettings";
import { useSidebarThreadActions } from "../../hooks/useSidebarThreadActions";
import { useCopyPathToClipboard, useCopyThreadIdToClipboard } from "../../hooks/useCopyToClipboard";
import { pinActionLabel } from "../../lib/pin";
import { dispatchThreadRename } from "../../lib/threadRename";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import type { SidebarThreadSummary } from "../../types";
import { RenameThreadDialog } from "../RenameThreadDialog";
import { toastManager } from "../ui/toast";

const NOOP_NEW_CHAT = async () => undefined;

interface RenameTarget {
  readonly threadId: ThreadId;
  readonly title: string;
}

export function useProjectThreadFeedContextMenu(
  sidebarThreads: readonly SidebarThreadSummary[],
): {
  readonly showThreadContextMenu: (
    thread: SidebarThreadSummary,
    event: MouseEvent<HTMLElement>,
  ) => void;
  readonly renameDialog: ReactNode;
} {
  const { settings } = useAppSettings();
  const projects = useStore((state) => state.projects);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const markThreadUnread = useStore((state) => state.markThreadUnread);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const sidebarThreadSummaryById = useMemo(
    () => Object.fromEntries(sidebarThreads.map((thread) => [thread.id, thread])),
    [sidebarThreads],
  );
  const { pinnedThreadIdSet, toggleThreadPinned, confirmAndArchiveThread, confirmAndDeleteThread } =
    useSidebarThreadActions({
      activeSplitView: null,
      appSettings: settings,
      clearTerminalState,
      handleNewChat: NOOP_NEW_CHAT,
      projectById,
      routeSplitViewId: null,
      routeThreadId: null,
      sidebarThreads,
      sidebarTreeThreads: sidebarThreads,
      sidebarThreadSummaryById,
      threadsHydrated,
    });
  const copyPathToClipboard = useCopyPathToClipboard();
  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);

  const showThreadContextMenu = useCallback(
    (thread: SidebarThreadSummary, event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readNativeApi();
      if (!api) return;
      const position = { x: event.clientX, y: event.clientY };
      const workspacePath = resolveThreadWorkspaceCwd({
        projectCwd: projectById.get(thread.projectId)?.cwd ?? null,
        envMode: thread.envMode,
        worktreePath: thread.worktreePath,
      });
      const isPinned = pinnedThreadIdSet.has(thread.id);

      void (async () => {
        const clicked = await api.contextMenu.show(
          [
            { id: "rename", label: "Rename thread" },
            { id: "toggle-pin", label: pinActionLabel("thread", isPinned) },
            { id: "mark-unread", label: "Mark unread" },
            ...(workspacePath
              ? [{ id: "copy-path", label: "Copy Path", separatorBefore: true }]
              : []),
            { id: "copy-thread-id", label: "Copy Thread ID" },
            ...(thread.parentThreadId
              ? []
              : [{ id: "archive", label: "Archive", separatorBefore: true }]),
            {
              id: "delete",
              label: "Delete",
              destructive: true,
              ...(thread.parentThreadId ? { separatorBefore: true } : {}),
            },
          ],
          position,
        );

        if (clicked === "rename") {
          setRenameTarget({ threadId: thread.id, title: thread.title });
          return;
        }
        if (clicked === "toggle-pin") {
          toggleThreadPinned(thread.id);
          return;
        }
        if (clicked === "mark-unread") {
          markThreadUnread(thread.id);
          return;
        }
        if (clicked === "copy-path" && workspacePath) {
          copyPathToClipboard(workspacePath);
          return;
        }
        if (clicked === "copy-thread-id") {
          copyThreadIdToClipboard(thread.id);
          return;
        }
        if (clicked === "archive") {
          await confirmAndArchiveThread(thread.id);
          return;
        }
        if (clicked === "delete") {
          await confirmAndDeleteThread(thread.id);
        }
      })();
    },
    [
      confirmAndArchiveThread,
      confirmAndDeleteThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      markThreadUnread,
      pinnedThreadIdSet,
      projectById,
      toggleThreadPinned,
    ],
  );

  const renameDialog = (
    <RenameThreadDialog
      open={renameTarget !== null}
      currentTitle={renameTarget?.title ?? ""}
      onOpenChange={(open) => {
        if (!open) setRenameTarget(null);
      }}
      onSave={async (newTitle) => {
        if (!renameTarget) return;
        const outcome = await dispatchThreadRename({
          threadId: renameTarget.threadId,
          newTitle,
          unchangedTitles: [renameTarget.title],
        });
        if (outcome === "unavailable") {
          toastManager.add({
            type: "error",
            title: "Not connected",
            description: "Reconnect to the server before renaming.",
          });
          return;
        }
        setRenameTarget(null);
      }}
    />
  );

  return { showThreadContextMenu, renameDialog };
}
