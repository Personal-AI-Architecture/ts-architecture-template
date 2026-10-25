#!/usr/bin/env node
const http = require('node:http');
const { installTypeScriptRequire } = require('./ts-require.js');
installTypeScriptRequire();

const { loadRuntimeConfiguration } = require('../src/config/loader.ts');
const { loadModelAdapter } = require('../src/adapters/loader.ts');
const { createEngineChatHandler } = require('../src/engine/index.ts');
const { createMemoryTools } = require('../src/memory/tools.ts');
const { createGatewayConversationStore } = require('../src/gateway/conversation-store.ts');
const { createGatewayRoutes } = require('../src/gateway/routes.ts');
const { createAuthProvider } = require('../src/auth/provider.ts');
const { createAuthMiddleware } = require('../src/auth/middleware.ts');

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_DRAIN_BYTES = 4 * 1024 * 1024;

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function main() {
  const token = process.env.PAA_DEMO_API_KEY;
  if (!token) throw new Error('Set PAA_DEMO_API_KEY to a local test token before starting.');
  const runtime = loadRuntimeConfiguration();
  if (runtime.auth_mode !== 'enforced') throw new Error('The HTTP starter requires enforced Auth.');
  const external = runtime.provider_adapter === 'openai-compatible';
  if (external && (!process.env.PAA_MODEL_API_BASE_URL || !process.env.PAA_MODEL_ID || !process.env.PAA_MODEL_CONTEXT_LIMIT)) {
    throw new Error('OpenAI-compatible mode requires PAA_MODEL_API_BASE_URL, PAA_MODEL_ID, and PAA_MODEL_CONTEXT_LIMIT.');
  }
  const modelAdapter = loadModelAdapter({
    runtime,
    ...(runtime.provider_adapter === 'openai-compatible' ? {
      openai_compatible: {
        api_base_url: process.env.PAA_MODEL_API_BASE_URL,
        model: process.env.PAA_MODEL_ID,
        api_key: process.env.PAA_MODEL_API_KEY
      }
    } : {})
  });
  const memory = await createMemoryTools({ memory_root: runtime.memory_root });
  const store = createGatewayConversationStore({ memory });
  const contextLimits = external ? { local: { [process.env.PAA_MODEL_ID]: Number(process.env.PAA_MODEL_CONTEXT_LIMIT) } } : undefined;
  const routes = createGatewayRoutes({
    conversation_store: store,
    engine_handler: createEngineChatHandler({ model_adapter: modelAdapter, tools: [], ...(contextLimits ? { context_limits: contextLimits } : {}) }),
    current_model: () => external ? process.env.PAA_MODEL_ID : 'mock',
    current_provider: () => 'local',
    ...(contextLimits ? { context_limits: contextLimits } : {})
  });
  const authProvider = await createAuthProvider({
    state_root: runtime.memory_root,
    auth_mode: runtime.auth_mode,
    seed_actors: [{ actor_id: 'local-owner', token, permissions: ['*'] }]
  });
  const authenticate = createAuthMiddleware({ provider: authProvider, default_protected: true });
  const host = process.env.PAA_HOST || '127.0.0.1';
  const port = Number(process.env.PAA_PORT || '8000');
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok', architecture: 'PAA' });
      return;
    }
    try {
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) =>
        !['x-actor-id', 'x-actor-permissions'].includes(name.toLowerCase())));
      const authorized = await authenticate({ method: request.method, path: request.url, headers });
      let body;
      if (request.method === 'POST') {
        const contentLength = Number(request.headers['content-length']);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          sendJson(response, 411, { code: 'length_required', message: 'Content-Length required.' });
          return;
        }
        if (contentLength > MAX_REQUEST_BYTES) {
          let drained = 0;
          for await (const chunk of request) {
            drained += chunk.length;
            if (drained > MAX_DRAIN_BYTES) break;
          }
          sendJson(response, 413, { code: 'request_too_large', message: 'Request body too large.' });
          return;
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > MAX_REQUEST_BYTES) {
            sendJson(response, 413, { code: 'request_too_large', message: 'Request body too large.' });
            return;
          }
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { sendJson(response, 400, { code: 'invalid_request', message: 'Malformed JSON.' }); return; }
      }
      const routed = await routes.handle({ method: request.method, path: request.url, headers: authorized.request.headers, body });
      response.writeHead(routed.status, routed.headers);
      if (!routed.stream) { response.end(JSON.stringify(routed.body ?? {})); return; }
      for await (const event of routed.stream) {
        response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`);
      }
      response.end();
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error && typeof error.status_code === 'number') {
        sendJson(response, error.status_code, { code: error.error_code, message: error.message });
      } else {
        console.error(error);
        sendJson(response, 500, { code: 'internal_error', message: 'Gateway request failed.' });
      }
    }
  });
  server.listen(port, host, () => console.log(`PAA TypeScript starter listening at http://${host}:${port}`));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
