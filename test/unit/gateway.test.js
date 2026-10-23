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
const { createGatewayServer } = require("../../src/gateway/server.ts");

async function withTempMemoryRoot(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-test-"));
  try {
    await run(memoryRoot);
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
}

function createEngineHandler(streamFactory) {
  const calls = [];
  return {
    calls,
    handler: {
      async *handle(request) {
        calls.push(request);
        const events = streamFactory(calls.length - 1, request);
        for (const event of events) {
          yield event;
        }
      }
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

test("gateway forwards canonical model errors without saving a reply", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const engine = createEngineHandler(() => [{ event: "error", data: { code: "capability_unsupported", capability: "image_input", message: "Selected model does not support image_input." } }]);
    const routes = createGatewayRoutes({ conversation_store: store, engine_handler: engine.handler });
    const response = await routes.handle({ method: "POST", path: "/conversations/messages", headers: { "X-Actor-ID": "owner", "X-Actor-Permissions": "memory:read,memory:write" }, body: { content: [{ type: "text", text: "hello" }] } });
    const events = await collectEvents(response.stream);
    assert.deepEqual(events.map((event) => event.event), ["error"]);
    assert.equal(events[0].data.code, "capability_unsupported");
    assert.equal(events[0].data.capability, "image_input");
    assert.equal(engine.calls.length, 1);
    const detail = await routes.handle({ method: "GET", path: `/conversations/${response.headers["X-Conversation-ID"]}` });
    assert.equal(detail.body.messages.length, 1);
  });
});

test("gateway rejects public requests that include internal messages arrays", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const engine = createEngineHandler(() => [{ event: "done" }]);
    const routes = createGatewayRoutes({
      conversation_store: store,
      engine_handler: engine.handler
    });

    const response = await routes.handle({
      method: "POST",
      path: "/conversations/messages",
      headers: {
        "X-Actor-ID": "actor-1",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "hello" }],
        metadata: {},
        messages: [{ role: "user", content: [{ type: "text", text: "bad" }] }]
      }
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, "invalid_request");
    assert.match(response.body.message, /must not include a messages array/i);
    assert.equal(engine.calls.length, 0);
  });
});

test("gateway accepts inert part extensions and rejects unknown core fields", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const engine = createEngineHandler(() => [{ event: "done" }]);
    const routes = createGatewayRoutes({ conversation_store: store, engine_handler: engine.handler });
    const base = { method: "POST", path: "/conversations/messages", headers: { "X-Actor-ID": "actor-1", "X-Actor-Permissions": "memory:read,memory:write" } };
    const valid = await routes.handle({ ...base, body: { content: [{ type: "text", text: "hello", extensions: { future_key: "ignored" } }] } });
    assert.equal(valid.status, 200);
    await collectEvents(valid.stream);
    assert.equal(engine.calls.length, 1);
    const invalid = await routes.handle({ ...base, body: { content: [{ type: "text", text: "hello", future_key: "not an extension" }] } });
    assert.equal(invalid.status, 400);
    assert.equal(engine.calls.length, 1);
  });
});

test("gateway streams responses with conversation header and completion payload", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const engine = createEngineHandler(() => [
      { event: "text-delta", data: { text: "Hello there." } },
      { event: "done", data: { provider: "mock" } }
    ]);

    const routes = createGatewayRoutes({
      conversation_store: store,
      engine_handler: engine.handler
    });

    const response = await routes.handle({
      method: "POST",
      path: "/conversations/messages",
      headers: {
        "X-Actor-ID": "actor-1",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "Hi" }],
        metadata: {
          topic: "contracts"
        }
      }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers["Content-Type"], "text/event-stream");
    assert.ok(typeof response.headers["X-Conversation-ID"] === "string");

    const conversationId = response.headers["X-Conversation-ID"];
    const events = await collectEvents(response.stream);
    const doneEvent = events[events.length - 1];

    assert.equal(doneEvent.event, "done");
    assert.equal(doneEvent.data.finish_reason, "stop");
    assert.ok(typeof doneEvent.data.message_id === "string");
    assert.equal(doneEvent.data.provider, "mock");

    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0].method, "POST");
    assert.equal(engine.calls[0].path, "/agent-loop/chat");
    assert.equal(engine.calls[0].headers["X-Actor-ID"], "actor-1");
    assert.equal(engine.calls[0].headers["X-Actor-Permissions"], "memory:read,memory:write");
    assert.equal(engine.calls[0].body.metadata.conversation_id, conversationId);
    assert.ok(typeof engine.calls[0].body.metadata.correlation_id === "string");
    assert.equal(engine.calls[0].body.metadata.client_context.topic, "contracts");

    const listResponse = await routes.handle({
      method: "GET",
      path: "/conversations"
    });
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.body.conversations.length, 1);
    assert.equal(listResponse.body.conversations[0].id, conversationId);
    assert.equal(listResponse.body.total, 1);

    const detailResponse = await routes.handle({
      method: "GET",
      path: `/conversations/${conversationId}`
    });
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.body.id, conversationId);
    assert.equal(detailResponse.body.messages.length, 2);
    assert.equal(detailResponse.body.messages[0].role, "user");
    assert.deepEqual(detailResponse.body.messages[0].content, [{ type: "text", text: "Hi" }]);
    assert.ok(typeof detailResponse.body.messages[0].id === "string");
    assert.equal(detailResponse.body.messages[1].role, "assistant");
    assert.deepEqual(detailResponse.body.messages[1].content, [{ type: "text", text: "Hello there." }]);
    assert.ok(typeof detailResponse.body.messages[1].id === "string");
  });
});

