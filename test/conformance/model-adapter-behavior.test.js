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

const { loadModelAdapter } = require("../../src/adapters/loader.ts");
const { createOpenAICompatibleAdapter } = require("../../src/adapters/openai-compatible.ts");
const { createAgentLoop } = require("../../src/engine/index.ts");

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

test("model adapter loader swaps providers via runtime configuration", () => {
  const runtimeBase = {
    memory_root: "/tmp/conformance-memory",
    auth_mode: "enforced",
    tool_sources: []
  };

  const mockAdapter = loadModelAdapter({
    runtime: {
      ...runtimeBase,
      provider_adapter: "mock"
    }
  });
  assert.equal(mockAdapter.name, "mock");

  const openaiAdapter = loadModelAdapter({
    runtime: {
      ...runtimeBase,
      provider_adapter: "openai-compatible"
    },
    openai_compatible: {
      api_base_url: "http://provider.local/v1",
      model: "gpt-test",
      fetcher: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: (async function* createBody() {
          yield Buffer.from('data: {"choices":[{"finish_reason":"stop"}]}\\n\\n', "utf8");
          yield Buffer.from("data: [DONE]\\n\\n", "utf8");
        })(),
        text: async () => "",
        json: async () => ({})
      })
    }
  });

  assert.equal(openaiAdapter.name, "openai-compatible");
});

test("openai-compatible adapter keeps model selection config-driven", async () => {
  let capturedBody;

  const adapter = createOpenAICompatibleAdapter({
    api_base_url: "http://provider.local/v1",
    model: "gpt-config-selected",
    fetcher: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: (async function* createBody() {
          yield Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\n', "utf8");
          yield Buffer.from('data: {"choices":[{"finish_reason":"stop"}]}\\n\\n', "utf8");
          yield Buffer.from("data: [DONE]\\n\\n", "utf8");
        })(),
        text: async () => "",
        json: async () => ({})
      };
    }
  });

  for await (const _chunk of adapter.stream({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    stream: true
  })) {
    // consume stream
  }

  assert.equal(capturedBody.model, "gpt-config-selected");
  assert.equal(capturedBody.stream, true);
});

test("agent loop tolerates adapter swap with canonical stream semantics", async () => {
  const request = {
    messages: [{ role: "user", content: "hello" }],
    metadata: {
      correlation_id: "corr-adapter-swap"
    }
  };

  const loopA = createAgentLoop({
    model_adapter: {
      name: "adapter-a",
      async *stream() {
        yield { type: "text-delta", delta: { text: "A" } };
        yield { type: "done" };
      }
    },
    tools: []
  });

  const loopB = createAgentLoop({
    model_adapter: {
      name: "adapter-b",
      async *stream() {
        yield { type: "text-delta", delta: { text: "B" } };
        yield { type: "done", delta: { reason: "stop" } };
      }
    },
    tools: []
  });

  const eventsA = await collectEvents(loopA.run(request));
  const eventsB = await collectEvents(loopB.run(request));

  assert.equal(eventsA[0].event, "text-delta");
  assert.equal(eventsA[eventsA.length - 1].event, "done");
  assert.equal(eventsB[0].event, "text-delta");
  assert.equal(eventsB[eventsB.length - 1].event, "done");
});
