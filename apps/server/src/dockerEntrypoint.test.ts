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
});
