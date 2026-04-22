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

const { createMemoryTools } = require("../../src/memory/tools.ts");
const { createGatewayConversationStore } = require("../../src/gateway/conversation-store.ts");
const { createGatewayRoutes } = require("../../src/gateway/routes.ts");

function createEngineHandler() {
  return {
    async *handle() {
      yield { event: "text-delta", data: { text: "contract-ok" } };
      yield { event: "done", data: { provider: "mock" } };
    }
  };
}

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function withTempMemoryRoot(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-conformance-"));
  try {
    await run(memoryRoot);
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
}

test("gateway enforces public request shape and completion identifiers", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const routes = createGatewayRoutes({
      conversation_store: store,
      engine_handler: createEngineHandler()
    });

    const badMessagesRequest = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "hello",
        metadata: {},
        messages: [{ role: "user", content: "not-allowed" }]
      }
    });

    assert.equal(badMessagesRequest.status, 400);
    assert.equal(badMessagesRequest.body.error.code, "invalid_request");

    const badFieldRequest = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "hello",
        metadata: {},
        unexpected: true
      }
    });

    assert.equal(badFieldRequest.status, 400);
    assert.equal(badFieldRequest.body.error.code, "invalid_request");

    const missingActorHeaders = await routes.handle({
      method: "POST",
      path: "/chat",
      body: {
        content: "hello",
        metadata: {}
      }
    });

    assert.equal(missingActorHeaders.status, 401);
    assert.equal(missingActorHeaders.body.error.code, "missing_actor_headers");

    const validResponse = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "hello",
        metadata: {
          source: "conformance"
        }
      }
    });

    assert.equal(validResponse.status, 200);
    assert.equal(validResponse.headers["Content-Type"], "text/event-stream");
    assert.ok(typeof validResponse.headers["X-Conversation-ID"] === "string");

    const events = await collectEvents(validResponse.stream);
    const doneEvent = events[events.length - 1];
    assert.equal(doneEvent.event, "done");
    assert.equal(doneEvent.data.conversation_id, validResponse.headers["X-Conversation-ID"]);
    assert.ok(typeof doneEvent.data.message_id === "string");
  });
});

test("gateway supports client route swap from /chat to /conversations/{id}/messages", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const routes = createGatewayRoutes({
      conversation_store: store,
      engine_handler: {
        async *handle(request) {
          const turn = request.body.messages.length;
          yield { event: "text-delta", data: { text: `turn-${turn}` } };
          yield { event: "done", data: { provider: "mock" } };
        }
      }
    });

    const first = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "first",
        metadata: {
          client: "conformance"
        }
      }
    });

    assert.equal(first.status, 200);
    const conversationId = first.headers["X-Conversation-ID"];
    assert.ok(typeof conversationId === "string");
    const firstEvents = await collectEvents(first.stream);
    const firstDone = firstEvents[firstEvents.length - 1];
    assert.equal(firstDone.event, "done");
    assert.equal(firstDone.data.conversation_id, conversationId);
    assert.ok(typeof firstDone.data.message_id === "string");

    const second = await routes.handle({
      method: "POST",
      path: `/conversations/${conversationId}/messages`,
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "second",
        metadata: {
          client: "conformance"
        }
      }
    });

    assert.equal(second.status, 200);
    assert.equal(second.headers["X-Conversation-ID"], conversationId);
    const secondEvents = await collectEvents(second.stream);
    const secondDone = secondEvents[secondEvents.length - 1];
    assert.equal(secondDone.event, "done");
    assert.equal(secondDone.data.conversation_id, conversationId);
    assert.ok(typeof secondDone.data.message_id === "string");
    assert.notEqual(secondDone.data.message_id, firstDone.data.message_id);
  });
});
