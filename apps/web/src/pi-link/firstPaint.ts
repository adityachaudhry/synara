// FILE: pi-link/firstPaint.ts
// Purpose: The shell the workspace paints with before the worker connects, from the company
// thread list the host fetched with the page (the same translation the worker uses).
// Layer: Pi Link, page side; runs once per mount.

import { deriveProject, deriveShellThread, type ThreadRow } from "./derive";
import type { TabConfig } from "./messages";

export function piLinkShellSnapshot(config: TabConfig & { readonly initialCompanyThreads?: unknown }) {
  const value = config.initialCompanyThreads as { threads?: Record<string, ThreadRow> } | undefined;
  if (!value?.threads) return undefined;
  const project = config.project;
  return {
    snapshotSequence: 0,
    spaces: [],
    projects: [deriveProject({ companyId: project.companyId, slug: project.slug, name: project.name, ...(project.repository ? { repository: project.repository } : {}) })],
    threads: Object.values(value.threads).map((row) => deriveShellThread(row, project.companyId)),
    updatedAt: new Date().toISOString(),
  };
}
