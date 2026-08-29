import { describe, expect, it } from "vitest";

import {
  resolveHostAwareThemeVariant,
  resolveThemeDomTarget,
  shouldProjectSynaraThemeVariables,
} from "./themeDomTarget";

describe("resolveThemeDomTarget", () => {
  it("uses the document root for standalone and only the mount root for embedded builds", () => {
    const documentRoot = { id: "html" } as HTMLElement;
    const embeddedRoot = { id: "synara" } as HTMLElement;
    const documentLike = {
      documentElement: documentRoot,
      querySelector: (selector: string) =>
        selector === "[data-synara-app-root]" ? embeddedRoot : null,
    };

    expect(resolveThemeDomTarget(documentLike, false)).toBe(documentRoot);
    expect(resolveThemeDomTarget(documentLike, true)).toBe(embeddedRoot);
    expect(resolveThemeDomTarget({ ...documentLike, querySelector: () => null }, true)).toBeNull();
  });

  it("preserves host-owned theme variables", () => {
    const themedRoot = {
      hasAttribute: (name: string) => name === "data-synara-host-themed",
    } as HTMLElement;

    expect(shouldProjectSynaraThemeVariables(themedRoot, true)).toBe(false);
    expect(shouldProjectSynaraThemeVariables(themedRoot, false)).toBe(true);
    expect(resolveHostAwareThemeVariant("dark", true)).toBe("light");
    expect(resolveHostAwareThemeVariant("dark", false)).toBe("dark");
  });
});
