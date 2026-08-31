import { useCallback, useEffect, useMemo, useState } from "react";

import { CheckIcon, RefreshCwIcon } from "~/lib/icons";
import { type SynaraHostPersistenceCandidate, useSynaraHostSidebar } from "../../hostSidebar";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

function selectionKey(candidate: Pick<SynaraHostPersistenceCandidate, "source" | "path">) {
  return `${candidate.source}\0${candidate.path}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SandboxPersistencePanel({ threadId }: { readonly threadId: string }) {
  const host = useSynaraHostSidebar();
  const listCandidates = host?.listSandboxPersistenceCandidates;
  const saveContent = host?.saveChatContent;
  const [result, setResult] = useState<Awaited<
    ReturnType<NonNullable<typeof listCandidates>>
  > | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!listCandidates) return;
    setLoading(true);
    try {
      const next = await listCandidates(threadId);
      setResult(next);
      const available = new Set(next.entries.map(selectionKey));
      setSelected((current) => new Set(Array.from(current).filter((key) => available.has(key))));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not inspect sandbox files",
        description:
          error instanceof Error ? error.message : "Try again after the Pi turn finishes.",
      });
    } finally {
      setLoading(false);
    }
  }, [listCandidates, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedEntries = useMemo(
    () => result?.entries.filter((entry) => selected.has(selectionKey(entry))) ?? [],
    [result, selected],
  );

  if (!listCandidates || !saveContent || (!loading && (result?.entries.length ?? 0) === 0)) {
    return null;
  }

  const saveSelected = async () => {
    if (!result || selectedEntries.length === 0) return;
    setSaving(true);
    try {
      const saved = await saveContent({
        kind: "sandbox-files",
        threadId,
        lifecycleGeneration: result.lifecycleGeneration,
        files: selectedEntries.map(({ source, path, sha256 }) => ({ source, path, sha256 })),
        displayLabel: `${String(selectedEntries.length)} sandbox file${selectedEntries.length === 1 ? "" : "s"}`,
      });
      if (!saved) return;
      toastManager.add({
        type: "success",
        title: `Saved ${String(saved.paths.length)} file${saved.paths.length === 1 ? "" : "s"}`,
        description: saved.synchronized
          ? "The same sandbox is now on the saved repository commit."
          : "The files are saved; local sandbox changes still need reconciliation.",
      });
      setSelected(new Set());
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save sandbox files",
        description: error instanceof Error ? error.message : "Refresh and try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="shrink-0 border-b border-[var(--color-border-subtle)] bg-[var(--color-background-primary)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-[var(--color-text-foreground)]">
            Files ready to save
          </p>
          <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--color-text-foreground-secondary)]">
            Choose complete files from this sandbox.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh sandbox files"
          disabled={loading || saving}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>
      {result?.entries.length ? (
        <div className="max-h-52 overflow-y-auto border-y border-[var(--color-border-subtle)]">
          {result.entries.map((entry) => {
            const key = selectionKey(entry);
            const checked = selected.has(key);
            return (
              <label
                key={key}
                className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-[var(--color-background-secondary)]"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-3.5 accent-[var(--color-text-accent)]"
                  checked={checked}
                  disabled={saving}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground)]"
                    title={entry.destinationPath}
                  >
                    {entry.name}
                  </span>
                  <span className="block truncate text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--color-text-foreground-secondary)]">
                    {entry.source === "outbox" ? "Outbox" : "Checkout edit"} ·{" "}
                    {formatBytes(entry.sizeBytes)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
      <div className="flex items-center justify-end px-3 py-2">
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={saving || selectedEntries.length === 0}
          onClick={() => void saveSelected()}
        >
          <CheckIcon className="size-3.5" />
          {saving
            ? "Saving…"
            : `Save selected${selectedEntries.length ? ` (${String(selectedEntries.length)})` : ""}`}
        </Button>
      </div>
    </section>
  );
}
