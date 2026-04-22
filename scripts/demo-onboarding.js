const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installTypeScriptRequire } = require('./ts-require.js');

async function runDemoOnboarding() {
  const restore = installTypeScriptRequire();

  try {
    const { createMemoryTools } = require('../src/memory/tools.ts');
    const { createGatewayConversationStore } = require('../src/gateway/conversation-store.ts');
    const { createGatewayRoutes } = require('../src/gateway/routes.ts');

    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-memory-'));

    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const conversationStore = createGatewayConversationStore({ memory });

    const routes = createGatewayRoutes({
      conversation_store: conversationStore,
      engine_handler: {
        async *handle() {
          yield { event: 'text-delta', data: { text: 'hello ' } };
          yield { event: 'text-delta', data: { text: 'from mock stream' } };
          yield { event: 'done', data: { provider: 'mock' } };
        }
      }
    });

    const response = await routes.handle({
      method: 'POST',
      path: '/chat',
      headers: {
        'X-Actor-ID': 'dev-onboarding',
        'X-Actor-Permissions': 'memory:read,memory:write'
      },
      body: {
        content: 'Summarize this architecture template.',
        metadata: {
          channel: 'readme-demo',
          correlation_id: 'corr-readme-demo-001'
        }
      }
    });

    console.log('status:', response.status);
    console.log('stream headers:', response.headers);

    for await (const event of response.stream) {
      console.log('event:', event.event, JSON.stringify(event.data ?? {}));
    }

    const conversationId = response.headers['X-Conversation-ID'];
    const detail = await routes.handle({
      method: 'GET',
      path: `/conversations/${conversationId}`
    });

    console.log('persisted message count:', detail.body.messages.length);
    console.log('memory root used:', memoryRoot);

    fs.rmSync(memoryRoot, { recursive: true, force: true });
  } finally {
    restore();
  }
}

if (require.main === module) {
  runDemoOnboarding().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  runDemoOnboarding
};
