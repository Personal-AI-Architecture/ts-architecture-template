const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
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

const { createMemoryTools } = require("../../src/memory/tools.ts");

async function withTempMemoryRoot(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-tools-test-"));
  try {
    await run(memoryRoot);
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
}

test("memory tools track write/edit/delete history records", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const tools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: {
        mode: "disabled"
      }
    });

    await tools.write("profile", { name: "Ada" });
    const edited = await tools.edit("profile", { alias: "Countess" });
    const deleted = await tools.delete("profile");

    assert.equal(deleted, true);
    assert.deepEqual(edited.value, { name: "Ada", alias: "Countess" });
    assert.equal(await tools.read("profile"), null);

    const history = await tools.history({ key: "profile" });
    assert.deepEqual(
      history.map((record) => record.operation),
      ["write", "edit", "delete"]
    );
    assert.equal(history[0].previous_state, null);
    assert.deepEqual(history[0].next_state, { name: "Ada" });
    assert.deepEqual(history[1].previous_state, { name: "Ada" });
    assert.equal(history[2].next_state, null);
  });
});

test("conversation helpers and export surface are available", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const tools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: {
        mode: "disabled"
      }
    });

    await tools.write("notes/welcome", { message: "hello" });
    await tools.saveConversation(
      "conv-1",
      [{ role: "user", content: "hi" }],
      { source: "unit-test" }
    );
    await tools.appendConversationMessage("conv-1", {
      role: "assistant",
      content: "hello there"
    });

    const conversation = await tools.getConversation("conv-1");
    assert.ok(conversation);
    assert.equal(conversation.value.messages.length, 2);

    const exported = await tools.export();
    assert.equal(exported.memory_root, memoryRoot);
    assert.ok(exported.entries.some((record) => record.key === "notes/welcome"));
    assert.ok(
      exported.conversations.some((record) => record.key === "conversations/conv-1")
    );
    assert.equal(exported.history_metadata.schema_version, 1);
    assert.ok(Array.isArray(exported.history));
  });
});

test("memory tools enforce approval on non-conversation writes by default", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const tools = await createMemoryTools({ memory_root: memoryRoot });
    await assert.rejects(() => tools.write("profile", { name: "Ada" }), /requires approval/i);
  });
});
