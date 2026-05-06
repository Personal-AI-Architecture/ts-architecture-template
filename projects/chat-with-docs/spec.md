# Spec: Chat With My Docs

## Overview

### What we're building

A localhost-only prototype that lets a single user chat with a folder of personal markdown notes through a small web UI. On server start, an indexer crawls the folder and writes a summary index (`agent.md`) into it; at chat time, the agent loop receives the index in context, decides which file(s) it needs, calls a `read_file` tool to load them, and answers with citations. Streaming + conversation persistence reuse the existing template flow.

### Target user

- **Who:** Dave (the template author), as a single end user
- **Technical level:** Advanced (builds on the PAA template)
- **Context:** Used locally on Dave's laptop to query his own desktop notes folder. Not multi-user, not deployed, not exposed to the network.

### Problem statement

Dave keeps a folder of markdown notes on his desktop. Today, finding what an old note said requires opening files manually or using `grep`. He wants a chat surface that retrieves and grounds answers in those files, and he wants to build it on the PAA template both as a useful personal tool and as a working reference of what the template looks like with a real feature on top.

This is a prototype — proving the architecture supports the pattern, not productionizing it.

## User Stories

### US-1: Ask a question grounded in the docs folder

As Dave, I want to type a question into a small web chat UI and get an answer grounded in my markdown notes, so that I can recall what I previously wrote without opening files manually.

**Steps:**
1. User opens `http://localhost:<gateway-port>` in a browser.
2. System renders a minimal chat page (input + streaming reply area).
3. User types a question and submits.
4. System streams an answer back, citing the markdown file(s) it pulled from.

**Acceptance Criteria (Given-When-Then):**

```gherkin
Given the gateway server is running
And the corpus folder /Users/davidwaring/Desktop/BrainDrive Files contains markdown files
And agent.md exists and is up to date
When the user opens http://localhost:<gateway-port>
And submits the message "what did we decide about X"
Then the response streams back via SSE
And the reply includes a citation listing at least one source file path
And the cited file path is inside the corpus folder
```

```gherkin
Given the corpus folder is empty
When the user submits any question
Then the system returns an answer that explicitly states no documents were found in the corpus
And no read_file tool calls occur
```

### US-2: Auto-index on server start when the corpus has changed

As Dave, I want the index to regenerate automatically when I edit my notes and restart the server, so that I don't have to remember to run a separate command.

**Steps:**
1. User edits or adds a markdown file in the corpus folder.
2. User starts the gateway server.
3. System detects the index is stale (any markdown file's mtime is newer than `agent.md`'s, or `agent.md` is missing).
4. System regenerates `agent.md` by summarizing each file via the configured model.
5. System completes boot and begins accepting chat requests.

**Acceptance Criteria (Given-When-Then):**

```gherkin
Given agent.md does not exist in the corpus folder
When the gateway server starts
Then the indexer crawls every *.md file in the corpus folder (excluding agent.md itself)
And writes agent.md to the corpus folder
And the file contains one section per indexed markdown file
And the server reaches ready state after indexing completes
```

```gherkin
Given agent.md exists with mtime T_index
And at least one *.md file in the corpus has mtime > T_index
When the gateway server starts
Then the indexer regenerates agent.md
And agent.md's new mtime is greater than every source file's mtime
```

```gherkin
Given agent.md exists with mtime T_index
And every *.md file in the corpus has mtime <= T_index
When the gateway server starts
Then the indexer skips regeneration
And boot completes without calling the model
```

### US-3: Manual reindex via npm script

As Dave, I want to be able to force a reindex without restarting the server, so that I can rebuild the summaries on demand if the auto check missed something.

**Steps:**
1. User runs `npm run index` from the template repo.
2. System unconditionally regenerates `agent.md` for the configured corpus folder.
3. Script exits 0 on success, non-zero on failure.

**Acceptance Criteria:**

```gherkin
Given any state of agent.md
When the user runs `npm run index`
Then the script regenerates agent.md unconditionally
And exits 0 if generation succeeded
And exits non-zero with a clear error message if the corpus folder is missing or unreadable
```

