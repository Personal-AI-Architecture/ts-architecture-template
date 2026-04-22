// @ts-nocheck

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOT = process.cwd();

const REQUIRED_FILES = [
  "src/adapters/loader.ts",
  "src/adapters/mock.ts",
  "src/adapters/openai-compatible.ts",
  "src/engine/index.ts",
  "src/types/contracts.ts"
];

const FORBIDDEN_ENGINE_METADATA_KEYS = ["provider", "provider_adapter", "model", "tools", "tool_sources"];

const PROVIDER_LOCKIN_TOKENS = ["/chat/completions", "api_base_url", "api_key", "openai-compatible"];

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function listTypeScriptFiles(directory) {
  const output = [];
  if (!fs.existsSync(directory)) {
    return output;
  }

  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        output.push(fullPath);
      }
    }
  }

  return output;
}

function ensureFile(relativePath, errors) {
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`Missing required file: ${relativePath}`);
  }
}

function readFile(relativePath, errors) {
  const absolutePath = path.join(ROOT, relativePath);
  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    errors.push(`Unable to read ${relativePath}: ${error.message}`);
    return "";
  }
}

function checkLoaderWiring(loaderSource, errors) {
  if (!/provider_adapter/.test(loaderSource)) {
    errors.push("Adapter loader must select provider based on runtime.provider_adapter.");
  }
  if (!/createMockAdapter/.test(loaderSource)) {
    errors.push("Adapter loader must wire the mock adapter.");
  }
  if (!/createOpenAICompatibleAdapter/.test(loaderSource)) {
    errors.push("Adapter loader must wire the OpenAI-compatible adapter.");
  }
}

function checkContractsRuntimeConfig(contractsSource, errors) {
  if (!/interface\s+RuntimeConfiguration/.test(contractsSource)) {
    errors.push("RuntimeConfiguration contract is missing.");
    return;
  }

  if (!/\bprovider_adapter:\s*string\b/.test(contractsSource)) {
    errors.push("RuntimeConfiguration must include provider_adapter for config-driven provider swap.");
  }
}

function checkEngineMetadata(contractsSource, errors) {
  const metadataMatch = contractsSource.match(
    /export\s+interface\s+EngineRequestMetadata\s*\{([\s\S]*?)\n\}/m
  );

  if (!metadataMatch) {
    errors.push("EngineRequestMetadata contract is missing.");
    return;
  }

  const block = metadataMatch[1];
  for (const forbiddenKey of FORBIDDEN_ENGINE_METADATA_KEYS) {
    const pattern = new RegExp(`\\b${forbiddenKey}\\s*\\??\\s*:`, "m");
    if (pattern.test(block)) {
      errors.push(`EngineRequestMetadata must not include runtime reconfiguration key: ${forbiddenKey}`);
    }
  }
}

function checkEngineUsesConfiguredTools(engineSource, errors) {
  if (!/configuredTools/.test(engineSource) || !/copyToolDefinitions\(config\.tools\s*\?\?\s*\[\]\)/.test(engineSource)) {
    errors.push("Agent loop must derive tool list from configured tools.");
  }

  if (!/toModelRequest\(request\.messages,\s*configuredTools\)/.test(engineSource)) {
    errors.push("Agent loop must send configured tools to model adapter.");
  }

  if (/request\.metadata\.(provider|provider_adapter|model|tools|tool_sources)\b/.test(engineSource)) {
    errors.push("Agent loop must not read provider/model/tool override keys from request metadata.");
  }
}

function checkProviderDetailsConfinedToAdapters(errors) {
  const srcRoot = path.join(ROOT, "src");
  const files = listTypeScriptFiles(srcRoot);

  for (const filePath of files) {
    const relativePath = toPosixPath(path.relative(ROOT, filePath));
    if (relativePath.startsWith("src/adapters/")) {
      continue;
    }

    const source = fs.readFileSync(filePath, "utf8");
    for (const token of PROVIDER_LOCKIN_TOKENS) {
      if (source.includes(token)) {
        errors.push(`Provider-specific token "${token}" must stay within src/adapters/: ${relativePath}`);
      }
    }
  }
}

