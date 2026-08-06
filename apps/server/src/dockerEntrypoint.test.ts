import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Railway Docker entrypoint", () => {
  it("accepts Railway private-network IPv6 and loopback IPv4 traffic", () => {
    const script = readFileSync(
      new URL("../../../docker-entrypoint.sh", import.meta.url),
      "utf8",
    );

    expect(script).toContain("TCP6-LISTEN:3773");
    expect(script).toContain("ipv6only=0");
    expect(script).toContain("TCP:127.0.0.1:3774");
  });

  it("initializes the mounted state directory before dropping root privileges", () => {
    const script = readFileSync(
      new URL("../../../docker-entrypoint.sh", import.meta.url),
      "utf8",
    );
    const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).not.toContain("\nUSER node\n");
    expect(script).toContain('if [ "$(id -u)" -eq 0 ]; then');
    expect(script).toContain("install -d -m 0700 -o node -g node /data/userdata");
    expect(script).toContain("/data/gitea-company-projects");
    expect(script).toContain("/data/worktrees");
    expect(script).toContain('exec /usr/sbin/runuser -u node -- "$0" "$@"');
  });
});
