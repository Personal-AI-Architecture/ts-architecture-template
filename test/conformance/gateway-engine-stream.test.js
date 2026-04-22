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

const { createEngineChatHandler } = require("../../src/engine/index.ts");

const allowedEvents = new Set(["text-delta", "tool-call", "tool-result", "done", "error"]);

const readTool = {
  type: "function",
  source: "memory",
  function: {
    name: "memory_read",
    description: "read memory",
    parameters: { type: "object", properties: {} }
  }
};

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

test("gateway engine handler emits canonical stream events for tool + done flow", async () => {
  let turn = 0;

  const handler = createEngineChatHandler({
    model_adapter: {
      name: "conformance-adapter",
      async *stream() {
        if (turn === 0) {
          turn += 1;
          yield {
            type: "tool-call",
            delta: {
              id: "call-1",
              type: "function",
              name: "memory_read",
              arguments: "{}"
            }
          };
          yield { type: "done" };
          return;
        }

        yield {
          type: "text-delta",
          delta: {
            text: "tool-finished"
          }
        };
        yield { type: "done" };
      }
    },
    tools: [readTool],
    tool_executor: {
      async executeMany(toolCalls) {
        return toolCalls.map((toolCall) => ({
          ok: true,
          tool_call: toolCall,
          output: { value: "ok" },
          content: JSON.stringify({ value: "ok" })
        }));
      }
    }
  });

  const events = await collectEvents(
    handler.handle({
      method: "POST",
      path: "/engine/chat",
      headers: {
        "X-Actor-ID": "actor-conformance",
        "X-Actor-Permissions": "memory:read"
      },
      body: {
        messages: [{ role: "user", content: "read memory" }],
        metadata: {
          correlation_id: "corr-conformance"
        }
      }
    })
  );

  assert.ok(events.length >= 3);
  for (const event of events) {
    assert.equal(allowedEvents.has(event.event), true);
  }

  assert.equal(events[0].event, "tool-call");
  assert.equal(events[1].event, "tool-result");
  assert.equal(events[events.length - 2].event, "text-delta");
  assert.equal(events[events.length - 1].event, "done");
});

test("gateway engine handler enforces endpoint and actor headers", async () => {
  const handler = createEngineChatHandler({
    model_adapter: {
      name: "conformance-adapter",
      async *stream() {
        yield { type: "done" };
      }
    },
    tools: []
  });

  const badPathEvents = await collectEvents(
    handler.handle({
      method: "POST",
      path: "/engine/invalid",
      headers: {
        "X-Actor-ID": "actor-conformance",
        "X-Actor-Permissions": "memory:read"
      },
      body: {
        messages: [{ role: "user", content: "hello" }],
        metadata: {
          correlation_id: "corr-1"
        }
      }
    })
  );

  assert.equal(badPathEvents.length, 1);
  assert.equal(badPathEvents[0].event, "error");

  const missingHeaderEvents = await collectEvents(
    handler.handle({
      method: "POST",
      path: "/engine/chat",
      headers: {
        "X-Actor-ID": "actor-conformance"
      },
      body: {
        messages: [{ role: "user", content: "hello" }],
        metadata: {
          correlation_id: "corr-2"
        }
      }
    })
  );

  assert.equal(missingHeaderEvents.length, 1);
  assert.equal(missingHeaderEvents[0].event, "error");
  assert.equal(missingHeaderEvents[0].data.code, "provider_error");
});
