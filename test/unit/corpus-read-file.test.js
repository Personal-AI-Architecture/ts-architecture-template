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
  createReadFileTool,
  READ_FILE_TOOL_NAME,
  CORPUS_TOOL_SOURCE
} = require("../../src/tools/corpus/read-file.ts");

let workspace;
let corpus;
let outside;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "corpus-read-file-"));
  corpus = path.join(workspace, "corpus dir with space");
  outside = path.join(workspace, "outside");
  await fsp.mkdir(corpus, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(corpus, "note.md"), "# Note\nbody");
  await fsp.writeFile(path.join(corpus, "plain.txt"), "plain body");
  await fsp.writeFile(path.join(corpus, "secret.png"), "binary");
  await fsp.writeFile(path.join(outside, "leak.md"), "do not read");
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("read_file: tool definition advertises name, source, and read-only nature", () => {
  const { definition } = createReadFileTool({ corpus_root: corpus });
  assert.equal(definition.function.name, READ_FILE_TOOL_NAME);
  assert.equal(definition.source, CORPUS_TOOL_SOURCE);
  assert.equal(definition.mutates_state, false);
  assert.equal(definition.type, "function");
  assert.ok(definition.function.description.length > 0);
  assert.ok(definition.function.parameters && typeof definition.function.parameters === "object");
});

test("read_file: returns content for a relative path inside the corpus", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  const result = await handler({ path: "note.md" });
  assert.equal(result.ok, true);
  assert.equal(result.path, "note.md");
  assert.equal(result.content, "# Note\nbody");
});

test("read_file: returns content for an absolute path inside the corpus", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  const result = await handler({ path: path.join(corpus, "note.md") });
  assert.equal(result.ok, true);
  assert.equal(result.content, "# Note\nbody");
});

test("read_file: rejects '..' traversal that escapes the corpus", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  await assert.rejects(
    () => handler({ path: "../outside/leak.md" }),
    /outside the corpus/i
  );
});

test("read_file: rejects absolute paths outside the corpus", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  await assert.rejects(
    () => handler({ path: path.join(outside, "leak.md") }),
    /outside the corpus/i
  );
});

test("read_file: rejects symlinks pointing outside the corpus", async () => {
  const linkPath = path.join(corpus, "escape-link.md");
  try {
    await fsp.symlink(path.join(outside, "leak.md"), linkPath);
  } catch (error) {
    if (error && error.code === "EPERM") {
      return;
    }
    throw error;
  }

  const { handler } = createReadFileTool({ corpus_root: corpus });
  await assert.rejects(
    () => handler({ path: "escape-link.md" }),
    /outside the corpus/i
  );

  await fsp.unlink(linkPath);
});

test("read_file: rejects extensions outside the allowlist", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  await assert.rejects(
    () => handler({ path: "secret.png" }),
    /unsupported file type/i
  );
});

test("read_file: accepts .txt within the corpus", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  const result = await handler({ path: "plain.txt" });
  assert.equal(result.ok, true);
  assert.equal(result.content, "plain body");
});

test("read_file: rejects missing path argument", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  await assert.rejects(
    () => handler({}),
    /path/i
  );
});

test("read_file: rejects non-string path argument", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  await assert.rejects(
    () => handler({ path: 123 }),
    /path/i
  );
});

test("read_file: rejects nonexistent file with classified error", async () => {
  const { handler } = createReadFileTool({ corpus_root: corpus });
  await assert.rejects(
    () => handler({ path: "missing.md" }),
    /not found|no such file/i
  );
});