## Invariants & Edge Cases

### Properties that must always hold

- **Citation soundness:** every file path the model claims to have read in a reply must correspond to an actual `read_file` tool call that succeeded against a path inside the corpus folder during that turn.
- **Index leanness:** each per-file summary in `agent.md` is ≤ 240 characters of body text (excluding the `## <path>` heading and surrounding blank lines). The indexer enforces this with a server-side hard truncation, not by trusting the model's prompt-following. This bound exists to make the Citation Soundness invariant observable — a richer index would let the model answer detail questions from the system prompt alone, which appears correct but bypasses runtime grounding.
- **Path containment:** the `read_file` tool rejects any path that does not resolve (after symlink + `..` resolution) to a location inside the configured corpus folder.
- **Index freshness invariant:** after `auto-index` runs, either every `*.md` in the corpus has mtime ≤ `agent.md`'s mtime, or generation failed and the server logs a startup error.
- **Idempotent index:** regenerating `agent.md` against an unchanged corpus produces semantically equivalent output (same set of file sections; per-file summaries may vary because the model is non-deterministic, but the structural shape is stable).
- **Read-only corpus:** the system never writes to any `*.md` in the corpus folder. Only `agent.md` is written by the indexer; other files are read-only.
- **Gateway contract preservation:** the public chat request shape stays `{ content, metadata }`; the streaming `done` payload still contains `conversation_id` and `message_id`; the `X-Conversation-ID` header still appears.

### Edge cases to test

- Corpus folder is empty (no `*.md`)
- Corpus folder does not exist
- `agent.md` exists but is empty / corrupted / not valid markdown
- Markdown file with no headings / very short / very large
- File names with spaces, unicode, emoji
- Symlinks inside the corpus pointing outside it (must be rejected by `read_file`)
- Path traversal attempt: `read_file` called with `../../etc/passwd`
- Tool argument is a relative path vs an absolute path
- Model returns a citation for a file that doesn't exist (the system must not pretend it does)
- Concurrent requests during boot-time indexing (server must not accept chat traffic until index completes)

### Failure modes

| Scenario | Expected behavior |
|---|---|
| Ollama is not running | Indexer fails fast with a clear error referencing the configured model endpoint; gateway boot fails. Chat requests return a structured error if attempted. |
| Corpus folder missing | Server logs a clear startup error and refuses to start serving chat. |
| `read_file` called with a path outside the corpus | Tool returns a structured error; engine surfaces it back to the model so it can recover or apologize. No file content is leaked. |
| Indexer fails partway through | `agent.md` is not partially overwritten — write to a temp file, rename atomically. On failure, prior `agent.md` remains usable. |
| Model returns malformed tool call JSON | Engine surfaces a tool error to the model; conversation continues. |
| Markdown file too large to summarize in one prompt | Indexer truncates input with a marker (e.g. `[...truncated...]`) and notes truncation in the file's section. |

## Detailed Requirements

### Core functionality

- **Indexer (boot-time + manual):** crawl the configured corpus folder for `*.md` files (excluding `agent.md`), summarize each file via the configured model adapter, and write a structured `agent.md` to the corpus folder.
- **Index format:** `# Document Index` heading, generation timestamp, source folder, file count, then one `## <relative-path>` section per file with a **≤ 240-character** summary. The summary is produced by the model and then **truncated server-side** to enforce the leanness invariant — the model is asked for a short summary, but the indexer does not trust it to comply. If truncation occurs, the summary ends with `…`.
- **Stale check:** compare the maximum mtime across all `*.md` files (excluding `agent.md`) to `agent.md`'s mtime. If the index is missing or older, regenerate.
- **System prompt assembly:** every chat turn injects `agent.md` content into the engine's system prompt (or first message), so the model sees the index without the gateway request shape needing to carry it.
- **Tools:**
  - `read_file(path: string)` — reads UTF-8 text from a path resolved inside the corpus folder. Rejects paths outside it.
  - `list_files()` — returns the list of indexed `*.md` paths (relative to the corpus folder). Optional in v1 but cheap to add given the indexer already enumerates them.
