import type { OrchestrationMessageAuthor } from "@synara/contracts";
import { createContext, useContext, type ReactNode } from "react";

export type SynaraHostPersistenceRequest =
  | {
      readonly kind: "attachments";
      readonly threadId: string;
      readonly messageId: string;
      readonly attachmentIds: readonly string[];
      readonly displayLabel: string;
    }
  | {
      readonly kind: "message";
      readonly threadId: string;
      readonly messageId: string;
      readonly displayLabel: string;
    }
  | {
      readonly kind: "thread";
      readonly threadId: string;
      readonly displayLabel: string;
    }
  | {
      readonly kind: "sandbox-files";
      readonly threadId: string;
      readonly lifecycleGeneration: string;
      readonly files: ReadonlyArray<{
        readonly source: "outbox" | "checkout";
        readonly path: string;
        readonly sha256: string;
      }>;
      readonly displayLabel: string;
    };

export interface SynaraHostPersistenceResult {
  readonly commitSha: string;
  readonly paths: readonly string[];
  readonly synchronized: boolean;
}

export interface SynaraHostFilePaneContext {
  readonly threadId: string | null;
}

export interface SynaraHostSidebar {
  readonly widthPx: number;
  readonly hidden?: boolean;
  readonly viewportHeightOffsetPx?: number;
  readonly lockedOpen?: boolean;
  readonly showProjectTitle?: boolean;
  readonly projectThreadsOnly?: boolean;
  readonly brandIconUrl?: string;
  readonly simplifiedComposer?: boolean;
  readonly chatFontSizePx?: number;
  readonly currentMessageAuthor?: OrchestrationMessageAuthor;
  readonly assistantLabel?: string;
  readonly messageAuthorNamesByLabel?: Readonly<Record<string, string>>;
  readonly openFilesPaneOnMount?: boolean;
  readonly filesPane?: ReactNode | ((openFile: (filePath: string) => void) => ReactNode);
  readonly renderFilePane?: (filePath: string, context: SynaraHostFilePaneContext) => ReactNode;
  readonly saveChatContent?: (
    request: SynaraHostPersistenceRequest,
  ) => Promise<SynaraHostPersistenceResult | null>;
  readonly header?: ReactNode;
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

export function resolveHostMessageAuthorLabel(
  sidebar: Pick<SynaraHostSidebar, "messageAuthorNamesByLabel"> | null,
  author: OrchestrationMessageAuthor | null | undefined,
): string | null {
  const label = author?.label?.trim();
  if (!label) return null;
  return sidebar?.messageAuthorNamesByLabel?.[label.toLowerCase()] ?? label;
}

export function resolveHostSidebarPresentation(
  sidebar: Pick<SynaraHostSidebar, "widthPx" | "lockedOpen" | "showProjectTitle"> | null,
) {
  const lockedOpen = sidebar?.lockedOpen === true;
  return {
    width:
      sidebar && Number.isFinite(sidebar.widthPx) && sidebar.widthPx > 0
        ? `${sidebar.widthPx}px`
        : undefined,
    collapsible: lockedOpen ? ("none" as const) : ("offcanvas" as const),
    resizable: !lockedOpen,
    showSeamRail: !lockedOpen,
    showProjectTitle: sidebar?.showProjectTitle !== false,
  };
}
