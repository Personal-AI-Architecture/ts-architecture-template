export const STATIC_SERMON_PREP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Sermon Prep</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #f5f3ee;
    color: #1a1a1a;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    height: 100%;
  }
  .layout {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100vh;
  }
  header {
    padding: 14px 20px 6px;
    border-bottom: 1px solid #d8d4cb;
  }
  h1 { font-size: 17px; font-weight: 600; margin: 0; color: #1a1a1a; }
  .meta { font-size: 12px; color: #666; margin-top: 4px; }
  .panes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    overflow: hidden;
    min-height: 0;
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .pane + .pane { border-left: 1px solid #d8d4cb; }
  .pane-header {
    padding: 10px 16px;
    font-size: 12px;
    color: #6b5d3f;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: #efeae0;
    border-bottom: 1px solid #d8d4cb;
    flex: none;
  }
  .pane-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
  #thread .turn { padding: 12px 0; border-top: 1px solid #ece8df; }
  #thread .turn:first-child { border-top: 0; }
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
  .updates {
    font-size: 12px;
    color: #6b5d3f;
    margin-top: 6px;
    font-style: italic;
  }
  .section {
    margin-bottom: 16px;
    border: 1px solid #d8d4cb;
    border-radius: 6px;
    background: #fffdf7;
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-bottom: 1px solid #ece8df;
    font-size: 12px;
    color: #6b5d3f;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: #efeae0;
    border-radius: 5px 5px 0 0;
  }
  .section-status { font-style: italic; font-size: 11px; }
  .section-status.saved { color: #2e7d32; }
  .section-status.dirty { color: #b85c00; }
  .section-status.error { color: #c0392b; }
  .section textarea {
    display: block;
    width: 100%;
    min-height: 60px;
    border: 0;
    padding: 10px;
    font: 13px/1.55 ui-monospace, "SFMono-Regular", "Menlo", monospace;
    resize: vertical;
    background: transparent;
    color: inherit;
    box-sizing: border-box;
  }
  .section textarea:focus { outline: 2px solid #8a6d3b; outline-offset: -2px; }
  .section-actions {
    display: flex;
    justify-content: flex-end;
    padding: 6px 10px;
    border-top: 1px solid #ece8df;
    background: #fffdf7;
    border-radius: 0 0 5px 5px;
  }
  .section-actions button {
    background: #1a1a1a;
    color: #ffffff;
    border: 1px solid #1a1a1a;
    border-radius: 4px;
    padding: 4px 12px;
    font: 12px inherit;
    cursor: pointer;
  }
  .section-actions button[disabled] { opacity: 0.5; cursor: progress; }
  .section.section-flash { animation: flash 0.6s ease-out; }
  @keyframes flash {
    0% { background: #fde7c0; }
    100% { background: #fffdf7; }
  }
  footer {
    padding: 12px 20px;
    border-top: 1px solid #d8d4cb;
    background: #efeae0;
  }
  form { display: flex; gap: 8px; }
  textarea#input {
    flex: 1;
    background: #ffffff;
    color: #1a1a1a;
    border: 1px solid #c8c2b3;
    border-radius: 6px;
    padding: 8px 10px;
    font: inherit;
    resize: vertical;
    min-height: 56px;
  }
  textarea#input:focus { outline: 2px solid #8a6d3b; outline-offset: 0; }
  button#send {
    background: #1a1a1a;
    color: #ffffff;
    border: 1px solid #1a1a1a;
    border-radius: 6px;
    padding: 0 18px;
    font: inherit;
    cursor: pointer;
  }
  button#send:hover { background: #333; }
  button#send[disabled] { opacity: 0.5; cursor: progress; }

  @media (max-width: 720px) {
    .panes { grid-template-columns: 1fr; }
    .pane + .pane { border-left: 0; border-top: 1px solid #d8d4cb; }
  }
  @media (prefers-color-scheme: dark) {
    html, body { background: #15140f; color: #ece8df; }
    h1 { color: #ece8df; }
    .meta { color: #968c7a; }
    header, footer { border-color: #2c2a23; }
    .pane + .pane { border-left-color: #2c2a23; }
    .pane-header {
      background: #1d1c17;
      color: #c4ad7a;
      border-bottom-color: #2c2a23;
    }
    footer { background: #1d1c17; }
    #thread .turn { border-top-color: #2c2a23; }
    .role { color: #b1a896; }
    .msg { color: #ece8df; }
    .updates { color: #c4ad7a; }
    .section { background: #1d1c17; border-color: #2c2a23; }
    .section-header { background: #2c2a23; color: #c4ad7a; border-bottom-color: #2c2a23; }
    .section textarea { color: #ece8df; }
    .section-actions { background: #1d1c17; border-top-color: #2c2a23; }
    .section-actions button { background: #ece8df; color: #14130f; border-color: #ece8df; }
    .section-status.saved { color: #7fc783; }
    .section-status.dirty { color: #d4a058; }
    textarea#input { background: #15140f; color: #ece8df; border-color: #2c2a23; }
    button#send { background: #ece8df; color: #15140f; border-color: #ece8df; }
    button#send:hover { background: #ffffff; }
    @keyframes flash {
      0% { background: #5a4a1c; }
      100% { background: #1d1c17; }
    }
  }
</style>
</head>
<body>
<div class="layout">
  <header>
    <h1>Sermon prep</h1>
    <div class="meta" id="meta">Loading sermon&hellip;</div>
  </header>
  <div class="panes">
    <section class="pane">
      <div class="pane-header">Conversation</div>
      <div id="thread" class="pane-body" aria-live="polite"></div>
    </section>
    <section class="pane">
      <div class="pane-header">Outline (editable)</div>
      <div id="outline" class="pane-body">(loading)</div>
    </section>
  </div>
  <footer>
    <form id="composer">
      <textarea id="input" placeholder="Where would you like to begin? Topic? Scripture? A prompt that's been on your heart?" required></textarea>
      <button id="send" type="submit">Send</button>
    </form>
  </footer>
</div>
<script>
(function () {
  const meta = document.getElementById("meta");
  const thread = document.getElementById("thread");
  const outlinePane = document.getElementById("outline");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  let conversationId = null;
  const sermonSlug = window.__SERMON_SLUG__ || "";

  meta.textContent = "Active sermon: " + (sermonSlug || "(set the SERMON env var)");

  // Per-section state: { textarea, statusEl, lastSavedValue, sectionEl }
  const sections = new Map();

  function parseOutline(text) {
    // Returns Map<sectionName, body>
    const result = new Map();
    const lines = text.split(/\\r?\\n/g);
    let current = null;
    let buffer = [];
    for (const line of lines) {
      const m = /^##\\s+(\\S+)\\s*$/.exec(line);
      if (m) {
        if (current) { result.set(current, buffer.join("\\n").trim()); }
        current = m[1];
        buffer = [];
        continue;
      }
      if (current) { buffer.push(line); }
    }
    if (current) { result.set(current, buffer.join("\\n").trim()); }
    return result;
  }

  function ensureSectionElement(name) {
    if (sections.has(name)) { return sections.get(name); }
    const sectionEl = document.createElement("div");
    sectionEl.className = "section";
    sectionEl.dataset.section = name;

    const header = document.createElement("div");
    header.className = "section-header";
    const title = document.createElement("span");
    title.textContent = name;
    const status = document.createElement("span");
    status.className = "section-status";
    status.textContent = "";
    header.append(title, status);

    const ta = document.createElement("textarea");
    ta.value = "";
    ta.spellcheck = true;
    ta.addEventListener("input", function () {
      const state = sections.get(name);
      if (!state) { return; }
      const dirty = ta.value !== state.lastSavedValue;
      status.textContent = dirty ? "unsaved" : "";
      status.className = "section-status" + (dirty ? " dirty" : "");
    });

    const actions = document.createElement("div");
    actions.className = "section-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => saveSection(name));
    actions.append(saveBtn);

    sectionEl.append(header, ta, actions);
    outlinePane.append(sectionEl);

    const state = {
      sectionEl: sectionEl,
      textarea: ta,
      statusEl: status,
      saveButton: saveBtn,
      lastSavedValue: ""
    };
    sections.set(name, state);
    return state;
  }

  function setSectionValue(name, value) {
    const state = ensureSectionElement(name);
    // Only overwrite if the user isn't actively editing (textarea isn't focused with unsaved changes).
    const dirty = state.textarea.value !== state.lastSavedValue;
    const focused = document.activeElement === state.textarea;
    if (!dirty || (!focused && state.textarea.value === state.lastSavedValue)) {
      state.textarea.value = value;
      state.lastSavedValue = value;
      state.statusEl.textContent = "";
      state.statusEl.className = "section-status";
    } else {
      // Pastor has unsaved changes; just update lastSavedValue tracking so dirty detection works,
      // but DON'T clobber their typing. Keep the new server value visible as the baseline.
      state.lastSavedValue = value;
    }
  }

  async function saveSection(name) {
    const state = sections.get(name);
    if (!state || !sermonSlug) { return; }
    const value = state.textarea.value;
    state.saveButton.disabled = true;
    state.statusEl.textContent = "saving…";
    state.statusEl.className = "section-status";
    try {
      const response = await fetch(
        "/outline/" + encodeURIComponent(sermonSlug) + "/" + encodeURIComponent(name),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value)
        }
      );
      if (!response.ok) {
        let message = "save failed (" + response.status + ")";
        try {
          const err = await response.json();
          if (err && err.error && err.error.message) { message = "error: " + err.error.message; }
        } catch (e) { /* ignore */ }
        state.statusEl.textContent = message;
        state.statusEl.className = "section-status error";
        return;
      }
      state.lastSavedValue = value;
      state.statusEl.textContent = "saved ✓";
      state.statusEl.className = "section-status saved";
      state.sectionEl.classList.remove("section-flash");
      void state.sectionEl.offsetWidth;
      state.sectionEl.classList.add("section-flash");
    } catch (err) {
      state.statusEl.textContent = "network error";
      state.statusEl.className = "section-status error";
    } finally {
      state.saveButton.disabled = false;
    }
  }

  async function refreshOutline() {
    if (!sermonSlug) { return; }
    try {
      const response = await fetch("/outline/" + encodeURIComponent(sermonSlug), {
        headers: { "Cache-Control": "no-cache" }
      });
      if (!response.ok) {
        outlinePane.textContent = "(outline unavailable: " + response.status + ")";
        return;
      }
      const text = await response.text();
      const parsed = parseOutline(text);
      // Render in declaration order from the parsed file.
      for (const [name, value] of parsed.entries()) {
        setSectionValue(name, value);
      }
    } catch (err) {
      // leave existing UI in place
    }
  }
  refreshOutline();

  function appendTurn(role) {
    const turn = document.createElement("div");
    turn.className = "turn";
    const head = document.createElement("div");
    head.className = "role";
    head.textContent = role;
    const body = document.createElement("div");
    body.className = "msg";
    const updates = document.createElement("div");
    updates.className = "updates";
    updates.hidden = true;
    turn.append(head, body, updates);
    thread.append(turn);
    thread.scrollTop = thread.scrollHeight;
    return { body, updates };
  }

  function renderUpdates(updatesEl, sectionsTouched) {
    if (!sectionsTouched || sectionsTouched.size === 0) {
      updatesEl.hidden = true;
      return;
    }
    updatesEl.hidden = false;
    updatesEl.textContent = "Outline updated: " + Array.from(sectionsTouched).join(", ");
  }

  async function sendMessage(content) {
    appendTurn("you").body.textContent = content;
    const assistant = appendTurn("assistant");
    const sectionsTouched = new Set();

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
        } else if (eventName === "tool-call" && data && data.name === "update_outline_section") {
          try {
            const args = data.arguments ? JSON.parse(data.arguments) : {};
            if (args && typeof args.section === "string") { sectionsTouched.add(args.section); }
          } catch (e) { /* ignore */ }
        } else if (eventName === "tool-result" && data && data.name === "update_outline_section" && !data.error) {
          refreshOutline();
        } else if (eventName === "error" && data && typeof data.message === "string") {
          assistant.body.textContent += "\\n[" + (data.code || "error") + "] " + data.message;
        }
        renderUpdates(assistant.updates, sectionsTouched);
        separator = buffer.indexOf("\\n\\n");
      }
    }
    renderUpdates(assistant.updates, sectionsTouched);
    refreshOutline();
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