- **Citations:** the system prompt instructs the model to cite the file paths it read; the prompt is the only enforcement for v1 (no post-processing). This is acceptable for a prototype.
- **Web UI:** minimal HTML/JS chat page served by the gateway, single conversation per page load, streams responses via SSE. No history, no model picker, no auth UI.

### User interface

- **Web page (single route, e.g. `GET /`):** input box, send button, message thread area. Streaming reply renders incrementally as `text-delta` events arrive. Citations are rendered as part of the reply text (whatever the model produces); no special citation rendering in v1.
- **Index file (`agent.md`):**

  ```markdown
  # Document Index

  Generated: 2026-05-06T12:34:56Z
  Source: /Users/davidwaring/Desktop/BrainDrive Files
  Files: 14

  ## architecture.md
  Discusses the four-component PAA model and how it maps onto this template.
  Key topics: components, contracts, lock-in.

  ## 2026-meeting.md
  Meeting notes from 2026-04-02 covering the indexer prototype scope.
  ```

### Data & state

- **Stored on disk (corpus folder):** the source `*.md` files (read-only, never written by this system) and the generated `agent.md` (written only by the indexer).
- **Stored in template repo:** existing memory/conversation persistence (unchanged from template).
- **Temporary / in-memory:** the loaded `agent.md` content used for system prompt assembly per request; tool-call results during a single turn.
- **Configuration:** corpus folder path (env var or config), model endpoint (Ollama localhost), model name (`qwen2.5:4b` or whichever Qwen 4B build).

## Scope

### Feature type

- [x] Prototype — proving feasibility, skip polish
- [ ] Production — full implementation with error handling

### PAA components touched

- [ ] Memory _(unchanged from template — existing conversation persistence reused)_
- [x] Agent Loop _(must execute tool calls; verify or extend `engine/tool-executor.ts`)_
- [ ] Auth _(unchanged for v1 — existing stub remains; see Open Questions)_
- [x] Gateway _(serves new web UI route; system-prompt assembly hook)_
- [x] External — Models (Ollama via existing `openai-compatible` adapter — config-only)
- [x] External — Clients (new minimal web chat UI)
- [x] External — Tools (new `read_file`, optional `list_files`, scoped to corpus)

### MVP scope (v1)

**Included:**
- Indexer that runs on server start (mtime-stale check) AND via `npm run index`
- `agent.md` written to the corpus folder in the documented format
- System-prompt injection of `agent.md` content per chat turn
- `read_file` tool registered and callable by the engine, with corpus-folder path containment
- Minimal static web chat UI served by the gateway, streaming reply via SSE
- Existing gateway/engine/memory contracts preserved
- `npm run check:conformance` continues to pass

**Out of scope for v1:**
- Multi-user / multi-conversation UI (sidebar, history list)
- Model picker, settings panel, UI auth
- Embeddings / vector search / RAG (deliberate — index-then-read is the chosen approach)
- File watcher (chokidar) — auto-reindex is boot-time only
- Citation post-processing or strict citation enforcement
- Document formats other than markdown (no PDF, no HTML, no code files)
- Recursive folder traversal beyond a configured depth
- Production observability (metrics, structured logs beyond what the template ships)
- Docs that don't fit in context — chunking strategy beyond simple truncation

## Technical Context

### Integration points

- **Gateway API contract** (`specs/openapi/gateway-api.yaml`): unchanged. Public request shape stays `{ content, metadata }`. The web UI sends this shape verbatim.
- **Gateway-engine contract** (`specs/openapi/gateway-engine.yaml`): unchanged at the wire. The gateway injects `agent.md` content into the system prompt via the existing engine handoff — no new fields.
- **Model API contract** (`specs/openapi/model-api.yaml`): unchanged at the contract level. Tool-calling support inside the existing schema is required; if the schema does not already permit tool calls, that is an Open Question to resolve in the build plan.
- **New internal: tool registry entry** for `read_file` (and optional `list_files`) under `src/engine/tool-executor.ts` or its existing tool registration hook. No new component.
- **Adapters touched:** none modified. Ollama is reached via the existing `openai-compatible` adapter, configured to point at `http://127.0.0.1:11434/v1` with model `qwen2.5:4b` (or current Qwen 4B build).
- **Gateway routes:** add `GET /` (or equivalent root path) returning the static chat HTML. Existing `/chat`, `/conversations` routes unchanged.

