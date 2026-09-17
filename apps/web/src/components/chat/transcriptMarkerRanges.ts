import { useLayoutEffect, type RefObject } from "react";
import type { ThreadMarker } from "@synara/contracts";

// Both selection and painting use the displayed text, not the provider's merged Markdown.
function textNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('button, [aria-hidden="true"]')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = text.length;
    text += node.textContent ?? "";
    nodes.push({ node: node as Text, start, end: text.length });
  }
  return { nodes, text };
}

export function selectedTranscriptRange(root: HTMLElement, range: Range) {
  const { nodes, text } = textNodes(root);
  const selected = nodes.filter(({ node }) => range.intersectsNode(node));
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;
  let startOffset = first.start + (range.startContainer === first.node ? range.startOffset : 0);
  let endOffset = last.start + (range.endContainer === last.node ? range.endOffset : last.node.length);
  const raw = text.slice(startOffset, endOffset);
  startOffset += raw.length - raw.trimStart().length;
  endOffset -= raw.length - raw.trimEnd().length;
  if (endOffset <= startOffset) return null;
  return { startOffset, endOffset, selectedText: text.slice(startOffset, endOffset),
    textFormat: "rendered" as const, textPrefix: text.slice(Math.max(0, startOffset - 32), startOffset),
    textSuffix: text.slice(endOffset, endOffset + 32) };
}

export function findTranscriptMarkerRange(root: HTMLElement, marker: ThreadMarker): Range | null {
  const { nodes, text } = textNodes(root);
  let start = marker.textFormat === "rendered" &&
    text.slice(marker.startOffset, marker.endOffset) === marker.selectedText ? marker.startOffset : -1;
  let quote = marker.selectedText;
  if (start < 0) {
    // Older marks have Markdown offsets and no author. Preserve them without inventing ownership.
    const quotes = marker.textFormat === "rendered" ? [quote] : [quote, quote.replace(/[*_`~]+/g, "")];
    for (const candidate of quotes) {
      if (!candidate) continue;
      const matches: number[] = [];
      for (let at = text.indexOf(candidate); at >= 0; at = text.indexOf(candidate, at + 1)) {
        if (marker.textPrefix && !text.slice(0, at).endsWith(marker.textPrefix)) continue;
        if (marker.textSuffix && !text.slice(at + candidate.length).startsWith(marker.textSuffix)) continue;
        matches.push(at);
      }
      if (matches.length === 1) { start = matches[0]!; quote = candidate; break; }
    }
  }
  if (start < 0) return null;
  const end = start + quote.length;
  const first = nodes.find((entry) => entry.end > start);
  const last = nodes.find((entry) => entry.end >= end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

type HighlightSet = { priority: number; add(range: Range): void };
type HighlightApi = { registry: Map<string, HighlightSet>; Ctor: new (...ranges: Range[]) => HighlightSet };
function highlightApi(): HighlightApi | null {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightApi["registry"] })?.highlights;
  const Ctor = (globalThis as unknown as { Highlight?: HighlightApi["Ctor"] }).Highlight;
  return registry && Ctor ? { registry, Ctor } : null;
}

// A single registry per document retains ranges from every mounted transcript message.
const paints = new Map<HTMLElement, Array<{ name: string; range: Range }>>();
const names = ["synara-team-highlight", "synara-team-underline", "synara-own-highlight", "synara-own-underline"]
  .flatMap((name) => [name, `${name}-done`]);
function repaint() {
  const api = highlightApi();
  if (!api) return;
  names.forEach((name, priority) => {
    const highlight = new api.Ctor();
    highlight.priority = priority;
    for (const [root, ranges] of paints) {
      if (!root.isConnected) { paints.delete(root); continue; }
      for (const entry of ranges) if (entry.name === name) highlight.add(entry.range);
    }
    api.registry.set(name, highlight);
  });
}

export function useTranscriptMarkerPaint(
  rootRef: RefObject<HTMLDivElement | null>, markers: readonly ThreadMarker[] | undefined,
  viewerSubject: string | undefined, renderedText: string,
) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !markers?.length) return;
    const paint = () => {
      paints.set(root, markers.flatMap((marker) => {
        const range = findTranscriptMarkerRange(root, marker);
        const owner = viewerSubject && marker.author?.subject === viewerSubject ? "own" : "team";
        return range ? [{ name: `synara-${owner}-${marker.style}${marker.done ? "-done" : ""}`, range }] : [];
      }));
      repaint();
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => { observer.disconnect(); paints.delete(root); repaint(); };
  }, [rootRef, markers, viewerSubject, renderedText]);
}
