export const STATIC_CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Chat with my docs</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #f5f5f5;
    color: #1a1a1a;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .wrap { max-width: 780px; margin: 24px auto; padding: 0 16px; }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 12px;
    color: #1a1a1a;
  }
  .card {
    background: #ffffff;
    color: #1a1a1a;
    border: 1px solid #d8d8d8;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  #thread { min-height: 240px; }
  .turn { padding: 12px 0; border-top: 1px solid #ececec; }
  .turn:first-child { border-top: 0; }
  .role {
    font-size: 12px;
    color: #555;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .msg {
    color: #1a1a1a;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .citations {
    font-size: 12px;
    color: #555;
    margin-top: 6px;
  }
  form { display: flex; gap: 8px; }
  textarea {
    flex: 1;
    background: #ffffff;
    color: #1a1a1a;
    border: 1px solid #c8c8c8;
    border-radius: 6px;
    padding: 8px 10px;
    font: inherit;
    resize: vertical;
    min-height: 56px;
  }
  textarea:focus { outline: 2px solid #4a82d6; outline-offset: 0; }
  button {
    background: #1a1a1a;
    color: #ffffff;
    border: 1px solid #1a1a1a;
    border-radius: 6px;
    padding: 0 18px;
    font: inherit;
    cursor: pointer;
  }
  button:hover { background: #333; }
  button[disabled] { opacity: 0.5; cursor: progress; }
  @media (prefers-color-scheme: dark) {
    html, body { background: #14161a; color: #eaeaea; }
    h1 { color: #eaeaea; }
    .card {
      background: #1d2026;
      color: #eaeaea;
      border-color: #2c3038;
    }
    .turn { border-top-color: #2c3038; }
    .role { color: #9aa0a8; }
    .msg { color: #eaeaea; }
    .citations { color: #9aa0a8; }
    textarea {
      background: #14161a;
      color: #eaeaea;
      border-color: #2c3038;
    }
    button {
      background: #eaeaea;
      color: #14161a;
      border-color: #eaeaea;
    }
    button:hover { background: #ffffff; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Chat with my docs</h1>
  <div id="thread" class="card" aria-live="polite"></div>
  <form id="composer">
    <textarea id="input" placeholder="Ask a question about your notes..." required></textarea>
    <button id="send" type="submit">Send</button>
  </form>
</div>
<script>
(function () {
  const thread = document.getElementById("thread");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  let conversationId = null;

  function appendTurn(role) {
    const turn = document.createElement("div");
    turn.className = "turn";
    const head = document.createElement("div");
    head.className = "role";
    head.textContent = role;
    const body = document.createElement("div");
    body.className = "msg";
    const citations = document.createElement("div");
    citations.className = "citations";
    citations.hidden = true;
    turn.append(head, body, citations);
    thread.append(turn);
    thread.scrollTop = thread.scrollHeight;
    return { body, citations };
  }

  function renderCitations(citations, paths) {
    if (!paths || paths.size === 0) {
      citations.hidden = true;
      return;
    }
    citations.hidden = false;
    const list = Array.from(paths).join(", ");
    citations.textContent = "Sources: " + list;
  }

  async function sendMessage(content) {
    appendTurn("you").body.textContent = content;
    const assistant = appendTurn("assistant");
    const cited = new Set();

    const headers = { "Content-Type": "application/json" };
    const body = {
      content: content,
      metadata: {
        channel: "web",
        correlation_id: "web-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8)
      }
    };

    let url = "/chat";
    if (conversationId) {
      url = "/conversations/" + encodeURIComponent(conversationId) + "/messages";
    }

    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      assistant.body.textContent = "[error " + response.status + "]";
      return;
    }

    const headerConv = response.headers.get("x-conversation-id");
    if (headerConv) {
      conversationId = headerConv;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator = buffer.indexOf("\\n\\n");
      while (separator >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const lines = raw.split(/\\r?\\n/g);
        let eventName = "message";
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        const dataPayload = dataLines.join("\\n");
        let data = null;
        if (dataPayload) {
          try { data = JSON.parse(dataPayload); } catch (e) { data = null; }
        }
        if (eventName === "text-delta" && data && typeof data.text === "string") {
          assistant.body.textContent += data.text;
        } else if (eventName === "tool-call" && data && data.name === "read_file") {
          try {
            const args = data.arguments ? JSON.parse(data.arguments) : {};
            if (args && typeof args.path === "string") { cited.add(args.path); }
          } catch (e) { /* ignore */ }
        } else if (eventName === "error" && data && typeof data.message === "string") {
          assistant.body.textContent += "\\n[" + (data.code || "error") + "] " + data.message;
        }
        renderCitations(assistant.citations, cited);
        separator = buffer.indexOf("\\n\\n");
      }
    }
    renderCitations(assistant.citations, cited);
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) { return; }
    input.value = "";
    send.disabled = true;
    try {
      await sendMessage(value);
    } catch (err) {
      console.error(err);
    } finally {
      send.disabled = false;
      input.focus();
    }
  });
})();
</script>
</body>
</html>
`;