### Dependencies

- **Existing PAA components used:** Engine (loop + tool executor), Gateway (routes + streaming), Adapters (`openai-compatible`), Memory (conversation history), Auth (stubbed).
- **External services:** Ollama running locally on the user's machine (out-of-band setup; not managed by this build).
- **New packages:** none planned. The indexer can use Node built-ins (`node:fs`, `node:fs/promises`, `node:path`) and the existing adapter to call the model. The web UI is a single static HTML file with vanilla JS — no framework. **If** a build identifies a real need for a new dependency, the build plan must justify and pin it.

### Constraints

- **Local-first / offline-capable:** the system must run end-to-end with only Ollama on `localhost`. No cloud calls, no telemetry, no external network egress.
- **Localhost binding:** gateway continues to bind to `127.0.0.1` per the template's existing default. Do not introduce `0.0.0.0` binding.
- **Node:** `>=20 <21` (template's existing engines field).
- **TypeScript:** match the template's existing major (`^5.9.x` ships).
- **Performance:** prototype-grade. Boot-time indexing of ~10s of small markdown files should complete in a small number of seconds with Qwen 4B; no hard SLA.
- **Context window:** Qwen 4B = ~32k tokens. Index + a small number of full files must fit. If the corpus grows past that, the prototype is allowed to fail loudly — chunking is out of scope for v1.

## Test Strategy

### Test levels required

- [x] Unit — indexer staleness check, path containment in `read_file`, `agent.md` parse/format
- [x] Integration — boot sequence runs the indexer; gateway streams a chat response that includes a tool-call round-trip; `npm run index` script behaves correctly
- [ ] Property-based — not justified for v1 (path-containment unit tests are sufficient; revisit if invariants grow)
- [x] E2E — single happy-path user flow: server boots, browser hits `/`, submits a question, receives a streamed reply with a citation matching a real corpus file

### Verification approach

- **Agent self-verification:** `npm run check:conformance` (existing safety net) plus the new tests above. The build plan defines exact commands per phase.
- **Human verification:** open the web UI in a browser, ask a question against a small fixture corpus, eyeball the reply for grounded citations and reasonable streaming behavior.
- **Production monitoring:** N/A (prototype, single user, localhost).

### Baseline impact

- **Always-run checks affected:** `npm run check:conformance` continues to be the gate. No baseline command should regress.
- **Additional checks triggered:** new unit/integration test files under `test/` for the indexer, the `read_file` tool, and the boot hook. New conformance test if the build plan extends a contract (likely not).

## Security Considerations

### Risk level

- [x] Low — no user input from outside the local machine, no new APIs, no sensitive data, localhost only
- [ ] Medium
- [ ] High

The system is a single-user, localhost-bound prototype reading files in one configured folder. No multi-tenant blast radius. The one real surface is the `read_file` tool — it is reachable only via the model on the same machine, but a misbehaving prompt or model could request paths outside the corpus, so containment matters.

### Threat assessment

- **User input:** the only input is the user's own chat prompt, typed locally. Validation is light — gateway already validates the `{ content, metadata }` shape.
- **Code execution:** the system does not execute user-provided code. Tools are typed and finite (`read_file`, optionally `list_files`).
- **Data sensitivity:** the corpus may contain personal notes. Risk is local-only; the system does not transmit them anywhere except to the locally running model.
- **Network surface:** gateway binds `127.0.0.1`. Outbound calls go only to `127.0.0.1:11434` (Ollama). No new external endpoints.
- **Blast radius if compromised:** at worst, a malicious or confused model could try to read files outside the corpus folder via `read_file`. Path containment in the tool prevents this.

### Required mitigations

- `read_file` resolves paths with `path.resolve` + symlink resolution (`fs.realpath`) and rejects any path that does not start with the resolved corpus folder.
- `read_file` rejects file extensions outside an allowlist (`.md` and possibly `.txt`) — narrow surface even within the corpus.
- Indexer writes `agent.md` atomically (temp file + rename) to avoid leaving a partial index that future boots would consider valid.
- `agent.md` itself is excluded from the corpus crawl to avoid feeding old summaries back into new ones.

## Explicit Boundaries

### Do not modify

- Public gateway request shape (`{ content, metadata }`) — see `AGENT.md`.
- Streaming `done` payload (`conversation_id`, `message_id`) and `X-Conversation-ID` header.
- `POST /engine/chat` internal handoff contract.
- Provider-specific code outside `src/adapters/` — Ollama is reached only via the existing `openai-compatible` adapter, configured.
- Component boundaries enforced by `scripts/check-imports.ts`. Do not add cross-component imports outside the existing allowed patterns.
- Lock-in checks (`scripts/check-lockin.ts`).

### Do not introduce

- A new "fifth component" for tools, indexing, or RAG. Tools register inside the existing tool executor; the indexer lives inside `src/config/` boot or `src/gateway/` startup, not as a new top-level component.
- Runtime provider/model/tool overrides in engine request metadata (`AGENT.md` calls this out explicitly).
- A vector store, embeddings library, or RAG framework — this build chose index-then-read deliberately.
- A frontend framework (React/Vue/Svelte). v1 UI is a single static HTML file with vanilla JS.
- A file-watcher dependency (chokidar) — boot-time staleness check only.
- Networked egress beyond `127.0.0.1`.
- `0.0.0.0` binding or any change to the localhost-first default.

### Out of scope (even if related)

- Refactoring the existing engine/gateway/memory beyond what tool-call wiring strictly requires.
- Building a polished UI, theming, dark mode, mobile responsiveness.
- Multi-conversation UI, history sidebar, search.
- Auth UI or non-stub auth integration.
- Indexing non-markdown files, sub-folders deeper than configured, or remote sources.
- Deployment / packaging / Dockerfile.

## Open Questions

- **Engine tool-calling support:** `src/engine/tool-executor.ts` exists, but it's unverified whether the loop currently performs full tool-call round-trips with the `openai-compatible` adapter (model emits `tool_calls` → engine executes → model continues). The build plan's first phase must verify this and, if missing, scope the extension. **Action:** check during step 3.
- **Auth in this prototype:** the template has an Auth boundary on the request path. v1 assumes the existing localhost stub is acceptable (no real auth on a single-user localhost UI). **Confirm during build plan; flag if any new tool registration requires explicit Auth wiring.**
- **Model identifier exact string:** "Qwen 4B" — confirm the exact Ollama tag (`qwen2.5:4b` vs `qwen3:4b` etc.) at build time. Both have ≥32k context; either works for v1.
- **Index summarization prompt:** the prompt that asks the model to summarize each file is a build-plan detail, not a spec detail. Tuning happens during execution.
- **`list_files` tool:** included optionally; the build plan can drop it if the model performs well with just the index + `read_file`.

## Success Definition

When this feature is complete, Dave will be able to:

1. Start the gateway server with `BrainDrive Files/` configured as the corpus, and have `agent.md` automatically generated (or refreshed) before chat is available.
2. Open `http://localhost:<gateway-port>` in a browser, see a minimal chat input, type a question, and receive a streamed reply that names which markdown file(s) it pulled from.
3. Edit a markdown note, restart the server, and observe the index regenerate without running any extra command.
4. Run `npm run check:conformance` and have it pass — confirming the build did not drift the architecture.

---

## Changelog

| Date | Change | Source |
|---|---|---|
| 2026-05-06 | Initial spec | Interview 2026-05-06 + spec generation |
| 2026-05-06 | Added Index leanness invariant; tightened agent.md format spec to require ≤240-char summaries with server-side truncation | Loop after Phase 3 verification |
