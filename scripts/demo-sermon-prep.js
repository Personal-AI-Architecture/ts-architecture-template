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

const SECTION_SCRIPT = [
  ["topic", "Saying yes to God when comfort says no."],
  ["big_idea", "Obedience opens doors comfort never could."],
  ["anchor_scripture", "Acts 9:1-19 — Saul's calling."],
  ["point_1", "God speaks before we are ready. (anchor scripture). Illustration: my own first 'yes' to ministry."],
  ["point_2", "God's call costs us our preferences. Illustration: walking away from a steady job."],
  ["point_3", "God meets us in the doing. Illustration: the breakthrough at Cranford that I didn't see coming."],
  ["conclusion", "Saying yes is rarely convenient and never wasted."],
  ["call_to_response", "This week, name one place God is calling you to say yes. Tell one person."],
  ["notes", "Possible transitions: from 9:6 'go into the city' to point 1; from 9:15 'chosen instrument' to point 2."]
];

function createScriptedAdapter(sermonSlug) {
  let turn = 0;
  return {
    name: "scripted-sermon-demo",
    async *stream() {
      const current = turn;
      turn += 1;
      if (current < SECTION_SCRIPT.length) {
        const [section, content] = SECTION_SCRIPT[current];
        yield {
          type: "tool-call",
          delta: {
            id: `call-${current + 1}`,
            type: "function",
            name: "update_outline_section",
            arguments: JSON.stringify({ sermon: sermonSlug, section, content })
          }
        };
        yield { type: "done" };
        return;
      }
      yield { type: "text-delta", delta: { text: "Outline complete." } };
      yield { type: "done" };
    }
  };
}

