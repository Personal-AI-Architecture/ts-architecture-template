const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { installTypeScriptRequire } = require("./ts-require.js");

const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_BIND_ADDRESS = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_ACTOR_ID = "local-pastor";
const DEFAULT_ACTOR_PERMISSIONS = "memory:read,memory:write";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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

function resolveSermonRoot() {
  const fallback = path.join(os.homedir(), "SermonPrep");
  return readEnv("SERMON_ROOT", fallback);
}

function assertSlug(value) {
  if (!SLUG_PATTERN.test(value)) {
    throw new Error(
      `Invalid sermon slug '${value}'. Slugs must match /^[a-z0-9][a-z0-9-]*$/.`
    );
  }
}

function buildAdapter(provider, deps) {
  const normalized = provider.toLowerCase();
  if (normalized === "mock" || normalized === "local") {
    return deps.createMockAdapter({});
  }
  if (normalized === "openai-compatible" || normalized === "openai") {
    return deps.createOpenAICompatibleAdapter({
      api_base_url: readEnv("OPENAI_API_BASE_URL", DEFAULT_OPENROUTER_URL),
      model: readEnv("OPENAI_MODEL", DEFAULT_OPENROUTER_MODEL),
      api_key: readEnv("OPENAI_API_KEY", "")
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

function withSermonSystemPrompt(engineHandler, deps, opts) {
  return {
    async *handle(request) {
      const systemPrompt = await deps.assembleSermonSystemPrompt({
        sermon_root: opts.sermon_root,
        sermon_slug: opts.sermon_slug,
        edit_tracker: opts.edit_tracker
      });
      const augmented = {
        ...request,
        body: {
          ...request.body,
          messages: [
            { role: "system", content: systemPrompt },
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

function wrapRoutesWithOutlineEndpoint(routes, outlineHandler) {
  return {
    async handle(request) {
      const intercepted = await outlineHandler(request);
      if (intercepted) {
        return intercepted;
      }
      return routes.handle(request);
    }
  };
}

function injectSermonSlugIntoHtml(html, slug) {
  const safeSlug = JSON.stringify(slug);
  return html.replace(
    "<script>",
    `<script>window.__SERMON_SLUG__ = ${safeSlug};</script>\n<script>`
  );
}

async function buildApplication(deps) {
  const sermonRoot = resolveSermonRoot();
  const sermonSlug = requireEnv("SERMON");
  assertSlug(sermonSlug);

  await fsp.mkdir(sermonRoot, { recursive: true });
  const sermonDir = path.join(sermonRoot, sermonSlug);
  await fsp.mkdir(sermonDir, { recursive: true });
  await deps.scaffoldOutline(sermonDir);

  const provider = readEnv("RUNTIME_PROVIDER_ADAPTER", "openai-compatible");
  const adapter = buildAdapter(provider, deps);

  const memoryRoot = readEnv(
    "MEMORY_ROOT",
    path.resolve(process.cwd(), ".runtime-memory", "sermon-prep")
  );
  await fsp.mkdir(memoryRoot, { recursive: true });
  const memory = await deps.createMemoryTools({ memory_root: memoryRoot });
  const conversationStore = deps.createGatewayConversationStore({ memory });

  const editTracker = deps.createEditTracker();

  const { definition: updateDef, handler: updateHandler } = deps.createUpdateOutlineSectionTool({
    sermon_root: sermonRoot,
    edit_tracker: editTracker
  });
  const { definition: readDef, handler: readHandler } = deps.createReadOutlineTool({
    sermon_root: sermonRoot
  });

  const tools = [updateDef, readDef];
  const handlers = {
    [updateDef.function.name]: updateHandler,
    [readDef.function.name]: readHandler
  };

  const toolExecutor = deps.createToolExecutor({
    tools,
    handlers,
    approval_gate: deps.createSermonApprovalGate()
  });

  const engineChatHandler = deps.createEngineChatHandler({
    model_adapter: adapter,
    tools,
    tool_executor: toolExecutor
  });

  const wrappedEngineHandler = withSermonSystemPrompt(engineChatHandler, deps, {
    sermon_root: sermonRoot,
    sermon_slug: sermonSlug,
    edit_tracker: editTracker
  });

  const routes = deps.createGatewayRoutes({
    conversation_store: conversationStore,
    engine_handler: wrappedEngineHandler,
    static_html: injectSermonSlugIntoHtml(deps.STATIC_SERMON_PREP_HTML, sermonSlug)
  });

  const outlineHandler = deps.createOutlineRouteHandler({
    sermon_root: sermonRoot,
    edit_tracker: editTracker
  });
  const routesWithOutline = wrapRoutesWithOutlineEndpoint(routes, outlineHandler);
  const localhostAuthRoutes = wrapRoutesWithLocalhostAuth(routesWithOutline);

  return {
    sermonRoot,
    sermonSlug,
    sermonDir,
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
    const {
      createUpdateOutlineSectionTool,
      createReadOutlineTool,
      scaffoldOutline
    } = require("../src/tools/sermon/outline.ts");
    const { assembleSermonSystemPrompt } = require("../src/tools/sermon/system-prompt.ts");
    const { createSermonApprovalGate } = require("../src/tools/sermon/approval.ts");
    const { createOutlineRouteHandler } = require("../src/tools/sermon/outline-route.ts");
    const { createEditTracker } = require("../src/tools/sermon/edit-tracker.ts");
    const { createMockAdapter } = require("../src/adapters/mock.ts");
    const { createOpenAICompatibleAdapter } = require("../src/adapters/openai-compatible.ts");
    const { createHttpListener } = require("../src/gateway/http-listener.ts");
    const { STATIC_SERMON_PREP_HTML } = require("../src/gateway/static-sermon-prep.ts");

    const app = await buildApplication({
      createMemoryTools,
      createGatewayConversationStore,
      createGatewayRoutes,
      createEngineChatHandler,
      createToolExecutor,
      createUpdateOutlineSectionTool,
      createReadOutlineTool,
      scaffoldOutline,
      assembleSermonSystemPrompt,
      createSermonApprovalGate,
      createOutlineRouteHandler,
      createEditTracker,
      createMockAdapter,
      createOpenAICompatibleAdapter,
      STATIC_SERMON_PREP_HTML
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
    console.error(`Sermon: ${app.sermonSlug} (folder: ${app.sermonDir})`);
    console.error(`Listening on http://${address.address}:${address.port}/`);

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
