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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename
  });
  module._compile(compiled.outputText, filename);
};
after(() => { if (previousTsLoader) require.extensions[".ts"] = previousTsLoader; else delete require.extensions[".ts"]; });

const { createMemoryTools } = require("../../src/memory/tools.ts");
const { createGatewayConversationStore } = require("../../src/gateway/conversation-store.ts");
const { createGatewayRoutes } = require("../../src/gateway/routes.ts");
const { createAgentLoop, createAgentLoopChatHandler } = require("../../src/agent-loop/index.ts");
const { contextCost } = require("../../src/types/context.ts");
const { createOpenAICompatibleAdapter } = require("../../src/adapters/openai-compatible.ts");

const headers = { "X-Actor-ID": "owner", "X-Actor-Permissions": "memory:read,memory:write" };
const body = { content: [{ type: "text", text: "hello" }] };
async function events(stream) { const collected = []; for await (const event of stream) collected.push(event); return collected; }

test("selected provider reaches model and saved replies retain model/provider", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "paa-current-ts-"));
  try {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const selected = { provider: "alpha", model: "m1" };
    const limits = { alpha: { m1: 8192 }, beta: { m2: 8192 } };
    const calls = [];
    const handler = createAgentLoopChatHandler({
      context_limits: limits,
      tools: [],
      model_adapter: { name: "recording", async *stream(request) {
        calls.push(request);
        yield { type: "text-delta", delta: { text: "answer" } };
        yield { type: "done" };
      } }
    });
    const routes = createGatewayRoutes({ conversation_store: createGatewayConversationStore({ memory }), agent_loop_handler: handler,
      current_model: () => selected.model, current_provider: () => selected.provider, context_limits: limits });
    const first = await routes.handle({ method: "POST", path: "/conversations/messages", headers, body });
    await events(first.stream);
    selected.provider = "beta"; selected.model = "m2";
    const conversationPath = `/conversations/${first.headers["X-Conversation-ID"]}`;
    const second = await routes.handle({ method: "POST", path: `${conversationPath}/messages`, headers, body });
    await events(second.stream);
    assert.deepEqual(calls.map((request) => [request.provider, request.model]), [["alpha", "m1"], ["beta", "m2"]]);
    const detail = await routes.handle({ method: "GET", path: conversationPath });
    assert.deepEqual(detail.body.messages.filter((message) => message.role === "assistant").map((message) => [message.provider, message.model]), [["alpha", "m1"], ["beta", "m2"]]);
  } finally { await fsp.rm(memoryRoot, { recursive: true, force: true }); }
});

test("unknown and oversized contexts block dispatch; omitted turns produce notice without losing history", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "paa-context-ts-"));
  try {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const calls = [];
    const limits = { local: {} };
    const handler = createAgentLoopChatHandler({ context_limits: limits, tools: [], model_adapter: { name: "recording", async *stream(request) { calls.push(request); yield { type: "text-delta", delta: { text: "answer" } }; yield { type: "done" }; } } });
    const routes = createGatewayRoutes({ conversation_store: createGatewayConversationStore({ memory }), agent_loop_handler: handler, context_limits: limits });
    const unknown = await routes.handle({ method: "POST", path: "/conversations/messages", headers, body });
    assert.deepEqual([unknown.status, unknown.body.code], [503, "context_limit_unknown"]);
    limits.local.mock = 500;
    const huge = await routes.handle({ method: "POST", path: "/conversations/messages", headers, body: { content: [{ type: "text", text: "x".repeat(1000) }] } });
    assert.deepEqual([huge.status, huge.body.code], [422, "context_overflow"]);
    assert.equal(calls.length, 0);
    limits.local.mock = contextCost([{ role: "user", content: body.content }]) + 8;
    const first = await routes.handle({ method: "POST", path: "/conversations/messages", headers, body });
    await events(first.stream);
    const conversationPath = `/conversations/${first.headers["X-Conversation-ID"]}`;
    const second = await routes.handle({ method: "POST", path: `${conversationPath}/messages`, headers, body });
    const stream = await events(second.stream);
    assert.equal(stream[0].event, "context_notice");
    assert.equal(calls[1].messages.length, 1);
    const detail = await routes.handle({ method: "GET", path: conversationPath });
    assert.equal(detail.body.messages.length, 4);
  } finally { await fsp.rm(memoryRoot, { recursive: true, force: true }); }
});

test("agent loop refuses oversized live tool result before continuation", async () => {
  const calls = [];
  const output = "x".repeat(3000);
  const loop = createAgentLoop({
    context_limits: { local: { mock: 1000 } },
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
    tool_executor: { async executeMany(toolCalls) { return toolCalls.map((tool_call) => ({ ok: true, tool_call, output, content: output })); } },
    model_adapter: { name: "recording", async *stream(request) { calls.push(request); yield { type: "tool-call", delta: { id: "call-1", name: "read", arguments: "{}" } }; yield { type: "done" }; } }
  });
  const stream = await events(loop.run({ messages: [{ role: "user", content: [{ type: "text", text: "read" }] }], metadata: { correlation_id: "corr" }, model: "mock", provider: "local" }));
  assert.equal(calls.length, 1);
  assert.equal(stream.find((event) => event.event === "tool-result").data.output, output);
  assert.deepEqual([stream.at(-1).event, stream.at(-1).data.code], ["error", "context_overflow"]);
});

