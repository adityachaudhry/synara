import type { ProjectId, ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  memo,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { resolveHostMessageAuthorLabel, useSynaraHostSidebar } from "../../hostSidebar";
import { useAppSettings, type TimestampFormat } from "../../appSettings";
import { useComposerDraftStore } from "../../composerDraftStore";
import { basenameOfPath } from "../../file-icons";
import { cn, randomUUID } from "../../lib/utils";
import {
  WorkspaceFileOpenerContext,
  type WorkspaceFileOpener,
} from "../../lib/workspaceFileOpener";
import { readNativeApi } from "../../nativeApi";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import {
  closePaneInState,
  createDefaultRightDockState,
  openPaneInState,
  resolveSurfaceDockState,
  setActivePaneInState,
  setDockOpenInState,
  sharedRightDockKey,
  withPinnedHostPane,
  type RightDockPane,
  type RightDockPaneKind,
  type RightDockThreadState,
} from "../../rightDockStore.logic";
import type { SplitViewPanePanelState } from "../../splitViewStore";
import { useStore } from "../../store";
import { createSidebarDisplayThreadsSelector } from "../../storeSelectors";
import { useThreadDetailPrewarm } from "../../threadDetailPrewarm";
import type { SidebarThreadSummary } from "../../types";
import { formatThreadFeedTimestamp } from "../../timestampFormat";
import { RouteInsetSurface } from "../RouteInsetSurface";
import {
  DeferredChatView,
  noopChatSurfaceAction,
} from "./ChatThreadSurfacePrimitives";
import { PanelStateMessage } from "./PanelStateMessage";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "./composerPickerStyles";
import {
  RIGHT_DOCK_DEFAULT_WIDTH,
  RIGHT_DOCK_MIN_WIDTH,
  RightDock,
} from "./RightDock";
import {
  getChatMessageFooterTextStyle,
  getChatTranscriptUserMessageTextStyle,
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
  userMessageBubbleBorderClassName,
} from "./chatTypography";
import { useProjectThreadFeedContextMenu } from "./useProjectThreadFeedContextMenu";

const FEED_EXPLORER_PANE_ID = "project-feed-explorer";
const FEED_PINNED_PANE_ID = "project-feed-pinned";
// A shared dock's owner for panes the feed opens for itself (a new chat's workspace files).
const FEED_DOCK_OWNER = "project-feed";
const FEED_CHAT_PANE_SCOPE_ID = "project-thread-feed";
const FEED_MAIN_MIN_WIDTH = 28 * 16;
const THREAD_FEED_REFRESH_INTERVAL_MS = 2_000;
const FEED_CHAT_PANEL_STATE: SplitViewPanePanelState = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "browser",
};

function createProjectFeedDockState(): RightDockThreadState {
  return openPaneInState(createDefaultRightDockState(), {
    paneId: FEED_EXPLORER_PANE_ID,
    kind: "explorer",
  });
}

function shouldAcceptFeedDockWidth({
  nextWidth,
  wrapper,
}: {
  nextWidth: number;
  wrapper: HTMLElement;
}): boolean {
  return (wrapper.parentElement?.clientWidth ?? 0) - nextWidth >= FEED_MAIN_MIN_WIDTH;
}

function threadActivityAt(thread: SidebarThreadSummary): string {
  return (
    thread.feedSummary?.latestReplyAt ??
    thread.feedSummary?.firstMessageAt ??
    thread.updatedAt ??
    thread.createdAt
  );
}

