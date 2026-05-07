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
  replaceOutlineSection
} = require("../../src/tools/sermon/outline.ts");
const {
  createOutlineRouteHandler,
  isOutlineRoutePath
} = require("../../src/tools/sermon/outline-route.ts");

let workspace;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "sermon-outline-route-"));
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

test("isOutlineRoutePath: matches /outline/<slug> and rejects everything else", () => {
  assert.equal(isOutlineRoutePath("/outline/test-sermon"), true);
  assert.equal(isOutlineRoutePath("/outline/abc-123"), true);
  assert.equal(isOutlineRoutePath("/outline"), true);
  assert.equal(isOutlineRoutePath("/outline/"), true);
  assert.equal(isOutlineRoutePath("/chat"), false);
  assert.equal(isOutlineRoutePath("/conversations/foo"), false);
  assert.equal(isOutlineRoutePath("/"), false);
  assert.equal(isOutlineRoutePath("/outline/test/extra"), true); // matched but should 400 in handler
});

test("outline route: returns 200 text/markdown for a valid slug with existing sermon", async () => {
  const root = await freshSermonRoot("happy-path");
  const slug = "happy-sermon";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);
  await replaceOutlineSection(sermonDir, "topic", "topic-from-disk");

  const handle = createOutlineRouteHandler({ sermon_root: root });
  const response = await handle({ method: "GET", path: `/outline/${slug}` });

  assert.ok(response, "handler should return a response for matching path");
  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/markdown/);
  assert.match(response.body, /topic-from-disk/);
});

test("outline route: returns null for non-/outline paths (lets next handler run)", async () => {
  const root = await freshSermonRoot("fallthrough");
  const handle = createOutlineRouteHandler({ sermon_root: root });

  for (const route of ["/chat", "/", "/conversations", "/outlines"]) {
    const response = await handle({ method: "GET", path: route });
    assert.equal(response, null, `expected fallthrough for ${route}`);
  }
});

test("outline route: returns null for unsupported methods on /outline (POST/DELETE fall through; GET+PUT handled)", async () => {
  // Phase 2 only handled GET. Phase 3 adds PUT for in-place editing. Other methods still fall through.
  const root = await freshSermonRoot("non-get");
  const handle = createOutlineRouteHandler({ sermon_root: root });
  for (const method of ["POST", "DELETE", "PATCH", "OPTIONS"]) {
    const response = await handle({ method, path: "/outline/x" });
    assert.equal(response, null, `expected fallthrough for ${method} /outline/x`);
  }
});

test("outline route: 400 for missing slug (/outline or /outline/)", async () => {
  const root = await freshSermonRoot("missing-slug");
  const handle = createOutlineRouteHandler({ sermon_root: root });
  for (const route of ["/outline", "/outline/"]) {
    const response = await handle({ method: "GET", path: route });
    assert.equal(response.status, 400, `expected 400 for ${route}`);
    assert.match(response.body.error.message, /slug/i);
  }
});

test("outline route: 400 for path-shaped slugs (path traversal protection)", async () => {
  const root = await freshSermonRoot("bad-slug");
  const handle = createOutlineRouteHandler({ sermon_root: root });
  for (const slug of ["..", "../escape", "with%20space", "ABC", "_underscore"]) {
    const response = await handle({ method: "GET", path: `/outline/${slug}` });
    assert.equal(response.status, 400, `expected 400 for slug "${slug}"`);
    assert.match(response.body.error.message, /slug/i);
  }
});

test("outline route: 400 for /outline/<slug>/extra (extra path segments)", async () => {
  const root = await freshSermonRoot("extra-segments");
  const handle = createOutlineRouteHandler({ sermon_root: root });
  const response = await handle({ method: "GET", path: "/outline/x/extra" });
  assert.equal(response.status, 400);
});

test("outline route: 404 when sermon folder does not exist", async () => {
  const root = await freshSermonRoot("missing-sermon");
  const handle = createOutlineRouteHandler({ sermon_root: root });
  const response = await handle({ method: "GET", path: "/outline/no-such-sermon" });
  assert.equal(response.status, 404);
  assert.match(response.body.error.message, /not found|sermon/i);
});

test("outline route: serves latest disk content (mid-test write reflected on next fetch)", async () => {
  const root = await freshSermonRoot("freshness");
  const slug = "fresh-sermon";
  const sermonDir = path.join(root, slug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);
  await replaceOutlineSection(sermonDir, "topic", "v1 topic");

  const handle = createOutlineRouteHandler({ sermon_root: root });
  const first = await handle({ method: "GET", path: `/outline/${slug}` });
  assert.match(first.body, /v1 topic/);

  await replaceOutlineSection(sermonDir, "topic", "v2 topic");
  const second = await handle({ method: "GET", path: `/outline/${slug}` });
  assert.match(second.body, /v2 topic/);
  assert.doesNotMatch(second.body, /v1 topic/);
});
