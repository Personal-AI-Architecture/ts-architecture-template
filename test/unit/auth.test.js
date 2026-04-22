const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
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

const { createAuthProvider } = require("../../src/auth/provider.ts");
const { createAuthMiddleware, AuthMiddlewareError } = require("../../src/auth/middleware.ts");
const { createAuthTools } = require("../../src/auth/tools.ts");

async function withTempRoot(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "auth-tools-test-"));
  try {
    await run(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test("auth middleware rejects unauthenticated protected requests", async () => {
  await withTempRoot(async (stateRoot) => {
    const provider = await createAuthProvider({
      state_root: stateRoot,
      seed_actors: [
        {
          actor_id: "actor-1",
          token: "token-1",
          permissions: ["memory:read"]
        }
      ]
    });

    const middleware = createAuthMiddleware({ provider, default_protected: true });

    await assert.rejects(
      () =>
        middleware(
          {
            method: "POST",
            path: "/engine/chat",
            headers: {}
          },
          {
            resource: "memory",
            action: "read"
          }
        ),
      (error) => {
        assert.ok(error instanceof AuthMiddlewareError);
        assert.equal(error.status_code, 401);
        return true;
      }
    );
  });
});

test("auth middleware authorizes request and attaches actor headers", async () => {
  await withTempRoot(async (stateRoot) => {
    const provider = await createAuthProvider({
      state_root: stateRoot,
      seed_actors: [
        {
          actor_id: "actor-2",
          token: "token-2",
          permissions: ["memory:read", "memory:write"]
        }
      ]
    });

    const middleware = createAuthMiddleware({ provider, default_protected: true });

    const request = {
      method: "POST",
      path: "/engine/chat",
      headers: {
        authorization: "Bearer token-2"
      }
    };

    const result = await middleware(request, {
      resource: "memory",
      action: "read"
    });

    assert.equal(result.authenticated, true);
    assert.equal(result.actor?.actor_id, "actor-2");
    assert.equal(result.request.headers["X-Actor-ID"], "actor-2");
    assert.equal(result.request.headers["X-Actor-Permissions"], "memory:read,memory:write");
    assert.equal(result.authorization?.allowed, true);
  });
});

test("auth tools expose whoami/check/export without secrets", async () => {
  await withTempRoot(async (stateRoot) => {
    const provider = await createAuthProvider({
      state_root: stateRoot,
      seed_actors: [
        {
          actor_id: "actor-3",
          token: "super-secret-token",
          permissions: ["memory:read"],
          metadata: {
            team: "platform",
            api_token: "never-export"
          }
        }
      ],
      policies: [
        {
          resource: "memory",
          action: "read",
          required_permissions: ["memory:read"]
        }
      ]
    });

    const statePath = path.join(stateRoot, "auth", "state.json");
    assert.equal(fs.existsSync(statePath), true);

    const tools = createAuthTools(provider);

    const whoami = await tools.auth_whoami({
      request: {
        headers: {
          authorization: "Bearer super-secret-token"
        }
      }
    });
    assert.equal(whoami.authenticated, true);
    assert.equal(whoami.actor?.actor_id, "actor-3");

    const allowed = await tools.auth_check({
      request: {
        headers: {
          authorization: "Bearer super-secret-token"
        }
      },
      resource: "memory",
      action: "read"
    });
    assert.equal(allowed.allowed, true);

    const denied = await tools.auth_check({
      actor_id: "actor-3",
      resource: "memory",
      action: "delete"
    });
    assert.equal(denied.allowed, false);

    const exported = await tools.auth_export();
    assert.equal(exported.actors.length, 1);
    assert.equal(exported.actors[0].actor_id, "actor-3");
    assert.equal(exported.actors[0].metadata.team, "platform");
    assert.equal(exported.actors[0].metadata.api_token, undefined);
    assert.equal(exported.actors[0].token, undefined);
    assert.equal(exported.actors[0].token_digest, undefined);

    const persistedRaw = JSON.parse(await fsp.readFile(statePath, "utf8"));
    assert.ok(typeof persistedRaw.actors[0].token_digest === "string");
  });
});