function registerTypeScriptRequire() {
  const previous = require.extensions[".ts"];
  require.extensions[".ts"] = function compileTypeScript(module, filename) {
    const source = fs.readFileSync(filename, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true
      },
      fileName: filename
    });
    module._compile(compiled.outputText, filename);
  };

  return () => {
    if (previous) {
      require.extensions[".ts"] = previous;
      return;
    }
    delete require.extensions[".ts"];
  };
}

async function checkProviderSwapBehavior(errors) {
  const { loadModelAdapter } = require("../src/adapters/loader.ts");

  const runtimeBase = {
    memory_root: "/tmp/runtime",
    auth_mode: "enforced",
    tool_sources: []
  };

  const mockAdapter = loadModelAdapter({
    runtime: {
      ...runtimeBase,
      provider_adapter: "mock"
    }
  });
  if (mockAdapter.name !== "mock") {
    errors.push("Provider swap check failed: mock runtime should load mock adapter.");
  }

  const localAdapter = loadModelAdapter({
    runtime: {
      ...runtimeBase,
      provider_adapter: "local"
    }
  });
  if (localAdapter.name !== "mock") {
    errors.push("Provider swap check failed: local runtime should map to offline mock adapter.");
  }

  const openaiAdapter = loadModelAdapter({
    runtime: {
      ...runtimeBase,
      provider_adapter: "openai-compatible"
    },
    openai_compatible: {
      api_base_url: "http://provider.local/v1",
      model: "gpt-test",
      fetcher: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: (async function* createBody() {
          yield Buffer.from('data: {"choices":[{"finish_reason":"stop"}]}\\n\\n', "utf8");
          yield Buffer.from("data: [DONE]\\n\\n", "utf8");
        })(),
        text: async () => "",
        json: async () => ({})
      })
    }
  });

  if (openaiAdapter.name !== "openai-compatible") {
    errors.push("Provider swap check failed: openai-compatible runtime should load openai-compatible adapter.");
  }

  assert.throws(
    () =>
      loadModelAdapter({
        runtime: {
          ...runtimeBase,
          provider_adapter: "unknown"
        }
      }),
    /Unsupported provider adapter/
  );
}

async function checkModelSwapBehavior(errors) {
  const { createOpenAICompatibleAdapter } = require("../src/adapters/openai-compatible.ts");

  async function captureRequestedModel(model) {
    let captured = null;
    const adapter = createOpenAICompatibleAdapter({
      api_base_url: "http://provider.local/v1",
      model,
      fetcher: async (_url, init) => {
        captured = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: (async function* createBody() {
            yield Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\n', "utf8");
            yield Buffer.from('data: {"choices":[{"finish_reason":"stop"}]}\\n\\n', "utf8");
            yield Buffer.from("data: [DONE]\\n\\n", "utf8");
          })(),
          text: async () => "",
          json: async () => ({})
        };
      }
    });

    const request = {
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: true
    };

    for await (const _chunk of adapter.stream(request)) {
      // consume stream
    }

    return captured;
  }

  const first = await captureRequestedModel("gpt-first");
  const second = await captureRequestedModel("gpt-second");

  if (first?.model !== "gpt-first") {
    errors.push("Model swap check failed: adapter payload must use configured model gpt-first.");
  }
  if (second?.model !== "gpt-second") {
    errors.push("Model swap check failed: adapter payload must use configured model gpt-second.");
  }
}

