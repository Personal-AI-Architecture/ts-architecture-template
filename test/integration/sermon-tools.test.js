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

const { createAgentLoop } = require("../../src/engine/index.ts");
const { createToolExecutor } = require("../../src/engine/tool-executor.ts");
const { createApprovalGate } = require("../../src/types/approval.ts");
const {
  scaffoldOutline,
  replaceOutlineSection,
  parseOutlineSections,
  createUpdateOutlineSectionTool,
  createReadOutlineTool,
  SERMON_TOOL_SOURCE,
  UPDATE_OUTLINE_SECTION_TOOL_NAME
} = require("../../src/tools/sermon/outline.ts");
const { createSermonApprovalGate } = require("../../src/tools/sermon/approval.ts");

let workspace;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "sermon-int-"));
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

function createScriptedAdapter(scripts) {
  let turn = 0;
  const calls = [];
  return {
    calls,
    adapter: {
      name: "scripted-sermon",
      async *stream(request) {
        calls.push(request);
        const current = turn;
        turn += 1;
        const chunks = scripts[current] ?? [{ type: "done" }];
        for (const chunk of chunks) {
          yield chunk;
        }
      }
    }
  };
}

async function collectEvents(generator) {
  const events = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

test("createSermonApprovalGate auto-approves writes for source 'sermon'", async () => {
  const gate = createSermonApprovalGate();
  const evaluation = await gate.evaluate({
    action: "tool.execute.write",
    target: UPDATE_OUTLINE_SECTION_TOOL_NAME,
    reason: "writing topic",
    metadata: { tool_source: SERMON_TOOL_SOURCE, correlation_id: "corr-1" }
  });
  assert.equal(evaluation.approval_result.approved, true);
  assert.match(evaluation.approval_result.reason, /sermon/i);
});

test("createSermonApprovalGate denies writes from any other source", async () => {
  const gate = createSermonApprovalGate();
  const evaluation = await gate.evaluate({
    action: "tool.execute.write",
    target: "evil_tool",
    reason: "smuggle",
    metadata: { tool_source: "evil-source", correlation_id: "corr-2" }
  });
  assert.equal(evaluation.approval_result.approved, false);
});

test("update_outline_section round-trips through engine + auto-approving sermon gate", async () => {
  const sermonRoot = path.join(workspace, "round-trip-root");
  const sermonSlug = "round-trip-sermon";
  await fsp.mkdir(path.join(sermonRoot, sermonSlug), { recursive: true });
  await scaffoldOutline(path.join(sermonRoot, sermonSlug));

  const { definition: updateDef, handler: updateHandler } = createUpdateOutlineSectionTool({
    sermon_root: sermonRoot
  });
  const { definition: readDef, handler: readHandler } = createReadOutlineTool({
    sermon_root: sermonRoot
  });

  const tools = [updateDef, readDef];
  const handlers = {
    [updateDef.function.name]: updateHandler,
    [readDef.function.name]: readHandler
  };

  const recording = createScriptedAdapter([
    [
      {
        type: "tool-call",
        delta: {
          id: "call-1",
          type: "function",
          name: UPDATE_OUTLINE_SECTION_TOOL_NAME,
          arguments: JSON.stringify({
            sermon: sermonSlug,
            section: "topic",
            content: "Saying yes to God."
          })
        }
      },
      { type: "done" }
    ],
    [
      { type: "text-delta", delta: { text: "Topic saved." } },
      { type: "done" }
    ]
  ]);

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools,
    tool_executor: createToolExecutor({
      tools,
      handlers,
      approval_gate: createSermonApprovalGate()
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "set topic" }],
      metadata: { correlation_id: "corr-rt", actor_id: "tester", actor_permissions: ["*"] }
    })
  );

  const toolResultEvents = events.filter((event) => event.event === "tool-result");
  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].data.error, undefined, "tool call must succeed");
  assert.equal(toolResultEvents[0].data.name, UPDATE_OUTLINE_SECTION_TOOL_NAME);
  assert.ok(toolResultEvents[0].data.approval_request, "approval-request must be visible");
  assert.equal(toolResultEvents[0].data.approval_result.approved, true);

  const parsed = await parseOutlineSections(path.join(sermonRoot, sermonSlug));
  assert.equal(parsed.topic, "Saying yes to God.");
});

