const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { installTypeScriptRequire } = require("./ts-require.js");

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";
const DEFAULT_BIND_ADDRESS = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_ACTOR_ID = "local-user";
const DEFAULT_ACTOR_PERMISSIONS = "memory:read,memory:write";
const AGENT_INDEX_FILENAME = "agent.md";

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

function buildAdapter(provider, deps) {
  const normalized = provider.toLowerCase();
  if (normalized === "mock" || normalized === "local") {
    return deps.createMockAdapter({});
  }
  if (normalized === "openai-compatible" || normalized === "openai") {
    return deps.createOpenAICompatibleAdapter({
      api_base_url: readEnv("OPENAI_API_BASE_URL", DEFAULT_OLLAMA_URL),
      model: readEnv("OPENAI_MODEL", DEFAULT_OLLAMA_MODEL),
      api_key: readEnv("OPENAI_API_KEY", "ollama")
    });
  }
  throw new Error(`Unsupported RUNTIME_PROVIDER_ADAPTER: ${provider}`);
}

function injectActorHeaders(request) {
  const headers = { ...(request.headers ?? {}) };
  if (!headers["X-Actor-ID"] && !headers["x-actor-id"]) {
    headers["X-Actor-ID"] = DEFAULT_ACTOR_ID;
  }
  if (!headers["X-Actor-Permissions"] && !headers["x-actor-permissions"]) {
    headers["X-Actor-Permissions"] = DEFAULT_ACTOR_PERMISSIONS;
  }
  return { ...request, headers };
}

function withSystemPromptInjection(engineHandler, getIndexBody) {
  return {
    async *handle(request) {
      const indexBody = await getIndexBody();
      const augmented = {
        ...request,
        body: {
          ...request.body,
          messages: [
            {
              role: "system",
              content: [
                "You answer questions about the user's markdown notes.",
                "Below is an index of the available files. Use the read_file tool to load a file's full content if you need it.",
                "Always cite the file paths you read in your answer.",
                "",
                indexBody
              ].join("\n")
            },
            ...request.body.messages
          ]
        }
      };
      yield* engineHandler.handle(augmented);
    }
  };
}

function wrapRoutesWithLocalhostAuth(routes) {
  return {
    async handle(request) {
      const augmented = injectActorHeaders(request);
      return routes.handle(augmented);
    }
  };
}

async function readIndexBody(corpusRoot) {
  try {
    return await fsp.readFile(path.join(corpusRoot, AGENT_INDEX_FILENAME), "utf8");
  } catch (cause) {
    return "[Document index not yet generated.]";
  }
}

async function buildApplication(deps) {
  const corpusRoot = requireEnv("CORPUS_ROOT");
  try {
    const stat = await fsp.stat(corpusRoot);
    if (!stat.isDirectory()) {
      throw new Error(`CORPUS_ROOT is not a directory: ${corpusRoot}`);
    }
  } catch (cause) {
    if (cause && cause.code === "ENOENT") {
      throw new Error(`CORPUS_ROOT does not exist: ${corpusRoot}`);
    }
    throw cause;
  }

  const memoryRoot = readEnv(
    "MEMORY_ROOT",
    path.resolve(process.cwd(), ".runtime-memory", "chat-with-docs")
  );
  await fsp.mkdir(memoryRoot, { recursive: true });

  const provider = readEnv("RUNTIME_PROVIDER_ADAPTER", "openai-compatible");
  const adapter = buildAdapter(provider, deps);

  console.error(`Indexing corpus: ${corpusRoot}`);
  const indexResult = await deps.ensureCorpusIndex({
    corpus_root: corpusRoot,
    model_adapter: adapter
  });
  console.error(
    indexResult.regenerated ? "agent.md regenerated" : "agent.md already fresh; skipping regeneration"
  );

  const memory = await deps.createMemoryTools({ memory_root: memoryRoot });
  const conversationStore = deps.createGatewayConversationStore({ memory });

  const { definition: readFileDefinition, handler: readFileHandler } = deps.createReadFileTool({
    corpus_root: corpusRoot
  });
  const tools = [readFileDefinition];
  const handlers = { [readFileDefinition.function.name]: readFileHandler };
  const toolExecutor = deps.createToolExecutor({ tools, handlers });
  const engineChatHandler = deps.createEngineChatHandler({
    model_adapter: adapter,
    tools,
    tool_executor: toolExecutor
  });

  const wrappedEngineHandler = withSystemPromptInjection(engineChatHandler, () =>
    readIndexBody(corpusRoot)
  );

  const routes = deps.createGatewayRoutes({
    conversation_store: conversationStore,
    engine_handler: wrappedEngineHandler
  });

  const localhostAuthRoutes = wrapRoutesWithLocalhostAuth(routes);

  return {
    corpusRoot,
    memoryRoot,
    routes: localhostAuthRoutes
  };
}

async function startApplication() {
  const restore = installTypeScriptRequire();
  try {
    const { createMemoryTools } = require("../src/memory/tools.ts");
    const { createGatewayConversationStore } = require("../src/gateway/conversation-store.ts");
    const { createGatewayRoutes } = require("../src/gateway/routes.ts");
    const { createEngineChatHandler } = require("../src/engine/index.ts");
    const { createToolExecutor } = require("../src/engine/tool-executor.ts");
    const { createReadFileTool } = require("../src/tools/corpus/read-file.ts");
    const { createMockAdapter } = require("../src/adapters/mock.ts");
    const { createOpenAICompatibleAdapter } = require("../src/adapters/openai-compatible.ts");
    const { ensureCorpusIndex } = require("../src/tools/corpus/indexer.ts");
    const { createHttpListener } = require("../src/gateway/http-listener.ts");

    const app = await buildApplication({
      createMemoryTools,
      createGatewayConversationStore,
      createGatewayRoutes,
      createEngineChatHandler,
      createToolExecutor,
      createReadFileTool,
      createMockAdapter,
      createOpenAICompatibleAdapter,
      ensureCorpusIndex
    });

    const bindAddress = readEnv("BIND_ADDRESS", DEFAULT_BIND_ADDRESS);
    const port = Number(readEnv("PORT", String(DEFAULT_PORT)));
    const allowNonLocalBind = readEnv("ALLOW_NON_LOCAL_BIND", "") === "true";

    const listener = createHttpListener({
      routes: app.routes,
      bind_address: bindAddress,
      port,
      allow_non_local_bind: allowNonLocalBind
    });

    const address = await listener.start();
    console.error(`Listening on http://${address.address}:${address.port}/`);
    console.error(`Open this URL in a browser to chat with notes in: ${app.corpusRoot}`);

    const shutdown = async (signal) => {
      console.error(`Received ${signal}; shutting down.`);
      await listener.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    return { listener, address, app };
  } catch (error) {
    restore();
    throw error;
  }
}

if (require.main === module) {
  startApplication().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}

module.exports = { startApplication, buildApplication };
