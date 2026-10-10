// FILE: rightDockStore.logic.ts
// Purpose: Pure, testable transitions for the right dock (tabbed multi-pane right sidebar).
// Layer: UI state helpers
// Exports: dock pane types, default-state factory, and immutable open/close/activate helpers.

import type { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

// Single source of truth for the dock pane kinds. The union type, the runtime
// validator, the per-kind metadata map, and the add-menu order are all derived
// from this list so they can never drift apart.
export const RIGHT_DOCK_PANE_KINDS = [
  "browser",
  "device",
  "diff",
  "explorer",
  "file",
  "terminal",
  "sidechat",
  "git",
  "pullRequest",
  // A pane the embedding host renders (hostSidebar.pinnedPane): first tab, never closed.
  "host",
] as const;

export type RightDockPaneKind = (typeof RIGHT_DOCK_PANE_KINDS)[number];
export type PullRequestInitialTab = "summary" | "timeline" | "code";

const RIGHT_DOCK_PANE_KIND_SET: ReadonlySet<string> = new Set(RIGHT_DOCK_PANE_KINDS);

export interface RightDockPane {
  id: string;
  kind: RightDockPaneKind;
  // sidechat panes point at the embedded thread.
  threadId: ThreadId | null;
  // diff panes remember which turn/file they were opened on.
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
  // file panes preview one workspace-relative file.
  filePath: string | null;
  fileSource?: "host" | "workspace";
  fileRevision?: string | null;
  pullRequestProjectId: ProjectId | null;
  pullRequestRepository: string | null;
  pullRequestNumber: number | null;
  pullRequestInitialTab: PullRequestInitialTab | null;
  // In a dock shared by a project's surfaces (hostSidebar.sharedRightDock), the
  // surface a pane belongs to (a thread's workspace file); unowned panes show on all.
  ownerThreadId?: string;
}

export interface RightDockThreadState {
  open: boolean;
  panes: RightDockPane[];
  activePaneId: string | null;
  // Shared dock: the last active unowned pane, which a surface shows when the
  // active pane belongs to another surface.
  sharedActivePaneId?: string | null;
}

// File previews are the only multi-instance dock kind. Side chats share one
// destination and switch the embedded thread inside it.
const MULTI_INSTANCE_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set(["file"]);

// Kinds that can only ever have one instance per host thread, derived as
// "every kind that is not multi-instance" so the two sets can never drift.
export const SINGLETON_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set(
  RIGHT_DOCK_PANE_KINDS.filter((kind) => !MULTI_INSTANCE_PANE_KINDS.has(kind)),
);

export function isSingletonPaneKind(kind: RightDockPaneKind): boolean {
  return SINGLETON_PANE_KINDS.has(kind);
}

export function createDefaultRightDockState(): RightDockThreadState {
  return {
    open: false,
    panes: [],
    activePaneId: null,
  };
}

export function isRightDockPaneKind(value: unknown): value is RightDockPaneKind {
  return typeof value === "string" && RIGHT_DOCK_PANE_KIND_SET.has(value);
}

// Persisted dock state predates the current pane-kind union, so a stale entry
// (e.g. a kind that was renamed or removed) can crash the dock during render.
// Drop any pane we no longer understand and keep the active tab pointing at a
// surviving pane.
function sanitizePersistedPane(value: unknown): RightDockPane | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const candidate = value;
  if (typeof candidate.id !== "string" || !isRightDockPaneKind(candidate.kind)) {
    return null;
  }
  return {
    id: candidate.id,
    kind: candidate.kind,
    threadId: typeof candidate.threadId === "string" ? (candidate.threadId as ThreadId) : null,
    diffTurnId: typeof candidate.diffTurnId === "string" ? (candidate.diffTurnId as TurnId) : null,
    diffFilePath: typeof candidate.diffFilePath === "string" ? candidate.diffFilePath : null,
    filePath: typeof candidate.filePath === "string" ? candidate.filePath : null,
    ...(candidate.fileSource === "host" ? { fileSource: "host" as const } : {}),
    ...(typeof candidate.fileRevision === "string" ? { fileRevision: candidate.fileRevision } : {}),
    pullRequestProjectId:
      typeof candidate.pullRequestProjectId === "string"
        ? (candidate.pullRequestProjectId as ProjectId)
        : null,
    pullRequestRepository:
      typeof candidate.pullRequestRepository === "string" ? candidate.pullRequestRepository : null,
    pullRequestNumber:
      typeof candidate.pullRequestNumber === "number" &&
      Number.isInteger(candidate.pullRequestNumber) &&
      candidate.pullRequestNumber > 0
        ? candidate.pullRequestNumber
        : null,
    pullRequestInitialTab:
      candidate.pullRequestInitialTab === "summary" ||
      candidate.pullRequestInitialTab === "timeline" ||
      candidate.pullRequestInitialTab === "code"
        ? candidate.pullRequestInitialTab
        : null,
    ...(typeof candidate.ownerThreadId === "string" ? { ownerThreadId: candidate.ownerThreadId } : {}),
  };
}

