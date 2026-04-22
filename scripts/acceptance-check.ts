// @ts-nocheck

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { installTypeScriptRequire } = require("./ts-require.js");

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));

function assertFileExists(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  assert.equal(fs.existsSync(absolute), true, `Missing required file: ${relativePath}`);
}

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function runBootChecks() {
  assertFileExists("src/config/loader.ts");
  assertFileExists("src/config/boot.ts");

  const { loadRuntimeConfiguration } = require("../src/config/loader.ts");
  const { bootRuntime } = require("../src/config/boot.ts");

  const callOrder = [];

  const runtime = loadRuntimeConfiguration({
    environment: "test",
    cwd: ROOT,
    runtime_config: {
      default: {
        memory_root: path.join(ROOT, ".tmp-acceptance-memory"),
        provider_adapter: "mock",
        auth_mode: "enforced",
        tool_sources: ["memory"]
      }
    }
  });

  const result = await bootRuntime({
    async load_runtime_config() {
      callOrder.push("load_runtime_config");
      return runtime;
    },
    async load_adapter_config() {
      callOrder.push("load_adapter_config");
      return { provider: runtime.provider_adapter };
    },
    async discover_tools() {
      callOrder.push("discover_tools");
      return [];
    },
    async mount_memory() {
      callOrder.push("mount_memory");
      return {};
    },
    async verify_memory_history() {
      callOrder.push("verify_memory_history");
    },
    async read_preferences() {
      callOrder.push("read_preferences");
      return { model: "local" };
    }
  });

  assert.deepEqual(callOrder, [
    "load_runtime_config",
    "load_adapter_config",
    "discover_tools",
    "mount_memory",
    "verify_memory_history",
    "read_preferences"
  ]);
  assert.equal(result.ready, true);
  assert.equal(result.bind_address, "127.0.0.1");
  assert.equal(result.offline_mode, true);
}

async function runMessageStreamPersistenceExportChecks() {
  assertFileExists("src/memory/tools.ts");
  assertFileExists("src/gateway/conversation-store.ts");
  assertFileExists("src/gateway/routes.ts");

  const { createMemoryTools } = require("../src/memory/tools.ts");
  const { createGatewayConversationStore } = require("../src/gateway/conversation-store.ts");
  const { createGatewayRoutes } = require("../src/gateway/routes.ts");

  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "acceptance-memory-"));

  try {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const conversationStore = createGatewayConversationStore({ memory });
    const routes = createGatewayRoutes({
      conversation_store: conversationStore,
      engine_handler: {
        async *handle() {
          yield {
            event: "text-delta",
            data: {
              text: "acceptance-ok"
            }
          };
          yield {
            event: "done",
            data: {
              provider: "mock"
            }
          };
        }
      }
    });

    const response = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-acceptance",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "Hello",
        metadata: {
          source: "acceptance"
        }
      }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers["Content-Type"], "text/event-stream");
    assert.ok(typeof response.headers["X-Conversation-ID"] === "string");

    const events = await collectEvents(response.stream);
    assert.equal(events.length >= 2, true);
    assert.equal(events[0].event, "text-delta");

    const done = events[events.length - 1];
    assert.equal(done.event, "done");
    assert.equal(done.data.conversation_id, response.headers["X-Conversation-ID"]);
    assert.ok(typeof done.data.message_id === "string");

    const listResponse = await routes.handle({
      method: "GET",
      path: "/conversations"
    });
    assert.equal(listResponse.status, 200);
    assert.equal(Array.isArray(listResponse.body.conversations), true);
    assert.equal(listResponse.body.conversations.length, 1);

    const detailResponse = await routes.handle({
      method: "GET",
      path: `/conversations/${response.headers["X-Conversation-ID"]}`
    });
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.body.messages.length, 2);
    assert.equal(detailResponse.body.messages[0].role, "user");
    assert.equal(detailResponse.body.messages[1].role, "assistant");

    const exported = await memory.export();
    assert.equal(exported.memory_root, memoryRoot);
    assert.equal(Array.isArray(exported.entries), true);
    assert.equal(Array.isArray(exported.conversations), true);
    assert.equal(Array.isArray(exported.history), true);
    assert.ok(exported.conversations.length >= 1);
    assert.ok(exported.history.length >= 1);
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
}

async function runConformanceScripts() {
  const { runContractCheck } = require("./check-contracts.ts");
  const { runImportBoundaryCheck } = require("./check-imports.ts");
  const { runLockinCheck } = require("./check-lockin.ts");

  const contractErrors = runContractCheck();
  assert.equal(contractErrors.length, 0, `Contract check failed: ${contractErrors.join(" | ")}`);

  const importErrors = runImportBoundaryCheck();
  assert.equal(importErrors.length, 0, `Import check failed: ${importErrors.join(" | ")}`);

  const lockinErrors = await runLockinCheck();
  assert.equal(lockinErrors.length, 0, `Lock-in check failed: ${lockinErrors.join(" | ")}`);
}

async function runAcceptanceCheck(options = {}) {
  const restore = installTypeScriptRequire();
  try {
    if (args.has("--boot-only")) {
      await runBootChecks();
      return {
        ok: true,
        boot_only: true
      };
    }

    await runBootChecks();
    await runMessageStreamPersistenceExportChecks();
    await runConformanceScripts();

    return {
      ok: true,
      boot_only: false
    };
  } finally {
    restore();
  }
}

async function main() {
  const result = await runAcceptanceCheck();
  if (result.boot_only) {
    console.log("Acceptance check passed (boot-only).");
  } else {
    console.log("Acceptance check passed.");
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Acceptance check failed: ${message}`);
    process.exit(1);
  });
}

module.exports = {
  runAcceptanceCheck
};
