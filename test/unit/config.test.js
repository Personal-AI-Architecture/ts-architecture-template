const assert = require("node:assert/strict");
const fs = require("node:fs");
const { after, test } = require("node:test");
const ts = require("typescript");

const previousTsLoader = require.extensions[".ts"];
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

after(() => {
  if (previousTsLoader) {
    require.extensions[".ts"] = previousTsLoader;
    return;
  }
  delete require.extensions[".ts"];
});

const { loadRuntimeConfiguration } = require("../../src/config/loader.ts");
const { bootRuntime, RuntimeBootError } = require("../../src/config/boot.ts");

test("runtime loader resolves environment-scoped runtime configuration", () => {
  const runtime = loadRuntimeConfiguration({
    environment: "test",
    cwd: "/workspace",
    runtime_config: {
      default: {
        memory_root: "/memory/default",
        provider_adapter: "mock",
        auth_mode: "enforced",
        tool_sources: ["filesystem"]
      },
      test: {
        memory_root: "/memory/test",
        tool_sources: "memory,http"
      }
    },
    env: {
      TEST_AUTH_MODE: "disabled",
      TEST_PROVIDER_ADAPTER: "local"
    }
  });

  assert.equal(runtime.memory_root, "/memory/test");
  assert.equal(runtime.provider_adapter, "local");
  assert.equal(runtime.auth_mode, "disabled");
  assert.deepEqual(runtime.tool_sources, ["memory", "http"]);
});

test("runtime loader rejects tracked runtime config with secret-like values", () => {
  assert.throws(
    () =>
      loadRuntimeConfiguration({
        environment: "development",
        runtime_config: {
          default: {
            memory_root: "/tmp/memory",
            provider_adapter: "mock",
            auth_mode: "enforced",
            tool_sources: [],
            api_key: "sk-1234567890abcdef1234567890abcdef"
          }
        }
      }),
    /secret-looking/
  );
});

test("boot runtime executes deterministic startup order and localhost bind default", async () => {
  const order = [];
  const runtime = {
    memory_root: "/tmp/runtime-memory",
    provider_adapter: "mock",
    auth_mode: "enforced",
    tool_sources: ["memory"]
  };
  const adapterConfig = { provider: "mock" };
  const tools = [{ name: "memory_read" }];
  const memory = { root: runtime.memory_root };
  const preferences = { model: "local-default" };

  const result = await bootRuntime({
    async load_runtime_config() {
      order.push("load_runtime_config");
      return runtime;
    },
    async load_adapter_config(inputRuntime) {
      order.push("load_adapter_config");
      assert.equal(inputRuntime, runtime);
      return adapterConfig;
    },
    async discover_tools(input) {
      order.push("discover_tools");
      assert.equal(input.runtime, runtime);
      assert.equal(input.adapter_config, adapterConfig);
      return tools;
    },
    async mount_memory(inputRuntime) {
      order.push("mount_memory");
      assert.equal(inputRuntime, runtime);
      return memory;
    },
    async verify_memory_history(input) {
      order.push("verify_memory_history");
      assert.equal(input.runtime, runtime);
      assert.equal(input.memory, memory);
    },
    async read_preferences(input) {
      order.push("read_preferences");
      assert.equal(input.runtime, runtime);
      assert.equal(input.memory, memory);
      return preferences;
    }
  });

  assert.deepEqual(order, [
    "load_runtime_config",
    "load_adapter_config",
    "discover_tools",
    "mount_memory",
    "verify_memory_history",
    "read_preferences"
  ]);
  assert.equal(result.ready, true);
  assert.equal(result.bind_address, "127.0.0.1");
  assert.equal(result.offline_mode, true);
  assert.equal(result.runtime_config, runtime);
  assert.equal(result.adapter_config, adapterConfig);
  assert.equal(result.preferences, preferences);
});

test("boot runtime keeps offline mock path independent from outbound network checks", async () => {
  let networkCheckCalled = false;

  const result = await bootRuntime(
    {
      async load_runtime_config() {
        return {
          memory_root: "/tmp/runtime-memory",
          provider_adapter: "mock",
          auth_mode: "enforced",
          tool_sources: []
        };
      },
      async load_adapter_config() {
        return { provider: "mock" };
      },
      async discover_tools() {
        return [];
      },
      async mount_memory() {
        return {};
      },
      async verify_memory_history() {},
      async read_preferences() {
        return { profile: "local" };
      }
    },
    {
      async assert_outbound_network_ready() {
        networkCheckCalled = true;
        throw new Error("network should not be required for mock adapter");
      }
    }
  );

  assert.equal(result.ready, true);
  assert.equal(result.offline_mode, true);
  assert.equal(networkCheckCalled, false);
});

test("boot runtime fails before readiness when memory version history is unavailable", async () => {
  await assert.rejects(
    async () =>
      bootRuntime({
        async load_runtime_config() {
          return {
            memory_root: "/tmp/runtime-memory",
            provider_adapter: "local",
            auth_mode: "enforced",
            tool_sources: []
          };
        },
        async load_adapter_config() {
          return {};
        },
        async discover_tools() {
          return [];
        },
        async mount_memory() {
          return {};
        },
        async verify_memory_history() {
          throw new Error("history storage is unavailable");
        },
        async read_preferences() {
          return {};
        }
      }),
    (error) => {
      assert.ok(error instanceof RuntimeBootError);
      assert.equal(error.stage, "verify_memory_history");
      assert.equal(error.ready, false);
      return true;
    }
  );
});

test("boot runtime rejects secret-like values in memory preferences", async () => {
  await assert.rejects(
    async () =>
      bootRuntime({
        async load_runtime_config() {
          return {
            memory_root: "/tmp/runtime-memory",
            provider_adapter: "local",
            auth_mode: "enforced",
            tool_sources: []
          };
        },
        async load_adapter_config() {
          return {};
        },
        async discover_tools() {
          return [];
        },
        async mount_memory() {
          return {};
        },
        async verify_memory_history() {},
        async read_preferences() {
          return {
            user_profile: {
              api_key: "sk-1234567890abcdef1234567890abcdef"
            }
          };
        }
      }),
    /secret-looking/
  );
});
