/** Only old, unclaimed pools from this controller's previous configured snapshots. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const ids = JSON.parse(readFileSync(".daytona-obsolete-pools.json", "utf8"));
if (ids.length) {
  const require = createRequire(`${process.cwd()}/apps/server/package.json`);
  const { Daytona, DaytonaNotFoundError } = await import(require.resolve("@daytona/sdk"));
  const vars = JSON.parse(execFileSync("railway", ["variable", "list", "--json", "-p", process.env.WORKER_PROJECT, "-e", process.env.WORKER_ENVIRONMENT, "-s", process.env.WORKER_SERVICE], { encoding: "utf8" }));
  assert.equal(vars.SYNARA_DAYTONA_EXCLUSIVE_POOL_OWNER, "1");
  let version;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${vars.SYNARA_PUBLIC_URL.replace(/\/$/, "")}/api/version`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) version = await response.json();
      if (version?.commit === process.env.GITHUB_SHA) break;
    } catch { /* Keep old pools during a rolling deployment. */ }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  assert.equal(version?.commit, process.env.GITHUB_SHA, "Keep old pools until the new controller serves this release");
  const client = new Daytona({ apiKey: vars.SYNARA_DAYTONA_API_KEY, apiUrl: vars.SYNARA_DAYTONA_API_URL });
  const pools = await client.warmPool.list();
  for (const id of ids) {
    const pool = pools.find(p => p.id === id);
    if (!pool) continue;
    assert(![vars.SYNARA_DAYTONA_SNAPSHOT, vars.SYNARA_DAYTONA_FALLBACK_SNAPSHOT].includes(pool.snapshot));
    try { await client.warmPool.delete(id); }
    catch (cause) { if (!(cause instanceof DaytonaNotFoundError)) throw cause; }
    console.log(`Retired obsolete unclaimed warm pool ${id}`);
  }
}
