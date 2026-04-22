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
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-1",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "hello",
        metadata: {},
        messages: [{ role: "user", content: "bad" }]
      }
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_request");
    assert.match(response.body.error.message, /must not include a messages array/i);
    assert.equal(engine.calls.length, 0);
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
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-1",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "Hi",
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
    assert.equal(doneEvent.data.conversation_id, conversationId);
    assert.ok(typeof doneEvent.data.message_id === "string");
    assert.equal(doneEvent.data.provider, "mock");

    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0].method, "POST");
    assert.equal(engine.calls[0].path, "/engine/chat");
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
    assert.equal(listResponse.body.conversations[0].conversation_id, conversationId);

    const detailResponse = await routes.handle({
      method: "GET",
      path: `/conversations/${conversationId}`
    });
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.body.conversation_id, conversationId);
    assert.equal(detailResponse.body.messages.length, 2);
    assert.equal(detailResponse.body.messages[0].role, "user");
    assert.equal(detailResponse.body.messages[0].content, "Hi");
    assert.ok(typeof detailResponse.body.messages[0].message_id === "string");
    assert.equal(detailResponse.body.messages[1].role, "assistant");
    assert.equal(detailResponse.body.messages[1].content, "Hello there.");
    assert.ok(typeof detailResponse.body.messages[1].message_id === "string");
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
      path: "/chat",
      headers: {
        "X-Actor-ID": "actor-2",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "First message",
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
        content: "Second message",
        metadata: {}
      }
    });

    assert.equal(appendResponse.status, 200);
    assert.equal(appendResponse.headers["X-Conversation-ID"], conversationId);
    const appendEvents = await collectEvents(appendResponse.stream);
    const doneEvent = appendEvents[appendEvents.length - 1];
    assert.equal(doneEvent.event, "done");
    assert.equal(doneEvent.data.conversation_id, conversationId);

    const detailResponse = await routes.handle({
      method: "GET",
      path: `/conversations/${conversationId}`
    });
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.body.messages.length, 4);
    assert.equal(detailResponse.body.messages[3].content, "Second reply.");
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

test("gateway surfaces approval-request and approval-result semantics from tool payloads", async () => {
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
        content: "Trigger tool write",
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
  assert.equal(response.body.error.code, "unauthorized");
  assert.equal(response.body.error.message, "Request authorization failed.");
});
