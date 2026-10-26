# Autonomous Agent Rules

This document defines implementation boundaries for autonomous coding agents in this repository.

## Component Boundaries

- `src/memory/*`
  - Owns persistence, conversation storage records, history, and export.
  - Must not depend on other components.
- `src/agent-loop/*`
  - Owns agent loop orchestration and tool execution.
  - Must not contain provider-specific transport logic.
- `src/gateway/*`
  - Owns client route handling, request normalization, SSE forwarding, and conversation lifecycle.
  - Must not execute tools directly or embed provider selection behavior.
- `src/auth/*`
  - Owns request-path authentication/authorization and actor context.
  - Must remain an enforced boundary, not a stub.
- `src/adapters/*`
  - Owns provider-specific API mapping and streaming translation.
  - Provider-specific constants/tokens stay here.
- `src/config/*`
  - Owns runtime boot sequencing and runtime configuration loading.
- `src/types/*`
  - Owns shared contracts, safety helpers, audit/network/approval primitives.

## Source Of Truth Order

When implementing, reviewing, or reconciling drift, use this order:

1. `paa.lock.json` and `vendor/paa-contracts/`
2. `contracts/openapi/gateway-api.yaml`
3. `contracts/openapi/gateway-agent-loop.yaml`
4. `contracts/openapi/model-api.yaml`
5. `contracts/schemas/message.json`
6. `scripts/check-paa-pin.ts`
7. `scripts/check-contracts.ts`
8. `scripts/check-imports.ts`
9. `scripts/check-lockin.ts`
10. `test/conformance/*`

The shared language-neutral validator is a separate repository. Clone
`https://github.com/Personal-AI-Architecture/paa-conformance-validator.git`
beside this template, then use `../paa-conformance-validator/bin/paa-validate.js`
with this checkout's `paa.target.json`. The architecture source repository is
`the-architecture`; clone it beside the template for `--source-checkout`.

If examples diverge from contracts/checks, contracts and conformance checks are authoritative.

## Implementation Rules For Agents

- Preserve the PAA public gateway request shape: `{ content, metadata? }` only.
- Preserve the PAA gateway routes: `POST /conversations/messages`, `GET /conversations`,
  `GET /conversations/{id}`, and `POST /conversations/{id}/messages`.
- Preserve gateway stream contract including `X-Conversation-ID`, `finish_reason`,
  and the assistant `message_id` in the `done` payload.
- Preserve the PAA Agent Loop handoff contract: `POST /agent-loop/chat` with required `metadata.correlation_id`.
- Do not introduce runtime provider/model/tool overrides in Agent Loop request metadata.
- Keep adapter-format selection in runtime config. Read the active provider profile and model preference on every message; send both on every model request. Switching a listed profile or model requires no restart.
- Keep import boundaries intact; no cross-component coupling outside allowed patterns in `scripts/check-imports.ts`.
- Keep localhost-first boot defaults (`127.0.0.1`) and offline-capable local/mock path.
- Keep the PAA pin, contract mirror, lock-in, and conformance checks meaningful; do not bypass scripts/tests to force green output.

## Required Validation Before Finalizing Changes

Run the real checks:

```bash
npm run check:conformance
npm run acceptance:check
```

If either command fails, report exact failures and stop instead of downgrading validation.
