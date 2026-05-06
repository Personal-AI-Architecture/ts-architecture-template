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

const { createHttpListener } = require("../../src/gateway/http-listener.ts");

function createStubRoutes() {
  return {
    async handle(request) {
      if (request.method === "GET" && request.path === "/") {
        return {
          status: 200,
          headers: { "Content-Type": "text/html" },
          body: "<html><body>chat</body></html>"
        };
      }
      if (request.method === "POST" && request.path === "/chat") {
        const body = request.body;
        if (!body || typeof body !== "object") {
          return {
            status: 400,
            headers: { "Content-Type": "application/json" },
            body: { error: { code: "invalid_request", message: "body required" } }
          };
        }
        if (Object.prototype.hasOwnProperty.call(body, "messages")) {
          return {
            status: 400,
            headers: { "Content-Type": "application/json" },
            body: { error: { code: "invalid_request", message: "messages[] not allowed" } }
          };
        }
        const allowed = new Set(["content", "metadata"]);
        for (const key of Object.keys(body)) {
          if (!allowed.has(key)) {
            return {
              status: 400,
              headers: { "Content-Type": "application/json" },
              body: { error: { code: "invalid_request", message: `Unexpected field: ${key}` } }
            };
          }
        }
        return {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "X-Conversation-ID": "conv_test_123"
          },
          stream: (async function* () {
            yield { event: "text-delta", data: { text: "hi" } };
            yield {
              event: "done",
              data: { conversation_id: "conv_test_123", message_id: "msg_test_456" }
            };
          })()
        };
      }
      return {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: { error: { code: "not_found", message: "Route not found." } }
      };
    }
  };
}

async function startListenerForTest(options = {}) {
  const listener = createHttpListener({
    routes: createStubRoutes(),
    bind_address: options.bind_address ?? "127.0.0.1",
    allow_non_local_bind: options.allow_non_local_bind ?? false,
    port: 0
  });
  const address = await listener.start();
  return { listener, address };
}

async function readBodyText(response) {
  if (typeof response.text === "function") {
    return response.text();
  }
  return "";
}

async function readSseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  // Read the stream to completion.
  // Each SSE event is "event: NAME\ndata: JSON\n\n".
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const raw = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const lines = raw.split(/\r?\n/g);
      let eventName = "message";
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      const dataPayload = dataLines.join("\n");
      events.push({
        event: eventName,
        data: dataPayload.length > 0 ? JSON.parse(dataPayload) : null
      });
      separatorIndex = buffer.indexOf("\n\n");
    }
  }
  return events;
}

test("http-listener: refuses non-localhost bind without allow_non_local_bind", () => {
  assert.throws(
    () =>
      createHttpListener({
        routes: createStubRoutes(),
        bind_address: "0.0.0.0",
        port: 0
      }),
    /localhost/i
  );
});

test("http-listener: defaults to 127.0.0.1 when bind_address is omitted", async () => {
  const { listener, address } = await startListenerForTest({});
  try {
    assert.equal(address.address, "127.0.0.1");
  } finally {
    await listener.stop();
  }
});

test("http-listener: GET / returns the static chat HTML", async () => {
  const { listener, address } = await startListenerForTest({});
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/i);
    const body = await readBodyText(response);
    assert.match(body, /chat/i);
  } finally {
    await listener.stop();
  }
});

test("http-listener: POST /chat streams SSE with X-Conversation-ID and done payload", async () => {
  const { listener, address } = await startListenerForTest({});
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "hello",
        metadata: { channel: "test", correlation_id: "corr-test-1" }
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/i);
    assert.equal(response.headers.get("x-conversation-id"), "conv_test_123");

    const events = await readSseEvents(response);
    const eventNames = events.map((event) => event.event);
    assert.ok(eventNames.includes("text-delta"));
    assert.ok(eventNames.includes("done"));
    const doneEvent = events.find((event) => event.event === "done");
    assert.equal(doneEvent.data.conversation_id, "conv_test_123");
    assert.equal(doneEvent.data.message_id, "msg_test_456");
  } finally {
    await listener.stop();
  }
});

test("http-listener: POST /chat with messages[] is rejected with 400", async () => {
  const { listener, address } = await startListenerForTest({});
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "hi",
        metadata: { correlation_id: "c1" },
        messages: [{ role: "user", content: "stowaway" }]
      })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error.message, /messages/i);
  } finally {
    await listener.stop();
  }
});

test("http-listener: POST /chat with provider/model/tool_sources/tool_definitions at top level is rejected", async () => {
  const { listener, address } = await startListenerForTest({});
  try {
    for (const field of ["provider", "model", "tool_sources", "tool_definitions"]) {
      const payload = {
        content: "hi",
        metadata: { correlation_id: "c1" },
        [field]: "stowaway"
      };
      const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 400, `expected 400 for top-level ${field}`);
      const body = await response.json();
      assert.match(body.error.message, new RegExp(field, "i"));
    }
  } finally {
    await listener.stop();
  }
});

test("http-listener: unknown route returns 404", async () => {
  const { listener, address } = await startListenerForTest({});
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/no-such-path`);
    assert.equal(response.status, 404);
  } finally {
    await listener.stop();
  }
});

test("http-listener: malformed JSON body returns 400", async () => {
  const { listener, address } = await startListenerForTest({});
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json"
    });
    assert.equal(response.status, 400);
  } finally {
    await listener.stop();
  }
});

test("http-listener: stop() releases the port", async () => {
  const { listener, address } = await startListenerForTest({});
  await listener.stop();

  // After stop, a fresh fetch should fail.
  await assert.rejects(() => fetch(`http://127.0.0.1:${address.port}/`));
});
