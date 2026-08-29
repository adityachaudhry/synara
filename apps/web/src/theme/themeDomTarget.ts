interface ThemeDocumentLike {
  readonly documentElement: HTMLElement;
  querySelector(selector: string): HTMLElement | null;
}

export function resolveThemeDomTarget(
  documentLike: ThemeDocumentLike,
  embeddedBuild: boolean,
): HTMLElement | null {
  return embeddedBuild
    ? documentLike.querySelector("[data-synara-app-root]")
    : documentLike.documentElement;
}

export function shouldProjectSynaraThemeVariables(
  target: Pick<HTMLElement, "hasAttribute">,
  embeddedBuild: boolean,
): boolean {
  return !(embeddedBuild && target.hasAttribute("data-synara-host-themed"));
}

export function resolveHostAwareThemeVariant<T extends "light" | "dark">(
  variant: T,
  hostThemed: boolean,
): T | "light" {
  return hostThemed ? "light" : variant;
}
