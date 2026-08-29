import type { RouterHistory } from "@tanstack/react-router";

import { createEmbeddedAppHistory as createAppHistory } from "./appNavigation";

export type SynaraHistory = RouterHistory;

export function createEmbeddedAppHistory(initialPath = "/"): SynaraHistory {
  return createAppHistory(initialPath);
}
