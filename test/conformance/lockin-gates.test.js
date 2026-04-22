const assert = require("node:assert/strict");
const fs = require("node:fs");
const { after, test } = require("node:test");
const ts = require("typescript");

const previousTsLoader = require.extensions[".ts"];
require.extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: filename
  });
  module._compile(compiled.outputText, filename);
};

after(() => {
  if (previousTsLoader) {
    require.extensions[".ts"] = previousTsLoader;
    return;
  }
  delete require.extensions[".ts"];
});

const { runLockinCheck } = require("../../scripts/check-lockin.ts");
const { runContractCheck } = require("../../scripts/check-contracts.ts");
const { runImportBoundaryCheck } = require("../../scripts/check-imports.ts");

async function captureConsoleLogs(run) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };

  try {
    await run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

test("lock-in gate checklist executes and passes", async () => {
  const output = await captureConsoleLogs(async () => {
    const errors = await runLockinCheck();
    assert.deepEqual(errors, []);
  });

  assert.match(output, /\[PASS\] provider-swap/);
  assert.match(output, /\[PASS\] model-swap/);
  assert.match(output, /\[PASS\] tool-swap/);
});

test("contract and import conformance checks pass in-process", () => {
  const contractErrors = runContractCheck();
  assert.deepEqual(contractErrors, []);

  const importErrors = runImportBoundaryCheck();
  assert.deepEqual(importErrors, []);
});