async function runDemoSermonPrep() {
  const args = parseArgs(process.argv);
  const restore = installTypeScriptRequire();

  let sermonRoot;
  let memoryRoot;

  try {
    const { createMemoryTools } = require("../src/memory/tools.ts");
    const { createGatewayConversationStore } = require("../src/gateway/conversation-store.ts");
    const { createGatewayRoutes } = require("../src/gateway/routes.ts");
    const { createEngineChatHandler } = require("../src/engine/index.ts");
    const { createToolExecutor } = require("../src/engine/tool-executor.ts");
    const {
      createUpdateOutlineSectionTool,
      createReadOutlineTool,
      scaffoldOutline,
      parseOutlineSections,
      OUTLINE_SECTIONS
    } = require("../src/tools/sermon/outline.ts");
    const { assembleSermonSystemPrompt } = require("../src/tools/sermon/system-prompt.ts");
    const { createSermonApprovalGate } = require("../src/tools/sermon/approval.ts");
    const { createOpenAICompatibleAdapter } = require("../src/adapters/openai-compatible.ts");

    sermonRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "demo-sermon-prep-root-"));
    memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "demo-sermon-prep-memory-"));

    const sermonSlug = "demo-sermon";
    const sermonDir = path.join(sermonRoot, sermonSlug);
    await fsp.mkdir(sermonDir, { recursive: true });
    await scaffoldOutline(sermonDir);
    await fsp.writeFile(
      path.join(sermonRoot, "congregation.md"),
      "Demo congregation — suburban, mixed ages, mid-Atlantic, current series on Acts."
    );
    await fsp.writeFile(
      path.join(sermonRoot, "voice.md"),
      "Phrases:\n- 'lean in'\n- 'God's not done with you yet'\n"
    );

    const memory = await createMemoryTools({ memory_root: memoryRoot });
    const conversationStore = createGatewayConversationStore({ memory });

    const { definition: updateDef, handler: updateHandler } = createUpdateOutlineSectionTool({
      sermon_root: sermonRoot
    });
    const { definition: readDef, handler: readHandler } = createReadOutlineTool({
      sermon_root: sermonRoot
    });
    const tools = [updateDef, readDef];
    const handlers = {
      [updateDef.function.name]: updateHandler,
      [readDef.function.name]: readHandler
    };

    let adapter;
    if (args.adapter === "stub") {
      adapter = createScriptedAdapter(sermonSlug);
    } else if (args.adapter === "openai-compatible" || args.adapter === "openai") {
      adapter = createOpenAICompatibleAdapter({
        api_base_url: process.env.OPENAI_API_BASE_URL || "https://openrouter.ai/api/v1",
        model: process.env.OPENAI_MODEL || "anthropic/claude-sonnet-4.5",
        api_key: process.env.OPENAI_API_KEY || ""
      });
    } else {
      const { createMockAdapter } = require("../src/adapters/mock.ts");
      adapter = createMockAdapter({});
    }

    const toolExecutor = createToolExecutor({
      tools,
      handlers,
      approval_gate: createSermonApprovalGate()
    });
    const engineChatHandler = createEngineChatHandler({
      model_adapter: adapter,
      tools,
      tool_executor: toolExecutor
    });

    const engineHandler = {
      async *handle(request) {
        const systemPrompt = await assembleSermonSystemPrompt({
          sermon_root: sermonRoot,
          sermon_slug: sermonSlug
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
        yield* engineChatHandler.handle(augmented);
      }
    };

    const routes = createGatewayRoutes({
      conversation_store: conversationStore,
      engine_handler: engineHandler
    });

    let sawDone = false;
    let sawApproval = false;
    const sectionsTouched = new Set();
    const conversationIds = new Set();

    // Drive 9 turns — one per section. For the stub adapter, each turn yields one tool-call.
    for (let i = 0; i < SECTION_SCRIPT.length; i += 1) {
      const expectedSection = SECTION_SCRIPT[i][0];
      const response = await routes.handle({
        method: "POST",
        path: "/chat",
        headers: {
          "X-Actor-ID": "demo-sermon-prep",
          "X-Actor-Permissions": "memory:read,memory:write"
        },
        body: {
          content: `Capture the ${expectedSection} section.`,
          metadata: {
            channel: "demo",
            correlation_id: `corr-demo-${i + 1}`
          }
        }
      });

      console.log(`turn ${i + 1}/${SECTION_SCRIPT.length} status:`, response.status);
      const conversationId = response.headers["X-Conversation-ID"];
      if (conversationId) {
        conversationIds.add(conversationId);
      }

      if (!response.stream) {
        throw new Error(`Smoke failed: turn ${i + 1} produced no stream.`);
      }

      for await (const event of response.stream) {
        const data = event.data ?? {};
        if (event.event === "tool-call" && data.name === "update_outline_section") {
          try {
            const args = JSON.parse(data.arguments);
            sectionsTouched.add(args.section);
          } catch {
            // ignore
          }
        }
        if (event.event === "tool-result" && data.error) {
          throw new Error(`Smoke failed: tool-result error '${data.error}' on turn ${i + 1}`);
        }
        if (event.event === "approval-request") {
          sawApproval = true;
        }
        if (event.event === "done") {
          sawDone = true;
        }
      }
    }

    const parsed = await parseOutlineSections(sermonDir);
    console.log("\n=== assertions ===");
    console.log("sections touched:", Array.from(sectionsTouched).sort().join(", "));
    console.log("approval-request observed:", sawApproval);
    console.log("done observed:", sawDone);

    if (!sawDone) {
      throw new Error("Smoke failed: no done event observed.");
    }
    if (args.adapter === "stub" && !sawApproval) {
      throw new Error("Smoke failed: approval-request event not observed (auto-approval audit visibility check).");
    }
    for (const [section] of SECTION_SCRIPT) {
      if (parsed[section].length === 0) {
        throw new Error(`Smoke failed: section '${section}' is empty.`);
      }
      if (!sectionsTouched.has(section)) {
        throw new Error(`Smoke failed: section '${section}' was never written.`);
      }
    }

    console.log("\nsmoke OK — outline.md fully populated, all", SECTION_SCRIPT.length, "sections updated through the auto-approving sermon gate.");
  } finally {
    restore();
    if (sermonRoot) {
      fs.rmSync(sermonRoot, { recursive: true, force: true });
    }
    if (memoryRoot) {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  runDemoSermonPrep().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}

module.exports = { runDemoSermonPrep };
