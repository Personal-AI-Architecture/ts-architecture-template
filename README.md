# TypeScript Architecture Template

A contract-first scaffold for building a personal AI system on the [Personal AI Architecture](https://personalaiarchitecture.org).

Four components:

- `memory`
- `engine` (agent loop)
- `gateway`
- `auth`

This template enforces API contracts, import boundaries, and lock-in checks so provider/tool changes stay config-driven. To understand the architecture itself — components, contracts, principles, and the lock-in guarantees — see the [foundation spec](https://github.com/Personal-AI-Architecture/the-architecture/blob/main/docs/foundation-spec.md).

For AI agents: start with [AGENT.md](AGENT.md) — component boundaries, contracts to preserve, and validation commands.

For building on the template: see [`prompts/README.md`](prompts/README.md) — a 5-step + loop workflow (interview → spec → build plan → execute → test → ↻ loop) you can hand to any coding agent.

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
3. Install and validate: `npm ci && npm run check:conformance && npm run acceptance:check`.
4. Configure required secrets/variables for your target provider (if using non-mock adapters).
5. Enable branch protection and required status checks on `main`.
6. Replace architecture examples/branding text in `README.md` with your project specifics.

## 5-Minute Developer Onboarding

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
  "content": "Summarize this architecture template.",
  "metadata": {
    "channel": "readme-demo",
    "correlation_id": "corr-readme-demo-001"
  }
}
```

What to look for:

- stream response includes `Content-Type: text/event-stream`
- stream emits `text-delta` then `done`
- `done` payload contains `conversation_id` and `message_id`
- `X-Conversation-ID` header is returned
- `GET /conversations/:id` returns persisted user + assistant history

### 4) Run conformance and lock-in checks

```bash
npm run check:conformance
npm run acceptance:check
```

These commands cover contracts, boundary imports, lock-in gates, conformance tests, and acceptance checks.

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
  -> Gateway API (`/chat`, `/conversations`, `/conversations/{id}`, `/conversations/{id}/messages`)
     -> Gateway component (`src/gateway/*`)
        -> Internal contract: POST /engine/chat
           -> Engine component (`src/engine/*`)
              -> Adapters (`src/adapters/*`) -> Model API (`/chat/completions` style)
              -> Tools (validated by source + permissions)
                 -> Memory component (`src/memory/*`)

Auth boundary (`src/auth/*`) sits on request path and injects actor headers.
Shared contracts/types live in `src/types/*`.
```

## Anti-Drift: What Not To Change

- Do not change public Gateway request shape from `{ content, metadata }` to `{ messages, metadata }`.
- Do not remove `conversation_id` + `message_id` from `done` payloads.
- Do not remove `X-Conversation-ID` from streaming responses.
- Do not add runtime provider/model/tool override keys to engine request metadata.
- Do not move provider-specific tokens (for example `/chat/completions`, `api_key`) outside `src/adapters/`.
- Do not introduce cross-component imports that violate `scripts/check-imports.ts`.
- Do not weaken or bypass contract/conformance/lock-in checks.

If any example in docs, tests, or code appears inconsistent, contracts and conformance checks win.

## Source Of Truth Order

Use artifacts in this order when implementing or reviewing changes:

1. `plan.md`
2. `specs/openapi/gateway-api.yaml`
3. `specs/openapi/gateway-engine.yaml`
4. `specs/openapi/model-api.yaml`
5. `specs/schemas/message.json`
6. `scripts/check-contracts.ts`
7. `scripts/check-imports.ts`
8. `scripts/check-lockin.ts`
9. `test/conformance/*`

Rule: when examples diverge from contracts/checks, contracts and conformance checks are authoritative.

## Quick Troubleshooting (Contract Failures)

- `Contract check failed: Gateway API must define /chat endpoint.`
  - Restore endpoint definitions in `specs/openapi/gateway-api.yaml`.
- `PublicGatewayMessageRequest must not include messages array.`
  - Ensure request schema only has `content` and `metadata`.
- `CompletionPayload property drift...`
  - Ensure completion payload is exactly `conversation_id` and `message_id`.
- `Forbidden component coupling...`
  - Fix imports to stay within the owning component or `src/types`.
- `Provider-specific token ... must stay within src/adapters/`
  - Move provider-specific constants/parsing back into adapter files.

After a fix, re-run:

```bash
npm run check:conformance
npm run acceptance:check
```
