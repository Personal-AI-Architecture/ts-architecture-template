const { spawnSync } = require("node:child_process");

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

const effectiveTargets = testTargets.length > 0 ? testTargets : ["test/unit"];
const nodeArgs = ["--test", ...forwardedArgs, ...effectiveTargets];

const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
