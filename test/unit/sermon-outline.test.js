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
  OUTLINE_SECTIONS,
  OUTLINE_FILENAME,
  scaffoldOutline,
  parseOutlineSections,
  replaceOutlineSection,
  writeOutlineAtomic,
  readOutline,
  createUpdateOutlineSectionTool,
  createReadOutlineTool,
  UPDATE_OUTLINE_SECTION_TOOL_NAME,
  READ_OUTLINE_TOOL_NAME,
  SERMON_TOOL_SOURCE
} = require("../../src/tools/sermon/outline.ts");

let workspace;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "sermon-outline-"));
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

async function freshSermon(name) {
  const dir = path.join(workspace, name);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test("OUTLINE_SECTIONS exposes the closed allowlist with the documented vocabulary", () => {
  const expected = [
    "topic",
    "big_idea",
    "anchor_scripture",
    "point_1",
    "point_2",
    "point_3",
    "conclusion",
    "call_to_response",
    "notes"
  ];
  assert.deepEqual([...OUTLINE_SECTIONS], expected);
});

test("scaffoldOutline writes a markdown file with one ## heading per allowlisted section", async () => {
  const sermon = await freshSermon("scaffold-empty");
  await scaffoldOutline(sermon);
  const stored = await fsp.readFile(path.join(sermon, OUTLINE_FILENAME), "utf8");
  assert.match(stored, /^# /);
  for (const section of OUTLINE_SECTIONS) {
    assert.match(stored, new RegExp(`^## ${section}$`, "m"), `missing section ${section}`);
  }
});

test("scaffoldOutline does not overwrite an existing outline.md", async () => {
  const sermon = await freshSermon("scaffold-existing");
  const outlinePath = path.join(sermon, OUTLINE_FILENAME);
  await fsp.writeFile(outlinePath, "# Existing\n\n## topic\n\nsomething\n");
  await scaffoldOutline(sermon);
  const stored = await fsp.readFile(outlinePath, "utf8");
  assert.match(stored, /Existing/);
  assert.match(stored, /something/);
});

test("parseOutlineSections returns a Record<section, body>", async () => {
  const sermon = await freshSermon("parse");
  await scaffoldOutline(sermon);
  const outlinePath = path.join(sermon, OUTLINE_FILENAME);
  let body = await fsp.readFile(outlinePath, "utf8");
  body = body.replace(
    /## topic\n\n/,
    "## topic\n\nSaying yes to God: what it costs and what it gives.\n"
  );
  body = body.replace(/## big_idea\n\n/, "## big_idea\n\nObedience over comfort.\n");
  await fsp.writeFile(outlinePath, body);

  const parsed = await parseOutlineSections(sermon);
  assert.equal(typeof parsed.topic, "string");
  assert.match(parsed.topic, /Saying yes to God/);
  assert.match(parsed.big_idea, /Obedience over comfort/);
  for (const section of OUTLINE_SECTIONS) {
    assert.ok(section in parsed, `missing key ${section}`);
  }
});

test("replaceOutlineSection replaces only the named section", async () => {
  const sermon = await freshSermon("replace");
  await scaffoldOutline(sermon);
  await replaceOutlineSection(sermon, "topic", "Topic content here.");
  await replaceOutlineSection(sermon, "big_idea", "Big idea content.");
  const parsed = await parseOutlineSections(sermon);
  assert.equal(parsed.topic, "Topic content here.");
  assert.equal(parsed.big_idea, "Big idea content.");
  assert.equal(parsed.point_1, "");
});

test("replaceOutlineSection rejects unknown section names with classified error", async () => {
  const sermon = await freshSermon("replace-unknown");
  await scaffoldOutline(sermon);
  await assert.rejects(
    () => replaceOutlineSection(sermon, "evil_section", "never"),
    /unknown section|not in allowlist/i
  );
});

test("replaceOutlineSection rejects path-shaped section names", async () => {
  const sermon = await freshSermon("replace-path");
  await scaffoldOutline(sermon);
  for (const evil of ["../escape", "topic/extra", "..", ".git"]) {
    await assert.rejects(
      () => replaceOutlineSection(sermon, evil, "never"),
      /unknown section|not in allowlist/i
    );
  }
});

test("writeOutlineAtomic uses temp + rename and is recoverable on failure", async () => {
  const sermon = await freshSermon("atomic");
  await scaffoldOutline(sermon);
  await writeOutlineAtomic(sermon, "# Replaced\n\nbody\n");
  const stored = await fsp.readFile(path.join(sermon, OUTLINE_FILENAME), "utf8");
  assert.equal(stored, "# Replaced\n\nbody\n");

  // Failure injection: stub rename to throw, prior outline must remain
  const realRename = fsp.rename;
  try {
    fsp.rename = async () => {
      throw new Error("simulated rename failure");
    };
    await assert.rejects(
      () => writeOutlineAtomic(sermon, "should not land"),
      /simulated rename failure/
    );
  } finally {
    fsp.rename = realRename;
  }
  const after = await fsp.readFile(path.join(sermon, OUTLINE_FILENAME), "utf8");
  assert.equal(after, "# Replaced\n\nbody\n");
  // tmp file must be cleaned up
  const entries = await fsp.readdir(sermon);
  assert.deepEqual(
    entries.filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("readOutline returns the current contents of outline.md", async () => {
  const sermon = await freshSermon("read");
  await scaffoldOutline(sermon);
  await replaceOutlineSection(sermon, "topic", "topic body");
  const text = await readOutline(sermon);
  assert.match(text, /## topic\n\ntopic body/);
});

test("readOutline returns an empty placeholder when outline.md is missing", async () => {
  const sermon = await freshSermon("read-missing");
  const text = await readOutline(sermon);
  assert.match(text, /not yet/i);
});

test("update_outline_section: tool definition declares mutates_state and source", () => {
  const { definition } = createUpdateOutlineSectionTool({ sermon_root: workspace });
  assert.equal(definition.function.name, UPDATE_OUTLINE_SECTION_TOOL_NAME);
  assert.equal(definition.source, SERMON_TOOL_SOURCE);
  assert.equal(definition.mutates_state, true);
  assert.equal(definition.type, "function");
  assert.deepEqual(definition.function.parameters.required, ["sermon", "section", "content"]);
});

test("update_outline_section handler rejects unknown sermon slug shapes", async () => {
  const sermon = await freshSermon("handler-bad-slug");
  const { handler } = createUpdateOutlineSectionTool({ sermon_root: workspace });
  for (const slug of ["", "../escape", "/abs/path", "with spaces", "..", "."]) {
    await assert.rejects(
      () => handler({ sermon: slug, section: "topic", content: "x" }),
      /sermon|slug/i,
      `expected reject for slug "${slug}"`
    );
  }
  // sanity: a valid slug is accepted
  const validSlug = path.basename(sermon);
  await scaffoldOutline(sermon);
  const result = await handler({ sermon: validSlug, section: "topic", content: "ok" });
  assert.equal(result.ok, true);
  assert.equal(result.section, "topic");
});

test("update_outline_section handler rejects unknown section names with classified error", async () => {
  const sermon = await freshSermon("handler-bad-section");
  await scaffoldOutline(sermon);
  const { handler } = createUpdateOutlineSectionTool({ sermon_root: workspace });
  await assert.rejects(
    () => handler({ sermon: path.basename(sermon), section: "evil", content: "x" }),
    /unknown section/i
  );
});

test("update_outline_section handler accepts every allowed section name", async () => {
  const sermon = await freshSermon("handler-all-sections");
  await scaffoldOutline(sermon);
  const { handler } = createUpdateOutlineSectionTool({ sermon_root: workspace });
  for (const section of OUTLINE_SECTIONS) {
    const result = await handler({
      sermon: path.basename(sermon),
      section,
      content: `${section} content`
    });
    assert.equal(result.ok, true);
    assert.equal(result.section, section);
  }
  const parsed = await parseOutlineSections(sermon);
  for (const section of OUTLINE_SECTIONS) {
    assert.equal(parsed[section], `${section} content`);
  }
});

test("read_outline: tool definition is read-only", () => {
  const { definition } = createReadOutlineTool({ sermon_root: workspace });
  assert.equal(definition.function.name, READ_OUTLINE_TOOL_NAME);
  assert.equal(definition.source, SERMON_TOOL_SOURCE);
  assert.equal(definition.mutates_state, false);
});

test("read_outline handler returns current outline content for the named sermon", async () => {
  const sermon = await freshSermon("read-handler");
  await scaffoldOutline(sermon);
  await replaceOutlineSection(sermon, "topic", "topic content");
  const { handler } = createReadOutlineTool({ sermon_root: workspace });
  const result = await handler({ sermon: path.basename(sermon) });
  assert.equal(result.ok, true);
  assert.match(result.content, /topic content/);
});

test("update_outline_section: 7 parallel writes to the same sermon all land (no race-induced losses)", async () => {
  // Regression for ENOENT bug: Claude can emit many tool calls in one turn.
  // All parallel writes must complete and every distinct section must be persisted.
  const sermon = await freshSermon("parallel-writes");
  await scaffoldOutline(sermon);
  const { handler } = createUpdateOutlineSectionTool({ sermon_root: workspace });
  const slug = path.basename(sermon);

  const targetSections = [
    "topic",
    "big_idea",
    "anchor_scripture",
    "point_1",
    "point_2",
    "point_3",
    "conclusion"
  ];

  const results = await Promise.all(
    targetSections.map((section) =>
      handler({ sermon: slug, section, content: `${section} content` })
    )
  );

  for (const result of results) {
    assert.equal(result.ok, true);
  }

  const parsed = await parseOutlineSections(sermon);
  for (const section of targetSections) {
    assert.equal(parsed[section], `${section} content`, `${section} should be persisted`);
  }
});

test("update_outline_section: 20 parallel writes to different sections all land", async () => {
  // Stress test: 20 concurrent calls hit the per-directory mutex.
  // We only have 9 distinct sections so there will be repeats — last write of each section wins.
  const sermon = await freshSermon("stress-writes");
  await scaffoldOutline(sermon);
  const { handler } = createUpdateOutlineSectionTool({ sermon_root: workspace });
  const slug = path.basename(sermon);

  const calls = [];
  for (let i = 0; i < 20; i += 1) {
    const section = ["topic", "big_idea", "anchor_scripture", "point_1", "point_2", "point_3", "conclusion", "call_to_response", "notes"][i % 9];
    calls.push(handler({ sermon: slug, section, content: `${section}-${i}` }));
  }

  const results = await Promise.all(calls);
  for (const result of results) {
    assert.equal(result.ok, true);
  }

  const parsed = await parseOutlineSections(sermon);
  // Every section that was touched at least once must be non-empty.
  for (const section of ["topic", "big_idea", "anchor_scripture", "point_1", "point_2", "point_3", "conclusion", "call_to_response", "notes"]) {
    assert.notEqual(parsed[section], "", `${section} should be non-empty after stress test`);
  }
});

test("update_outline_section: parallel writes do not leave .tmp files behind", async () => {
  const sermon = await freshSermon("no-tmp-leftovers");
  await scaffoldOutline(sermon);
  const { handler } = createUpdateOutlineSectionTool({ sermon_root: workspace });
  const slug = path.basename(sermon);

  await Promise.all(
    ["topic", "big_idea", "anchor_scripture", "point_1", "point_2", "point_3"].map((section) =>
      handler({ sermon: slug, section, content: `${section} content` })
    )
  );

  const entries = await fsp.readdir(sermon);
  const tmpFiles = entries.filter((name) => name.endsWith(".tmp") || name.includes(".tmp."));
  assert.deepEqual(tmpFiles, [], `expected no .tmp files, found: ${tmpFiles.join(", ")}`);
});
