import { describe, expect, it } from "vitest";

import { scopeEmbeddedCss } from "./scope-embed-css.mjs";

describe("scopeEmbeddedCss", () => {
  it("contains document and ordinary selectors below the embedded root", async () => {
    const css = [
      ":root, html, body, #root { color: black; }",
      ".thread-row:hover, .menu [role='menuitem'] { color: red; }",
      "@media (min-width: 800px) { .chat-header { height: 46px; } }",
    ].join("\n");

    const result = await scopeEmbeddedCss(css);

    expect(result).toMatch(
      /\[data-synara-app-root\]\s*,\s*\[data-synara-app-root\]\s*,\s*\[data-synara-app-root\]\s*,\s*\[data-synara-app-root\]/,
    );
    expect(result).toContain("[data-synara-app-root] .thread-row:hover");
    expect(result).toMatch(/\[data-synara-app-root\]\s+\.menu \[role='menuitem'\]/);
    expect(result).toContain("[data-synara-app-root] .chat-header");
    expect(result).not.toMatch(/(^|[},])\s*(?:html|body|:root|#root)\b/);
  });

  it("leaves keyframes and descriptor at-rules unchanged", async () => {
    const css = [
      "@font-face { font-family: Example; src: url(example.woff2); }",
      "@keyframes pulse { from { opacity: 0; } 50% { opacity: .5; } to { opacity: 1; } }",
      ".spinner { animation: pulse 1s infinite; }",
    ].join("\n");

    const result = await scopeEmbeddedCss(css);

    expect(result).toContain("@font-face");
    expect(result).toContain("@keyframes pulse");
    expect(result).toContain("from { opacity: 0; }");
    expect(result).toContain("50% { opacity: .5; }");
    expect(result).toContain("to { opacity: 1; }");
    expect(result).toContain("[data-synara-app-root] .spinner");
    expect(result).not.toContain("[data-synara-app-root] from");
  });
});