export function sanitizeRightDockThreadState(value: unknown): RightDockThreadState {
  if (!isPlainObject(value)) {
    return createDefaultRightDockState();
  }
  const candidate = value;
  const sanitizedPanes = Array.isArray(candidate.panes)
    ? candidate.panes
        .map(sanitizePersistedPane)
        .filter((pane): pane is RightDockPane => pane !== null)
    : [];
  const persistedActivePaneId =
    typeof candidate.activePaneId === "string" ? candidate.activePaneId : null;
  // One singleton per kind and owner (a shared dock holds each surface's own).
  const singletonKey = (pane: RightDockPane) => `${pane.kind}:${pane.ownerThreadId ?? ""}`;
  const keptSingletonPaneIdByKind = new Map<string, string>();
  for (const pane of sanitizedPanes) {
    if (
      isSingletonPaneKind(pane.kind) &&
      (pane.id === persistedActivePaneId || !keptSingletonPaneIdByKind.has(singletonKey(pane)))
    ) {
      keptSingletonPaneIdByKind.set(singletonKey(pane), pane.id);
    }
  }
  const panes = sanitizedPanes.filter(
    (pane) =>
      !isSingletonPaneKind(pane.kind) || keptSingletonPaneIdByKind.get(singletonKey(pane)) === pane.id,
  );
  const activePaneId =
    persistedActivePaneId && panes.some((pane) => pane.id === persistedActivePaneId)
      ? persistedActivePaneId
      : (panes[0]?.id ?? null);
  const sharedActivePaneId =
    typeof candidate.sharedActivePaneId === "string" &&
    panes.some((pane) => pane.id === candidate.sharedActivePaneId)
      ? candidate.sharedActivePaneId
      : null;
  return {
    open: candidate.open === true,
    panes,
    activePaneId,
    ...(sharedActivePaneId ? { sharedActivePaneId } : {}),
  };
}

export function sanitizeRightDockStateByThreadId(
  value: unknown,
): Record<string, RightDockThreadState> {
  return sanitizeStringKeyedRecord(value, (raw) =>
    raw === undefined ? null : sanitizeRightDockThreadState(raw),
  );
}

export interface OpenPaneInput {
  paneId: string;
  kind: RightDockPaneKind;
  threadId?: ThreadId | null;
  diffTurnId?: TurnId | null;
  diffFilePath?: string | null;
  filePath?: string | null;
  fileSource?: "host" | "workspace";
  fileRevision?: string | null;
  pullRequestProjectId?: ProjectId | null;
  pullRequestRepository?: string | null;
  pullRequestNumber?: number | null;
  pullRequestInitialTab?: PullRequestInitialTab | null;
  ownerThreadId?: string | null;
}

