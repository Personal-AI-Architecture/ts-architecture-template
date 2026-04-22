# Autonomous Agent Rules

This document defines implementation boundaries for autonomous coding agents in this repository.

## Component Boundaries

- `src/memory/*`
  - Owns persistence, conversation storage records, history, and export.
  - Must not depend on other components.
- `src/engine/*`
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

1. `plan.md`
2. `specs/openapi/gateway-api.yaml`
3. `specs/openapi/gateway-engine.yaml`
4. `specs/openapi/model-api.yaml`
5. `specs/schemas/message.json`
6. `scripts/check-contracts.ts`
7. `scripts/check-imports.ts`
8. `scripts/check-lockin.ts`
9. `test/conformance/*`

If examples diverge from contracts/checks, contracts and conformance checks are authoritative.

## Implementation Rules For Agents

- Preserve public gateway request shape: `{ content, metadata }` only.
- Preserve gateway stream contract including `X-Conversation-ID` and `done` payload identifiers (`conversation_id`, `message_id`).
- Preserve the internal engine handoff contract: `POST /engine/chat` with required `metadata.correlation_id`.
- Do not introduce runtime provider/model/tool overrides in engine request metadata.
- Keep provider/model swap behavior config-driven (`runtime.provider_adapter`, adapter config), not hardcoded in engine/gateway.
- Keep import boundaries intact; no cross-component coupling outside allowed patterns in `scripts/check-imports.ts`.
- Keep localhost-first boot defaults (`127.0.0.1`) and offline-capable local/mock path.
- Keep lock-in and conformance checks meaningful; do not bypass scripts/tests to force green output.

## Required Validation Before Finalizing Changes

Run the real checks:

```bash
npm run check:conformance
npm run acceptance:check
```

If either command fails, report exact failures and stop instead of downgrading validation.
