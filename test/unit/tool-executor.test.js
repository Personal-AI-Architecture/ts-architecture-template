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

const { createToolExecutor } = require("../../src/engine/tool-executor.ts");

const toolA = {
  type: "function",
  function: {
    name: "tool_a",
    description: "A",
    parameters: { type: "object", properties: {} }
  }
};

const toolB = {
  type: "function",
  function: {
    name: "tool_b",
    description: "B",
    parameters: { type: "object", properties: {} }
  }
};

test("tool executor runs independent calls in parallel", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const executor = createToolExecutor({
    tools: [toolA, toolB],
    handlers: {
      tool_a: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(25);
        inFlight -= 1;
        return "a";
      },
      tool_b: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(25);
        inFlight -= 1;
        return "b";
      }
    }
  });

  const results = await executor.executeMany(
    [
      {
        id: "a",
        type: "function",
        function: {
          name: "tool_a",
          arguments: "{}"
        }
      },
      {
        id: "b",
        type: "function",
        function: {
          name: "tool_b",
          arguments: "{}"
        }
      }
    ],
    { metadata: { correlation_id: "corr-1" } }
  );

  assert.equal(results.length, 2);
  assert.equal(maxInFlight, 2);
  assert.equal(results.every((result) => result.ok), true);
});

test("tool executor fails unknown or malformed calls safely", async () => {
  const executor = createToolExecutor({
    tools: [toolA],
    handlers: {
      tool_a: async () => "ok"
    }
  });

  const results = await executor.executeMany(
    [
      {
        id: "unknown",
        type: "function",
        function: {
          name: "tool_missing",
          arguments: "{}"
        }
      },
      {
        id: "bad-json",
        type: "function",
        function: {
          name: "tool_a",
          arguments: "{"
        }
      }
    ],
    { metadata: { correlation_id: "corr-2" } }
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, false);
  assert.equal(results[0].message, "Tool execution failed.");
  assert.equal(results[1].message, "Tool execution failed.");
});

test("tool executor enforces tool scope independently from auth permissions", async () => {
  const scopedTool = {
    type: "function",
    source: "memory",
    required_permissions: ["memory:write"],
    function: {
      name: "memory_write",
      description: "write memory",
      parameters: { type: "object", properties: {} }
    }
  };

  const executor = createToolExecutor({
    tools: [scopedTool],
    allowed_tool_sources: ["auth"],
    handlers: {
      memory_write: async () => "ok"
    }
  });

  const [result] = await executor.executeMany(
    [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "memory_write",
          arguments: "{}"
        }
      }
    ],
    {
      metadata: {
        correlation_id: "corr-scope",
        actor_permissions: ["memory:write"]
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "scope_violation");
});

test("tool executor emits approval payload and denies write tools without approval", async () => {
  const writeTool = {
    type: "function",
    source: "memory",
    mutates_state: true,
    function: {
      name: "memory_update",
      description: "update memory",
      parameters: { type: "object", properties: {} }
    }
  };

  const executor = createToolExecutor({
    tools: [writeTool],
    handlers: {
      memory_update: async () => ({ ok: true })
    }
  });

  const [result] = await executor.executeMany(
    [
      {
        id: "call-approval",
        type: "function",
        function: {
          name: "memory_update",
          arguments: "{}"
        }
      }
    ],
    {
      metadata: {
        correlation_id: "corr-approval"
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "approval_denied");
  assert.equal(typeof result.approval_request?.approval_id, "string");
  assert.equal(result.approval_result?.approved, false);
});
