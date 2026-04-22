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

async function withTempMemoryRoot(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-integration-"));
  try {
    await run(memoryRoot);
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
}

test("gateway server handles authenticated conversation lifecycle", async () => {
  await withTempMemoryRoot(async (memoryRoot) => {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const store = createGatewayConversationStore({ memory });
    const engine = createEngineHandler((index) => {
      if (index === 0) {
        return [
          { event: "text-delta", data: { text: "First answer." } },
          { event: "done", data: { provider: "mock" } }
        ];
      }

      return [
        { event: "text-delta", data: { text: "Second answer." } },
        { event: "done", data: { provider: "mock" } }
      ];
    });

    const routes = createGatewayRoutes({
      conversation_store: store,
      engine_handler: engine.handler
    });

    const server = createGatewayServer({
      routes,
      authenticate: async (request) => {
        if (request.headers?.authorization !== "Bearer gateway-token") {
          throw {
            status_code: 401,
            error_code: "unauthorized",
            message: "Invalid credentials."
          };
        }

        return {
          ...request,
          headers: {
            ...(request.headers ?? {}),
            "X-Actor-ID": "actor-integration",
            "X-Actor-Permissions": "memory:read,memory:write"
          }
        };
      }
    });

    const unauthorized = await server.handle({
      method: "POST",
      path: "/chat",
      headers: {},
      body: {
        content: "hello",
        metadata: {}
      }
    });
    assert.equal(unauthorized.status, 401);

    const firstResponse = await server.handle({
      method: "POST",
      path: "/chat",
      headers: {
        authorization: "Bearer gateway-token"
      },
      body: {
        content: "First question",
        metadata: {
          channel: "integration"
        }
      }
    });

    assert.equal(firstResponse.status, 200);
    const conversationId = firstResponse.headers["X-Conversation-ID"];
    assert.ok(typeof conversationId === "string");

    const firstEvents = await collectEvents(firstResponse.stream);
    const firstDone = firstEvents[firstEvents.length - 1];
    assert.equal(firstDone.event, "done");
    assert.equal(firstDone.data.conversation_id, conversationId);
    assert.ok(typeof firstDone.data.message_id === "string");

    const secondResponse = await server.handle({
      method: "POST",
      path: `/conversations/${conversationId}/messages`,
      headers: {
        authorization: "Bearer gateway-token"
      },
      body: {
        content: "Second question",
        metadata: {
          channel: "integration"
        }
      }
    });

    assert.equal(secondResponse.status, 200);
    assert.equal(secondResponse.headers["X-Conversation-ID"], conversationId);
    const secondEvents = await collectEvents(secondResponse.stream);
    const secondDone = secondEvents[secondEvents.length - 1];
    assert.equal(secondDone.event, "done");
    assert.equal(secondDone.data.conversation_id, conversationId);
    assert.ok(typeof secondDone.data.message_id === "string");

    const listResponse = await server.handle({
      method: "GET",
      path: "/conversations",
      headers: {
        authorization: "Bearer gateway-token"
      }
    });
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.body.conversations.length, 1);
    assert.equal(listResponse.body.conversations[0].conversation_id, conversationId);

    const detailResponse = await server.handle({
      method: "GET",
      path: `/conversations/${conversationId}`,
      headers: {
        authorization: "Bearer gateway-token"
      }
    });

    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.body.messages.length, 4);
    assert.equal(detailResponse.body.messages[0].content, "First question");
    assert.equal(detailResponse.body.messages[1].content, "First answer.");
    assert.equal(detailResponse.body.messages[2].content, "Second question");
    assert.equal(detailResponse.body.messages[3].content, "Second answer.");

    assert.equal(engine.calls.length, 2);
    assert.equal(engine.calls[0].path, "/engine/chat");
    assert.equal(engine.calls[0].headers["X-Actor-ID"], "actor-integration");
    assert.equal(engine.calls[0].body.metadata.client_context.channel, "integration");
    assert.equal(engine.calls[0].body.metadata.conversation_id, conversationId);
    assert.equal(engine.calls[1].body.metadata.conversation_id, conversationId);
  });
});