function createPane(input: OpenPaneInput): RightDockPane {
  return {
    id: input.paneId,
    kind: input.kind,
    threadId: input.threadId ?? null,
    diffTurnId: input.diffTurnId ?? null,
    diffFilePath: input.diffFilePath ?? null,
    filePath: input.filePath ?? null,
    ...(input.fileSource ? { fileSource: input.fileSource } : {}),
    ...(input.fileRevision ? { fileRevision: input.fileRevision } : {}),
    pullRequestProjectId: input.pullRequestProjectId ?? null,
    pullRequestRepository: input.pullRequestRepository ?? null,
    pullRequestNumber: input.pullRequestNumber ?? null,
    pullRequestInitialTab: input.pullRequestInitialTab ?? null,
    ...(input.ownerThreadId ? { ownerThreadId: input.ownerThreadId } : {}),
  };
}

// Payload to merge into an existing singleton pane when re-opening it. Only
// overwrite content metadata when the caller explicitly targets new content,
// so a bare re-open/toggle keeps the pane focused on what it currently shows.
function singletonPaneReopenPatch(input: OpenPaneInput): Partial<RightDockPane> | null {
  if (input.kind === "sidechat" && input.threadId !== undefined) {
    return { threadId: input.threadId ?? null };
  }
  if (
    input.kind === "diff" &&
    (input.diffTurnId !== undefined || input.diffFilePath !== undefined)
  ) {
    return { diffTurnId: input.diffTurnId ?? null, diffFilePath: input.diffFilePath ?? null };
  }
  if (
    input.kind === "pullRequest" &&
    (input.pullRequestProjectId !== undefined ||
      input.pullRequestRepository !== undefined ||
      input.pullRequestNumber !== undefined ||
      input.pullRequestInitialTab !== undefined)
  ) {
    return {
      pullRequestProjectId: input.pullRequestProjectId ?? null,
      pullRequestRepository: input.pullRequestRepository ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      pullRequestInitialTab: input.pullRequestInitialTab ?? null,
    };
  }
  return null;
}

// Multi-instance file panes reuse an existing pane when it already shows the
// requested path, so re-clicking a file focuses its tab instead of duplicating it.
function findMatchingMultiInstancePane(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockPane | undefined {
  if (input.kind === "file") {
    const filePath = input.filePath ?? null;
    return state.panes.find(
      (pane) =>
        pane.kind === "file" &&
        pane.filePath === filePath &&
        (pane.fileSource ?? "workspace") === (input.fileSource ?? "workspace") &&
        (pane.fileRevision ?? null) === (input.fileRevision ?? null) &&
        pane.threadId === (input.threadId ?? null) &&
        (pane.ownerThreadId ?? null) === (input.ownerThreadId ?? null),
    );
  }
  return undefined;
}

function findSingletonPane(
  state: RightDockThreadState,
  kind: RightDockPaneKind,
  ownerThreadId: string | null = null,
): RightDockPane | undefined {
  return state.panes.find(
    (pane) => pane.kind === kind && (pane.ownerThreadId ?? null) === ownerThreadId,
  );
}

// Opens (or focuses) a pane and makes the dock visible. Singleton kinds reuse
// the existing pane and merge diff metadata; multi-instance kinds add a new
// pane unless one already shows the same content (thread / file).
export function openPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  if (isSingletonPaneKind(input.kind)) {
    const existing = findSingletonPane(state, input.kind, input.ownerThreadId ?? null);
    if (existing) {
      const patch = singletonPaneReopenPatch(input);
      const nextPanes = patch
        ? state.panes.map((pane) => (pane.id === existing.id ? { ...pane, ...patch } : pane))
        : state.panes;
      return { ...state, open: true, panes: nextPanes, activePaneId: existing.id };
    }
  } else {
    const existing = findMatchingMultiInstancePane(state, input);
    if (existing) {
      return { ...state, open: true, panes: state.panes, activePaneId: existing.id };
    }
  }

  const pane = createPane(input);
  return {
    ...state,
    open: true,
    panes: [...state.panes, pane],
    activePaneId: pane.id,
  };
}

