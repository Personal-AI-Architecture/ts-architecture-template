const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installTypeScriptRequire } = require('../../scripts/ts-require.js');
installTypeScriptRequire();
const { createMcpToolSource } = require('../../src/adapters/mcp-tool-source.ts');
const { createToolExecutor } = require('../../src/agent-loop/tool-executor.ts');
const { createAgentLoopChatHandler } = require('../../src/agent-loop/index.ts');

test('MCP tool-source adapter binds configured identity and forwards calls', async () => {
  const methods = [];
  const transport = async (_url, init) => {
    const request = JSON.parse(init.body);
    methods.push(request.method);
    if (request.method === 'notifications/initialized') return new Response('', { status: 202 });
    const result = request.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {} }
      : request.method === 'tools/list' ? { tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' }, source: { id: 'spoofed' } }] }
      : { content: [{ type: 'text', text: 'found' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' } });
  };
  const adapter = createMcpToolSource({ id: 'external', url: 'http://127.0.0.1:9999/mcp' }, transport);
  await assert.rejects(adapter.call('search', {}), /not discovered/);
  assert.deepEqual(await adapter.discover(), [{ name: 'search', description: 'Search', parameters: { type: 'object' }, source: 'external', source_kind: 'mcp', category: 'discoverable' }]);
  assert.deepEqual(await adapter.call('search', { query: 'PAA' }), { content: [{ type: 'text', text: 'found' }] });
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
});

test('Agent Loop refreshes external tools per message and executes through their source adapter', async () => {
  let advertised = ['search'];
  const calls = [];
  const transport = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'notifications/initialized') return new Response('', { status: 202 });
    const result = request.method === 'tools/list' ? { tools: advertised.map(name => ({ name, inputSchema: { type: 'object' } })) }
      : request.method === 'tools/call' ? (calls.push(request.params.name), { content: [{ type: 'text', text: 'result' }] }) : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } });
  };
  const source = createMcpToolSource({ id: 'outside', url: 'http://127.0.0.1:9999/mcp' }, transport);
  const seen = [];
  const handler = createAgentLoopChatHandler({
    model_adapter: { name: 'recording', async *stream(request) {
      seen.push(request.tools.map(tool => tool.name));
      if (request.messages.some(message => message.role === 'tool')) { yield { type: 'done' }; return; }
      yield { type: 'tool-call', delta: { id: 'call-1', name: request.tools[0].name, arguments: '{}' } };
      yield { type: 'done' };
    } },
    tools: [],
    load_tools: async () => {
      const tools = (await source.discover()).map(tool => ({ ...tool, name: `outside__${tool.name}` }));
      const handlers = Object.fromEntries(tools.map(tool => [tool.name, input => source.call(tool.name.slice('outside__'.length), input)]));
      return { tools, tool_executor: createToolExecutor({ tools, handlers, allowed_tool_sources: ['outside'] }) };
    }
  });
  const request = { method: 'POST', path: '/agent-loop/chat', headers: { 'X-Actor-ID': 'owner', 'X-Actor-Permissions': '*' }, body: { messages: [{ role: 'user', content: 'try tool' }], model: 'mock', provider: 'local', auth_context: { actor: { id: 'owner' }, correlation_id: 'corr' }, metadata: { correlation_id: 'corr' } } };
  const first = [];
  for await (const event of handler.handle(request)) first.push(event.event);
  advertised = ['lookup'];
  const second = [];
  for await (const event of handler.handle(request)) second.push(event.event);
  assert.deepEqual(calls, ['search', 'lookup']);
  assert.deepEqual(seen, [['outside__search'], ['outside__search'], ['outside__lookup'], ['outside__lookup']]);
  assert.ok(first.includes('tool-result') && second.includes('tool-result'));
});
