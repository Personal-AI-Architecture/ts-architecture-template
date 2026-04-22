const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const { createAgentLoop, createEngineChatHandler } = require("../../src/engine/index.ts");
const { createToolExecutor } = require("../../src/engine/tool-executor.ts");

const configuredTool = {
  type: "function",
  function: {
    name: "configured_tool",
    description: "Configured tool",
    parameters: { type: "object", properties: {} }
  }
};

function createRecordingAdapter(streamFactory) {
  const calls = [];
  return {
    calls,
    adapter: {
      name: "recording",
      async *stream(request) {
        calls.push(request);
        const chunks = streamFactory(calls.length - 1, request);
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

test("agent loop uses configured tools, not runtime metadata overrides", async () => {
  const recording = createRecordingAdapter(() => [
    { type: "text-delta", delta: { text: "hello" } },
    { type: "done" }
  ]);

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [configuredTool]
  });

  const request = {
    messages: [{ role: "user", content: "Hi" }],
    metadata: {
      correlation_id: "corr-1",
      provider_adapter: "openai-compatible",
      tools: [
        {
          type: "function",
          function: {
            name: "runtime_override_tool",
            description: "should be ignored",
            parameters: {}
          }
        }
      ]
    }
  };

  const events = await collectEvents(loop.run(request));

  assert.equal(recording.calls.length, 1);
  assert.equal(recording.calls[0].tools.length, 1);
  assert.equal(recording.calls[0].tools[0].function.name, "configured_tool");
  assert.equal(events[0].event, "text-delta");
  assert.equal(events[events.length - 1].event, "done");
});

test("agent loop preserves text emitted in the same turn as tool calls", async () => {
  const recording = createRecordingAdapter((turnIndex) => {
    if (turnIndex === 0) {
      return [
        { type: "text-delta", delta: { text: "Let me " } },
        {
          type: "tool-call",
          delta: {
            id: "call-1",
            type: "function",
            name: "configured_tool",
            arguments: JSON.stringify({ value: 7 })
          }
        },
        { type: "text-delta", delta: { text: "check that." } },
        { type: "done" }
      ];
    }

    return [
      { type: "text-delta", delta: { text: "All set." } },
      { type: "done" }
    ];
  });

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [configuredTool],
    tool_executor: createToolExecutor({
      tools: [configuredTool],
      handlers: {
        configured_tool: async (input) => ({ echoed: input.value })
      }
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "Use a tool" }],
      metadata: { correlation_id: "corr-2" }
    })
  );

  assert.equal(recording.calls.length, 2);
  assert.equal(recording.calls[1].messages[1].role, "assistant");
  assert.equal(recording.calls[1].messages[1].content, "Let me check that.");
  assert.equal(recording.calls[1].messages[1].tool_calls[0].id, "call-1");
  assert.equal(recording.calls[1].messages[2].role, "tool");
  assert.equal(recording.calls[1].messages[2].tool_call_id, "call-1");

  assert.deepEqual(
    events.map((event) => event.event),
    ["text-delta", "tool-call", "text-delta", "tool-result", "text-delta", "done"]
  );
});

test("agent loop executes multiple tool calls in parallel within one turn", async () => {
  const toolA = {
    type: "function",
    function: {
      name: "tool_a",
      description: "Tool A",
      parameters: { type: "object", properties: {} }
    }
  };

  const toolB = {
    type: "function",
    function: {
      name: "tool_b",
      description: "Tool B",
      parameters: { type: "object", properties: {} }
    }
  };

  const recording = createRecordingAdapter((turnIndex) => {
    if (turnIndex === 0) {
      return [
        {
          type: "tool-call",
          delta: {
            id: "a",
            type: "function",
            name: "tool_a",
            arguments: "{}"
          }
        },
        {
          type: "tool-call",
          delta: {
            id: "b",
            type: "function",
            name: "tool_b",
            arguments: "{}"
          }
        },
        { type: "done" }
      ];
    }

    return [{ type: "done" }];
  });

  let inFlight = 0;
  let maxInFlight = 0;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [toolA, toolB],
    tool_executor: createToolExecutor({
      tools: [toolA, toolB],
      handlers: {
        tool_a: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(30);
          inFlight -= 1;
          return { from: "a" };
        },
        tool_b: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(30);
          inFlight -= 1;
          return { from: "b" };
        }
      }
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "call tools" }],
      metadata: { correlation_id: "corr-3" }
    })
  );

  assert.equal(maxInFlight, 2);
  assert.equal(
    events.filter((event) => event.event === "tool-result").length,
    2
  );
  assert.equal(events[events.length - 1].event, "done");
});

