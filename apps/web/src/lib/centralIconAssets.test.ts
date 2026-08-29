import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectReferencedCentralIcons } from "../../vite.config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("central icon asset collection", () => {
  it("keeps only source-referenced icons from both variants", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-central-icons-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "icons.tsx"), 'const icon = "used";\n');
    for (const variant of ["reversed", "fill"]) {
      const directory = path.join(root, "public", `central-icons-${variant}`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "used.svg"), "<svg />");
      await fs.writeFile(path.join(directory, "unused.svg"), "<svg />");
    }

    const icons = await collectReferencedCentralIcons(root);

    expect(icons.reversed).toEqual(["used"]);
    expect(icons.fill).toEqual(["used"]);
  });
});
