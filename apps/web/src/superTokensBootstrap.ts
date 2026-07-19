export type SuperTokensBootstrapResult = "continue" | "handled" | "redirecting";

interface SuperTokensBootstrapDependencies {
  readonly pathname: string;
  readonly fetch: typeof globalThis.fetch;
  readonly replace: (path: string) => void;
  readonly renderAuth: () => Promise<void>;
}

export async function bootstrapSuperTokensAuth(
  dependencies: SuperTokensBootstrapDependencies = {
    pathname: window.location.pathname,
    fetch: globalThis.fetch,
    replace: (path) => window.location.replace(path),
    renderAuth: async () => {
      const { renderSuperTokensAuth } = await import("./superTokensAuth/render");
      renderSuperTokensAuth();
    },
  },
): Promise<SuperTokensBootstrapResult> {
  if (dependencies.pathname === "/auth") {
    await dependencies.renderAuth();
    return "handled";
  }

  try {
    const response = await dependencies.fetch("/api/auth/session", {
      credentials: "same-origin",
    });
    if (!response.ok) return "continue";
    const state = (await response.json()) as {
      readonly authenticated?: boolean;
      readonly auth?: { readonly externalProvider?: string };
    };
    if (state.authenticated === false && state.auth?.externalProvider === "supertokens") {
      dependencies.replace("/auth");
      return "redirecting";
    }
  } catch {
    return "continue";
  }
  return "continue";
}
