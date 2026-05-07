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
  scaffoldOutline,
  parseOutlineSections,
  replaceOutlineSection
} = require("../../src/tools/sermon/outline.ts");
const { createOutlineRouteHandler } = require("../../src/tools/sermon/outline-route.ts");
const { createEditTracker } = require("../../src/tools/sermon/edit-tracker.ts");
const { assembleSermonSystemPrompt } = require("../../src/tools/sermon/system-prompt.ts");

let workspace;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "sermon-outline-edit-"));
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

async function freshSermonRoot(label) {
  const root = path.join(workspace, label);
  await fsp.mkdir(root, { recursive: true });
  return root;
}

test("PUT /outline/<slug>/<section>: replaces the named section atomically", async () => {
  const root = await freshSermonRoot("put-happy");
  const slug = "edit-sermon";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const tracker = createEditTracker();
  const handle = createOutlineRouteHandler({ sermon_root: root, edit_tracker: tracker });
  const response = await handle({
    method: "PUT",
    path: `/outline/${slug}/topic`,
    body: "Topic edited by the pastor."
  });

  assert.equal(response.status, 200);
  const parsed = await parseOutlineSections(sermonDir);
  assert.equal(parsed.topic, "Topic edited by the pastor.");
});

test("PUT /outline/<slug>/<section>: records the edit in the tracker", async () => {
  const root = await freshSermonRoot("put-tracker");
  const slug = "tracker-sermon";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const tracker = createEditTracker();
  const handle = createOutlineRouteHandler({ sermon_root: root, edit_tracker: tracker });
  await handle({
    method: "PUT",
    path: `/outline/${slug}/topic`,
    body: "edited"
  });
  assert.deepEqual(tracker.sectionsEditedAheadOfAi(slug), ["topic"]);
});

test("PUT /outline/<slug>/<section>: 400 for unknown section", async () => {
  const root = await freshSermonRoot("put-bad-section");
  const slug = "x";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const handle = createOutlineRouteHandler({ sermon_root: root });
  const response = await handle({
    method: "PUT",
    path: `/outline/${slug}/evil_section`,
    body: "x"
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /section/i);
});

test("PUT /outline/<slug>/<section>: 400 for invalid slug", async () => {
  const root = await freshSermonRoot("put-bad-slug");
  const handle = createOutlineRouteHandler({ sermon_root: root });
  for (const badSlug of ["..", "ABC", "with%20space"]) {
    const response = await handle({
      method: "PUT",
      path: `/outline/${badSlug}/topic`,
      body: "x"
    });
    assert.equal(response.status, 400, `expected 400 for slug "${badSlug}"`);
  }
});

test("PUT /outline/<slug>/<section>: 404 when sermon folder doesn't exist", async () => {
  const root = await freshSermonRoot("put-missing-sermon");
  const handle = createOutlineRouteHandler({ sermon_root: root });
  const response = await handle({
    method: "PUT",
    path: "/outline/no-such-sermon/topic",
    body: "x"
  });
  assert.equal(response.status, 404);
});

test("PUT /outline/<slug>/<section>: 400 when path doesn't include a section", async () => {
  const root = await freshSermonRoot("put-no-section");
  const slug = "x";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const handle = createOutlineRouteHandler({ sermon_root: root });
  const response = await handle({ method: "PUT", path: `/outline/${slug}`, body: "x" });
  assert.equal(response.status, 400);
});

test("PUT /outline/<slug>/<section>: 400 when body is missing or non-string", async () => {
  const root = await freshSermonRoot("put-missing-body");
  const slug = "x";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const handle = createOutlineRouteHandler({ sermon_root: root });
  const response = await handle({ method: "PUT", path: `/outline/${slug}/topic` });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /body|content/i);
});

test("GET /outline/<slug>/<section>: not a recognized GET shape — should fall through", async () => {
  // The GET surface is only /outline/<slug> (Phase 2). Adding a section to the GET path
  // is malformed; let it fall through (return null) so the gateway's 404 handler sees it.
  const root = await freshSermonRoot("get-with-section");
  const slug = "x";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const handle = createOutlineRouteHandler({ sermon_root: root });
  const response = await handle({ method: "GET", path: `/outline/${slug}/topic` });
  // GET with an extra segment was previously a 400 (Phase 2). That behavior stays.
  assert.equal(response.status, 400);
});

test("system prompt assembly: includes edit notice when tracker shows pending user edits", async () => {
  const root = await freshSermonRoot("prompt-with-edits");
  const slug = "edit-noticed";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const tracker = createEditTracker();
  tracker.recordAiWrite(slug, "topic");
  await new Promise((resolve) => setTimeout(resolve, 5));
  tracker.recordUserEdit(slug, "topic");

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: root,
    sermon_slug: slug,
    edit_tracker: tracker
  });

  assert.match(prompt, /pastor edited|user edited|since your last reply/i);
  assert.match(prompt, /\btopic\b/);
});

test("system prompt assembly: no edit notice when there are no pending user edits", async () => {
  const root = await freshSermonRoot("prompt-no-edits");
  const slug = "no-edits";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const tracker = createEditTracker();
  // AI wrote, then nothing else
  tracker.recordAiWrite(slug, "topic");

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: root,
    sermon_slug: slug,
    edit_tracker: tracker
  });

  assert.doesNotMatch(prompt, /pastor edited|since your last reply/i);
});

test("system prompt assembly: no edit notice when tracker is omitted (backward compat)", async () => {
  const root = await freshSermonRoot("prompt-no-tracker");
  const slug = "no-tracker";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);

  const prompt = await assembleSermonSystemPrompt({
    sermon_root: root,
    sermon_slug: slug
  });

  assert.doesNotMatch(prompt, /pastor edited|since your last reply/i);
});