async function checkToolSwapBehavior(errors) {
  const { createAgentLoop } = require("../src/engine/index.ts");

  const toolA = {
    type: "function",
    function: {
      name: "tool_a",
      description: "A",
      parameters: { type: "object", properties: {} }
    }
  };

  const toolB = {
    type: "function",
    function: {
      name: "tool_b",
      description: "B",
      parameters: { type: "object", properties: {} }
    }
  };

  const runtimeOverrideTool = {
    type: "function",
    function: {
      name: "tool_runtime_override",
      description: "runtime",
      parameters: { type: "object", properties: {} }
    }
  };

  async function runWithTools(tools) {
    const calls = [];
    const loop = createAgentLoop({
      model_adapter: {
        name: "recording",
        async *stream(request) {
          calls.push(request);
          yield { type: "done" };
        }
      },
      tools
    });

    const events = [];
    for await (const event of loop.run({
      messages: [{ role: "user", content: "hello" }],
      metadata: {
        correlation_id: "corr-lockin",
        tools: [runtimeOverrideTool]
      }
    })) {
      events.push(event);
    }

    return {
      calls,
      events
    };
  }

  const runA = await runWithTools([toolA]);
  const runB = await runWithTools([toolB]);

  const firstToolName = runA.calls[0]?.tools?.[0]?.function?.name;
  const secondToolName = runB.calls[0]?.tools?.[0]?.function?.name;

  if (firstToolName !== "tool_a") {
    errors.push("Tool swap check failed: first run should use configured tool_a.");
  }
  if (secondToolName !== "tool_b") {
    errors.push("Tool swap check failed: second run should use configured tool_b.");
  }

  if (runA.events[runA.events.length - 1]?.event !== "done") {
    errors.push("Tool swap check failed: first run must complete with done event.");
  }
  if (runB.events[runB.events.length - 1]?.event !== "done") {
    errors.push("Tool swap check failed: second run must complete with done event.");
  }
}

async function executeChecklist(checks, errors) {
  for (const check of checks) {
    const before = errors.length;
    try {
      await check.run();
      if (errors.length > before) {
        throw new Error(errors.slice(before).join(" | "));
      }
      console.log(`[PASS] ${check.id} ${check.description}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (errors.length === before) {
        errors.push(`${check.id}: ${reason}`);
      }
      console.log(`[FAIL] ${check.id} ${check.description}`);
    }
  }
}

async function runLockinCheck() {
  const errors = [];

  for (const filePath of REQUIRED_FILES) {
    ensureFile(filePath, errors);
  }

  const loaderSource = readFile("src/adapters/loader.ts", errors);
  const contractsSource = readFile("src/types/contracts.ts", errors);
  const engineSource = readFile("src/engine/index.ts", errors);

  if (loaderSource) {
    checkLoaderWiring(loaderSource, errors);
  }
  if (contractsSource) {
    checkContractsRuntimeConfig(contractsSource, errors);
    checkEngineMetadata(contractsSource, errors);
  }
  if (engineSource) {
    checkEngineUsesConfiguredTools(engineSource, errors);
  }

  checkProviderDetailsConfinedToAdapters(errors);

  const restore = registerTypeScriptRequire();
  try {
    await executeChecklist(
      [
        {
          id: "provider-swap",
          description: "provider selection remains runtime config-driven",
          run: async () => checkProviderSwapBehavior(errors)
        },
        {
          id: "model-swap",
          description: "model selection remains adapter config-driven",
          run: async () => checkModelSwapBehavior(errors)
        },
        {
          id: "tool-swap",
          description: "agent loop tool selection remains config-driven",
          run: async () => checkToolSwapBehavior(errors)
        }
      ],
      errors
    );
  } finally {
    restore();
  }

  return errors;
}

function reportFailure(errors) {
  console.error("Lock-in check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
}

async function main() {
  const errors = await runLockinCheck();
  if (errors.length > 0) {
    reportFailure(errors);
    return 1;
  }

  console.log("Lock-in check passed.");
  return 0;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Lock-in check failed: ${message}`);
      process.exit(1);
    });
}

module.exports = {
  runLockinCheck
};