function resolveActiveAfterRemoval(
  panes: RightDockPane[],
  removedIndex: number,
  previousActiveId: string | null,
  removedId: string,
): string | null {
  if (previousActiveId !== removedId) {
    return previousActiveId;
  }
  if (panes.length === 0) {
    return null;
  }
  const neighborIndex = Math.min(removedIndex, panes.length - 1);
  return panes[neighborIndex]?.id ?? null;
}

export function closePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  const removedIndex = state.panes.findIndex((pane) => pane.id === paneId);
  if (removedIndex === -1) {
    return state;
  }
  const nextPanes = state.panes.filter((pane) => pane.id !== paneId);
  const nextActiveId = resolveActiveAfterRemoval(
    nextPanes,
    removedIndex,
    state.activePaneId,
    paneId,
  );
  return {
    ...state,
    // An open dock with no panes is the launcher state. Closing the final tab
    // returns to that launcher instead of collapsing the entire dock.
    open: state.open,
    panes: nextPanes,
    activePaneId: nextActiveId,
  };
}

export function setActivePaneInState(
  state: RightDockThreadState,
  paneId: string | null,
): RightDockThreadState {
  if (paneId === null) {
    return state.open && state.activePaneId === null
      ? state
      : { ...state, open: true, activePaneId: null };
  }
  if (!state.panes.some((pane) => pane.id === paneId)) {
    return state;
  }
  return { ...state, open: true, activePaneId: paneId };
}

export function setDockOpenInState(
  state: RightDockThreadState,
  open: boolean,
): RightDockThreadState {
  if (state.open === open) {
    return state;
  }
  return { ...state, open };
}

export function updatePaneInState(
  state: RightDockThreadState,
  paneId: string,
  patch: Partial<
    Pick<
      RightDockPane,
      | "diffTurnId"
      | "diffFilePath"
      | "filePath"
      | "threadId"
      | "pullRequestProjectId"
      | "pullRequestRepository"
      | "pullRequestNumber"
      | "pullRequestInitialTab"
    >
  >,
): RightDockThreadState {
  let changed = false;
  const nextPanes = state.panes.map((pane) => {
    if (pane.id !== paneId) {
      return pane;
    }
    const nextPane = { ...pane, ...patch };
    if (
      nextPane.diffTurnId !== pane.diffTurnId ||
      nextPane.diffFilePath !== pane.diffFilePath ||
      nextPane.filePath !== pane.filePath ||
      nextPane.threadId !== pane.threadId ||
      nextPane.pullRequestProjectId !== pane.pullRequestProjectId ||
      nextPane.pullRequestRepository !== pane.pullRequestRepository ||
      nextPane.pullRequestNumber !== pane.pullRequestNumber ||
      nextPane.pullRequestInitialTab !== pane.pullRequestInitialTab
    ) {
      changed = true;
      return nextPane;
    }
    return pane;
  });
  return changed ? { ...state, panes: nextPanes } : state;
}

// Header toggles behave like a visibility switch for a singleton kind: if that
// kind is the active visible pane, collapse the dock (preserving tabs);
// otherwise open/focus it.
export function toggleSingletonPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  const existing = findSingletonPane(state, input.kind, input.ownerThreadId ?? null);
  if (existing && state.open && state.activePaneId === existing.id) {
    return { ...state, open: false };
  }
  return openPaneInState(state, input);
}

/**
 * The dock as shown when the host pins a pane: that pane leads the tab strip
 * (it is added if the stored state lacks it, without changing the active tab).
 */
export function withPinnedHostPane(state: RightDockThreadState, paneId: string): RightDockThreadState {
  const existing = findSingletonPane(state, "host");
  const withHost = existing
    ? state
    : {
        ...openPaneInState(state, { paneId, kind: "host" }),
        open: state.open,
        activePaneId: state.activePaneId ?? paneId,
      };
  const host = findSingletonPane(withHost, "host")!;
  return { ...withHost, panes: [host, ...withHost.panes.filter((pane) => pane.id !== host.id)] };
}