test("agent loop emits provider_error when adapter throws", async () => {
  const loop = createAgentLoop({
    model_adapter: {
      name: "failing",
      async *stream() {
        throw new Error("provider offline");
      }
    },
    tools: []
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "Hello" }],
      metadata: { correlation_id: "corr-4" }
    })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "error");
  assert.equal(events[0].data.code, "provider_error");
  assert.equal(events[0].data.message, "Model provider failed to complete the stream.");
});

test("agent loop emits context_overflow for context limit failures", async () => {
  const loop = createAgentLoop({
    model_adapter: {
      name: "overflow",
      async *stream() {
        throw new Error("maximum context length exceeded");
      }
    },
    tools: []
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "Hello" }],
      metadata: { correlation_id: "corr-5" }
    })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "error");
  assert.equal(events[0].data.code, "context_overflow");
});

test("agent loop emits approval semantics before tool_error on denied write tool", async () => {
  const writeTool = {
    type: "function",
    source: "memory",
    mutates_state: true,
    function: {
      name: "memory_write",
      description: "memory write",
      parameters: { type: "object", properties: {} }
    }
  };

  const recording = createRecordingAdapter(() => [
    {
      type: "tool-call",
      delta: {
        id: "write-1",
        type: "function",
        name: "memory_write",
        arguments: "{}"
      }
    },
    { type: "done" }
  ]);

  const loop = createAgentLoop({
    model_adapter: recording.adapter,
    tools: [writeTool],
    tool_executor: createToolExecutor({
      tools: [writeTool],
      handlers: {
        memory_write: async () => ({ ok: true })
      }
    })
  });

  const events = await collectEvents(
    loop.run({
      messages: [{ role: "user", content: "write memory" }],
      metadata: { correlation_id: "corr-approval-engine" }
    })
  );

  assert.equal(events[0].event, "tool-call");
  assert.equal(events[1].event, "tool-result");
  assert.equal(events[1].data.error, "approval_denied");
  assert.equal(typeof events[1].data.approval_request.approval_id, "string");
  assert.equal(events[1].data.approval_result.approved, false);
  assert.equal(events[2].event, "error");
  assert.equal(events[2].data.code, "tool_error");
});

test("engine chat handler enforces internal POST /engine/chat semantics", async () => {
  const handler = createEngineChatHandler({
    model_adapter: createRecordingAdapter(() => [{ type: "done" }]).adapter,
    tools: []
  });

  const missingHeaders = await collectEvents(
    handler.handle({
      method: "POST",
      path: "/engine/chat",
      body: {
        messages: [{ role: "user", content: "hi" }],
        metadata: { correlation_id: "corr-6" }
      }
    })
  );

  assert.equal(missingHeaders.length, 1);
  assert.equal(missingHeaders[0].event, "error");
  assert.equal(missingHeaders[0].data.code, "provider_error");

  const ok = await collectEvents(
    handler.handle({
      method: "POST",
      path: "/engine/chat",
      headers: {
        "X-Actor-ID": "actor-1",
        "X-Actor-Permissions": "memory:read"
      },
      body: {
        messages: [{ role: "user", content: "hi" }],
        metadata: { correlation_id: "corr-7" }
      }
    })
  );

  assert.equal(ok[ok.length - 1].event, "done");
});
