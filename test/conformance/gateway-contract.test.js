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
      path: "/conversations/messages",
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "hello" }],
        metadata: {},
        messages: [{ role: "user", content: [{ type: "text", text: "not-allowed" }] }]
      }
    });

    assert.equal(badMessagesRequest.status, 400);
    assert.equal(badMessagesRequest.body.code, "invalid_request");

    const badFieldRequest = await routes.handle({
      method: "POST",
      path: "/conversations/messages",
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "hello" }],
        metadata: {},
        unexpected: true
      }
    });

    assert.equal(badFieldRequest.status, 400);
    assert.equal(badFieldRequest.body.code, "invalid_request");

    const missingActorHeaders = await routes.handle({
      method: "POST",
      path: "/conversations/messages",
      body: {
        content: [{ type: "text", text: "hello" }],
        metadata: {}
      }
    });

    assert.equal(missingActorHeaders.status, 401);
    assert.equal(missingActorHeaders.body.code, "missing_actor_headers");

    const validResponse = await routes.handle({
      method: "POST",
      path: "/conversations/messages",
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "hello" }],
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
    assert.equal(doneEvent.data.finish_reason, "stop");
    assert.ok(typeof doneEvent.data.message_id === "string");
  });
});

test("gateway supports the PAA create route and conversation append route", async () => {
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
      path: "/conversations/messages",
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "first" }],
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
    assert.equal(firstDone.data.finish_reason, "stop");
    assert.ok(typeof firstDone.data.message_id === "string");

    const second = await routes.handle({
      method: "POST",
      path: `/conversations/${conversationId}/messages`,
      headers: {
        "X-Actor-ID": "actor-contract",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "second" }],
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
    assert.equal(secondDone.data.finish_reason, "stop");
    assert.ok(typeof secondDone.data.message_id === "string");
    assert.notEqual(secondDone.data.message_id, firstDone.data.message_id);
  });
});

test("current PAA request uses content parts, a per-turn model, and authenticated context", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const handoffs = [];
    let selectedModel = "model-one";
    const routes = createGatewayRoutes({
      conversation_store: store,
      current_model: () => selectedModel,
      engine_handler: {
        async *handle(request) {
          handoffs.push(request);
          yield { event: "text-delta", data: { content: "ok" } };
          yield { event: "done", data: { finish_reason: "stop" } };
        }
      }
    });
    const headers = { "X-Actor-ID": "owner", "X-Actor-Permissions": "memory:read,memory:write" };
    const oldShape = await routes.handle({ method: "POST", path: "/conversations/messages", headers, body: { content: "old string" } });
    assert.equal(oldShape.status, 400);

    const first = await routes.handle({ method: "POST", path: "/conversations/messages", headers, body: { content: [{ type: "text", text: "hello" }] } });
    assert.equal(first.status, 200);
    await collectEvents(first.stream);
    selectedModel = "model-two";
    const second = await routes.handle({ method: "POST", path: `/conversations/${first.headers["X-Conversation-ID"]}/messages`, headers, body: { content: [{ type: "text", text: "again" }] } });
    assert.equal(second.status, 200);
    await collectEvents(second.stream);

    assert.deepEqual(handoffs.map((request) => request.body.model), ["model-one", "model-two"]);
    assert.deepEqual(handoffs.map((request) => request.path), ["/agent-loop/chat", "/agent-loop/chat"]);
    assert.deepEqual(handoffs[0].body.messages[0].content, [{ type: "text", text: "hello" }]);
    assert.equal(handoffs[0].body.auth_context.actor.id, "owner");
    assert.equal(handoffs[0].body.auth_context.correlation_id, handoffs[0].body.metadata.correlation_id);
    const detail = await routes.handle({ method: "GET", path: `/conversations/${first.headers["X-Conversation-ID"]}` });
    assert.deepEqual(detail.body.messages[0].content, [{ type: "text", text: "hello" }]);
  });
});
