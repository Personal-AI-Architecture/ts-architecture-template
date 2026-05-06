const { installTypeScriptRequire } = require("./ts-require.js");

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";

function readEnv(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

function requireEnv(name) {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function runIndex() {
  const restore = installTypeScriptRequire();
  try {
    const { buildIndex, writeIndexAtomic } = require("../src/tools/corpus/indexer.ts");
    const { createMockAdapter } = require("../src/adapters/mock.ts");
    const { createOpenAICompatibleAdapter } = require("../src/adapters/openai-compatible.ts");

    const corpusRoot = requireEnv("CORPUS_ROOT");
    const provider = readEnv("RUNTIME_PROVIDER_ADAPTER", "openai-compatible").toLowerCase();

    let adapter;
    if (provider === "mock" || provider === "local") {
      adapter = createMockAdapter({ response_text: "Auto-generated mock summary." });
    } else if (provider === "openai-compatible" || provider === "openai") {
      adapter = createOpenAICompatibleAdapter({
        api_base_url: readEnv("OPENAI_API_BASE_URL", DEFAULT_OLLAMA_URL),
        model: readEnv("OPENAI_MODEL", DEFAULT_OLLAMA_MODEL),
        api_key: readEnv("OPENAI_API_KEY", "ollama")
      });
    } else {
      throw new Error(`Unsupported RUNTIME_PROVIDER_ADAPTER: ${provider}`);
    }

    console.error(`Indexing corpus: ${corpusRoot} (provider: ${provider})`);
    const content = await buildIndex({ corpus_root: corpusRoot, model_adapter: adapter });
    await writeIndexAtomic(corpusRoot, content);
    console.error("agent.md written successfully.");
  } finally {
    restore();
  }
}

if (require.main === module) {
  runIndex().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}

module.exports = { runIndex };
