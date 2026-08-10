// FILE: embeddedTypography.test.ts
// Purpose: Verifies that embedding hosts can enlarge Synara text without scaling layout geometry.
// Layer: Web runtime adapter tests

import { describe, expect, it } from "vitest";

import { createEmbeddedTypographyStyle } from "./embeddedTypography";

describe("embedded typography", () => {
  it("maps a host base size onto Synara's existing UI and chat typography tokens", () => {
    expect(createEmbeddedTypographyStyle(15)).toEqual({
      "--app-font-size-base": "15px",
      "--app-font-size-ui": "15px",
      "--app-font-size-ui-lg": "16px",
      "--app-font-size-ui-sm": "14px",
      "--app-font-size-ui-xs": "13px",
      "--app-font-size-ui-2xs": "11px",
      "--app-font-size-ui-meta": "13px",
      "--app-font-size-ui-timestamp": "11px",
      "--app-font-size-chat": "15px",
      "--app-font-size-chat-code": "14px",
      "--app-font-size-chat-meta": "11px",
      "--app-font-size-chat-tiny": "10px",
    });
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "15"])(
    "does not override standalone typography for invalid host value %s",
    (value) => expect(createEmbeddedTypographyStyle(value)).toBeUndefined(),
  );
});

