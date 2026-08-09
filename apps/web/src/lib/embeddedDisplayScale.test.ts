// FILE: embeddedDisplayScale.test.ts
// Purpose: Verifies safe host-provided scaling for the complete embedded app.
// Layer: Web runtime adapter tests

import { describe, expect, it } from "vitest";

import {
  createEmbeddedDisplayScaleStyle,
  normalizeEmbeddedDisplayScale,
} from "./embeddedDisplayScale";

describe("embedded display scale", () => {
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "1.3"])(
    "falls back to one for invalid value %s",
    (value) => expect(normalizeEmbeddedDisplayScale(value)).toBe(1),
  );

  it("rounds and clamps valid numeric values", () => {
    expect(normalizeEmbeddedDisplayScale(0.8)).toBe(1);
    expect(normalizeEmbeddedDisplayScale(1.296)).toBe(1.3);
    expect(normalizeEmbeddedDisplayScale(1.8)).toBe(1.5);
  });

  it("creates an inverse-sized layout viewport for scaled mounts", () => {
    expect(createEmbeddedDisplayScaleStyle(1)).toBeUndefined();
    expect(createEmbeddedDisplayScaleStyle(1.3)).toEqual({
      width: "76.923%",
      height: "76.923%",
      zoom: 1.3,
    });
  });
});
