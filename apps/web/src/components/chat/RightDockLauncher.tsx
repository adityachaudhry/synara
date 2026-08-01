// FILE: RightDockLauncher.tsx
// Purpose: Default chooser shown when the right dock is opened manually.
// Layer: Chat right-dock UI

import type { RightDockPaneKind } from "~/rightDockStore.logic";
import type { RightDockLauncherItem } from "./rightDockPaneMeta";

interface RightDockLauncherProps {
  items: readonly RightDockLauncherItem[];
  onOpen: (kind: RightDockPaneKind) => void;
}

export function RightDockLauncher(props: RightDockLauncherProps) {
  return (
    <div className="h-full min-h-0 overflow-y-auto px-8 py-12">
      <div className="flex min-h-full items-center justify-center">
        <nav className="flex w-full max-w-sm flex-col gap-1" aria-label="Available panels">
          {props.items.map(({ kind, Icon, label }) => {
            return (
              <button
                key={kind}
                type="button"
                className="flex h-11 w-full items-center gap-3 rounded-lg px-4 text-left font-system-ui text-sm font-normal text-foreground/90 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => props.onOpen(kind)}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
