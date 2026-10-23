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

const {
  isAllowedEngineEventName,
  toErrorEventFromChunk,
  toStreamEventFromModelChunk
} = require("../../src/engine/stream.ts");

test("stream mapper emits only internal engine event names", () => {
  const chunks = [
    { type: "text-delta", delta: { text: "x" } },
    { type: "tool-call", delta: { id: "1", name: "x", arguments: "{}" } },
    { type: "tool-result", delta: { id: "1", output: "ok" } },
    { type: "done" },
    { type: "error", delta: { message: "provider unavailable" } }
  ];

  for (const chunk of chunks) {
    const event = toStreamEventFromModelChunk(chunk);
    assert.ok(event);
    assert.equal(isAllowedEngineEventName(event.event), true);
  }

  assert.equal(toStreamEventFromModelChunk(chunks[0]).data.content, "x");
  assert.equal(toStreamEventFromModelChunk(chunks[3]).data.finish_reason, "stop");

  assert.equal(isAllowedEngineEventName("approval-request"), false);
  assert.equal(toStreamEventFromModelChunk({ type: "unknown" }), null);
});

test("provider chunk errors map to safe client messages", () => {
  const event = toErrorEventFromChunk({
    type: "error",
    delta: {
      code: "provider_error",
      message: "stack at /tmp/private/path secret=abc"
    }
  });

  assert.equal(event.event, "error");
  assert.equal(event.data.code, "provider_error");
  assert.equal(event.data.message, "Model provider failed to complete the stream.");
});

test("context-limit provider chunk errors map to context_overflow", () => {
  const event = toErrorEventFromChunk({
    type: "error",
    delta: {
      message: "maximum context length exceeded"
    }
  });

  assert.equal(event.event, "error");
  assert.equal(event.data.code, "context_overflow");
});

test("canonical model errors keep their category and required capability without leaking provider text", () => {
  const unavailable = toErrorEventFromChunk({ type: "error", delta: { code: "model_unavailable", message: "secret=/tmp/key" } });
  assert.equal(unavailable.data.code, "model_unavailable");
  assert.doesNotMatch(unavailable.data.message, /secret|\/tmp/);

  const unsupported = toErrorEventFromChunk({ type: "error", delta: { code: "capability_unsupported", capability: "image_input", message: "secret=/tmp/key" } });
  assert.equal(unsupported.data.code, "capability_unsupported");
  assert.equal(unsupported.data.capability, "image_input");
  assert.doesNotMatch(unsupported.data.message, /secret|\/tmp/);
  assert.equal(toErrorEventFromChunk({ type: "error", delta: { code: "capability_unsupported" } }).data.code, "provider_error");
});
