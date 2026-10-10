// FILE: rightDockKey.ts
// Purpose: The right-dock store key a thread's surface uses: its own, or its
// project's when the host shares one dock across the feed and threads.

import { useSynaraHostSidebar } from "./hostSidebar";
import { sharedRightDockKey } from "./rightDockStore.logic";

export function useRightDockKey(threadId: string, projectId: string | null | undefined): string {
  const hostSidebar = useSynaraHostSidebar();
  return hostSidebar?.sharedRightDock === true && projectId ? sharedRightDockKey(projectId) : threadId;
}
