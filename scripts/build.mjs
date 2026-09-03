// Bundle src/cli.ts (TypeScript + Effect) into a single zero-dependency
// dist/toolscan.mjs that `node dist/toolscan.mjs` can run directly — that is
// the artifact consumers (e.g. Ix's TOOLSCAN_PATH seam) actually spawn.
import { mkdirSync, chmodSync } from "node:fs";

import { build } from "esbuild";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/toolscan.mjs",
  banner: { js: "#!/usr/bin/env node" },
  // Effect ships a lot of surface; only what the scanner actually touches.
  treeShaking: true,
  legalComments: "none",
});

chmodSync("dist/toolscan.mjs", 0o755);
console.log("dist/toolscan.mjs written");