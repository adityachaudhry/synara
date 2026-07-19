import { describe, expect, it, vi } from "vitest";

import { bootstrapSuperTokensAuth } from "./superTokensBootstrap";

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("bootstrapSuperTokensAuth", () => {
  it("renders the standalone auth page on /auth", async () => {
    const renderAuth = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn();
    await expect(
      bootstrapSuperTokensAuth({
        pathname: "/auth",
        fetch,
        replace: vi.fn(),
        renderAuth,
      }),
    ).resolves.toBe("handled");
    expect(renderAuth).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redirects an unauthenticated external-auth browser", async () => {
    const replace = vi.fn();
    await expect(
      bootstrapSuperTokensAuth({
        pathname: "/",
        fetch: vi.fn().mockResolvedValue(
          response({
            authenticated: false,
            auth: { externalProvider: "supertokens" },
          }),
        ),
        replace,
        renderAuth: vi.fn(),
      }),
    ).resolves.toBe("redirecting");
    expect(replace).toHaveBeenCalledWith("/auth");
  });

  it("continues for native auth and authenticated sessions", async () => {
    for (const body of [
      { authenticated: false, auth: {} },
      { authenticated: true, auth: { externalProvider: "supertokens" } },
    ]) {
      await expect(
        bootstrapSuperTokensAuth({
          pathname: "/",
          fetch: vi.fn().mockResolvedValue(response(body)),
          replace: vi.fn(),
          renderAuth: vi.fn(),
        }),
      ).resolves.toBe("continue");
    }
  });
});