test("real tool turns validate Agent Loop events and persist canonical tool parts across restart", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "paa-tool-turn-ts-"));
  try {
    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const tool = {
      name: "ext__get_vault_code",
      description: "Return a vault code.",
      parameters: { type: "object", properties: { vault: { type: "string" } }, required: ["vault"] },
      source: "ext",
      source_kind: "mcp"
    };
    let modelTurn = 0;
    const observedAgentLoopEvents = [];
    const baseHandler = createAgentLoopChatHandler({
      tools: [tool],
      model_adapter: {
        name: "tool-turn-recording",
        async *stream() {
          if (modelTurn++ === 0) {
            yield {
              type: "tool-call",
              delta: {
                id: "call-vault-1",
                name: "ext__get_vault_code",
                arguments: JSON.stringify({ vault: "alpha" })
              }
            };
            yield { type: "done" };
            return;
          }
          yield { type: "text-delta", delta: { text: "The vault code is VAULT-ALPHA." } };
          yield { type: "done" };
        }
      },
      tool_executor: {
        async executeMany(toolCalls) {
          return toolCalls.map((tool_call) => ({
            ok: true,
            tool_call,
            output: { code: "VAULT-ALPHA" },
            content: JSON.stringify({ code: "VAULT-ALPHA" })
          }));
        }
      }
    });
    const handler = {
      context_limits: baseHandler.context_limits,
      async *handle(request) {
        for await (const event of baseHandler.handle(request)) {
          observedAgentLoopEvents.push(event);
          yield event;
        }
      }
    };
    const store = createGatewayConversationStore({ memory });
    const routes = createGatewayRoutes({
      conversation_store: store,
      agent_loop_handler: handler,
      current_model: () => "mock",
      current_provider: () => "local"
    });

    const response = await routes.handle({
      method: "POST",
      path: "/conversations/messages",
      headers,
      body
    });
    const publicEvents = await events(response.stream);

    assert.equal(response.status, 200);
    assert.ok(publicEvents.some((event) => event.event === "tool-call"));
    assert.ok(publicEvents.some((event) => event.event === "tool-result"));
    for (const event of observedAgentLoopEvents) {
      const payload = { _event_type: event.event, ...(event.data || {}) };
      if (event.event === "tool-call") {
        assert.equal(typeof payload.id, "string");
        assert.equal(typeof payload.source_id, "string");
        assert.ok(payload.source_id.length > 0);
        assert.equal(typeof payload.name, "string");
        assert.equal(typeof payload.arguments, "object");
      } else if (event.event === "tool-result") {
        assert.equal(typeof payload.id, "string");
        if (payload.output !== undefined) assert.equal(typeof payload.output, "string");
      } else if (event.event === "text-delta") {
        assert.equal(typeof payload.content, "string");
      } else if (event.event === "done") {
        assert.equal(typeof payload.finish_reason, "string");
      } else if (event.event === "error") {
        assert.equal(typeof payload.code, "string");
        assert.equal(typeof payload.message, "string");
      }
    }

    const conversationId = response.headers["X-Conversation-ID"];
    const detail = await routes.handle({ method: "GET", path: `/conversations/${conversationId}` });
    assert.deepEqual(detail.body.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    const toolAssistant = detail.body.messages[1];
    assert.deepEqual(toolAssistant.content.find((part) => part.type === "tool_call"), {
      type: "tool_call",
      id: "call-vault-1",
      source_id: "ext",
      name: "ext__get_vault_code",
      arguments: { vault: "alpha" }
    });
    assert.deepEqual(detail.body.messages[2].content[0], {
      type: "tool_result",
      tool_call_id: "call-vault-1",
      result: { code: "VAULT-ALPHA" }
    });

    const restartedMemory = await createMemoryTools({ memory_root: memoryRoot });
    const restartedRoutes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: restartedMemory }),
      agent_loop_handler: handler,
      current_model: () => "mock",
      current_provider: () => "local"
    });
    const afterRestart = await restartedRoutes.handle({ method: "GET", path: `/conversations/${conversationId}` });
    assert.deepEqual(afterRestart.body.messages, detail.body.messages);
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
});

test("derived context summary is labelled, ephemeral, and kept outside saved messages", async () => {
  const calls = [];
  const original = [{ role: "user", content: [{ type: "text", text: "current" }] }];
  const loop = createAgentLoop({ model_adapter: { name: "recording", async *stream(request) { calls.push(request); yield { type: "done" }; } }, tools: [] });
  await events(loop.run({ messages: original, metadata: { correlation_id: "corr-summary" }, model: "mock", provider: "local",
    context_summary: { source: "gateway", method: "deterministic", omitted_turn_count: 1, text: "older fact" } }));
  assert.equal(original.length, 1);
  assert.equal(calls[0].messages.length, 2);
  assert.match(calls[0].messages[0].content[0].text, /Gateway-derived context/);
  assert.equal(calls[0].messages[1].content[0].text, "current");
});

test("OpenAI-compatible adapter routes by selected profile without fallback", async () => {
  const urls = [];
  const adapter = createOpenAICompatibleAdapter({
    provider_profiles: { alpha: { base_url: "http://alpha.local/v1", model_context_limits: { m1: 8192 } }, beta: { base_url: "http://beta.local/v1", model_context_limits: { m1: 8192 } } },
    fetcher: async (url) => { urls.push(url); return { ok: true, status: 200, statusText: "OK", body: null, text: async () => "", json: async () => ({ choices: [{ delta: { content: "ok" } }] }) }; }
  });
  assert.equal(adapter.context_limits.beta.m1, 8192);
  for (const provider of ["alpha", "beta"]) await events(adapter.stream({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [], stream: true, model: "m1", provider }));
  assert.deepEqual(urls, ["http://alpha.local/v1/chat/completions", "http://beta.local/v1/chat/completions"]);
  await assert.rejects(() => events(adapter.stream({ messages: [], tools: [], stream: true, model: "m1", provider: "missing" })), /Unknown selected provider profile/);
  await assert.rejects(() => events(adapter.stream({ messages: [], tools: [], stream: true, model: "", provider: "alpha" })), /requires model and provider/);
});