test("gateway supports appending to existing conversations using canonical route", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const engine = createEngineHandler((index) => {
      if (index === 0) {
        return [
          { event: "text-delta", data: { text: "First reply." } },
          { event: "done" }
        ];
      }
      return [
        { event: "text-delta", data: { text: "Second reply." } },
        { event: "done" }
      ];
    });
    const routes = createGatewayRoutes({
      conversation_store: store,
      engine_handler: engine.handler
    });

    const createResponse = await routes.handle({
      method: "POST",
      path: "/conversations/messages",
      headers: {
        "X-Actor-ID": "actor-2",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "First message" }],
        metadata: {}
      }
    });
    const firstEvents = await collectEvents(createResponse.stream);
    assert.equal(firstEvents[firstEvents.length - 1].event, "done");
    const conversationId = createResponse.headers["X-Conversation-ID"];

    const appendResponse = await routes.handle({
      method: "POST",
      path: `/conversations/${conversationId}/messages`,
      headers: {
        "X-Actor-ID": "actor-2",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "Second message" }],
        metadata: {}
      }
    });

    assert.equal(appendResponse.status, 200);
    assert.equal(appendResponse.headers["X-Conversation-ID"], conversationId);
    const appendEvents = await collectEvents(appendResponse.stream);
    const doneEvent = appendEvents[appendEvents.length - 1];
    assert.equal(doneEvent.event, "done");
    assert.equal(doneEvent.data.finish_reason, "stop");

    const detailResponse = await routes.handle({
      method: "GET",
      path: `/conversations/${conversationId}`
    });
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.body.messages.length, 4);
    assert.deepEqual(detailResponse.body.messages[3].content, [{ type: "text", text: "Second reply." }]);
  });
});

test("gateway server can apply auth preprocessing before routing", async () => {
  let routedRequest = null;
  const routes = {
    async handle(request) {
      routedRequest = request;
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        },
        body: { ok: true }
      };
    }
  };

  const server = createGatewayServer({
    routes,
    authenticate: async (request) => ({
      request: {
        ...request,
        headers: {
          ...(request.headers || {}),
          "X-Actor-ID": "auth-actor",
          "X-Actor-Permissions": "memory:read"
        }
      }
    })
  });

  const response = await server.handle({
    method: "GET",
    path: "/conversations",
    headers: {}
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(routedRequest.headers["X-Actor-ID"], "auth-actor");
});

test("gateway keeps EXT-001 legacy /chat alias for approval payloads", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const engine = createEngineHandler(() => [
      {
        event: "tool-result",
        data: {
          id: "call-1",
          name: "memory_write",
          approval_request: {
            approval_id: "appr-1",
            action: "tool.execute.write",
            target: "memory_write",
            reason: "requires approval",
            requested_at: new Date().toISOString()
          },
          approval_result: {
            approval_id: "appr-1",
            approved: false,
            status: "denied",
            reason: "denied",
            resolved_at: new Date().toISOString()
          },
          error: "approval_denied"
        }
      },
      { event: "error", data: { code: "tool_error", message: "Tool execution failed." } }
    ]);

    const routes = createGatewayRoutes({
      conversation_store: store,
      engine_handler: engine.handler
    });

    const response = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-1",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: [{ type: "text", text: "Trigger tool write" }],
        metadata: {}
      }
    });

    const events = await collectEvents(response.stream);
    assert.equal(events[0].event, "approval-request");
    assert.equal(events[1].event, "approval-result");
    assert.equal(events[2].event, "tool-result");
    assert.equal(events[3].event, "error");
    assert.equal(events[2].data.approval_request, undefined);
    assert.equal(events[2].data.approval_result, undefined);
  });
});

test("gateway server sanitizes auth errors for client responses", async () => {
  const routes = {
    async handle() {
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        },
        body: { ok: true }
      };
    }
  };

  const server = createGatewayServer({
    routes,
    authenticate: async () => {
      throw {
        status_code: 401,
        error_code: "unauthorized",
        message: "token leaked at /tmp/private/path"
      };
    }
  });

  const response = await server.handle({
    method: "GET",
    path: "/conversations",
    headers: {}
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, "unauthorized");
  assert.equal(response.body.message, "Request authorization failed.");
});
