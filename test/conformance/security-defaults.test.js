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

const { bootRuntime } = require("../../src/config/boot.ts");
const { installOutboundNetworkGuard, withOutboundNetworkPermit } = require("../../src/types/network.ts");
const { createMemoryTools } = require("../../src/memory/tools.ts");
const { createAuditLogger } = require("../../src/types/audit.ts");
const { createToolExecutor } = require("../../src/engine/tool-executor.ts");

test("runtime boot defaults to localhost and keeps offline provider path independent", async () => {
  let outboundCheckCalled = false;

  const result = await bootRuntime(
    {
      async load_runtime_config() {
        return {
          memory_root: "/tmp/conformance-memory",
          provider_adapter: "mock",
          auth_mode: "enforced",
          tool_sources: ["memory"]
        };
      },
      async load_adapter_config() {
        return {};
      },
      async discover_tools() {
        return [];
      },
      async mount_memory() {
        return {};
      },
      async verify_memory_history() {},
      async read_preferences() {
        return { profile: "local" };
      }
    },
    {
      async assert_outbound_network_ready() {
        outboundCheckCalled = true;
      }
    }
  );

  assert.equal(result.ready, true);
  assert.equal(result.bind_address, "127.0.0.1");
  assert.equal(result.offline_mode, true);
  assert.equal(outboundCheckCalled, false);
});

test("outbound guard blocks silent fetch and permits explicit calls", async () => {
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
      operation: "conformance",
      target: "data:text/plain,allowed"
    },
    () => globalThis.fetch("data:text/plain,allowed")
  );

  assert.equal(await response.text(), "allowed");
});

test("approval defaults are enforced for memory writes", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "conformance-memory-"));
  try {
    const memory = await createMemoryTools({ memory_root: memoryRoot });

    await assert.rejects(
      async () => memory.write("profile", { theme: "dark" }),
      /requires approval/i
    );
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
});

test("tool isolation enforces allowed source boundaries", async () => {
  const writeTool = {
    type: "function",
    source: "memory",
    required_permissions: ["memory:write"],
    function: {
      name: "memory_write",
      description: "write",
      parameters: { type: "object", properties: {} }
    }
  };

  const executor = createToolExecutor({
    tools: [writeTool],
    allowed_tool_sources: ["auth"],
    handlers: {
      memory_write: async () => ({ ok: true })
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
        correlation_id: "corr-security",
        actor_permissions: ["memory:write"]
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "scope_violation");
});

test("audit logging is structured JSON with required core fields", () => {
  const logger = createAuditLogger();

  const captured = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };

  try {
    logger.log({
      category: "security",
      action: "conformance",
      outcome: "success",
      actor_id: "actor-security",
      correlation_id: "corr-security"
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(captured.length >= 1, true);
  const entry = JSON.parse(captured.join("").trim());
  assert.equal(entry.category, "security");
  assert.equal(entry.action, "conformance");
  assert.equal(entry.outcome, "success");
  assert.equal(typeof entry.timestamp, "string");
});
