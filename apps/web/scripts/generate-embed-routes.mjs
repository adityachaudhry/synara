import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Use the generator version owned by the installed router plugin.
const require = createRequire(import.meta.resolve("@tanstack/router-plugin"));
const { Generator, getConfig } = require("@tanstack/router-generator");
const root = fileURLToPath(new URL("../", import.meta.url));
await new Generator({
  root,
  config: getConfig({ target: "react", autoCodeSplitting: true }, root),
}).run();
