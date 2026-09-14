// check-dist.mjs — ECOv6 close-out (from plans/dist-hygiene.md).
// Fails when the committed dist bundle is stale relative to src/.
//
// What it does:
//   1. Runs the root's build script (scripts/build.mjs) so dist/ reflects src/.
//   2. `git diff --exit-code -- dist/toolscan.mjs` — a non-empty diff means the
//      index (last committed bundle) differs from the fresh rebuild, i.e. the
//      committed dist was stale (the 50b5c9f incident).
//
// Usage: node scripts/check-dist.mjs [--root <dir>]   (default: process.cwd())
// Exit 0 = dist fresh. Exit 1 = stale (or build failed). Exit 2 = usage/actor error.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf("--root");
const root = rootIdx >= 0 ? resolve(argv[rootIdx + 1]) : process.cwd();

const buildScript = resolve(root, "scripts/build.mjs");
const distFile = "dist/toolscan.mjs";
if (!existsSync(buildScript)) {
  console.error(`check-dist: no build script at ${buildScript}`);
  process.exit(2);
}

const build = spawnSync(process.execPath, [buildScript], { cwd: root, stdio: "inherit" });
if (build.status !== 0) {
  console.error("check-dist: build failed — cannot verify dist freshness");
  process.exit(1);
}

const diff = spawnSync("git", ["diff", "--exit-code", "--", distFile], {
  cwd: root,
  encoding: "utf8",
});
if (diff.status === 0) {
  console.log("check-dist: OK — committed dist matches a fresh rebuild");
  process.exit(0);
}
console.error(
  `check-dist: STALE — committed ${distFile} differs from a fresh rebuild.\n` +
    "Run `npm run build` and commit dist/ before pushing (see plans/dist-hygiene.md)."
);
if (diff.stdout) console.error(diff.stdout);
process.exit(1);