export const SHARED_RIGHT_DOCK_KEY_PREFIX = "project-dock:";

/** A shared dock's key for one project: its feed and every thread use the same state. */
export function sharedRightDockKey(projectId: string): string {
  return `${SHARED_RIGHT_DOCK_KEY_PREFIX}${projectId}`;
}

/** Shared dock: panes every surface shows (the host's pane, Explorer, committed files). */
export function isSharedDockPane(input: { kind: RightDockPaneKind; fileSource?: "host" | "workspace" | undefined }): boolean {
  return input.kind === "host" || input.kind === "explorer" || (input.kind === "file" && input.fileSource === "host");
}

/** Shared dock: keep the last active unowned pane, so another surface can show it. */
export function withSharedActivePane(
  previous: RightDockThreadState,
  next: RightDockThreadState,
): RightDockThreadState {
  const active = next.panes.find((pane) => pane.id === next.activePaneId);
  const sharedActivePaneId =
    active && !active.ownerThreadId
      ? active.id
      : (next.sharedActivePaneId ?? previous.sharedActivePaneId ?? null);
  return (next.sharedActivePaneId ?? null) === sharedActivePaneId ? next : { ...next, sharedActivePaneId };
}

/**
 * A shared dock as one surface shows it: unowned panes plus that surface's own;
 * when the active pane is another surface's, the last active unowned pane.
 */
export function resolveSurfaceDockState(
  state: RightDockThreadState,
  ownerThreadId: string,
): RightDockThreadState {
  const visible = (pane: RightDockPane) => !pane.ownerThreadId || pane.ownerThreadId === ownerThreadId;
  if (state.panes.every(visible)) return state;
  const panes = state.panes.filter(visible);
  const activePaneId = panes.some((pane) => pane.id === state.activePaneId)
    ? state.activePaneId
    : panes.some((pane) => pane.id === state.sharedActivePaneId)
      ? (state.sharedActivePaneId ?? null)
      : (panes[0]?.id ?? null);
  return { ...state, panes, activePaneId };
}

export function resolveActivePane(state: RightDockThreadState): RightDockPane | null {
  if (!state.open || state.activePaneId === null) {
    return null;
  }
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? null;
}

export function findMissingSidechatPaneIds(
  state: RightDockThreadState,
  existingThreadIds: ReadonlySet<ThreadId>,
): readonly string[] {
  return state.panes.flatMap((pane) =>
    pane.kind === "sidechat" && pane.threadId && !existingThreadIds.has(pane.threadId)
      ? [pane.id]
      : [],
  );
}

// An active sidechat embeds a full chat, so it needs a detail lease just like a
// split-view pane. Persisted inactive or currently unrendered docks stay out of
// the scarce live-stream budget.
export function resolveVisibleDockSidechatThreadIds(input: {
  dockRendered: boolean;
  dockStateByThreadId: Record<string, RightDockThreadState | undefined>;
  hostThreadIds: readonly ThreadId[];
}): ThreadId[] {
  if (!input.dockRendered) {
    return [];
  }

  const sidechatThreadIds: ThreadId[] = [];
  const seenThreadIds = new Set<ThreadId>(input.hostThreadIds);
  for (const hostThreadId of input.hostThreadIds) {
    const dockState = input.dockStateByThreadId[hostThreadId];
    if (!dockState) {
      continue;
    }
    const activePane = resolveActivePane(dockState);
    if (
      activePane?.kind === "sidechat" &&
      activePane.threadId &&
      !seenThreadIds.has(activePane.threadId)
    ) {
      seenThreadIds.add(activePane.threadId);
      sidechatThreadIds.push(activePane.threadId);
    }
  }
  return sidechatThreadIds;
}
