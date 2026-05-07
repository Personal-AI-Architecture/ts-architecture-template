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

const { scaffoldOutline, replaceOutlineSection } = require("../../src/tools/sermon/outline.ts");
const { assembleSermonSystemPrompt } = require("../../src/tools/sermon/system-prompt.ts");

let workspace;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "sermon-prompt-"));
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("assembleSermonSystemPrompt includes the 6-stage workflow rules", async () => {
  const sermonRoot = path.join(workspace, "case-1");
  const sermonSlug = "test-sermon";
  await fsp.mkdir(path.join(sermonRoot, sermonSlug), { recursive: true });
  await scaffoldOutline(path.join(sermonRoot, sermonSlug));

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });

  // Workflow rules
  assert.match(prompt, /6.?stage|six.?stage/i);
  assert.match(prompt, /topic/i);
  assert.match(prompt, /anchor scripture/i);
  assert.match(prompt, /illustration/i);
  assert.match(prompt, /transition/i);
  assert.match(prompt, /landing|conclusion/i);
  // Voice rules
  assert.match(prompt, /thought partner/i);
  assert.match(prompt, /never fabricate|do not fabricate|do not invent/i);
  // BSB rule
  assert.match(prompt, /BSB|Berean Standard Bible/);
});

test("assembleSermonSystemPrompt loads congregation.md when present", async () => {
  const sermonRoot = path.join(workspace, "case-2");
  const sermonSlug = "test-sermon";
  await fsp.mkdir(path.join(sermonRoot, sermonSlug), { recursive: true });
  await scaffoldOutline(path.join(sermonRoot, sermonSlug));
  await fsp.writeFile(
    path.join(sermonRoot, "congregation.md"),
    "# Cranford NJ\n\nSuburban, mixed working/professional, average age 45."
  );

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });
  assert.match(prompt, /Cranford NJ/);
  assert.match(prompt, /Suburban/);
});

test("assembleSermonSystemPrompt notes a placeholder when congregation.md is missing", async () => {
  const sermonRoot = path.join(workspace, "case-3");
  const sermonSlug = "test-sermon";
  await fsp.mkdir(path.join(sermonRoot, sermonSlug), { recursive: true });
  await scaffoldOutline(path.join(sermonRoot, sermonSlug));

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });
  assert.match(prompt, /congregation.*not.*provided|congregation.*missing|congregation.md/i);
});

test("assembleSermonSystemPrompt loads voice.md when present", async () => {
  const sermonRoot = path.join(workspace, "case-4");
  const sermonSlug = "test-sermon";
  await fsp.mkdir(path.join(sermonRoot, sermonSlug), { recursive: true });
  await scaffoldOutline(path.join(sermonRoot, sermonSlug));
  await fsp.writeFile(
    path.join(sermonRoot, "voice.md"),
    "Phrases I use:\n- 'lean in'\n- 'God's not done with you yet'\n"
  );

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });
  assert.match(prompt, /lean in/);
  assert.match(prompt, /God's not done/);
});

test("assembleSermonSystemPrompt silently skips voice.md when missing (no scary placeholder)", async () => {
  const sermonRoot = path.join(workspace, "case-5");
  const sermonSlug = "test-sermon";
  await fsp.mkdir(path.join(sermonRoot, sermonSlug), { recursive: true });
  await scaffoldOutline(path.join(sermonRoot, sermonSlug));

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });
  // We don't want the prompt to scream about missing voice — it's optional
  assert.doesNotMatch(prompt, /voice.md.*missing|voice.md.*not found/i);
});

test("assembleSermonSystemPrompt embeds the current outline contents", async () => {
  const sermonRoot = path.join(workspace, "case-6");
  const sermonSlug = "test-sermon";
  const sermonDir = path.join(sermonRoot, sermonSlug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);
  await replaceOutlineSection(sermonDir, "topic", "Saying yes to God");
  await replaceOutlineSection(sermonDir, "big_idea", "Obedience over comfort");

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });
  assert.match(prompt, /Saying yes to God/);
  assert.match(prompt, /Obedience over comfort/);
});

test("assembleSermonSystemPrompt re-reads files fresh per call (external edits picked up)", async () => {
  const sermonRoot = path.join(workspace, "case-7");
  const sermonSlug = "test-sermon";
  const sermonDir = path.join(sermonRoot, sermonSlug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);
  await fsp.writeFile(path.join(sermonRoot, "congregation.md"), "v1 congregation");

  const first = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });
  assert.match(first, /v1 congregation/);

  await fsp.writeFile(path.join(sermonRoot, "congregation.md"), "v2 congregation");
  const second = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });
  assert.match(second, /v2 congregation/);
  assert.doesNotMatch(second, /v1 congregation/);
});

test("assembleSermonSystemPrompt names the active sermon slug explicitly so the model can't invent its own", async () => {
  const sermonRoot = path.join(workspace, "case-active-slug");
  const sermonSlug = "acts-kingdom-focus";
  await fsp.mkdir(path.join(sermonRoot, sermonSlug), { recursive: true });
  await scaffoldOutline(path.join(sermonRoot, sermonSlug));

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug
  });

  // The active slug must appear in the prompt as a fixed instruction, not just an example.
  // Match: a line that quotes the slug AND mentions passing it / using it for tool calls.
  const slugMentions = prompt.match(/acts-kingdom-focus/g);
  assert.ok(slugMentions && slugMentions.length >= 1, "active slug must appear in prompt");
  assert.match(prompt, /sermon.*['"]acts-kingdom-focus['"]|active sermon|sermon slug/i);
});

test("assembleSermonSystemPrompt rejects path-shaped sermon slugs", async () => {
  const sermonRoot = path.join(workspace, "case-8");
  await fsp.mkdir(sermonRoot, { recursive: true });
  for (const slug of ["", "../escape", "/abs", "with spaces", ".."]) {
    await assert.rejects(
      () => assembleSermonSystemPrompt({ sermon_root: sermonRoot, sermon_slug: slug }),
      /sermon|slug/i,
      `expected reject for slug "${slug}"`
    );
  }
});
