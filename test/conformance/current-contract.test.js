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
