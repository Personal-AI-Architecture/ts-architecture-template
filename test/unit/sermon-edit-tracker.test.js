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

const { createEditTracker } = require("../../src/tools/sermon/edit-tracker.ts");

test("createEditTracker: empty by default", () => {
  const tracker = createEditTracker();
  assert.deepEqual(tracker.sectionsEditedAheadOfAi("any-slug"), []);
});

test("createEditTracker: user edit ahead of AI write surfaces in the list", async () => {
  const tracker = createEditTracker();
  tracker.recordAiWrite("acts-kingdom-focus", "topic");
  // Tiny delay so timestamps differ.
  await new Promise((resolve) => setTimeout(resolve, 5));
  tracker.recordUserEdit("acts-kingdom-focus", "topic");
  assert.deepEqual(tracker.sectionsEditedAheadOfAi("acts-kingdom-focus"), ["topic"]);
});

test("createEditTracker: AI write after user edit clears the section from the ahead list", async () => {
  const tracker = createEditTracker();
  tracker.recordAiWrite("acts-kingdom-focus", "topic");
  await new Promise((resolve) => setTimeout(resolve, 5));
  tracker.recordUserEdit("acts-kingdom-focus", "topic");
  await new Promise((resolve) => setTimeout(resolve, 5));
  tracker.recordAiWrite("acts-kingdom-focus", "topic");
  assert.deepEqual(tracker.sectionsEditedAheadOfAi("acts-kingdom-focus"), []);
});

test("createEditTracker: multiple sections tracked independently per sermon", async () => {
  const tracker = createEditTracker();
  tracker.recordAiWrite("acts-kingdom-focus", "topic");
  tracker.recordAiWrite("acts-kingdom-focus", "big_idea");
  await new Promise((resolve) => setTimeout(resolve, 5));
  tracker.recordUserEdit("acts-kingdom-focus", "topic");
  // big_idea was NOT user-edited
  const ahead = tracker.sectionsEditedAheadOfAi("acts-kingdom-focus");
  assert.deepEqual(ahead.sort(), ["topic"]);
});

test("createEditTracker: per-sermon isolation", async () => {
  const tracker = createEditTracker();
  tracker.recordAiWrite("sermon-a", "topic");
  await new Promise((resolve) => setTimeout(resolve, 5));
  tracker.recordUserEdit("sermon-b", "topic");
  // sermon-a has AI write, no user edit; sermon-b has user edit, no AI write
  assert.deepEqual(tracker.sectionsEditedAheadOfAi("sermon-a"), []);
  assert.deepEqual(tracker.sectionsEditedAheadOfAi("sermon-b"), ["topic"]);
});

test("createEditTracker: user edit without prior AI write also surfaces", () => {
  const tracker = createEditTracker();
  tracker.recordUserEdit("acts-kingdom-focus", "notes");
  assert.deepEqual(tracker.sectionsEditedAheadOfAi("acts-kingdom-focus"), ["notes"]);
});
