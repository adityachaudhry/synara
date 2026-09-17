// Pending sends belong to a thread, not the feed/chat component displaying it.
// Keep this transient state in memory so opening the newly-created thread does
// not lose the bridge between its accepted request and the provider's first turn.
import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS, type LocalDispatchSnapshot } from "./components/ChatView.logic";

export type LocalDispatchUpdate = LocalDispatchSnapshot | null |
  ((current: LocalDispatchSnapshot | null) => LocalDispatchSnapshot | null);

interface LocalDispatchStore {
  byThreadId: Partial<Record<ThreadId, LocalDispatchSnapshot>>;
  set: (threadId: ThreadId, update: LocalDispatchUpdate) => void;
}

export const useLocalDispatchStore = create<LocalDispatchStore>((set) => ({
  byThreadId: {},
  set: (threadId, update) => set((state) => {
    const current = state.byThreadId[threadId] ?? null;
    const next = typeof update === "function" ? update(current) : update;
    if (next === current) return state;
    const byThreadId = { ...state.byThreadId };
    // A hidden thread has no mounted cleanup effect. Prune old non-setup
    // entries on the next write; active worktree preparation keeps its own life cycle.
    for (const [id, dispatch] of Object.entries(byThreadId)) {
      if (dispatch && !dispatch.worktreeSetup &&
          Date.now() - Date.parse(dispatch.startedAt) >= LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS) {
        delete byThreadId[id as ThreadId];
      }
    }
    if (next) byThreadId[threadId] = next;
    else delete byThreadId[threadId];
    return { byThreadId };
  }),
}));
