#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
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
  let profiles;
  if (external) {
    if (process.env.PAA_ADAPTER_CONFIG_FILE) {
      profiles = JSON.parse(fs.readFileSync(process.env.PAA_ADAPTER_CONFIG_FILE, 'utf8')).provider_profiles;
    } else if (process.env.PAA_MODEL_PROFILES_JSON) {
      profiles = JSON.parse(process.env.PAA_MODEL_PROFILES_JSON);
    } else if (process.env.PAA_MODEL_API_BASE_URL && process.env.PAA_MODEL_ID && process.env.PAA_MODEL_CONTEXT_LIMIT) {
      profiles = { local: { base_url: process.env.PAA_MODEL_API_BASE_URL, api_key_env: 'PAA_MODEL_API_KEY',
        model_context_limits: { [process.env.PAA_MODEL_ID]: Number(process.env.PAA_MODEL_CONTEXT_LIMIT) } } };
    }
    if (!profiles || !Object.keys(profiles).length) throw new Error('OpenAI-compatible mode requires provider profiles.');
  }
  const modelAdapter = loadModelAdapter({
    runtime,
    ...(runtime.provider_adapter === 'openai-compatible' ? {
      openai_compatible: { provider_profiles: profiles }
    } : {})
  });
  const memory = await createMemoryTools({ memory_root: runtime.memory_root,
    approvals: { decide: request => request.metadata?.key === 'preferences'
      ? { approved: true, reason: 'Owner preference update.' } : false } });
  const defaultProvider = process.env.PAA_DEFAULT_PROVIDER || (external ? Object.keys(profiles)[0] : 'local');
  const defaultModel = process.env.PAA_MODEL_ID || (external ? Object.keys(profiles[defaultProvider]?.model_context_limits || {})[0] : 'mock');
  if (!defaultModel) throw new Error('Configure a default model in the selected provider profile.');
  if (!(await memory.read('preferences'))) {
    await memory.write('preferences', { model: defaultModel, active_provider_profile: defaultProvider });
  }
  const store = createGatewayConversationStore({ memory });
  const contextLimits = external ? Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, profile.model_context_limits])) : undefined;
  const routes = createGatewayRoutes({
    conversation_store: store,
    engine_handler: createEngineChatHandler({ model_adapter: modelAdapter, tools: [], ...(contextLimits ? { context_limits: contextLimits } : {}) }),
    current_selection: async () => {
      const record = await memory.read('preferences');
      const value = record?.value;
      if (!value || typeof value.model !== 'string' || typeof value.active_provider_profile !== 'string') {
        throw new Error('Model or provider preference missing.');
      }
      return { model: value.model, provider: value.active_provider_profile };
    },
    ...(contextLimits ? { context_limits: contextLimits } : {})
  });
  const authProvider = await createAuthProvider({
    state_root: process.env.PAA_AUTH_STATE_ROOT || `${runtime.memory_root}-auth`,
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
      if (request.method === 'POST' || request.method === 'PUT') {
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
      if (request.url === '/owner/preferences') {
        if (request.method === 'GET') {
          const record = await memory.read('preferences');
          sendJson(response, record ? 200 : 503, record?.value ?? { code: 'selection_unavailable', message: 'Preferences unavailable.' });
          return;
        }
        if (request.method === 'PUT') {
          if (!body || typeof body.model !== 'string' || !body.model ||
              typeof body.active_provider_profile !== 'string' || !body.active_provider_profile) {
            sendJson(response, 400, { code: 'invalid_request', message: 'Model and active_provider_profile are required.' });
            return;
          }
          await memory.write('preferences', { model: body.model, active_provider_profile: body.active_provider_profile });
          sendJson(response, 200, { model: body.model, active_provider_profile: body.active_provider_profile });
          return;
        }
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
