import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const UI_DIRECTORY = path.resolve(import.meta.dirname, "components/ui");

describe("shared portal primitives", () => {
  it("route every Base UI portal through the Synara portal container", async () => {
    const files = await fs.readdir(UI_DIRECTORY);
    const portalFiles: string[] = [];
    const missingContainer: string[] = [];

    for (const file of files.filter((name) => name.endsWith(".tsx"))) {
      const source = await fs.readFile(path.join(UI_DIRECTORY, file), "utf8");
      if (!/(?:Primitive|Toast)\.Portal/.test(source)) continue;
      portalFiles.push(file);
      if (!source.includes("useSynaraPortalContainer")) missingContainer.push(file);
    }

    expect(portalFiles.sort()).toEqual([
      "alert-dialog.tsx",
      "autocomplete.tsx",
      "combobox.tsx",
      "command.tsx",
      "dialog.tsx",
      "menu.tsx",
      "popover.tsx",
      "preview-card.tsx",
      "select.tsx",
      "sheet.tsx",
      "toast.tsx",
      "tooltip.tsx",
    ]);
    expect(missingContainer).toEqual([]);
  });
});
