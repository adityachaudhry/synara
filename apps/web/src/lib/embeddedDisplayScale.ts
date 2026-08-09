// FILE: embeddedDisplayScale.ts
// Purpose: Normalizes host-provided display scaling for embedded Synara mounts.
// Layer: Web runtime adapter

export const MIN_EMBEDDED_DISPLAY_SCALE = 1;
export const MAX_EMBEDDED_DISPLAY_SCALE = 1.5;

export interface EmbeddedDisplayScaleStyle {
  readonly width: string;
  readonly height: string;
  readonly zoom: number;
}

export function normalizeEmbeddedDisplayScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const bounded = Math.min(
    MAX_EMBEDDED_DISPLAY_SCALE,
    Math.max(MIN_EMBEDDED_DISPLAY_SCALE, value),
  );
  return Math.round(bounded * 100) / 100;
}

export function createEmbeddedDisplayScaleStyle(
  value: unknown,
): EmbeddedDisplayScaleStyle | undefined {
  const zoom = normalizeEmbeddedDisplayScale(value);
  if (zoom === 1) return undefined;
  // CSS layout zoom already reduces the element's logical percentage basis.
  // Full percentage dimensions therefore reflow at 1 / zoom while their
  // rendered edges remain exactly aligned with the embedding host.
  return { width: "100%", height: "100%", zoom };
}
