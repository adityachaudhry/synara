import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const { transform } = vi.hoisted(() => ({ transform: vi.fn() }));
vi.mock("@rolldown/plugin-babel", () => ({ default: async () => ({ transform: { handler: transform } }) }));
import { cachedReactCompilerPlugin } from "./cached-react-compiler.mjs";

const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "react-compiler-cache-"));
  directories.push(cacheDirectory);
  return { cacheDirectory, plugin: await cachedReactCompilerPlugin({ cacheDirectory }) };
}

it("reuses exact transforms across builds but invalidates changed source and environment", async () => {
  transform.mockImplementation(async (code: string) => ({ code: `compiled:${code}`, map: null }));
  const { plugin, cacheDirectory } = await fixture();
  const context = { environment: { name: "client", config: { mode: "production" } } };
  const first = await plugin.transform.handler.call(context, "source", "/App.tsx", { moduleType: "tsx" });
  const nextBuild = await cachedReactCompilerPlugin({ cacheDirectory });
  expect(await nextBuild.transform.handler.call(context, "source", "/App.tsx", { moduleType: "tsx" })).toEqual(first);
  expect(transform).toHaveBeenCalledTimes(1);
  await nextBuild.transform.handler.call(context, "changed", "/App.tsx", { moduleType: "tsx" });
  await nextBuild.transform.handler.call({ environment: { name: "ssr" } }, "source", "/App.tsx", { moduleType: "tsx" });
  expect(transform).toHaveBeenCalledTimes(3);
});

it("never caches failed compiler checks and recovers from a damaged cache entry", async () => {
  const { plugin, cacheDirectory } = await fixture();
  transform.mockRejectedValueOnce(new Error("invalid component"));
  await expect(plugin.transform.handler.call({}, "source", "/App.tsx")).rejects.toThrow("invalid component");
  expect(await fs.readdir(cacheDirectory)).toEqual([]);
  transform.mockResolvedValue({ code: "valid", map: null });
  await plugin.transform.handler.call({}, "source", "/App.tsx");
  const [file] = await fs.readdir(cacheDirectory);
  await fs.writeFile(path.join(cacheDirectory, file!), "broken JSON");
  expect(await plugin.transform.handler.call({}, "source", "/App.tsx")).toEqual({ code: "valid", map: null });
  expect(transform).toHaveBeenCalledTimes(3);
});
