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
const { createMockAdapter } = require("../../src/adapters/mock.ts");
const {
  createOpenAICompatibleAdapter,
  mapModelRequestToOpenAIPayload,
  mapOpenAIChunkToModelChunk
} = require("../../src/adapters/openai-compatible.ts");
const {
  installOutboundNetworkGuard,
  withOutboundNetworkPermit
} = require("../../src/types/network.ts");
const { normalizeToolDefinition } = require("../../src/types/contracts.ts");

const runtimeBase = {
  memory_root: "/tmp/memory",
  auth_mode: "enforced",
  tool_sources: []
};

const basicRequest = {
  model: "mock", provider: "local",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  stream: true
};

const sampleTool = {
  name: "lookup_weather",
  description: "Look up weather",
  parameters: {
    type: "object",
    properties: {}
  }
};

test("adapter loader selects provider from runtime configuration", () => {
  const adapter = loadModelAdapter({
    runtime: {
      ...runtimeBase,
      provider_adapter: "mock"
    }
  });

  assert.equal(adapter.name, "mock");
});

test("adapter loader rejects unknown providers", () => {
  assert.throws(
    () =>
      loadModelAdapter({
        runtime: {
          ...runtimeBase,
          provider_adapter: "unknown-provider"
        }
      }),
    /Unsupported provider adapter/
  );
});

test("mock adapter streams local response without network access", async () => {
  const adapter = createMockAdapter({
    response_text: "Local mock stream"
  });

  const chunks = [];
  for await (const chunk of adapter.stream(basicRequest)) {
    chunks.push(chunk);
  }

  assert.ok(chunks.some((chunk) => chunk.type === "text-delta"));
  assert.equal(chunks[chunks.length - 1].type, "done");
});

test("mock adapter supports tool-call scenarios", async () => {
  const adapter = createMockAdapter();

  const chunks = [];
  for await (const chunk of adapter.stream({
    ...basicRequest,
    messages: [{ role: "user", content: "please use tool to look this up" }],
    tools: [sampleTool]
  })) {
    chunks.push(chunk);
  }

  const toolCall = chunks.find((chunk) => chunk.type === "tool-call");
  assert.ok(toolCall);
  assert.equal(toolCall.delta.name, "lookup_weather");
  assert.equal(chunks[chunks.length - 1].type, "done");
});

test("tool definitions retain source identity with a new protocol label and ignore extensions", () => {
  const normalized = normalizeToolDefinition({
    name: "lookup_weather", description: "Weather", parameters: { type: "object" },
    source: { id: "weather-service", kind: "future-protocol" }, visibility: "always-send",
    extensions: { future_key: "ignored" }
  });
  assert.equal(normalized.source, "weather-service");
  assert.equal(normalized.source_kind, "future-protocol");
  assert.equal(normalized.name, "lookup_weather");
  assert.equal(normalized.extensions, undefined);
});

test("openai-compatible adapter maps model request shape", () => {
  const payload = mapModelRequestToOpenAIPayload(
    {
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "calling tool",
          tool_calls: [
            {
              id: "call-1",
              name: "lookup_weather",
              arguments: {}
            }
          ]
        },
        {
          role: "tool",
          content: "{\"temp\":72}",
          tool_call_id: "call-1"
        }
      ],
      tools: [sampleTool],
      stream: true,
      model: "gpt-test",
      provider: "local"
    }
  );

  assert.equal(payload.model, "gpt-test");
  assert.equal(payload.stream, true);
  assert.equal(payload.tools[0].function.name, "lookup_weather");
  assert.equal(payload.messages[2].tool_calls[0].function.name, "lookup_weather");
  assert.equal(payload.messages[3].tool_call_id, "call-1");
});

test("openai-compatible chunk mapper translates text and tool deltas", () => {
  const textChunk = mapOpenAIChunkToModelChunk({
    choices: [{ delta: { content: "hello" } }]
  });
  assert.equal(textChunk.type, "text-delta");
  assert.equal(textChunk.delta.text, "hello");

  const toolChunk = mapOpenAIChunkToModelChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              id: "call-2",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: "{\"city\":\"NYC\"}"
              }
            }
          ]
        }
      }
    ]
  });
  assert.equal(toolChunk.type, "tool-call");
  assert.equal(toolChunk.delta.name, "lookup_weather");

  const doneChunk = mapOpenAIChunkToModelChunk({
    choices: [{ finish_reason: "stop" }]
  });
  assert.equal(doneChunk.type, "done");
});

test("openai-compatible adapter streams parsed SSE provider events", async () => {
  const events = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ];

  const adapter = createOpenAICompatibleAdapter({
    api_base_url: "http://provider.local/v1",
    model: "gpt-test",
    fetcher: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: (async function* createBody() {
        for (const event of events) {
          yield Buffer.from(event, "utf8");
        }
      })(),
      text: async () => "",
      json: async () => ({})
    })
  });

  const chunks = [];
  for await (const chunk of adapter.stream({ ...basicRequest, tools: [sampleTool] })) {
    chunks.push(chunk);
  }

  assert.ok(chunks.some((chunk) => chunk.type === "text-delta"));
  assert.equal(chunks[chunks.length - 1].type, "done");
});

test("openai-compatible adapter recognizes explicit model failures without exposing provider text", async () => {
  for (const [providerCode, capability, expected] of [
    ["model_not_found", undefined, "model_unavailable"],
    ["unsupported_capability", "image_input", "capability_unsupported"]
  ]) {
    const adapter = createOpenAICompatibleAdapter({
      api_base_url: "http://provider.local/v1",
      fetcher: async () => ({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => JSON.stringify({ error: { code: providerCode, capability, message: "secret=/tmp/key" } }),
        json: async () => ({})
      })
    });
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream(basicRequest)) { /* consume */ }
    }, (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.capability, capability);
      assert.doesNotMatch(error.message, /secret|\/tmp/);
      return true;
    });
  }
});

test("outbound guard blocks silent fetch and permits explicit provider calls", async () => {
  if (typeof globalThis.fetch !== "function") {
    return;
  }

  installOutboundNetworkGuard();
  await assert.rejects(
    () => globalThis.fetch("data:text/plain,blocked"),
    /Outbound network call blocked/i
  );

  const response = await withOutboundNetworkPermit(
    {
      channel: "provider",
      operation: "unit-test",
      target: "data:text/plain,allowed"
    },
    () => globalThis.fetch("data:text/plain,allowed")
  );

  assert.equal(await response.text(), "allowed");
});
