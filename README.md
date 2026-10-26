# TypeScript Architecture Template

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A contract-first scaffold for building a personal AI system on the [Personal AI Architecture](https://personalaiarchitecture.org).

The current contract pin is recorded in `paa.lock.json`. For the architecture's
`v1.0-rc.1` newcomer test, use template commit `0861782` (the verified starting
point). The tag is two documentation-only commits newer than the template's
contract pin. The live check below verifies a bounded Gateway journey, not
complete product conformance.

Four components:

- `memory`
- `agent loop` (`src/engine`, legacy path)
- `gateway`
- `auth`

This template enforces the pinned PAA contracts, import boundaries, and lock-in checks. Adapter format is configured at startup; the selected model and provider profile are read from Memory on every message. The in-process Agent Loop supports configured tools, but the `npm start` HTTP starter currently passes an empty tool list and does not load `tool_sources`. See [docs/paa-compatibility.md](docs/paa-compatibility.md) for the pin and compatibility policy, the [PAA architecture overview](https://github.com/Personal-AI-Architecture/the-architecture/blob/main/architecture/overview.md) for component names, and the [decision glossary](https://github.com/Personal-AI-Architecture/the-architecture/blob/main/maintainers/decision-glossary.md) for decision IDs.

The current contract checks cover per-request model and provider selection, provider-profile routing, saved reply provenance, context limits and notices, and overflow before a live tool-result continuation. The template is a starting point for an implementation, not a claim that every product-specific PAA conformance case is complete.

For AI agents: start with [AGENT.md](AGENT.md) — component boundaries, contracts to preserve, and validation commands.

For building on the template: see [`prompts/README.md`](prompts/README.md) — a 5-step + loop workflow (interview → spec → build plan → execute → test → ↻ loop) you can hand to any coding agent.

For a complete worked example of that workflow — recorded interview, spec, build plan, full source, and a per-phase walkthrough — see [`chat-with-my-docs-example`](https://github.com/Personal-AI-Architecture/chat-with-my-docs-example).

## Create A New Repo From This Template (Preferred)

Use GitHub's template flow instead of `git clone` so your new project starts clean.

### GitHub UI

1. Open this repository on GitHub.
2. Click `Use this template` -> `Create a new repository`.
3. Choose owner/name/visibility, then create the repo.
4. Clone your new repo locally and start building.

### If You Accidentally Cloned The Template

Point your local `origin` at your own new repository:

```bash
git remote set-url origin https://github.com/<your-org>/<your-new-repo>.git
git remote -v
```

### Post-Template Checklist

After creating your new repository from this template:

1. Rename package metadata in `package.json` (`name`, `description`, `version`).
2. Pin runtime locally: `nvm use` (uses `.nvmrc`, Node 20).
3. Install and validate: `npm ci && npm run check:paa && npm run check:conformance && npm run acceptance:check`.
4. Configure required secrets/variables for your target provider (if using non-mock adapters).
5. Enable branch protection and required status checks on `main`.
6. Replace architecture examples/branding text in `README.md` with your project specifics.

The executable checks cover this starter's text-message journey and declared component boundaries. Pinning the full PAA contract set does not by itself certify unimplemented product-specific paths such as production authentication, approval policy, or multimodal provider handling.

## Live Gateway quickstart

### Start the live Gateway

Generate a local owner token with `openssl rand -hex 24`, store it outside
Memory, and set `PAA_DEMO_API_KEY` to that value. Then start the HTTP server:

```bash
export PAA_DEMO_API_KEY='replace-with-a-local-test-token'
npm start
```

Send a canonical PAA message from another terminal:

```bash
curl -N -X POST http://127.0.0.1:8000/conversations/messages \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $PAA_DEMO_API_KEY" \
  -d '{"content":[{"type":"text","text":"Explain PAA."}]}'
```

The server accepts `X-API-Key` and Bearer auth, rejects requests over 1 MiB,
and saves conversations under `RUNTIME_MEMORY_ROOT` (default
`.runtime-memory/development`). Auth state lives beside that root by default;
set `PAA_AUTH_STATE_ROOT` to keep it elsewhere. The token is for local testing.

### Choose a provider configuration

For a single OpenAI-compatible profile named `local`, set
`RUNTIME_PROVIDER_ADAPTER=openai-compatible`, `PAA_MODEL_API_BASE_URL`,
`PAA_MODEL_ID`, `PAA_MODEL_CONTEXT_LIMIT`, and `PAA_MODEL_API_KEY` in the local
environment before starting.

For named OpenAI-compatible profiles, put their connection
settings in an untracked adapter config file and set `PAA_ADAPTER_CONFIG_FILE`
to its path. For example, an OpenRouter profile uses
`https://openrouter.ai/api/v1` and an `OPENROUTER_API_KEY` environment variable
([OpenRouter's endpoint](https://openrouter.ai/developers)). Set a verified model
ID and conservative context limit in `model_context_limits`; never put the API
key value in this file or Memory. The `api_key_env` field names the environment
variable holding the key; it is `OPENROUTER_API_KEY` in this example, while the
single-profile path above uses `PAA_MODEL_API_KEY`. `PAA_DEFAULT_PROVIDER` and
`PAA_MODEL_ID` seed owner preferences only when they do not yet exist.

```json
{"provider_profiles":{"openrouter":{"base_url":"https://openrouter.ai/api/v1","api_key_env":"OPENROUTER_API_KEY","model_context_limits":{"first-model-id":8192,"second-model-id":8192}}}}
```

The adapter config is loaded at startup. To change the model without a restart,
list every intended model under `model_context_limits` before starting; to
change provider profile without a restart, load that profile at startup too.
Check current model IDs with the provider before using them.

The authenticated `PUT /owner/preferences` route updates the owner's selection
through Memory. For example, with another configured profile and model:

```bash
curl -X PUT http://127.0.0.1:8000/owner/preferences \
  -H 'Content-Type: application/json' -H "X-API-Key: $PAA_DEMO_API_KEY" \
  -d '{"model":"your-model-id","active_provider_profile":"your-profile"}'
```

The next message reads that selection without restarting. Currently this route
stores any non-empty model and profile strings. If one is not configured, the
next message returns `503 context_limit_unknown`; no default is substituted.
Send another `PUT` with a configured selection to recover. A provider request
failure appears as a generic `provider_error` to the client; the server's
stdout audit/diagnostic output has the status for troubleshooting. A failed
provider turn can leave its user message saved without an assistant reply.

The shared validator is a separate repository. From this template's root,
clone it beside the template once, then run the live and provider checks:

```bash
git clone https://github.com/Personal-AI-Architecture/paa-conformance-validator.git ../paa-conformance-validator
node ../paa-conformance-validator/bin/paa-live-target.js --target paa.target.json
node ../paa-conformance-validator/bin/paa-provider-target.js --target paa.target.json
```

The direct `paa-live.js` check against an already-running server has 11 named
checks. `paa-live-target.js` starts this template and adds four Memory/restart
checks. `paa-provider-target.js` starts a separate server and controlled
provider and adds six selection checks, for 21 total; it does not make a real
provider call.

## Offline mock demos and repository checks

These numbered steps use in-process mock adapters. Use the live quickstart
above to test the HTTP server and a real provider.

### 1) Install dependencies from a clean checkout

```bash
git clone <your-fork-or-template-url>
cd ts-architecture-template
npm ci
npm run check
```

Expected: `npm run check` passes `check:toolchain` and `check:deps`.

### 2) Run in local/mock mode with localhost-only defaults

```bash
npm run acceptance:check -- --boot-only
```

What this verifies:

- runtime boot order is correct
- bind address defaults to `127.0.0.1` (localhost only)
- provider `mock`/`local` runs in offline mode

### 3) Send a canonical client message (`content` + `metadata`), observe SSE stream, and verify conversation persistence

Run the end-to-end local demo:

```bash
npm run demo:onboarding
```

Script source: `scripts/demo-onboarding.js`

Canonical client request shape used above:

```json
{
  "content": [{"type": "text", "text": "Summarize this architecture template."}],
  "metadata": {
    "channel": "readme-demo",
    "correlation_id": "corr-readme-demo-001"
  }
}
```

What to look for:

- stream response includes `Content-Type: text/event-stream`
- stream emits `text-delta` then `done`
- `done` payload contains `finish_reason` and `message_id`
- `X-Conversation-ID` header is returned
- `GET /conversations/:id` returns persisted user + assistant history

### 4) Run conformance and lock-in checks

```bash
npm run check:conformance
npm run acceptance:check
```

These commands cover the pinned PAA contract mirror, boundary imports, lock-in gates, conformance tests, and acceptance checks. The canonical create route is `POST /conversations/messages`; the legacy `POST /chat` alias is documented as [EXT-001](docs/paa-compatibility.md).

Clone the architecture repository beside the template to compare against its
current contract source, then run the shared validator from the template root:

```bash
git clone https://github.com/Personal-AI-Architecture/the-architecture.git ../the-architecture
node ../paa-conformance-validator/bin/paa-validate.js \
  --target paa.target.json \
  --source-checkout ../the-architecture
```

### 5) Perform one config-only provider swap

This proves provider selection is runtime-config driven and does not require editing the engine loop.

```bash
npm run demo:provider-swap
```

Script source: `scripts/demo-provider-swap.js`

Expected output:

- `local -> mock`
- `openai-compatible -> openai-compatible`

## Architecture Boundary Map

```text
Client
  -> Gateway API (`/conversations/messages`, `/conversations`, `/conversations/{id}`, `/conversations/{id}/messages`)
     -> Gateway component (`src/gateway/*`)
        -> Internal contract: POST /agent-loop/chat
           -> Agent Loop component (`src/engine/*`)
              -> Adapters (`src/adapters/*`) -> Model API (`/completions`)
              -> Tools (validated by source + permissions)
                 -> Memory component (`src/memory/*`)

Auth boundary (`src/auth/*`) sits on request path and injects actor headers.
Shared contracts/types live in `src/types/*`.
```

## Anti-Drift: What Not To Change

- Do not change public Gateway request shape from `{ content, metadata? }` to `{ messages, metadata }`.
- Do not remove `finish_reason` or `message_id` from `done` payloads.
- Do not remove `X-Conversation-ID` from streaming responses.
- Do not add runtime provider/model/tool override keys to engine request metadata.
- Do not move provider-specific tokens (for example `/chat/completions`, `api_key`) outside `src/adapters/`.
- Do not introduce cross-component imports that violate `scripts/check-imports.ts`.
- Do not weaken or bypass contract/conformance/lock-in checks.

If any example in docs, tests, or code appears inconsistent, contracts and conformance checks win.

## Source Of Truth Order

Use artifacts in this order when implementing or reviewing changes:

1. `paa.lock.json` and `vendor/paa-contracts/`
2. `contracts/openapi/gateway-api.yaml`
3. `contracts/openapi/gateway-engine.yaml`
4. `contracts/openapi/model-api.yaml`
5. `contracts/schemas/message.json`
6. `scripts/check-paa-pin.ts`
7. `scripts/check-contracts.ts`
8. `scripts/check-imports.ts`
9. `scripts/check-lockin.ts`
10. `test/conformance/*`

Rule: when examples diverge from contracts/checks, contracts and conformance checks are authoritative.

## Quick Troubleshooting (Contract Failures)

- `PAA pin check failed...`
  - Review the pinned commit, vendored hashes, and local contract mirror.
- `Gateway API path ... has drifted.`
  - Restore the canonical PAA route in `contracts/openapi/gateway-api.yaml` and update the runtime/test together.
- `Model API must not promote provider-native /chat/completions...`
  - Keep provider-native transport details inside `src/adapters/`; the PAA contract is `/completions`.
- `Forbidden component coupling...`
  - Fix imports to stay within the owning component or `src/types`.
- `Provider-specific token ... must stay within src/adapters/`
  - Move provider-specific constants/parsing back into adapter files.

After a fix, re-run:

```bash
npm run check:conformance
npm run acceptance:check
```
