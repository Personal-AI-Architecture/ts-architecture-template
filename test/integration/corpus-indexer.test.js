const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
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

const {
  buildIndex,
  writeIndexAtomic,
  AGENT_INDEX_FILENAME
} = require("../../src/tools/corpus/indexer.ts");

let workspace;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "corpus-indexer-int-"));
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("buildIndex + writeIndexAtomic produces a parseable agent.md inside a corpus with a space in its name", async () => {
  const corpus = path.join(workspace, "BrainDrive Files");
  await fsp.mkdir(corpus, { recursive: true });
  await fsp.writeFile(path.join(corpus, "architecture.md"), "# Architecture\n\nFour-component PAA model.");
  await fsp.writeFile(path.join(corpus, "meeting.md"), "# Meeting 2026-04-02\n\nIndexer scope.");
  await fsp.writeFile(path.join(corpus, "ideas.md"), "# Ideas\n\nRandom thoughts.");

  const calls = [];
  const stubAdapter = {
    name: "summarizing-stub",
    async *stream(request) {
      const last = request.messages[request.messages.length - 1].content;
      const fileTag = /file:\s*(\S+)/.exec(last)?.[1] ?? "?";
      calls.push(fileTag);
      yield {
        type: "text-delta",
        delta: { text: `Summary of ${fileTag}: about ${fileTag.replace(/\.md$/, "")}.` }
      };
      yield { type: "done" };
    }
  };

  const indexContent = await buildIndex({ corpus_root: corpus, model_adapter: stubAdapter });
  await writeIndexAtomic(corpus, indexContent);

  const stored = await fsp.readFile(path.join(corpus, AGENT_INDEX_FILENAME), "utf8");

  assert.match(stored, /^# Document Index/);
  assert.match(stored, /Files: 3/);
  assert.match(stored, new RegExp(`Source: ${corpus.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
  assert.match(stored, /## architecture\.md/);
  assert.match(stored, /## meeting\.md/);
  assert.match(stored, /## ideas\.md/);
  assert.match(stored, /Summary of architecture\.md/);
  assert.match(stored, /Summary of meeting\.md/);
  assert.match(stored, /Summary of ideas\.md/);
  assert.deepEqual(calls.sort(), ["architecture.md", "ideas.md", "meeting.md"]);
});
