const { installTypeScriptRequire } = require('./ts-require.js');

function runDemoProviderSwap() {
  const restore = installTypeScriptRequire();

  try {
    const { loadRuntimeConfiguration } = require('../src/config/loader.ts');
    const { loadModelAdapter } = require('../src/adapters/loader.ts');

    const localRuntime = loadRuntimeConfiguration({
      env: {
        RUNTIME_PROVIDER_ADAPTER: 'local',
        RUNTIME_MEMORY_ROOT: '/tmp/template-memory-local'
      },
      cwd: process.cwd()
    });
    const localAdapter = loadModelAdapter({ runtime: localRuntime });

    const openaiRuntime = loadRuntimeConfiguration({
      env: {
        RUNTIME_PROVIDER_ADAPTER: 'openai-compatible',
        RUNTIME_MEMORY_ROOT: '/tmp/template-memory-openai'
      },
      cwd: process.cwd()
    });
    const openaiAdapter = loadModelAdapter({
      runtime: openaiRuntime,
      openai_compatible: {
        api_base_url: 'http://provider.local/v1',
        model: 'gpt-test',
        fetcher: async () => {
          throw new Error('not-called');
        }
      }
    });

    console.log('local ->', localAdapter.name);
    console.log('openai-compatible ->', openaiAdapter.name);
  } finally {
    restore();
  }
}

if (require.main === module) {
  try {
    runDemoProviderSwap();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = {
  runDemoProviderSwap
};
