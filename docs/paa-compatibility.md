# PAA Compatibility Policy

This template is pinned to the Personal AI Architecture contract source at
commit `28e9a275a0f5e062aa4452892e9ec70644f88c69`. The pin is recorded in
[`paa.lock.json`](../paa.lock.json), and the exact contract files are vendored
under [`vendor/paa-contracts/`](../vendor/paa-contracts/).

## Required alignment

The following are normative and must remain byte-for-byte aligned with the
pinned PAA source:

- Gateway API routes and schemas.
- Gateway ↔ Agent Loop internal contract.
- Model API contract.
- Canonical message, configuration, identity, policy, and tool-definition schemas.
- The PAA terminology used in implementation-facing documentation.

The template runtime may have stricter internal types, but every public or
cross-component payload must remain valid against the pinned PAA contracts.

## Intentional, versioned extensions

- `EXT-001` — `POST /chat` remains as a legacy template convenience alias for
  `POST /conversations/messages`. It is not part of the PAA contract and is
  tested separately from the canonical route.
- `EXT-002` — Source paths and symbols under `src/engine/` retain the legacy
  name because PAA still reserves `/agent-loop/chat` and `gateway-engine.yaml` in
  the current contract. New documentation uses “Agent Loop.”
- `EXT-003` — The OpenAI-compatible provider transport may use provider-native
  `/chat/completions` details, but those details must remain inside
  `src/adapters/` and never appear in PAA-facing contracts.
- `EXT-004` — The template accepts legacy OpenAI-shaped tool definitions and
  tool calls at the JavaScript compatibility boundary, but normalizes them to
  PAA `{name, description, parameters}` and `{id, name, arguments}` objects
  before the Agent Loop, tool executor, or PAA-facing stream sees them.

Extensions must not change the pinned PAA contract files. Any new extension
requires a new entry here, a compatibility test, and an explicit removal or
versioning policy.

## Verification

```bash
npm run check:paa
npm run check:conformance
npm run acceptance:check
```

The upstream PAA repository currently publishes its four conformance categories
as implementation-agnostic test specifications rather than executable scripts.
The template's `check:conformance` suite is the executable reference gate for
those categories here: contract/pin checks, swap and boundary checks, and the
template conformance tests run before acceptance.

CI also runs `npm run check:paa:remote`, which fails when the PAA `main` branch
moves beyond the pinned commit. That forces an intentional pin review before
upstream contract changes can enter the template.
