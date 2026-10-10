// FILE: rightDockStore.ts
// Purpose: Persist the tabbed right-dock state (open panes + active tab) per host thread
// (or per project, for a dock its surfaces share; keys from sharedRightDockKey).
// Layer: UI state store
// Exports: dock store hook, per-thread selector, and stable default snapshot.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { randomUUID } from "./lib/utils";
import {
  type OpenPaneInput,
  type RightDockPane,
  type RightDockThreadState,
  closePaneInState,
  createDefaultRightDockState,
  openPaneInState,
  sanitizeRightDockStateByThreadId,
  setActivePaneInState,
  setDockOpenInState,
  toggleSingletonPaneInState,
  updatePaneInState,
  SHARED_RIGHT_DOCK_KEY_PREFIX,
  withSharedActivePane,
} from "./rightDockStore.logic";

const RIGHT_DOCK_STORAGE_KEY = "synara:right-dock-state:v1";

interface RightDockStore {
  dockStateByThreadId: Record<string, RightDockThreadState | undefined>;
  openPane: (
    threadId: string,
    input: Omit<OpenPaneInput, "paneId"> & { paneId?: string },
  ) => void;
  toggleSingletonPane: (
    threadId: string,
    input: Omit<OpenPaneInput, "paneId"> & { paneId?: string },
  ) => void;
  closePane: (threadId: string, paneId: string) => void;
  setActivePane: (threadId: string, paneId: string | null) => void;
  setDockOpen: (threadId: string, open: boolean) => void;
  updatePane: (
    threadId: string,
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
  ) => void;
  clearThreadDockState: (threadId: string) => void;
  updateDockState: (
    threadId: string,
    transform: (state: RightDockThreadState) => RightDockThreadState,
  ) => void;
}

// Frozen shared snapshot: it is handed back from `selectRightDockState` for any
// thread without persisted dock state, so it must stay a stable, immutable
// reference (transitions always build new objects rather than mutating it).
const DEFAULT_RIGHT_DOCK_STATE = createDefaultRightDockState();
Object.freeze(DEFAULT_RIGHT_DOCK_STATE);
Object.freeze(DEFAULT_RIGHT_DOCK_STATE.panes);

function commit(
  set: (fn: (store: RightDockStore) => Partial<RightDockStore>) => void,
  threadId: string,
  transform: (state: RightDockThreadState) => RightDockThreadState,
): void {
  set((store) => {
    const previous = store.dockStateByThreadId[threadId] ?? DEFAULT_RIGHT_DOCK_STATE;
    const transformed = transform(previous);
    const next = threadId.startsWith(SHARED_RIGHT_DOCK_KEY_PREFIX)
      ? withSharedActivePane(previous, transformed)
      : transformed;
    if (next === previous) {
      return {};
    }
    return {
      dockStateByThreadId: {
        ...store.dockStateByThreadId,
        [threadId]: next,
      },
    };
  });
}

export const useRightDockStore = create<RightDockStore>()(
  persist(
    (set) => ({
      dockStateByThreadId: {},
      openPane: (threadId, input) =>
        commit(set, threadId, (state) =>
          openPaneInState(state, { ...input, paneId: input.paneId ?? randomUUID() }),
        ),
      toggleSingletonPane: (threadId, input) =>
        commit(set, threadId, (state) =>
          toggleSingletonPaneInState(state, { ...input, paneId: input.paneId ?? randomUUID() }),
        ),
      closePane: (threadId, paneId) =>
        commit(set, threadId, (state) => closePaneInState(state, paneId)),
      setActivePane: (threadId, paneId) =>
        commit(set, threadId, (state) => setActivePaneInState(state, paneId)),
      setDockOpen: (threadId, open) =>
        commit(set, threadId, (state) => setDockOpenInState(state, open)),
      updatePane: (threadId, paneId, patch) =>
        commit(set, threadId, (state) => updatePaneInState(state, paneId, patch)),
      updateDockState: (threadId, transform) => commit(set, threadId, transform),
      clearThreadDockState: (threadId) =>
        set((store) => {
          if (!Object.hasOwn(store.dockStateByThreadId, threadId)) {
            return {};
          }
          const next = { ...store.dockStateByThreadId };
          delete next[threadId];
          return { dockStateByThreadId: next };
        }),
    }),
    {
      name: RIGHT_DOCK_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Validate persisted panes on rehydrate so a stale/unknown pane kind from
      // an older app version can never crash the dock during render.
      merge: (persisted, current) => ({
        ...current,
        dockStateByThreadId: sanitizeRightDockStateByThreadId(
          (persisted as { dockStateByThreadId?: unknown } | undefined)?.dockStateByThreadId,
        ),
      }),
    },
  ),
);

export function selectRightDockState(threadId: string | null) {
  // Keep the fallback snapshot stable so React does not observe phantom store
  // changes while mounting a thread that has no persisted dock state yet.
  return (store: RightDockStore) =>
    (threadId ? store.dockStateByThreadId[threadId] : undefined) ?? DEFAULT_RIGHT_DOCK_STATE;
}