test("non-sermon tool with mutates_state: true is denied by sermon gate (proves auto-approval is scope-bounded)", async () => {
  const fakeWriteTool = {
    type: "function",
    function: {
      name: "evil_write",
      description: "should never execute",
      parameters: { type: "object", properties: {} }
    },
    source: "evil",
    mutates_state: true
  };

  let handlerCalled = false;
  const handlers = {
    evil_write: () => {
      handlerCalled = true;
      return { ok: true };
    }
  };

  const recording = createScriptedAdapter([
    [
      {
        type: "tool-call",
        delta: {
          id: "call-evil",
          type: "function",
          name: "evil_write",
          arguments: "{}"
        }
      },
      { type: "done" }
    ]
  ]);

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [fakeWriteTool],
    tool_executor: createToolExecutor({
      tools: [fakeWriteTool],
      handlers,
      approval_gate: createSermonApprovalGate()
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "go" }],
      metadata: { correlation_id: "corr-evil", actor_id: "tester", actor_permissions: ["*"] }
    })
  );

  assert.equal(handlerCalled, false, "evil handler must not run");
  const toolResultEvents = events.filter((event) => event.event === "tool-result");
  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].data.error, "approval_denied");
});

test("resume: pre-populated outline is read by read_outline before any write", async () => {
  const sermonRoot = path.join(workspace, "resume-root");
  const sermonSlug = "resume-sermon";
  const sermonDir = path.join(sermonRoot, sermonSlug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await scaffoldOutline(sermonDir);
  await replaceOutlineSection(sermonDir, "topic", "Topic from prior session");
  await replaceOutlineSection(sermonDir, "big_idea", "Big idea from prior session");

  const { definition: readDef, handler: readHandler } = createReadOutlineTool({
    sermon_root: sermonRoot
  });
  const tools = [readDef];
  const handlers = { [readDef.function.name]: readHandler };

  const recording = createScriptedAdapter([
    [
      {
        type: "tool-call",
        delta: {
          id: "call-read",
          type: "function",
          name: readDef.function.name,
          arguments: JSON.stringify({ sermon: sermonSlug })
        }
      },
      { type: "done" }
    ],
    [
      {
        type: "text-delta",
        delta: { text: "I see we've already covered topic and big idea. Ready for anchor scripture?" }
      },
      { type: "done" }
    ]
  ]);

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools,
    tool_executor: createToolExecutor({
      tools,
      handlers,
      approval_gate: createSermonApprovalGate()
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "let's continue" }],
      metadata: { correlation_id: "corr-resume", actor_id: "tester", actor_permissions: ["*"] }
    })
  );

  const toolResultEvents = events.filter((event) => event.event === "tool-result");
  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].data.error, undefined);
  assert.match(toolResultEvents[0].data.output.content, /Topic from prior session/);
  assert.match(toolResultEvents[0].data.output.content, /Big idea from prior session/);
});

test("update_outline_section called with unknown section emits a tool-result with error", async () => {
  const sermonRoot = path.join(workspace, "unknown-section-root");
  const sermonSlug = "us-sermon";
  await fsp.mkdir(path.join(sermonRoot, sermonSlug), { recursive: true });
  await scaffoldOutline(path.join(sermonRoot, sermonSlug));

  const { definition, handler } = createUpdateOutlineSectionTool({ sermon_root: sermonRoot });
  const tools = [definition];
  const handlers = { [definition.function.name]: handler };

  const recording = createScriptedAdapter([
    [
      {
        type: "tool-call",
        delta: {
          id: "call-1",
          type: "function",
          name: UPDATE_OUTLINE_SECTION_TOOL_NAME,
          arguments: JSON.stringify({
            sermon: sermonSlug,
            section: "definitely_not_a_section",
            content: "x"
          })
        }
      },
      { type: "done" }
    ]
  ]);

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools,
    tool_executor: createToolExecutor({
      tools,
      handlers,
      approval_gate: createSermonApprovalGate()
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "go" }],
      metadata: { correlation_id: "corr-bad", actor_id: "tester", actor_permissions: ["*"] }
    })
  );

  const toolResultEvents = events.filter((event) => event.event === "tool-result");
  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].data.error, "execution_failed");
});
