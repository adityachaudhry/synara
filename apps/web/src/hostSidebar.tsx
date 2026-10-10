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
  readonly fileSource?: "host" | "workspace";
  readonly fileRevision?: string | null;
  readonly threadId: string | null;
  readonly closePane: () => void;
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
  /** Suppress successful thread/terminal completion notifications; attention alerts remain enabled. */
  readonly suppressCompletionNotifications?: boolean;
  readonly openFilesPaneOnMount?: boolean;
  /**
   * The right dock's opening width for a workspace this wide (default: half). It
   * follows window resizes until someone drags the dock. Keep the function stable.
   */
  readonly rightDockOpenWidth?: (shellWidthPx: number) => number;
  /**
   * The narrowest the chat may get beside the right dock: drags stop there and a
   * narrowing window shrinks the dock (down to its own minimum) instead.
   */
  readonly chatMinWidthPx?: number;
  /**
   * The dock header offers "Expand panel" (the dock fills the workspace and the chat
   * is hidden) and "Restore split" in place of "Collapse panel"; the chat header's
   * panel toggle still opens and closes the dock.
   */
  readonly rightDockExpandable?: boolean;
  /** "tabs": the dock's tabs are file tabs (the active one joined to its pane), not
   *  loose chips. */
  readonly rightDockTabStyle?: "chips" | "tabs";
  readonly filesPane?: ReactNode | ((openFile: (filePath: string, revision?: string) => void) => ReactNode);
  readonly renderFilePane?: (filePath: string, context: SynaraHostFilePaneContext) => ReactNode;
  readonly renderFilePaneTabIcon?: (filePath: string) => ReactNode;
  /**
   * A pane the host renders as the first right-dock tab, left of Explorer. It is
   * always present and cannot be closed; `defaultActive` selects it when the dock
   * opens on mount.
   */
  readonly pinnedPane?: {
    readonly label: string;
    readonly icon?: ReactNode;
    readonly defaultActive?: boolean;
    readonly render: () => ReactNode;
  };
  readonly threadFeedHeader?: ReactNode;
  readonly saveChatContent?: (
    request: SynaraHostPersistenceRequest,
  ) => Promise<SynaraHostPersistenceResult | null>;
  readonly downloadAnswerPdf?: (request: {
    readonly threadId: string;
    readonly messageId: string;
  }) => Promise<void>;
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