const ThreadFeedCard = memo(function ThreadFeedCard({
  thread,
  onOpen,
  onIntent,
  onContextMenu,
  chatFontSizePx,
  timestampFormat,
}: {
  thread: SidebarThreadSummary;
  onOpen: (threadId: ThreadId) => void;
  onIntent: (threadId: ThreadId) => void;
  onContextMenu?: (thread: SidebarThreadSummary, event: MouseEvent<HTMLElement>) => void;
  chatFontSizePx: number | undefined;
  timestampFormat: TimestampFormat;
}) {
  const hostSidebar = useSynaraHostSidebar();
  const summary = thread.feedSummary;
  if (!summary) return null;

  const authorLabel =
    resolveHostMessageAuthorLabel(hostSidebar, summary.author) ?? "Glasswing user";
  const isOtherAuthor =
    hostSidebar?.currentMessageAuthor !== undefined &&
    summary.author !== null &&
    summary.author.subject !== hostSidebar.currentMessageAuthor.subject;
  const replyLabel = `${summary.replyCount} ${summary.replyCount === 1 ? "reply" : "replies"}`;
  const lastReplyLabel = summary.latestReplyAt
    ? formatThreadFeedTimestamp(summary.latestReplyAt, timestampFormat)
    : null;
  const firstMessage = summary.firstMessageText.trim() || "Started a thread.";
  const openFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen(thread.id);
  };

  return (
    <article
      className={cn(
        "flex flex-col [content-visibility:auto] [contain-intrinsic-size:auto_180px]",
        isOtherAuthor ? "items-start" : "items-end",
      )}
      aria-labelledby={`thread-feed-author-${thread.id}`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${replyLabel} from ${authorLabel}${
          lastReplyLabel ? `, last reply ${lastReplyLabel}` : ""
        }`}
        onClick={() => onOpen(thread.id)}
        onKeyDown={openFromKeyboard}
        onContextMenu={onContextMenu ? (event) => onContextMenu(thread, event) : undefined}
        onMouseEnter={() => onIntent(thread.id)}
        onFocus={() => onIntent(thread.id)}
        className={cn(
          "group flex w-full max-w-[80%] cursor-pointer flex-col gap-px rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2",
          isOtherAuthor ? "items-start" : "items-end",
        )}
      >
        <div
          className={cn(
            "mb-1 flex max-w-full items-center gap-2 font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground)]",
            isOtherAuthor ? "pl-0.5" : "pr-0.5",
          )}
        >
          <span
            id={`thread-feed-author-${thread.id}`}
            className="truncate font-medium text-[var(--color-text-foreground)]"
          >
            {authorLabel}
          </span>
          <time className="shrink-0 font-normal" dateTime={summary.firstMessageAt}>
            {formatThreadFeedTimestamp(summary.firstMessageAt, timestampFormat)}
          </time>
        </div>
        <div
          className={cn(
            "w-max max-w-full min-w-0",
            isOtherAuthor
              ? "self-start bg-[var(--app-other-user-message-background,var(--app-user-message-background))]"
              : "self-end bg-[var(--app-user-message-background)] [--app-user-message-background:var(--app-current-user-message-background)]",
            USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
            userMessageBubbleBorderClassName(false),
            hostSidebar?.simplifiedComposer === true &&
              "border-[color:var(--app-surface-divider)] transition-colors group-hover:border-[color:var(--brand)] group-focus-visible:border-[color:var(--brand)]",
            USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
          )}
        >
          <p
            className={cn(
              "whitespace-pre-wrap break-words font-system-ui",
              isOtherAuthor
                ? "text-[var(--color-text-foreground)]"
                : "text-[var(--app-user-message-text,var(--color-text-foreground))]",
            )}
            style={getChatTranscriptUserMessageTextStyle(chatFontSizePx)}
          >
            {firstMessage}
          </p>
        </div>
        <footer
          className={cn(
            "flex items-center gap-2 font-system-ui font-normal text-[var(--color-text-foreground)]",
            isOtherAuthor ? "justify-start pl-0.5" : "justify-end pr-0.5",
          )}
          style={getChatMessageFooterTextStyle(chatFontSizePx)}
        >
          <span
            className="rounded-md px-1.5 py-0.5 font-medium text-[var(--brand)] underline-offset-2 transition-colors group-hover:underline group-focus-visible:underline"
          >
            {replyLabel}
          </span>
          {summary.latestReplyAt && lastReplyLabel ? (
            <span className="shrink-0">
              Last reply{" "}
              <time dateTime={summary.latestReplyAt}>{lastReplyLabel}</time>
            </span>
          ) : null}
        </footer>
      </div>
    </article>
  );
});

export function ProjectThreadFeedSurface({
  projectId,
  projectName,
  draftThreadId,
}: {
  projectId: ProjectId;
  projectName: string;
  draftThreadId: ThreadId;
}) {
  const navigate = useNavigate();
  const hostSidebar = useSynaraHostSidebar();
  const { settings } = useAppSettings();
  const selectDisplayThreads = useMemo(
    () => createSidebarDisplayThreadsSelector({ hideAutomationRunThreads: true }),
    [],
  );
  const displayThreads = useStore(selectDisplayThreads);
  const { showThreadContextMenu, renameDialog } =
    useProjectThreadFeedContextMenu(displayThreads);
  const syncServerShellSnapshot = useStore((state) => state.syncServerShellSnapshot);
  const { prewarmThreadDetail } = useThreadDetailPrewarm();
  const pinnedPane = hostSidebar?.pinnedPane;
  const [localDockState, setLocalDockState] = useState<RightDockThreadState>(() => {
    const state = createProjectFeedDockState();
    if (!pinnedPane) return state;
    const pinned = withPinnedHostPane(state, FEED_PINNED_PANE_ID);
    return pinnedPane.defaultActive ? setActivePaneInState(pinned, FEED_PINNED_PANE_ID) : pinned;
  });
  // A shared dock (hostSidebar.sharedRightDock) is the one the project's threads use,
  // so opening a thread and coming back keeps the panel as it is. The feed's
  // default tabs seed it the first time.
  const sharedDockKey = hostSidebar?.sharedRightDock === true ? sharedRightDockKey(projectId) : null;
  const storedDockState = useRightDockStore(
    useMemo(() => selectRightDockState(sharedDockKey), [sharedDockKey]),
  );
  const hasStoredDock = useRightDockStore((store) =>
    sharedDockKey ? store.dockStateByThreadId[sharedDockKey] !== undefined : false,
  );
  const updateStoredDockState = useRightDockStore((store) => store.updateDockState);
  useLayoutEffect(() => {
    if (sharedDockKey && !hasStoredDock) updateStoredDockState(sharedDockKey, () => localDockState);
  }, [hasStoredDock, localDockState, sharedDockKey, updateStoredDockState]);
  const dockState = useMemo(
    () =>
      sharedDockKey && hasStoredDock
        ? resolveSurfaceDockState(storedDockState, FEED_DOCK_OWNER)
        : localDockState,
    [hasStoredDock, localDockState, sharedDockKey, storedDockState],
  );
  const setDockState = useCallback(
    (transform: (state: RightDockThreadState) => RightDockThreadState) => {
      if (sharedDockKey) updateStoredDockState(sharedDockKey, transform);
      else setLocalDockState(transform);
    },
    [sharedDockKey, updateStoredDockState],
  );
  // The host's pinned pane leads the tab strip.
  const displayDockState = pinnedPane ? withPinnedHostPane(dockState, FEED_PINNED_PANE_ID) : dockState;
  const feedContentRef = useRef<HTMLElement | null>(null);
  const positionedProjectIdRef = useRef<ProjectId | null>(null);

  const threads = useMemo(() => {
    const visible = displayThreads.filter(
      (thread) =>
        thread.projectId === projectId &&
        (thread.creationSource == null || thread.creationSource === "diligence_run") &&
        thread.sidechatSourceThreadId == null &&
        thread.forkSourceThreadId == null &&
        thread.feedSummary !== null,
    );
    // A run started from a chat sits right below that chat until its own activity is newer.
    const activityById = new Map(visible.map((thread) => [thread.id, threadActivityAt(thread)]));
    const sortKey = (thread: SidebarThreadSummary) => {
      const own = activityById.get(thread.id)!;
      const source = thread.sourceThreadId ? activityById.get(thread.sourceThreadId) : undefined;
      return source !== undefined && source >= own ? `${source}~` : own;
    };
    return visible.toSorted((left, right) => sortKey(left).localeCompare(sortKey(right)));
  }, [displayThreads, projectId]);

  useLayoutEffect(() => {
    if (threads.length === 0 || positionedProjectIdRef.current === projectId) return;
    const viewport = feedContentRef.current?.parentElement;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    positionedProjectIdRef.current = projectId;
  }, [projectId, threads.length]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let refreshInFlight = false;
    let refreshPending = false;
    const refresh = (): void => {
      if (refreshInFlight) {
        refreshPending = true;
        return;
      }
      if (document.visibilityState !== "visible") return;
      refreshInFlight = true;
      void api.orchestration
        .getShellSnapshot()
        .then((snapshot) => {
          if (!disposed) syncServerShellSnapshot(snapshot);
        })
        .catch(() => undefined)
        .finally(() => {
          refreshInFlight = false;
          if (!disposed && refreshPending) {
            refreshPending = false;
            refresh();
          }
        });
    };
    // ponytail: shell-only polling is the smallest reliable cross-client fallback;
    // remove it when the scoped shell stream delivers post-snapshot events consistently.
    const intervalId = window.setInterval(refresh, THREAD_FEED_REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [syncServerShellSnapshot]);

  const openThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: () => ({}),
      });
    },
    [navigate],
  );

  const openStartedThread = useCallback(
    (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) {
        openThread(threadId);
        return;
      }
      void api.orchestration
        .getShellSnapshot()
        .then(syncServerShellSnapshot)
        .catch(() => undefined)
        .finally(() => openThread(threadId));
    },
    [openThread, syncServerShellSnapshot],
  );

  const openFeedFile = useCallback((filePath: string, threadId: ThreadId | null = null, fileSource: "host" | "workspace" = "workspace", fileRevision?: string) => {
    setDockState((state) =>
      openPaneInState(state, {
        paneId: randomUUID(),
        kind: "file",
        filePath,
        fileSource,
        fileRevision: fileRevision ?? null,
        threadId,
        ownerThreadId: sharedDockKey && fileSource !== "host" ? FEED_DOCK_OWNER : null,
      }),
    );
  }, [setDockState, sharedDockKey]);

  const openFeedHostFile = useCallback((filePath: string, revision?: string) => {
    openFeedFile(filePath, null, "host", revision);
  }, [openFeedFile]);

  const feedFileOpener = useMemo<WorkspaceFileOpener>(
    () => ({
      openFile: (filePath) => {
        if (!hostSidebar?.renderFilePane) return false;
        const threadId =
          useComposerDraftStore.getState().draftThreadsByThreadId[draftThreadId]?.promotedTo ??
          draftThreadId;
        openFeedFile(filePath, threadId);
        return true;
      },
    }),
    [draftThreadId, hostSidebar, openFeedFile],
  );

  const closeDockPane = useCallback((paneId: string) => {
    setDockState((state) => {
      const next = closePaneInState(state, paneId);
      return next.panes.length === 0 ? setDockOpenInState(next, false) : next;
    });
  }, [setDockState]);

  const renderDockPane = useCallback(
    (pane: RightDockPane): ReactNode => {
      if (pane.kind === "host") {
        return hostSidebar?.pinnedPane ? (
          <div className="h-full min-h-0 w-full overflow-hidden">{hostSidebar.pinnedPane.render()}</div>
        ) : (
          <PanelStateMessage>This panel is unavailable.</PanelStateMessage>
        );
      }
      if (pane.kind === "explorer") {
        if (!hostSidebar?.filesPane) {
          return <PanelStateMessage>Explorer is unavailable.</PanelStateMessage>;
        }
        const filesPane =
          typeof hostSidebar.filesPane === "function"
            ? hostSidebar.filesPane(openFeedHostFile)
            : hostSidebar.filesPane;
        return <div className="h-full min-h-0 w-full overflow-hidden">{filesPane}</div>;
      }
      if (pane.kind === "file" && pane.filePath && hostSidebar?.renderFilePane) {
        return hostSidebar.renderFilePane(pane.filePath, {
          threadId: pane.threadId,
          fileSource: pane.fileSource ?? "workspace",
          fileRevision: pane.fileRevision ?? null,
          closePane: () => closeDockPane(pane.id),
        });
      }
      return <PanelStateMessage>This panel is unavailable from the thread feed.</PanelStateMessage>;
    },
    [closeDockPane, hostSidebar, openFeedHostFile],
  );

  const toggleDock = useCallback((open: boolean) => {
    setDockState((state) => {
      if (!open) return setDockOpenInState(state, false);
      return state.panes.length > 0
        ? setDockOpenInState(state, true)
        : openPaneInState(state, {
            paneId: FEED_EXPLORER_PANE_ID,
            kind: "explorer",
          });
    });
  }, [setDockState]);
  const openFeedExplorer = useCallback(() => toggleDock(true), [toggleDock]);

  const addDockPane = useCallback((kind: RightDockPaneKind) => {
    if (kind !== "explorer") return;
    setDockState((state) =>
      openPaneInState(state, { paneId: FEED_EXPLORER_PANE_ID, kind: "explorer" }),
    );
  }, [setDockState]);

  const paneLabelOverrides: Record<string, string> = {};
  const paneIconOverrides: Record<string, ReactNode | undefined> = {};
  for (const pane of displayDockState.panes) {
    if (pane.kind === "file" && pane.filePath) {
      paneLabelOverrides[pane.id] = basenameOfPath(pane.filePath);
      paneIconOverrides[pane.id] = hostSidebar?.renderFilePaneTabIcon?.(pane.filePath);
    } else if (pane.kind === "host" && pinnedPane) {
      paneLabelOverrides[pane.id] = pinnedPane.label;
      paneIconOverrides[pane.id] = pinnedPane.icon;
    }
  }

  const feedContent =
    threads.length > 0 ? (
      <section
        ref={feedContentRef}
        aria-label={`${projectName} threads`}
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-4"
      >
        {threads.map((thread) => (
          <ThreadFeedCard
            key={thread.id}
            thread={thread}
            onOpen={openThread}
            onIntent={prewarmThreadDetail}
            {...(hostSidebar?.simplifiedComposer ? {} : { onContextMenu: showThreadContextMenu })}
            chatFontSizePx={hostSidebar?.chatFontSizePx}
            timestampFormat={settings.timestampFormat}
          />
        ))}
      </section>
    ) : undefined;

  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
      <RouteInsetSurface surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}>
        <WorkspaceFileOpenerContext.Provider value={feedFileOpener}>
          <DeferredChatView
            threadId={draftThreadId}
            paneScopeId={FEED_CHAT_PANE_SCOPE_ID}
            deferMount={false}
            surfaceMode="single"
            isFocusedPane
            panelState={FEED_CHAT_PANEL_STATE}
            onToggleDiff={noopChatSurfaceAction}
            onToggleRightDock={() => toggleDock(!dockState.open)}
            onToggleBrowser={noopChatSurfaceAction}
            onOpenBrowserUrl={noopChatSurfaceAction}
            onOpenTurnDiff={noopChatSurfaceAction}
            emptyLandingContent={feedContent}
            emptyLandingProjectName={projectName}
            onOpenEmptyLandingProject={openFeedExplorer}
            onThreadStarted={openStartedThread}
            hideNewThreadAction
          />
        </WorkspaceFileOpenerContext.Provider>
      </RouteInsetSurface>
      <RightDock
        state={displayDockState}
        {...(hostSidebar?.viewportHeightOffsetPx
          ? { viewportHeightOffsetPx: hostSidebar.viewportHeightOffsetPx }
          : {})}
        minWidth={RIGHT_DOCK_MIN_WIDTH}
        defaultWidth={RIGHT_DOCK_DEFAULT_WIDTH}
        shouldAcceptWidth={shouldAcceptFeedDockWidth}
        motionKey={`project-feed:${projectId}`}
        widthMemoryKey={sharedDockKey ?? undefined}
        onSelectPane={(paneId) =>
          setDockState((state) =>
            setActivePaneInState(pinnedPane ? withPinnedHostPane(state, FEED_PINNED_PANE_ID) : state, paneId),
          )
        }
        onClosePane={closeDockPane}
        onCollapse={() => toggleDock(false)}
        onOpenChange={toggleDock}
        onAddPane={addDockPane}
        renderPane={renderDockPane}
        paneLabelOverrides={paneLabelOverrides}
        paneIconOverrides={paneIconOverrides}
      />
      {renameDialog}
    </div>
  );
}
