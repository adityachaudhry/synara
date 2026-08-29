import { createContext, useContext, type ReactNode, type RefObject } from "react";

export type SynaraPortalContainerRef = RefObject<HTMLElement | null>;

const HostPortalContext = createContext<SynaraPortalContainerRef | null>(null);

export function SynaraHostPortalProvider({
  value,
  children,
}: {
  readonly value: SynaraPortalContainerRef;
  readonly children: ReactNode;
}) {
  return <HostPortalContext.Provider value={value}>{children}</HostPortalContext.Provider>;
}

export function useSynaraPortalContainer(): SynaraPortalContainerRef | undefined {
  return useContext(HostPortalContext) ?? undefined;
}
