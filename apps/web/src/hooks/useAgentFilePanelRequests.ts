import type { ThreadId } from "@synara/contracts";
import { useEffect, useEffectEvent } from "react";

import { useStore } from "../store";

const OPEN_FILE_TOOL_NAME = "synara_open_file";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function openFilePath(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): string | null {
  if (activity.kind !== "tool.completed") return null;
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const toolName = data?.toolName ?? data?.name ?? data?.tool;
  if (toolName !== OPEN_FILE_TOOL_NAME || data?.isError === true) return null;
  const args = record(data?.args ?? data?.input ?? data?.rawInput);
  const path = typeof args?.path === "string" ? args.path.trim() : "";
  return path.length > 0 ? path : null;
}

/**
 * Converts a newly completed agent `synara_open_file` tool call into a local
 * pane request without replaying historical calls when a thread hydrates.
 * The imperative subscription avoids re-rendering the chat surface for every
 * tool/activity update.
 */
export function useAgentFilePanelRequests(input: {
  readonly threadId: ThreadId;
  readonly onOpenFile: (path: string) => void;
}): void {
  const handleOpen = useEffectEvent(input.onOpenFile);

  useEffect(() => {
    const initial = useStore.getState();
    const seen = new Set(initial.activityIdsByThreadId?.[input.threadId] ?? []);
    return useStore.subscribe((state) => {
      const ids = state.activityIdsByThreadId?.[input.threadId] ?? [];
      const activities = state.activityByThreadId?.[input.threadId] ?? {};
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const activity = activities[id];
        if (!activity) continue;
        const path = openFilePath(activity);
        if (path) handleOpen(path);
      }
    });
  }, [input.threadId]);
}
