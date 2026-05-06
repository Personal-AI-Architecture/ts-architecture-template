const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");
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
  isIndexStale,
  buildIndex,
  writeIndexAtomic,
  truncateSummary,
  AGENT_INDEX_FILENAME,
  SUMMARY_MAX_CHARS
} = require("../../src/tools/corpus/indexer.ts");

let workspace;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "corpus-indexer-"));
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

async function freshCorpus(name) {
  const dir = path.join(workspace, name);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function setMtime(file, mtime) {
  await fsp.utimes(file, mtime, mtime);
}

test("isIndexStale: missing agent.md is stale", async () => {
  const corpus = await freshCorpus("missing-index");
  await fsp.writeFile(path.join(corpus, "a.md"), "# A");

  const stale = await isIndexStale(corpus);
  assert.equal(stale, true);
});

test("isIndexStale: agent.md older than any source file is stale", async () => {
  const corpus = await freshCorpus("older-index");
  const indexPath = path.join(corpus, AGENT_INDEX_FILENAME);
  const sourcePath = path.join(corpus, "a.md");

  await fsp.writeFile(indexPath, "# Document Index");
  await fsp.writeFile(sourcePath, "# A");

  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  await setMtime(indexPath, past);
  await setMtime(sourcePath, future);

  const stale = await isIndexStale(corpus);
  assert.equal(stale, true);
});

test("isIndexStale: agent.md newer than every source file is fresh", async () => {
  const corpus = await freshCorpus("fresh-index");
  const indexPath = path.join(corpus, AGENT_INDEX_FILENAME);
  const sourcePath = path.join(corpus, "a.md");

  await fsp.writeFile(sourcePath, "# A");
  await fsp.writeFile(indexPath, "# Document Index");

  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  await setMtime(sourcePath, past);
  await setMtime(indexPath, future);

  const stale = await isIndexStale(corpus);
  assert.equal(stale, false);
});

test("isIndexStale: empty folder with no markdown but agent.md present is fresh", async () => {
  const corpus = await freshCorpus("empty-with-index");
  await fsp.writeFile(path.join(corpus, AGENT_INDEX_FILENAME), "# Document Index\n\nFiles: 0\n");
  const stale = await isIndexStale(corpus);
  assert.equal(stale, false);
});

test("isIndexStale: empty folder with no agent.md is stale", async () => {
  const corpus = await freshCorpus("empty-without-index");
  const stale = await isIndexStale(corpus);
  assert.equal(stale, true);
});

test("isIndexStale: missing folder rejects", async () => {
  await assert.rejects(
    () => isIndexStale(path.join(workspace, "no-such-folder")),
    /corpus folder/i
  );
});

test("isIndexStale: ignores non-md files when computing freshness", async () => {
  const corpus = await freshCorpus("mixed-files");
  const indexPath = path.join(corpus, AGENT_INDEX_FILENAME);
  await fsp.writeFile(path.join(corpus, "ignored.png"), "binary");
  await fsp.writeFile(path.join(corpus, "a.md"), "# A");
  await fsp.writeFile(indexPath, "# Document Index");

  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  await setMtime(path.join(corpus, "a.md"), past);
  await setMtime(path.join(corpus, "ignored.png"), future);
  await setMtime(indexPath, new Date(Date.now() - 30_000));

  const stale = await isIndexStale(corpus);
  assert.equal(stale, false);
});

test("buildIndex: produces one ## section per markdown file with summaries from the model", async () => {
  const corpus = await freshCorpus("build-three");
  await fsp.writeFile(path.join(corpus, "alpha.md"), "# Alpha\n\nFirst note.");
  await fsp.writeFile(path.join(corpus, "beta.md"), "# Beta\n\nSecond note.");
  await fsp.writeFile(path.join(corpus, "gamma.md"), "# Gamma\n\nThird note.");

  const stubAdapter = {
    name: "stub-summary",
    async *stream(request) {
      const lastUserMessage = request.messages[request.messages.length - 1].content;
      const fileNameMatch = /file:\s*(\S+)/.exec(lastUserMessage);
      const tag = fileNameMatch ? fileNameMatch[1] : "unknown";
      yield { type: "text-delta", delta: { text: `Summary of ${tag}.` } };
      yield { type: "done" };
    }
  };

  const content = await buildIndex({ corpus_root: corpus, model_adapter: stubAdapter });

  assert.match(content, /^# Document Index/);
  assert.match(content, /Files: 3/);
  assert.match(content, /## alpha\.md/);
  assert.match(content, /## beta\.md/);
  assert.match(content, /## gamma\.md/);
  assert.match(content, /Summary of alpha\.md\./);
  assert.match(content, /Summary of beta\.md\./);
  assert.match(content, /Summary of gamma\.md\./);
});

test("buildIndex: excludes agent.md itself from enumeration", async () => {
  const corpus = await freshCorpus("excludes-self");
  await fsp.writeFile(path.join(corpus, AGENT_INDEX_FILENAME), "# Old index");
  await fsp.writeFile(path.join(corpus, "real.md"), "# Real\n");

  const stubAdapter = {
    name: "stub",
    async *stream() {
      yield { type: "text-delta", delta: { text: "ok." } };
      yield { type: "done" };
    }
  };

  const content = await buildIndex({ corpus_root: corpus, model_adapter: stubAdapter });
  assert.doesNotMatch(content, /## agent\.md/);
  assert.match(content, /## real\.md/);
});

test("buildIndex: empty corpus produces a valid index with Files: 0", async () => {
  const corpus = await freshCorpus("empty-build");
  const stubAdapter = {
    name: "stub",
    async *stream() {
      yield { type: "done" };
    }
  };

  const content = await buildIndex({ corpus_root: corpus, model_adapter: stubAdapter });
  assert.match(content, /Files: 0/);
});

test("writeIndexAtomic: writes content to agent.md via .tmp + rename", async () => {
  const corpus = await freshCorpus("atomic-write");
  await writeIndexAtomic(corpus, "# Document Index\n");
  const written = await fsp.readFile(path.join(corpus, AGENT_INDEX_FILENAME), "utf8");
  assert.equal(written, "# Document Index\n");
});

test("writeIndexAtomic: leaves prior agent.md intact when rename fails", async () => {
  const corpus = await freshCorpus("atomic-failure");
  const indexPath = path.join(corpus, AGENT_INDEX_FILENAME);
  await fsp.writeFile(indexPath, "PREVIOUS");

  const realRename = fsp.rename;
  let restored = false;
  try {
    fsp.rename = async () => {
      throw new Error("simulated rename failure");
    };
    await assert.rejects(
      () => writeIndexAtomic(corpus, "NEW"),
      /simulated rename failure/
    );
  } finally {
    fsp.rename = realRename;
    restored = true;
  }
  assert.equal(restored, true);
  const after = await fsp.readFile(indexPath, "utf8");
  assert.equal(after, "PREVIOUS");
});

test("truncateSummary: SUMMARY_MAX_CHARS is exported and is 240", () => {
  assert.equal(SUMMARY_MAX_CHARS, 240);
});

test("truncateSummary: short summary (≤ 240 chars) passes through unchanged", () => {
  const short = "Notes on the four-component architecture: Memory, Engine, Auth, Gateway.";
  assert.ok(short.length <= SUMMARY_MAX_CHARS);
  assert.equal(truncateSummary(short), short);
});

test("truncateSummary: empty/whitespace-only input returns empty string", () => {
  assert.equal(truncateSummary(""), "");
  assert.equal(truncateSummary("   \n  "), "");
});

test("truncateSummary: 1000-char input is truncated to ≤ 240 chars with trailing ellipsis", () => {
  const long = "lorem ipsum ".repeat(100); // ~1200 chars
  const result = truncateSummary(long);
  assert.ok(result.length <= SUMMARY_MAX_CHARS, `got length ${result.length}`);
  assert.ok(result.endsWith("…"), `expected trailing ellipsis, got: ${result}`);
});

test("truncateSummary: input exactly at the boundary is unchanged", () => {
  const exact = "x".repeat(SUMMARY_MAX_CHARS);
  const result = truncateSummary(exact);
  assert.equal(result, exact);
  assert.equal(result.endsWith("…"), false);
});

test("truncateSummary: input one over the boundary is truncated and ends with ellipsis", () => {
  const overBy1 = "x".repeat(SUMMARY_MAX_CHARS + 1);
  const result = truncateSummary(overBy1);
  assert.ok(result.length <= SUMMARY_MAX_CHARS);
  assert.ok(result.endsWith("…"));
});

test("buildIndex: per-file summaries are capped at SUMMARY_MAX_CHARS", async () => {
  const corpus = await freshCorpus("buildindex-cap");
  await fsp.writeFile(path.join(corpus, "a.md"), "# A");
  await fsp.writeFile(path.join(corpus, "b.md"), "# B");

  const verboseAdapter = {
    name: "verbose-stub",
    async *stream() {
      yield {
        type: "text-delta",
        delta: { text: "lorem ipsum dolor sit amet, ".repeat(40) } // far too long
      };
      yield { type: "done" };
    }
  };

  const content = await buildIndex({ corpus_root: corpus, model_adapter: verboseAdapter });

  // Parse out per-file summaries and verify each is ≤ SUMMARY_MAX_CHARS
  const fileSections = content.split(/\n## /g).slice(1); // first piece is the header
  for (const section of fileSections) {
    const lines = section.split("\n");
    const bodyLines = lines.slice(1).filter((line) => line.length > 0);
    const body = bodyLines.join(" ");
    assert.ok(body.length <= SUMMARY_MAX_CHARS, `summary too long (${body.length}): ${body}`);
  }
});

test("writeIndexAtomic: cleans up its tmp file when rename fails", async () => {
  const corpus = await freshCorpus("atomic-cleanup");
  const realRename = fsp.rename;
  try {
    fsp.rename = async () => {
      throw new Error("rename boom");
    };
    await assert.rejects(() => writeIndexAtomic(corpus, "anything"));
  } finally {
    fsp.rename = realRename;
  }
  const entries = await fsp.readdir(corpus);
  assert.deepEqual(entries.filter((name) => name.endsWith(".tmp")), []);
});
