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
  ensureCorpusIndex,
  AGENT_INDEX_FILENAME
} = require("../../src/tools/corpus/indexer.ts");

let workspace;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "corpus-boot-"));
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

function createCountingAdapter() {
  let invocations = 0;
  return {
    get invocations() {
      return invocations;
    },
    adapter: {
      name: "counting-stub",
      async *stream() {
        invocations += 1;
        yield { type: "text-delta", delta: { text: "summary" } };
        yield { type: "done" };
      }
    }
  };
}

test("ensureCorpusIndex: builds and writes agent.md when it is missing", async () => {
  const corpus = path.join(workspace, "missing-agent");
  await fsp.mkdir(corpus, { recursive: true });
  await fsp.writeFile(path.join(corpus, "a.md"), "# A");
  await fsp.writeFile(path.join(corpus, "b.md"), "# B");

  const counter = createCountingAdapter();

  const result = await ensureCorpusIndex({ corpus_root: corpus, model_adapter: counter.adapter });

  assert.equal(result.regenerated, true);
  assert.equal(counter.invocations, 2);
  const indexPath = path.join(corpus, AGENT_INDEX_FILENAME);
  const stat = await fsp.stat(indexPath);
  assert.ok(stat.isFile());
});

test("ensureCorpusIndex: skips regeneration when agent.md is fresh", async () => {
  const corpus = path.join(workspace, "fresh-agent");
  await fsp.mkdir(corpus, { recursive: true });
  const sourcePath = path.join(corpus, "a.md");
  const indexPath = path.join(corpus, AGENT_INDEX_FILENAME);

  await fsp.writeFile(sourcePath, "# A");
  await fsp.writeFile(indexPath, "# Document Index\n\nFiles: 1\n");
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  await fsp.utimes(sourcePath, past, past);
  await fsp.utimes(indexPath, future, future);

  const counter = createCountingAdapter();

  const result = await ensureCorpusIndex({ corpus_root: corpus, model_adapter: counter.adapter });

  assert.equal(result.regenerated, false);
  assert.equal(counter.invocations, 0);
});

test("ensureCorpusIndex: rejects when corpus folder is missing", async () => {
  const counter = createCountingAdapter();

  await assert.rejects(
    () =>
      ensureCorpusIndex({
        corpus_root: path.join(workspace, "no-such-folder"),
        model_adapter: counter.adapter
      }),
    /corpus folder/i
  );
  assert.equal(counter.invocations, 0);
});
