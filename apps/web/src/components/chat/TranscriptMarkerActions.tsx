import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ThreadMarker } from "@synara/contracts";
import { PencilIcon, TextWrapIcon } from "~/lib/icons";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { findTranscriptMarkerRange } from "./transcriptMarkerRanges";

type MarkGroup = { markers: ThreadMarker[]; ranges: Range[]; top: number };

export function TranscriptMarkerActions({ rootRef, markers, viewerSubject, onRemove, renderedText }: {
  rootRef: RefObject<HTMLDivElement | null>;
  markers: readonly ThreadMarker[];
  viewerSubject: string | undefined;
  renderedText: string;
  onRemove: (id: ThreadMarker["id"]) => Promise<void> | void;
}) {
  const [groups, setGroups] = useState<MarkGroup[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpenId(null), 180);
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const top = root.getBoundingClientRect().top;
      const marks = markers.flatMap((marker) => {
        const range = findTranscriptMarkerRange(root, marker);
        const rect = range?.getClientRects()[0];
        return range && rect ? [{ marker, range, top: rect.top - top }] : [];
      }).sort((a, b) => a.top - b.top);
      // One gutter button for nearby marks, like overlapping diligence feedback.
      // Group instead of pushing buttons below a short paragraph into the next row.
      const next: MarkGroup[] = [];
      for (const mark of marks) {
        const previous = next.at(-1);
        if (previous && mark.top - previous.top < 24) {
          previous.markers.push(mark.marker);
          previous.ranges.push(mark.range);
        } else next.push({ markers: [mark.marker], ranges: [mark.range], top: mark.top });
      }
      setGroups(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [markers, rootRef, renderedText]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const move = (event: PointerEvent) => {
      if (window.getSelection()?.toString() || event.buttons) return;
      if (event.target instanceof Element && event.target.closest('[data-transcript-marker-actions]')) return;
      const group = groups.find(({ ranges }) => ranges.some((range) => [...range.getClientRects()].some((rect) =>
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)));
      if (group) { cancelClose(); setOpenId(group.markers[0]!.id); }
      else closeSoon();
    };
    const close = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-transcript-marker-actions]')) return;
      setOpenId(null);
    };
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerleave", closeSoon);
    window.addEventListener("scroll", close, true);
    return () => {
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", closeSoon);
      window.removeEventListener("scroll", close, true);
      cancelClose();
    };
  }, [groups, rootRef]);

  return <div data-transcript-marker-actions className="pointer-events-none absolute inset-0">
    {groups.map((group) => {
      const current = group.markers.filter((marker) => markers.some((item) => item.id === marker.id));
      const first = current[0];
      if (!first) return null;
      const ownGroup = current.some((marker) => viewerSubject && marker.author?.subject === viewerSubject);
      const Icon = first.style === "underline" ? TextWrapIcon : PencilIcon;
      const groupLabel = current.length > 1 ? `${current.length} text marks` :
        `${first.style === "underline" ? "Underline" : "Highlight"} by ${first.author?.label ?? "team member"}`;
      return <Popover key={first.id} open={openId === first.id} onOpenChange={(open) => setOpenId(open ? first.id : null)}>
        <PopoverTrigger openOnHover delay={80} closeDelay={180} aria-label={groupLabel}
          className={`pointer-events-auto absolute right-0 flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full border px-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 ${ownGroup ? "border-[var(--brand)]/40 bg-[var(--brand)]/10 text-[var(--brand)]" : "border-amber-400 bg-amber-100 text-amber-900"}`}
          style={{ top: group.top }} onMouseEnter={cancelClose}>
          <Icon className="size-3" />
          {current.length > 1 && <span className="text-[9px] leading-none">{current.length}</span>}
        </PopoverTrigger>
        <PopoverPopup side="left" align="start" initialFocus={false} className="w-72 rounded-lg" aria-label="Text mark details"
          onMouseEnter={cancelClose} onMouseLeave={closeSoon}>
          <div data-transcript-marker-actions className="max-h-80 space-y-3 overflow-auto text-xs">
            {current.map((marker) => {
              const owned = Boolean(viewerSubject && marker.author?.subject === viewerSubject);
              const MarkIcon = marker.style === "underline" ? TextWrapIcon : PencilIcon;
              return <div key={marker.id} className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <MarkIcon className={`size-3.5 shrink-0 ${owned ? "text-[var(--brand)]" : "text-amber-700"}`} />
                  <PopoverTitle className="min-w-0 truncate text-xs font-medium">{marker.author?.label ?? (owned ? "You" : marker.author ? "Team member" : "Earlier mark")}</PopoverTitle>
                  <time className="ml-auto shrink-0 text-muted-foreground" dateTime={marker.createdAt} title={new Date(marker.createdAt).toLocaleString()}>{new Date(marker.createdAt).toLocaleDateString()}</time>
                </div>
                <p className="max-h-24 overflow-auto whitespace-pre-wrap text-muted-foreground">{marker.selectedText}</p>
                {owned && <button type="button" aria-label={`Delete ${marker.style}`} disabled={removingId === marker.id}
                  className="font-medium text-muted-foreground hover:text-[var(--brand)] disabled:opacity-50"
                  onClick={() => {
                    setRemovingId(marker.id);
                    void Promise.resolve(onRemove(marker.id)).finally(() => setRemovingId(null));
                  }}>{removingId === marker.id ? "Deleting…" : "Delete"}</button>}
              </div>;
            })}
          </div>
        </PopoverPopup>
      </Popover>;
    })}
  </div>;
}
