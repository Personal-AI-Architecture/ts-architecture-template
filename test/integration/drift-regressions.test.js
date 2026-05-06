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

const { createAgentLoop, createEngineChatHandler } = require("../../src/engine/index.ts");
const { createToolExecutor } = require("../../src/engine/tool-executor.ts");
const { createReadFileTool, READ_FILE_TOOL_NAME } = require("../../src/tools/corpus/read-file.ts");

let workspace;
let corpusRoot;

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "drift-regressions-"));
  corpusRoot = path.join(workspace, "corpus");
  await fsp.mkdir(corpusRoot, { recursive: true });
  await fsp.writeFile(path.join(corpusRoot, "real.md"), "# Real\nbody");
});

after(async () => {
  if (workspace) {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

function createRecordingAdapter() {
  const calls = [];
  const scripts = [
    [
      {
        type: "tool-call",
        delta: {
          id: "call-1",
          type: "function",
          name: READ_FILE_TOOL_NAME,
          arguments: JSON.stringify({ path: "real.md" })
        }
      },
      { type: "done" }
    ],
    [{ type: "text-delta", delta: { text: "answer" } }, { type: "done" }]
  ];

  return {
    calls,
    adapter: {
      name: "scripted-recording",
      async *stream(request) {
        calls.push(request);
        const turn = calls.length - 1;
        const chunks = scripts[turn] ?? [{ type: "done" }];
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

test("metadata side-channel: client_context.tool_definitions does not replace configured tools", async () => {
  const recording = createRecordingAdapter();
  const { definition, handler } = createReadFileTool({ corpus_root: corpusRoot });

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [definition],
    tool_executor: createToolExecutor({
      tools: [definition],
      handlers: { [definition.function.name]: handler }
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "Use read_file" }],
      metadata: {
        correlation_id: "corr-side-channel-1",
        actor_id: "test-actor",
        actor_permissions: ["memory:read"],
        // Hostile metadata fields — must not affect engine behavior
        provider: "evil-provider",
        model: "evil-model",
        tool_sources: ["evil-source"],
        tool_definitions: [
          {
            type: "function",
            function: {
              name: "evil_tool",
              description: "Should never be advertised",
              parameters: {}
            }
          }
        ]
      }
    })
  );

  assert.equal(recording.calls.length >= 1, true);
  // Adapter must only see the configured tool — not the side-channel one.
  for (const call of recording.calls) {
    assert.equal(call.tools.length, 1, "adapter must only see configured tools");
    assert.equal(call.tools[0].function.name, READ_FILE_TOOL_NAME);
  }

  const toolResultEvents = events.filter((event) => event.event === "tool-result");
  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].data.name, READ_FILE_TOOL_NAME);

  const doneEvent = events.find((event) => event.event === "done");
  assert.ok(doneEvent, "loop should complete with done event");
});

test("metadata side-channel: metadata.allowed_tool_sources cannot widen beyond configured sources", async () => {
  const recording = createRecordingAdapter();
  const { definition, handler } = createReadFileTool({ corpus_root: corpusRoot });

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [definition],
    allowed_tool_sources: ["other-source"],
    tool_executor: createToolExecutor({
      tools: [definition],
      handlers: { [definition.function.name]: handler },
      allowed_tool_sources: ["other-source"]
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "Use read_file" }],
      metadata: {
        correlation_id: "corr-side-channel-2",
        actor_id: "test-actor",
        actor_permissions: ["*"],
        // Hostile attempt to widen tool source allowlist via metadata
        allowed_tool_sources: ["corpus", "other-source"]
      }
    })
  );

  const toolResultEvents = events.filter((event) => event.event === "tool-result");
  assert.equal(toolResultEvents.length, 1, "tool-result event should be emitted");
  assert.equal(
    toolResultEvents[0].data.error,
    "scope_violation",
    "read_file (source=corpus) must be denied because corpus is not in the configured allowlist"
  );

  const errorEvent = events.find((event) => event.event === "error");
  assert.ok(errorEvent, "scope_violation must terminate the loop with an error event");
  assert.equal(errorEvent.data.code, "tool_error");
});

test("tool source gating: allowed_tool_sources excluding 'corpus' produces scope_violation for read_file", async () => {
  const recording = createRecordingAdapter();
  const { definition, handler } = createReadFileTool({ corpus_root: corpusRoot });

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [definition],
    allowed_tool_sources: ["auth"],
    tool_executor: createToolExecutor({
      tools: [definition],
      handlers: { [definition.function.name]: handler },
      allowed_tool_sources: ["auth"]
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "Use read_file" }],
      metadata: {
        correlation_id: "corr-gate-1",
        actor_id: "test-actor",
        actor_permissions: ["*"]
      }
    })
  );

  const toolResultEvents = events.filter((event) => event.event === "tool-result");
  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].data.error, "scope_violation");
});

test("tool source gating: with corpus in allowed sources, read_file executes successfully", async () => {
  const recording = createRecordingAdapter();
  const { definition, handler } = createReadFileTool({ corpus_root: corpusRoot });

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [definition],
    allowed_tool_sources: ["corpus"],
    tool_executor: createToolExecutor({
      tools: [definition],
      handlers: { [definition.function.name]: handler },
      allowed_tool_sources: ["corpus"]
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "Use read_file" }],
      metadata: {
        correlation_id: "corr-gate-2",
        actor_id: "test-actor",
        actor_permissions: ["*"]
      }
    })
  );

  const toolResultEvents = events.filter((event) => event.event === "tool-result");
  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].data.error, undefined, "should NOT have error field on success");
  assert.equal(toolResultEvents[0].data.output.ok, true);
  assert.equal(toolResultEvents[0].data.output.path, "real.md");
});

test("citation soundness: every read_file tool-call has a path that resolves inside the corpus", async () => {
  // Drives a normal scripted run and asserts that the tool-call event's path
  // is a file path that exists inside the corpus root. This is the v1 coded
  // check on the spec invariant "Citation soundness".
  const recording = createRecordingAdapter();
  const { definition, handler } = createReadFileTool({ corpus_root: corpusRoot });

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [definition],
    tool_executor: createToolExecutor({
      tools: [definition],
      handlers: { [definition.function.name]: handler }
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "Tell me about the architecture." }],
      metadata: { correlation_id: "corr-citation-1", actor_id: "u", actor_permissions: ["*"] }
    })
  );

  const toolCallEvents = events.filter(
    (event) => event.event === "tool-call" && event.data?.name === READ_FILE_TOOL_NAME
  );
  assert.ok(toolCallEvents.length > 0, "scripted run should emit at least one read_file tool-call");

  for (const call of toolCallEvents) {
    const args = JSON.parse(call.data.arguments);
    assert.equal(typeof args.path, "string");
    const resolved = path.isAbsolute(args.path)
      ? path.resolve(args.path)
      : path.resolve(corpusRoot, args.path);
    assert.ok(
      resolved === path.resolve(corpusRoot) ||
        resolved.startsWith(`${path.resolve(corpusRoot)}${path.sep}`),
      `cited path must be inside corpus: ${args.path}`
    );
    const stat = await fsp.stat(resolved);
    assert.ok(stat.isFile(), `cited path must be a real file: ${args.path}`);
  }
});
