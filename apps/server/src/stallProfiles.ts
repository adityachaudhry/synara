import { Session } from "node:inspector/promises";

/** Keep the minute preceding a stall; attach no debugger port or user values. */
export function startStallProfiles() {
  if (process.env.SYNARA_STALL_PROFILING !== "1") return { capture: (_delayMs: number) => {}, stop: () => {} };
  const session = new Session();
  let active = true;
  let rotating = false;
  let profiling = false;
  let started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    active = false;
    clearInterval(timer);
    session.disconnect();
  };
  const rotate = async (delayMs = 0) => {
    if (!active || rotating || !profiling) return;
    rotating = true;
    try {
      const now = performance.now();
      const { profile } = await session.post("Profiler.stop");
      if (delayMs > 500 || now - started > 61_000) {
        const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
        const parents = new Map<number, number>();
        for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
        const weights = new Map<number, number>();
        let maxSamplingGapUs = 0;
        for (const [index, node] of (profile.samples ?? []).entries()) {
          const delta = profile.timeDeltas?.[index] ?? 0;
          weights.set(node, (weights.get(node) ?? 0) + delta);
          maxSamplingGapUs = Math.max(maxSamplingGapUs, delta);
        }
        const top = [...weights].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, us]) => {
          const stack = [];
          let nodeId: number | undefined = id;
          while (nodeId !== undefined && stack.length < 20) {
            const frame = nodes.get(nodeId)?.callFrame;
            if (frame) stack.push({
              function: frame.functionName.slice(0, 200),
              source: frame.url.startsWith("file:///app/") || frame.url.startsWith("node:") ? frame.url : "[external]",
              line: frame.lineNumber + 1,
            });
            nodeId = parents.get(nodeId);
          }
          return { sampledMs: Math.round(us / 1_000), stack };
        });
        console.warn("server stall profile", JSON.stringify({
          intervalMs: Math.round(now - started), timerDelayMs: delayMs || Math.round(now - started - 60_000),
          maxSamplingGapMs: Math.round(maxSamplingGapUs / 1_000), top,
        }));
      }
      if (active) {
        await session.post("Profiler.start");
        started = performance.now();
      }
    } catch (error) {
      if (active) console.warn("server stall profiling stopped", { message: error instanceof Error ? error.message : "Inspector unavailable" });
      stop();
    } finally {
      rotating = false;
    }
  };
  void (async () => {
    try {
      session.connect();
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: 20_000 });
      await session.post("Profiler.start");
      if (!active) return;
      profiling = true;
      started = performance.now();
      timer = setInterval(() => void rotate(), 60_000).unref();
    } catch (error) {
      if (active) console.warn("server stall profiling unavailable", { message: error instanceof Error ? error.message : "Inspector unavailable" });
      stop();
    }
  })();
  return { capture: (delayMs: number) => void rotate(delayMs), stop };
}
