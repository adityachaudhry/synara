// FILE: hostSidebar.tsx
// Purpose: Carries host-owned React sidebar slots through the embedded route tree.
// Layer: Web React adapter

import { createContext, useContext, type ReactNode } from "react";

export interface SynaraHostSidebar {
  /** Requested physical width in host screen pixels. */
  readonly widthPx: number;
  /** Keeps the embedded rail visible and removes Synara's collapse/resize affordances. */
  readonly lockedOpen?: boolean;
  /** Host-owned content rendered above Synara's thread list. */
  readonly header?: ReactNode;
  /** Host-owned content rendered below Synara's thread list. */
  readonly footer?: ReactNode;
}

const HostSidebarContext = createContext<SynaraHostSidebar | null>(null);

export function SynaraHostSidebarProvider({
  value,
  children,
}: {
  readonly value: SynaraHostSidebar | null;
  readonly children: ReactNode;
}) {
  return <HostSidebarContext.Provider value={value}>{children}</HostSidebarContext.Provider>;
}

export function useSynaraHostSidebar(): SynaraHostSidebar | null {
  return useContext(HostSidebarContext);
}
