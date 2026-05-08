const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const forwardedArgs = [];
const testTargets = [];

for (const arg of process.argv.slice(2)) {
  if (arg === "--runInBand") {
    continue;
  }
  if (arg.startsWith("-")) {
    forwardedArgs.push(arg);
    continue;
  }
  testTargets.push(arg);
}

function expandTestTarget(target) {
  if (target === "test/unit" || target === "test/integration") {
    return expandTestTarget(`${target}/*.test.js`);
  }

  if (!target.endsWith("/*.test.js")) {
    return [target];
  }

  const dir = target.slice(0, -"/*.test.js".length);
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".test.js"))
    .sort()
    .map((entry) => path.join(dir, entry));
}

const effectiveTargets = (testTargets.length > 0 ? testTargets : ["test/unit/*.test.js"])
  .flatMap(expandTestTarget);
const nodeArgs = ["--test", ...forwardedArgs, ...effectiveTargets];

const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
