# Chat With My Docs

A localhost-only prototype: chat with a folder of personal markdown notes through a small web UI. The agent reads `agent.md` (a generated index) and uses a `read_file` tool to ground answers in the actual files, citing sources.

> Spec: [`spec.md`](spec.md). Build plan: [`build-plan.md`](build-plan.md).

## Architecture summary

```text
Browser (GET /) --(SSE)--> http-listener.ts --> Gateway routes
                                                  |
                                                  v
                                    Engine + read_file tool (source: corpus)
                                                  |
                                                  v
                                  Adapter (openai-compatible) --> Ollama
```

- **`agent.md`** is regenerated at server start when stale (any markdown file's mtime > `agent.md`'s).
- **`read_file`** is path-contained to the configured corpus folder; `.md`/`.txt` only.
- All template lock-in / drift / contract checks remain green.

## Prerequisites

- **Node 20** (template's pinned version: `>=20 <21`). Use `nvm use` if you have nvm.
- **Ollama** running locally with a tool-calling-capable model:

  ```bash
  brew install ollama          # or download from ollama.com
  ollama pull qwen2.5:7b       # ~4.7 GB; reliable OpenAI-compatible tool calling on Ollama
  ollama serve                 # OpenAI-compatible API at http://127.0.0.1:11434/v1
  ```

  **Model choice matters.** This app depends on real OpenAI-compatible `tool_calls` round-trips. Qwen2.5 (any size) handles this cleanly on Ollama. Qwen3, Gemma 2/3/4, and some others tend to *fake* tool calls in the text channel — the engine never sees them and answers become hallucinations. If you swap models, watch for the `Sources:` chip under assistant replies — its absence means the model isn't actually invoking `read_file`.

- A folder of markdown files. The default fixture path used during development is `/Users/davidwaring/Desktop/BrainDrive Files`.

## Run

From the repo root:

```bash
nvm use                                # pin Node 20
npm ci                                 # if deps not installed
CORPUS_ROOT="/path/to/your/markdown" npm start
# server prints: Listening on http://127.0.0.1:3000/
```

Open `http://127.0.0.1:3000/` in your browser, type a question, and watch the answer stream back with cited file paths underneath.

### Re-indexing without restart

```bash
CORPUS_ROOT="/path/to/your/markdown" npm run index
```

Use this when you've edited a markdown file and want a fresh `agent.md` while the server is still running.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CORPUS_ROOT` | _required_ | Absolute path to the markdown folder |
| `RUNTIME_PROVIDER_ADAPTER` | `openai-compatible` | `openai-compatible` (Ollama) or `mock` (offline) |
| `OPENAI_API_BASE_URL` | `http://127.0.0.1:11434/v1` | Ollama OpenAI-compatible endpoint |
| `OPENAI_MODEL` | `qwen2.5:7b` | Model tag installed in Ollama (must support OpenAI-compatible tool calls) |
| `OPENAI_API_KEY` | `ollama` | Placeholder; Ollama ignores this |
| `MEMORY_ROOT` | `.runtime-memory/chat-with-docs` | Where conversations persist |
| `BIND_ADDRESS` | `127.0.0.1` | Listener bind; must be loopback unless `ALLOW_NON_LOCAL_BIND=true` |
| `PORT` | `3000` | HTTP listener port |
| `ALLOW_NON_LOCAL_BIND` | `false` | Set `true` to allow non-localhost binds (don't) |

## What's in this project

| Path | Role |
|---|---|
| `src/tools/corpus/indexer.ts` | `isIndexStale`, `buildIndex`, `writeIndexAtomic`, `ensureCorpusIndex` |
| `src/tools/corpus/read-file.ts` | `read_file` tool definition + handler factory (path-contained, `.md`/`.txt`) |
| `src/gateway/http-listener.ts` | Thin `node:http` listener (localhost-default, SSE streaming) |
| `src/gateway/static-chat.ts` | Vanilla-JS chat UI |
| `src/gateway/routes.ts` | (unchanged behavior; adds `GET /` returning the chat page) |
| `scripts/start-server.js` | `npm start` — the entrypoint |
| `scripts/run-index.js` | `npm run index` — manual rebuild |
| `scripts/demo-chat-with-docs.js` | `npm run demo:chat-with-docs` — smoke test |
| `test/unit/corpus-*.test.js` | Unit tests for indexer + read_file |
| `test/integration/corpus-*.test.js` | Integration tests for ensureCorpusIndex + buildIndex |
| `test/integration/http-listener.test.js` | HTTP listener tests |
| `test/integration/drift-regressions.test.js` | Drift-guard regression tests |

## Verification

```bash
nvm use
npm run check:conformance     # contracts + imports + lock-in + 14 conformance tests
npm run acceptance:check      # provider/model/tool swap regression suite
npm run demo:chat-with-docs -- --adapter=stub   # full tool-call round-trip smoke
npm run demo:provider-swap    # confirms config-only swap path still works
```

All tests:

```bash
node --test test/unit/*.test.js test/integration/*.test.js test/conformance/*.test.js
```

## Known limitations (v1)

- Single user, single conversation per page load (no history sidebar).
- No file watcher — restart the server (or `npm run index`) after editing notes to refresh the index.
- Citations are model-emitted: enforcement is the prompt + the `read_file` tool's path containment. If the model hallucinates a citation, v1 will not catch it (Phase 3 manual pass is the human check).
- Markdown only; no PDF, HTML, or recursive subfolder traversal.
- Localhost-only by design; do not expose this beyond `127.0.0.1`.

## Drift defenses

The build plan's [Drift Considerations](build-plan.md#drift-considerations) section enumerates the patterns this build defends against. Coded defenses live in:

- `test/integration/drift-regressions.test.js` — metadata side-channel rejection, tool source gating, citation soundness.
- `test/integration/http-listener.test.js` — localhost default, top-level field rejection.
- `test/unit/corpus-read-file.test.js` — path-traversal, symlink-escape, extension allowlist.
- `npm run check:conformance` — the template's safety net.
