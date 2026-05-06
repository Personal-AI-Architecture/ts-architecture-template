const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { installTypeScriptRequire } = require("./ts-require.js");

const ADAPTER_MODES = new Set(["stub", "openai-compatible", "openai", "mock", "local"]);

function parseArgs(argv) {
  const out = { adapter: process.env.RUNTIME_PROVIDER_ADAPTER || "stub" };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--adapter=")) {
      out.adapter = arg.slice("--adapter=".length).toLowerCase();
    }
  }
  if (!ADAPTER_MODES.has(out.adapter)) {
    throw new Error(`Unsupported --adapter: ${out.adapter}`);
  }
  return out;
}

async function setupFixtureCorpus() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-with-docs-fixture-"));
  await fsp.writeFile(
    path.join(root, "architecture.md"),
    "# Architecture\n\nFour-component PAA model: Memory, Agent Loop, Auth, Gateway.\n"
  );
  await fsp.writeFile(
    path.join(root, "meeting.md"),
    "# Meeting 2026-04-02\n\nDecided to prototype the markdown chat feature.\n"
  );
  const indexBody = [
    "# Document Index",
    "",
    "Generated: 2026-05-06T00:00:00.000Z",
    `Source: ${root}`,
    "Files: 2",
    "",
    "## architecture.md",
    "",
    "Notes about the four-component PAA model.",
    "",
    "## meeting.md",
    "",
    "Decisions from the 2026-04-02 meeting about the chat prototype.",
    ""
  ].join("\n");
  await fsp.writeFile(path.join(root, "agent.md"), indexBody);
  return root;
}

function createScriptedToolCallingAdapter() {
  let turn = 0;
  return {
    name: "scripted-stub",
    async *stream() {
      const current = turn;
      turn += 1;
      if (current === 0) {
        yield {
          type: "tool-call",
          delta: {
            id: "call-1",
            type: "function",
            name: "read_file",
            arguments: JSON.stringify({ path: "architecture.md" })
          }
        };
        yield { type: "done" };
        return;
      }
      yield {
        type: "text-delta",
        delta: {
          text:
            "Based on architecture.md, the system has four components: Memory, Agent Loop, Auth, and Gateway."
        }
      };
      yield { type: "done" };
    }
  };
}

async function runDemoChatWithDocs() {
  const args = parseArgs(process.argv);
  const restore = installTypeScriptRequire();

  let memoryRoot;
  let corpusRoot;

  try {
    const { createMemoryTools } = require("../src/memory/tools.ts");
    const { createGatewayConversationStore } = require("../src/gateway/conversation-store.ts");
    const { createGatewayRoutes } = require("../src/gateway/routes.ts");
    const { createAgentLoop, createEngineChatHandler } = require("../src/engine/index.ts");
    const { createToolExecutor } = require("../src/engine/tool-executor.ts");
    const { createReadFileTool } = require("../src/tools/corpus/read-file.ts");
    const { createOpenAICompatibleAdapter } = require("../src/adapters/openai-compatible.ts");

    memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-with-docs-memory-"));
    corpusRoot = await setupFixtureCorpus();

    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const conversationStore = createGatewayConversationStore({ memory });

    const { definition: readFileDefinition, handler: readFileHandler } = createReadFileTool({
      corpus_root: corpusRoot
    });

    const tools = [readFileDefinition];
    const handlers = { [readFileDefinition.function.name]: readFileHandler };

    let adapter;
    if (args.adapter === "stub") {
      adapter = createScriptedToolCallingAdapter();
    } else if (args.adapter === "openai-compatible" || args.adapter === "openai") {
      adapter = createOpenAICompatibleAdapter({
        api_base_url: process.env.OPENAI_API_BASE_URL || "http://127.0.0.1:11434/v1",
        model: process.env.OPENAI_MODEL || "qwen2.5:7b",
        api_key: process.env.OPENAI_API_KEY || "ollama"
      });
    } else {
      const { createMockAdapter } = require("../src/adapters/mock.ts");
      adapter = createMockAdapter({});
    }

    const toolExecutor = createToolExecutor({ tools, handlers });
    const engineChatHandler = createEngineChatHandler({
      model_adapter: adapter,
      tools,
      tool_executor: toolExecutor
    });

    const indexBody = await fsp.readFile(path.join(corpusRoot, "agent.md"), "utf8");

    const engineHandler = {
      async *handle(request) {
        const augmented = {
          ...request,
          body: {
            ...request.body,
            messages: [
              {
                role: "system",
                content: [
                  "You can answer questions about the user's markdown notes.",
                  "Below is an index of the available files. Use the read_file tool to load a file's full content if needed.",
                  "Cite the file path you read in your answer.",
                  "",
                  indexBody
                ].join("\n")
              },
              ...request.body.messages
            ]
          }
        };
        yield* engineChatHandler.handle(augmented);
      }
    };

    const routes = createGatewayRoutes({
      conversation_store: conversationStore,
      engine_handler: engineHandler
    });

    const response = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: {
        "X-Actor-ID": "demo-chat-with-docs",
        "X-Actor-Permissions": "memory:read,memory:write"
      },
      body: {
        content: "What components does the architecture have?",
        metadata: {
          channel: "demo",
          correlation_id: `corr-demo-${Date.now()}`
        }
      }
    });

    console.log("status:", response.status);
    console.log("conversation id:", response.headers["X-Conversation-ID"]);

    let sawToolCall = false;
    let sawToolResult = false;
    let sawDone = false;
    let textBuffer = "";

    if (response.stream) {
      for await (const event of response.stream) {
        const data = event.data ?? {};
        console.log("event:", event.event, JSON.stringify(data));
        if (event.event === "tool-call" && data.name === "read_file") {
          sawToolCall = true;
        }
        if (event.event === "tool-result" && data.name === "read_file") {
          sawToolResult = true;
        }
        if (event.event === "text-delta" && typeof data.text === "string") {
          textBuffer += data.text;
        }
        if (event.event === "done") {
          sawDone = true;
        }
      }
    }

    console.log("\nfinal text:", textBuffer);
    console.log("assertions:", { sawToolCall, sawToolResult, sawDone });

    if (!sawDone) {
      throw new Error("Smoke failed: no done event observed.");
    }
    if (args.adapter === "stub" && (!sawToolCall || !sawToolResult)) {
      throw new Error("Smoke failed: scripted stub should produce tool-call and tool-result.");
    }

    console.log("smoke OK");
  } finally {
    restore();
    if (memoryRoot) {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
    }
    if (corpusRoot) {
      fs.rmSync(corpusRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  runDemoChatWithDocs().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}

module.exports = { runDemoChatWithDocs };
