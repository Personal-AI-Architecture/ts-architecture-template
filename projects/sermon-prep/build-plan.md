# Build Plan: Sermon Prep Tool

**Status:** Not Started

---

## Overview

Localhost web prototype on the PAA template that walks pastors through a 6-stage sermon prep conversation, building `outline.md` on disk via tool calls. Same staging pattern as `chat-with-docs/` — sibling project, validate the workflow on the template before porting into BrainDrive (D33). This build also exercises two PAA paths chat-with-docs didn't: **mutating tools with the approval gate**, and **cloud egress** (OpenRouter → Claude) via the existing `openai-compatible` adapter.

See `spec.md` for detailed requirements and user stories.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Build target | `~/ts-architecture-template/projects/sermon-prep/`, sibling to `chat-with-docs/` | Reuses the template substrate (gateway, engine, adapters, memory). Two coexisting projects on one template. |
| Model + provider | OpenRouter API → `anthropic/claude-sonnet-4.5` (default) via existing `openai-compatible` adapter | OpenRouter is OpenAI-compatible; adapter handles `tools` parameter forwarding without modification. Claude's conversational quality is the right bar for sermon prep. |
| Outline location | `~/SermonPrep/<sermon-slug>/outline.md` (env var `SERMON_ROOT`, default `~/SermonPrep`) | Mirrors chat-with-docs' `CORPUS_ROOT` pattern. Keeps user data outside the template repo. |
| Section vocabulary | Closed allowlist: `topic`, `big_idea`, `anchor_scripture`, `point_1`, `point_2`, `point_3`, `conclusion`, `call_to_response`, `notes` | Bounds the AI's footguns; section name cannot encode a path. Matches the brief's outline structure. |
| Tool shape | One generalized `update_outline_section(section, content)` for writes; separate `read_outline()` for reads | Fewer tool definitions than per-section setters; vocabulary lives in the system prompt + the tool's parameters schema. |
| Approval gate | Auto-approve writes for `source: "sermon"` (mirrors memory tools' conversation-persistence auto-approval) | First real exercise of the template's `mutates_state` + `ApprovalGate` path. Single-user localhost; AI calls the write tool routinely during the workflow. |
| Voice signal | Global `~/SermonPrep/voice.md` (pastor jots phrasings) loaded into system prompt every turn | Cheap (~15 lines of code) middle ground between "no voice signal" (Q7a) and "full archive" (Q7b/Phase 4). |
| Congregation context | Global `~/SermonPrep/congregation.md` loaded every turn; per-sermon override is post-MVP | One pastor, one congregation in v1; hybrid pattern is post-MVP. |
| BSB scripture attribution | System-prompt instruction only; pastor verifies | OQ3a. No `lookup_scripture` tool in v1. Loop to a tool only if Phase 1 surfaces real drift. |
| Stage transitions | System-prompt heuristic ("after pastor confirms a section, propose advancing; if pastor says 'jump to X', jump"); iterate during build | OQ4 deferred. Not a spec-level invariant. |
| UI phasing | Phase 1 chat-only; Phase 2 read-only outline pane; Phase 3 editable; Phase 4 sermon picker + archive | Validate workflow first; polish budget grows phase over phase. |
| Tool location | `src/tools/sermon/` (new sibling to `src/tools/corpus/`) | Same imports-policy story as chat-with-docs — `src/tools/<name>/` is permitted; component boundary check skips it. |
| Dependencies | None new (Node built-ins + existing template) | Sermon UI is vanilla JS; `node:fs`, `node:fs/promises`, `node:path`, `node:http` only. |

## Architecture

### Component Diagram

```text
Browser (chat UI)
  -> http-listener.ts (existing, from chat-with-docs Phase 2)
     -> Gateway routes [unchanged contract]
        -> POST /chat                          [new sermon entrypoint script wires this]
           -> withSermonSystemPrompt(...)      [wrapper injects outline + congregation + voice]
              -> Engine [unchanged loop logic]
                 -> Adapter (openai-compatible) -> OpenRouter -> Claude
                 -> ToolExecutor.executeMany()
                    -> update_outline_section handler [new, source: "sermon", mutates_state: true]
                    -> read_outline handler           [new, source: "sermon"]
                    -> ApprovalGate                   [auto-approves source: "sermon"]

Boot (entrypoint script):
  validate SERMON_ROOT + SERMON
  scaffold sermon folder + outline.md if missing
  build adapter (openai-compatible @ openrouter.ai)
  build memory + conversation store
  register sermon tools + auto-approval gate
  start http listener (127.0.0.1, default 3000)
```

### Components Touched

#### 1. Engine (Agent Loop)

- **Purpose:** runs the existing tool-call loop; consumes the new sermon tools through `AgentLoopConfig.tools` injection. **First time `mutates_state: true` is exercised end-to-end** in this template — exists in code, but neither chat-with-docs nor the existing tests drive a full real-flow with approval gating.
- **Files:** none modified.
- **Contract changes:** none.

#### 2. Gateway

- **Purpose in this build:** unchanged routing; serves the new sermon-prep web UI. Phase 2 adds `GET /outline?sermon=<slug>` (read-only); Phase 3 adds `PUT /outline/<section>` (in-place edit). Existing `http-listener.ts` reused.
- **Files added:**
  - `src/gateway/static-sermon-prep.ts` (Phase 1) — new chat HTML/JS for sermon prep. Vanilla HTML/JS, dark-mode-aware, single-pane.
  - `src/gateway/static-sermon-prep.ts` (Phase 2 update) — adds the read-only outline pane.
  - `src/gateway/static-sermon-prep.ts` (Phase 3 update) — adds in-place edit.
- **Files modified:**
  - `src/gateway/routes.ts` — add a new route shape that serves either chat-with-docs or sermon-prep based on a config flag (the entrypoint chooses; routes don't pick by themselves). **Or** keep the routes generic and let the entrypoint compose; either is acceptable so long as no cross-project coupling appears in the routes module.
- **Contract changes:** Phase 2 + 3 add internal endpoints. Public chat shape `{ content, metadata }`, `done` payload, `X-Conversation-ID` header all preserved.

#### 3. Adapters

- **Purpose:** unchanged. OpenRouter is reached via the existing `openai-compatible` adapter, configured with `api_base_url: "https://openrouter.ai/api/v1"`, `model: "anthropic/claude-sonnet-4.5"` (env-overridable), `api_key` from env.
- **Files:** none modified.
- **Contract changes:** none.

#### 4. Tools (capability surface, not a component)

- **Files added:**
  - `src/tools/sermon/outline.ts` — `update_outline_section` tool definition + handler factory; `read_outline` tool definition + handler factory; section allowlist constant; outline scaffold helpers (`scaffoldOutline`, `parseOutlineSections`, `replaceOutlineSection`, `writeOutlineAtomic`).
  - `src/tools/sermon/system-prompt.ts` — assembly of the per-turn system prompt (workflow rules + voice rules + congregation + voice + current outline). Reads files fresh each call.
- **Tool definitions:**
  - `update_outline_section` — `source: "sermon"`, `mutates_state: true`, `required_permissions: []`. Section name validated against the closed allowlist.
  - `read_outline` — `source: "sermon"`, `mutates_state: false`, `required_permissions: []`.

#### 5. Configuration / Boot

- **Purpose:** new entrypoint script `scripts/start-sermon-prep.js` that composes memory + adapter + tools + system-prompt-injection wrapper + http listener. Mirrors `scripts/start-server.js` from chat-with-docs.
- **Files added:** `scripts/start-sermon-prep.js`, `scripts/demo-sermon-prep.js`.
- **Files modified:** `package.json` adds `npm run start:sermon-prep`, `npm run demo:sermon-prep`.
- **Contract changes:** none. `RuntimeConfiguration` is unchanged (corpus-style env vars stay at the entrypoint layer).

#### 6. Memory / Auth

- **Purpose:** unchanged. Memory persists conversation history per sermon (key = sermon slug). Auth uses the same localhost shim as chat-with-docs.

### Data Flow

1. Pastor runs `SERMON=acts-kingdom-focus npm run start:sermon-prep` (with `OPENAI_API_KEY` and `OPENAI_MODEL` set).
2. Entrypoint validates `SERMON_ROOT` + `SERMON`; creates `~/SermonPrep/acts-kingdom-focus/` if missing; scaffolds an empty `outline.md` (section headers + empty bodies).
3. Pastor opens `http://127.0.0.1:3000/`, sees the chat UI.
4. Pastor types "I want to preach on saying yes to God".
5. Gateway routes the message; engine handler wraps it with a fresh system prompt assembled from `outline.md` + `congregation.md` + `voice.md`.
6. Engine streams from Claude (via OpenRouter via the openai-compatible adapter). Claude eventually emits a `tool_calls` response for `update_outline_section(section: "topic", content: "Saying yes to God — what it costs and what it gives.")`.
7. ToolExecutor receives the call, validates `mutates_state: true` against the auto-approving sermon `ApprovalGate`, runs the handler, atomically writes to `outline.md`.
8. Tool result returns; engine continues the conversation (Claude acknowledges the write, asks about anchor scripture).
9. Conversation history persists per turn via the existing memory tool.
10. On restart, the system prompt re-reads `outline.md`; the AI continues from current state.

---

## Implementation Roadmap

### Schedule Overview

| Phase | Goal | Status |
|---|---|---|
| 1 | Sermon tools + on-disk outline + chat-only UI; full 6-stage flow works end-to-end with Claude via OpenRouter | Complete |
| 2 | Read-only outline preview pane (auto-refresh on `tool-result`) | Complete |
| 3 | In-place outline editing in the UI | Complete (pending user verification) |
| 4 | Sermon picker page + past-sermons archive integration | Not Started |

### Phase 1: Tools + on-disk outline + chat-only UI

**Status:** Complete (pending user verification)

**Goal:** A pastor can run `SERMON=<slug> npm run start:sermon-prep`, open the browser, converse through the 6 stages, and end with a populated `outline.md`. No outline pane in the UI yet; pastor opens the file in an editor.

**Tasks (tests-first ordering):**

| # | Task | US | Status |
|---|---|---|---|
| 1.1 | Confirm `src/tools/sermon/` is permitted by `scripts/check-imports.ts` (same logic as `src/tools/corpus/`); document in work log | — | Not Started |
| 1.2 | Write unit tests for the section allowlist (`update_outline_section` rejects unknown / path-shaped section names; accepts every allowed section) | invariants | Not Started |
| 1.3 | Write unit tests for atomic outline write + outline scaffold + parse-and-replace-section helper (including failure-injection: rename failure leaves prior outline intact) | invariants | Not Started |
| 1.4 | Write unit tests for system-prompt assembly: missing congregation.md → placeholder; missing voice.md → silent skip; outline.md re-read fresh per call; sermon root path-contained | invariants | Not Started |
| 1.5 | Write integration test for `update_outline_section` round-tripping through the engine + tool-executor + auto-approving sermon ApprovalGate (uses scripted stub adapter that emits a `tool_calls` for `update_outline_section`); assert: tool-call event, tool-result event with no error, outline.md updated | US-1 | Not Started |
| 1.6 | Write integration test for resume: pre-populate `outline.md` with topic + big_idea, drive a chat turn, assert system prompt includes the existing content (verified by recording adapter inspection) | US-2 | Not Started |
| 1.7 | Implement `src/tools/sermon/outline.ts` (allowlist constant, `scaffoldOutline`, `parseOutlineSections`, `replaceOutlineSection`, `writeOutlineAtomic`, `update_outline_section` factory, `read_outline` factory) | US-1, US-2 | Not Started |
| 1.8 | Implement `src/tools/sermon/system-prompt.ts` (assemble workflow rules + voice rules + congregation + voice + current outline; reads files fresh per call) | US-1, US-2 | Not Started |
| 1.9 | Implement the auto-approving `ApprovalGate` for `source: "sermon"` in the entrypoint composition (mirrors memory tools' conversation-persistence pattern; pass via `ToolExecutorConfig.approval_gate`) | invariants, drift | Not Started |
| 1.10 | Implement `scripts/start-sermon-prep.js` — composes memory + openai-compatible adapter (default OpenRouter URL + `anthropic/claude-sonnet-4.5`) + sermon tools + system-prompt wrapper + http listener; injects localhost actor headers (same shim as `start-server.js`) | US-1 | Not Started |
| 1.11 | Add `src/gateway/static-sermon-prep.ts` (chat HTML, vanilla JS, single-pane; same shape as chat-with-docs UI but distinct copy/branding for the sermon-prep app) | US-1 | Not Started |
| 1.12 | Wire a `GET /` route that serves the sermon-prep static HTML when this entrypoint is running. Two acceptable paths: (a) entrypoint passes a `static_html` config to `createGatewayRoutes` and routes serve whichever is configured; (b) entrypoint mounts a thin route wrapper that intercepts `GET /` before the existing routes. Pick (a) — minimal, additive, same module owns the `GET /` decision | US-1 | Not Started |
| 1.13 | Add `scripts/demo-sermon-prep.js` smoke script: scripted stub adapter that drives a 9-section conversation (one tool-call per section), bootstraps memory + tools, asserts every section appears in `outline.md` and every `tool-result` was successful | US-1 | Not Started |
| 1.14 | Add `npm run start:sermon-prep` and `npm run demo:sermon-prep` to `package.json` | — | Not Started |
| 1.15 | Run Phase 1 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| Phase 1 unit tests pass | `node --test test/unit/sermon-*.test.js` | All green |
| Phase 1 integration tests pass | `node --test test/integration/sermon-*.test.js` | All green |
| Stub-mode smoke runs end-to-end | `npm run demo:sermon-prep -- --adapter=stub` | Prints `tool-call(update_outline_section)`, `tool-result` (no error), `done`. Exit 0. `outline.md` populated with all 9 sections after run. |
| Approval gate path is exercised | (asserted inside the stub-mode smoke) | Audit log shows `category: "tool", action: "approval_request"` and `action: "approval_result", outcome: "allow"` for each `update_outline_section` invocation |
| Real-mode smoke runs against Claude via OpenRouter (manual) | `OPENAI_API_KEY=... OPENAI_API_BASE_URL=https://openrouter.ai/api/v1 OPENAI_MODEL=anthropic/claude-sonnet-4.5 npm run demo:sermon-prep` | Same events; reply text shows real conversational quality |
| Conformance check passes | `npm run check:conformance` | All green |
| Acceptance check passes | `npm run acceptance:check` | All green |
| Imports check passes (no boundary violations) | `npm run check:imports` | All green |
| Lock-in check passes (no inadvertent provider/tool coupling) | `npm run check:lockin && npm run demo:provider-swap` | All green; provider swap output unchanged |
| chat-with-docs still works | `npm run demo:chat-with-docs -- --adapter=stub` | smoke OK |

**Exit Criteria:** Pastor can run `SERMON=<slug> npm run start:sermon-prep` against Claude via OpenRouter, have a 6-stage conversation, and end with `outline.md` populated. All phase tests + project-wide conformance pass.

---

### Phase 2: Read-only outline preview pane

**Status:** Complete (pending user verification)

**Goal:** Pastor can see the current outline alongside the chat without leaving the browser.

**Tasks (tests-first ordering):**

| # | Task | US | Status |
|---|---|---|---|
| 2.1 | Write integration test for `GET /outline?sermon=<slug>` returning the current outline (200 + text/markdown body); 404 for unknown slug; 400 for missing slug | US-1 | Not Started |
| 2.2 | Write integration test verifying the route serves the latest disk content (write to outline.md mid-test, fetch, observe new content) | invariants | Not Started |
| 2.3 | Implement `GET /outline?sermon=<slug>` in routes.ts (path-contained, only serves files inside `SERMON_ROOT`) | US-1 | Not Started |
| 2.4 | Update `src/gateway/static-sermon-prep.ts` to a two-pane layout (chat left, outline right); UI re-fetches `GET /outline` on every `tool-result` SSE event with name `update_outline_section` | US-1 | Not Started |
| 2.5 | Run Phase 2 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| Phase 2 integration tests pass | `node --test test/integration/sermon-outline-route.test.js` | All green |
| End-to-end outline pane works | Manual: open the UI, send a message that triggers a tool-call, observe the outline pane refresh | Pane updates within ~1s of the `tool-result` event |
| Conformance still passes | `npm run check:conformance` | All green |

**Exit Criteria:** outline pane is visible and refreshes on tool-result.

---

### Phase 3: In-place outline editing

**Status:** Complete (pending user verification)

**Goal:** Pastor can edit any outline section in the UI; edits are saved back to disk and the AI sees them on the next turn.

**Tasks (tests-first ordering):**

| # | Task | US | Status |
|---|---|---|---|
| 3.1 | Write integration test for `PUT /outline/<section>?sermon=<slug>` with a body containing new content; 200 + updated outline.md; 400 for unknown section; 404 for unknown slug | US-3 | Not Started |
| 3.2 | Write integration test verifying that after a PUT, the next system-prompt assembly notes "the pastor edited <section> directly since the last reply" so the AI doesn't try to revert | US-3 | Not Started |
| 3.3 | Implement `PUT /outline/<section>?sermon=<slug>` in routes.ts (allowlisted section names; atomic write; emits an audit log) | US-3 | Not Started |
| 3.4 | Implement an "edit notice" mechanism — entrypoint composition records the time of last AI-write and last user-edit per section; system-prompt assembly compares them and adds the notice when applicable | US-3 | Not Started |
| 3.5 | Update the static UI: outline panel becomes editable per section; "Save" button per section; saved → PUT request | US-3 | Not Started |
| 3.6 | Run Phase 3 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| Phase 3 integration tests pass | `node --test test/integration/sermon-outline-edit.test.js` | All green |
| End-to-end edit flow works | Manual: edit a section in the UI, send a chat message, observe the AI honor the edit | AI's next reply reflects the edited section text; no attempt to revert |
| Conformance still passes | `npm run check:conformance` | All green |

**Exit Criteria:** Pastor can edit outline sections in-place; AI sees the edits on the next turn.

---

### Phase 4: Sermon picker + past-sermons archive

**Sketch only — out of MVP scope. Will be planned in detail when Phase 3 lands.**

- `GET /` becomes a sermon picker (list directories under `SERMON_ROOT/` excluding `_archive`); chat URL becomes `/sermon/<slug>`.
- `POST /sermons` creates a new sermon folder.
- `~/SermonPrep/_archive/<past-sermon>/outline.md` corpus; new `read_past_sermon(slug)` and `list_past_sermons()` tools (mirror chat-with-docs read patterns; `source: "sermon"`).
- The pastor's voice signal upgrades from `voice.md` alone to voice.md + the actual archive.

---

## Technical Details

### Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript | Pinned by template |
| Runtime | Node | `>=20 <21` |
| Test framework | `node:test` | What `npm run test:conformance` already uses |
| HTTP | `node:http` | Reuses `src/gateway/http-listener.ts` from chat-with-docs |
| Frontend | Vanilla HTML + JS | No framework |
| Model adapter | `openai-compatible` (existing) | Pointed at OpenRouter |

### Environment & Version Constraints

| Dependency | Required Version | Notes |
|---|---|---|
| Node | `>=20 <21` | Match `package.json` engines |
| TypeScript | `^5.9.3` | Match `package.json` devDependencies |
| OpenRouter API | any version (OpenAI-compatible) | Cloud; key required |
| Default model | `anthropic/claude-sonnet-4.5` | Override via `OPENAI_MODEL` |
| (no new npm packages) | — | If a real need arises mid-build, pin and justify in the work log |

### Contracts & Schemas (if applicable)

- **No public API contract changes.** Public chat shape stays `{ content, metadata }`; `done` payload (`conversation_id`, `message_id`) and `X-Conversation-ID` header preserved.
- **No engine handoff changes.** System-prompt assembly happens at the engine-handler wiring layer (entrypoint composition).
- **Tool definitions** follow the existing `ToolDefinition` shape. Section parameter is an enum-typed string (constrained schema).
- **Internal new endpoints** (Phase 2/3): `GET /outline?sermon=<slug>`, `PUT /outline/<section>?sermon=<slug>`. Documented above; not part of the public OpenAPI surface — internal to the sermon-prep entrypoint.

### Adapters & Externals (if applicable)

- **Model adapter:** existing `openai-compatible`. Configured at runtime via `OPENAI_API_BASE_URL=https://openrouter.ai/api/v1`, `OPENAI_API_KEY=<openrouter-key>`, `OPENAI_MODEL=anthropic/claude-sonnet-4.5` (env-overridable). The adapter forwards `tools` + parses tool-call deltas; chat-with-docs Phase 1 verified this round-trip works for OpenAI-compatible providers — OpenRouter behaves identically.
- **Tools:** new `update_outline_section` (write, `mutates_state: true`) and `read_outline` (read), both `source: "sermon"`, registered through the existing `AgentLoopConfig.tools` + `ToolExecutor.handlers` injection.
- **Approval gate:** custom `ApprovalGate` factored from `createApprovalGate` that auto-approves writes for `source: "sermon"` (mirrors memory tools' conversation-persistence pattern).
- **Client:** new sermon-prep static HTML/JS, served by the existing http-listener.

---

## Drift Considerations

> Sources read: `Engine-drift-guard.md`, `Gateway-drift-guard.md`, `Tools-drift-guard.md`, `Adapter-drift-guard.md`, `Configuration-drift-guard.md`, `Memory-Tools-drift-guard.md` (because we exercise the `mutates_state` + approval-gate path), `Security-drift-guard.md` (because cloud egress is in scope).

| Component | Drift Pattern | How We Prevent It |
|---|---|---|
| Engine | Engine accumulates product-specific business logic (ENGD §1) | System-prompt assembly + outline-write logic live at the wiring layer (`src/tools/sermon/system-prompt.ts` invoked by the entrypoint), not inside the engine loop. Phase 1 task 1.5 verifies the assembly happens outside `src/engine/`. |
| Engine | Recoverable tool failures incorrectly treated as terminal failures (ENGD §1) | When `update_outline_section` is called with an unknown section, the tool returns `failure_code: "execution_failed"` (or a more specific code if we add one); engine emits a `tool-result` with `error` and continues — verified by integration test 1.5 (unknown-section variant). |
| Engine | Approval semantics moved out of contract-visible events (ENGD §1) | The auto-approving sermon `ApprovalGate` still emits `approval_request` + `approval_result` audit events; the engine surfaces them through the canonical event taxonomy. Verified in stub-mode smoke (success criterion: audit log shows the approval pair). |
| Engine | Metadata side-channel reconfiguration (ENGD-CHK-003) | chat-with-docs' drift-regression test already covers this; no change. |
| Gateway | Gateway-to-Engine payload expanded into request-time configuration channel (GWD §1) | We do NOT pass sermon slug or outline contents through engine metadata. The entrypoint's system-prompt wrapper injects them directly into `request.body.messages` at the gateway/engine boundary, identical to chat-with-docs' pattern. |
| Gateway | Auth omitted on protected routes (GWD-CHK-001) | The localhost auth shim (same pattern as chat-with-docs `start-server.js`) injects `X-Actor-ID` + `X-Actor-Permissions` headers before routes are invoked. Phase 2/3 endpoints (`GET /outline`, `PUT /outline`) inherit the same shim. |
| Gateway | Conversation responses leaking raw storage rows (GWD-CHK-005) | `GET /outline` returns text/markdown content, not memory storage rows. `PUT /outline` updates a file on disk, not memory. |
| Tools | Tools promoted into a fifth architecture component (TOLD §1) | Sermon tools live under `src/tools/sermon/` (not a top-level component). Registered via the existing executor injection. No new top-level architecture surface. Verified by `npm run check:imports`. |
| Tools | Authorization logic embedded ad hoc in tool handlers (TOLD §1) | The `update_outline_section` handler does not perform auth checks. Authorization is the `ApprovalGate` + `required_permissions` pair, both enforced by the existing `ToolExecutor`. The handler does only safety (section allowlist, path containment, atomic write). |
| Tools | Approval-required mutations executed before approval decision (TOLD-CHK-009) | The approval gate runs **before** the handler; if it denies, the handler is never invoked. The auto-approver always approves for `source: "sermon"`, but the path is the same as a manual-approval flow — not a bypass. Verified by audit-log assertion in stub smoke. |
| Tools | Direct component storage access bypassing tool-mediated boundary (TOLD-CHK-011) | The sermon outline is **not** part of memory; it lives on disk under `SERMON_ROOT/`. Memory boundary is untouched. The outline is a tool-mediated resource — the AI only reaches it through `update_outline_section` / `read_outline`. |
| Adapter | Provider protocol logic leaked into Engine or Gateway internals (ADPD §1) | OpenRouter routing is configured via env vars. Adapter is unchanged. If we discover OpenRouter-specific quirks, the fix lives inside `src/adapters/openai-compatible.ts` — `npm run check:imports` enforces. |
| Adapter | Raw external/provider errors leaking to client-visible surfaces (ADPD §1) | Existing `toProviderErrorEvent` + `toSafeClientMessage` paths used. New code never returns raw stack traces or raw OpenRouter error bodies. |
| Adapter | Adapter config carrying secrets by value (ADPD-CHK-007) | `OPENAI_API_KEY` is read from `process.env` at adapter-construction time; never written to disk; `assertNoSecretLikeValues` defends tracked config. The adapter constructs the `Authorization: Bearer <key>` header at request time, not at config-load time. |
| Configuration | Runtime config bloats with preference- or provider-owned fields (CFGD-CHK-004) | `RuntimeConfiguration` is unchanged. `SERMON_ROOT` and `SERMON` are read at the entrypoint layer (script-level), not added to the runtime config schema. Same pattern as chat-with-docs' `CORPUS_ROOT`. |
| Configuration | Localhost-first bind default subverted (CFGD-CHK-012) | The entrypoint reuses `createHttpListener` with default `127.0.0.1`. Non-localhost binds require `ALLOW_NON_LOCAL_BIND=true` (existing behavior; tested in chat-with-docs Phase 2). |
| Configuration | Outbound network not guarded (CFGD §1, security implication) | The existing `installOutboundNetworkGuard` (called by `bootRuntime` and `createOpenAICompatibleAdapter`) restricts outbound to the configured endpoint. The non-`mock`/`local` provider triggers an explicit `assert_outbound_network_ready` callback if the entrypoint provides one. |
| Memory-Tools | Approval-required mutation auto-approval becomes a silent backdoor (Memory-Tools §1) | The sermon-source `ApprovalGate` is the explicit, scoped equivalent of the memory tools' conversation-persistence auto-approval — auto-approves for *exactly* the `source: "sermon"` action, no others. Tested via integration test 1.5: a tool-call with a different source name does NOT auto-approve. |
| Security | Sensitive content sent to cloud without consent | README + spec call out the cloud egress explicitly. Pastor consents by setting `OPENAI_API_KEY`. The adapter only contacts the configured endpoint; no telemetry. |

## Security Considerations

| Threat | Mitigation |
|---|---|
| Path traversal via section name | Closed allowlist; section names are pure identifiers (no `/`, `..`, etc.) |
| Path traversal via sermon slug | Slug validated at entrypoint (`/^[a-z0-9-]+$/`); `path.resolve` + `realpath` containment within `SERMON_ROOT` |
| Atomic-write torn file | `outline.md.tmp` → `rename` |
| Sensitive content sent to cloud LLM | Documented in README + spec; pastor consents via env var |
| API key leakage | Env-only; never written to disk by this build; `assertNoSecretLikeValues` guards tracked config |
| Cloud provider unreachable / rate-limited | Adapter raises clear error; UI surfaces it; conversation can resume |
| AI invokes write tool with malicious content | Section allowlist + atomic write isolate the blast radius to a single section of `outline.md`; pastor reviews; existing tool sanitization paths (`toErrorDiagnostics`, `toSafeClientMessage`) ensure no leakage |
| Approval-gate bypass | Auto-approval is scoped to `source: "sermon"` only; tested via negative case in 1.5 |

## Open Items

- **Slug validation rules:** ASCII-only `[a-z0-9-]+` in v1; if pastors want spaces or unicode in their slugs, address in Phase 4 picker design (Phase 4 can sanitize at folder-create time).
- **Concurrent edit conflict (Phase 3):** if pastor is editing a section in the UI when the AI tries to write to the same section, do we (a) reject the AI write with a "user is editing" failure, (b) accept and overwrite, (c) merge? Defer to Phase 3 design; v1 ships without the UI editor so the conflict cannot happen.
- **Phase 4 picker scope:** how multi-sermon UI handles the case where `SERMON` env var is also set; how new-sermon creation is exposed; whether sermon archival is a UI affordance or a manual `mv` to `_archive/`.
- **Voice file evolution:** if `voice.md` proves too coarse (everything injected as a single block), Phase 4 may stratify — sample sermons for full voice + voice.md for explicit phrasings + congregation.md for context — three signals instead of two.

## Completion Checklist

- [ ] All phases complete
- [ ] All tests passing
- [ ] Conformance check passes (`npm run check:conformance`)
- [ ] Acceptance check passes (`npm run acceptance:check`)
- [ ] Imports check passes (`npm run check:imports`)
- [ ] Lock-in check passes (`npm run check:lockin`); provider-swap demo unchanged
- [ ] Drift-guard checks pass (no drift patterns from §Drift Considerations slipped in)
- [ ] Spec acceptance criteria all covered by tests or documented manual passes
- [ ] chat-with-docs project still works (independent regression check)
- [ ] Work log updated
- [ ] Pastor (Matt) has actually used the tool to draft a real sermon and reported back

---

## Changelog

| Date | Change | Source |
|---|---|---|
| 2026-05-06 | Initial build plan | Generated from spec.md (interview 2026-05-06; brief at `~/BrainDrive-Library/projects/ideas/ai-bible/sermon-prep-tool.md`) |
| 2026-05-07 | Phases 1-3 marked Complete; status reflects shipped reality (164/164 tests; conformance + acceptance + lock-in green; sermon-prep + chat-with-docs smokes both pass) | Phase 3 verification + capture |

## Work Log

> Filled in during step 4 — Execute. The agent appends a new entry per phase (or per significant decision/issue).

**2026-05-06 — Phase 1: Sermon tools + on-disk outline + chat-only UI**

- **What was attempted:** all Phase 1 tasks (1.1 – 1.15): imports policy + drift-guard read; tests-first for outline allowlist + atomic write + scaffold + parse-and-replace + system-prompt assembly; integration tests for engine round-trip + auto-approving sermon gate + resume-from-existing-outline; implementations of `src/tools/sermon/{outline.ts, system-prompt.ts, approval.ts}` + `src/gateway/static-sermon-prep.ts` + entrypoint script + smoke script.
- **What worked:**
  - 30 new tests pass (`node --test test/unit/sermon-*.test.js test/integration/sermon-tools.test.js`).
  - Full repo: **134 / 134 tests pass** (chat-with-docs regression intact).
  - `npm run check:conformance` exit 0 (contracts ✓ imports ✓ lock-in ✓ 14/14 conformance).
  - `npm run acceptance:check` exit 0.
  - `npm run demo:provider-swap` unchanged (config-only swap preserved).
  - `npm run demo:sermon-prep -- --adapter=stub` runs 9 turns, each emitting a `update_outline_section` tool call; the auto-approving sermon gate emits `approval-request` + `approval-result(allow)` for every call; outline.md ends up with all 9 allowed sections populated. Smoke OK.
  - `npm run demo:chat-with-docs -- --adapter=stub` continues to pass — coexistence proven.
- **What didn't work:** nothing material. Initial gut-check noted that Node's test runner picks up source files only via the `node --test test/...` glob form per the chat-with-docs lesson; the integration tests use the same shape and run cleanly.
- **Decisions made (added during build):**
  - **Sermon slug becomes a tool argument**, not entrypoint state. Both `update_outline_section` and `read_outline` take a `sermon` param. This lets a single server eventually serve multiple sermons (Phase 4 picker) without re-architecting the tool surface. The entrypoint script still reads `SERMON` from env to pick the active conversation, but the tools are slug-aware from day 1.
  - **Slug validation** uses `/^[a-z0-9][a-z0-9-]*$/`. Tests pin the rejection of empty / path-shaped / unicode slugs.
  - **`scaffoldOutline` is idempotent.** If `outline.md` already exists, leave it alone. Pastor edits between sessions are not clobbered.
  - **System prompt re-reads files fresh per turn.** Test 6 in `sermon-system-prompt.test.js` writes `congregation.md`, calls assemble, rewrites it, calls assemble again, and asserts the new content is present. External edits between sessions OR mid-session are picked up.
  - **`read_outline` returns a placeholder** when the outline file is missing rather than throwing. Lets the AI ask the pastor to start fresh without a tool error in their face.
  - **Routes config gained `static_html?: string`** with the chat-with-docs UI as the default. Each composition entrypoint (chat-with-docs vs sermon-prep) chooses which UI to serve. Routes stay agnostic. Existing chat-with-docs tests/smokes unchanged.
  - **OpenRouter default model** set to `anthropic/claude-sonnet-4.5` in the entrypoint. `OPENAI_MODEL` env var overrides. The existing `openai-compatible` adapter handled the OpenRouter URL + tools forwarding without modification — no adapter changes.
  - **Sermon `ApprovalGate` lives in `src/tools/sermon/approval.ts`.** The decision function inspects `metadata.tool_source` and approves *only* when source is `"sermon"`. Negative test in `sermon-tools.test.js` proves a fake `evil_write` tool with `mutates_state: true` and a different source IS denied — the auto-approval is genuinely scoped, not a backdoor.
- **Lessons learned:**
  - The template's existing approval-gate path was already drift-defended. The sermon gate slots in cleanly via `ToolExecutorConfig.approval_gate`; no engine or executor changes needed. Auto-approval still goes through `ApprovalGate.evaluate()`, so audit events are emitted and the `tool-result` carries `approval_request` + `approval_result` per spec — Security drift-guard SECD-CHK-006 (approval contract-visible) holds without extra code.
  - The `withSermonSystemPrompt` wrapper pattern carries over cleanly from chat-with-docs. Each project gets its own wrapper; the engine loop stays product-agnostic; system-prompt assembly stays out of `src/engine/`.
  - Routes-as-a-shared-substrate works: chat-with-docs and sermon-prep share `routes.ts`, `http-listener.ts`, `conversation-store.ts`, the localhost auth shim, and the SSE patterns. Two coexisting projects on one template, validated.

**Manual verification (Phase 1 task 1.15) — for the user**

```bash
nvm use
# OpenRouter setup:
export OPENAI_API_KEY=<your-openrouter-key>   # required
# defaults: OPENAI_API_BASE_URL=https://openrouter.ai/api/v1, OPENAI_MODEL=anthropic/claude-sonnet-4.5
# optional: SERMON_ROOT=~/SermonPrep (default)

# Create the global congregation file (one-time, ~5 min):
mkdir -p ~/SermonPrep
echo "# Congregation\n\nMatt's congregation context here" > ~/SermonPrep/congregation.md
# Optional: voice notes
# echo "Phrases I use:\n- 'lean in'\n- 'God's not done with you yet'\n" > ~/SermonPrep/voice.md

# Start a sermon:
SERMON=acts-kingdom-focus npm run start:sermon-prep
# Open http://127.0.0.1:3000/
# Walk through the 6 stages with the AI; observe outline.md populate at ~/SermonPrep/acts-kingdom-focus/outline.md
# Restart, ask "let's continue" — AI picks up state.
# Edit outline.md externally; restart; AI honors the edit.
```

**2026-05-06 — Phase 2: Read-only outline preview pane**

- **What was attempted:** all Phase 2 tasks (2.1 – 2.5): tests-first for outline route handler (status codes, slug validation, freshness); implementation as a new `src/tools/sermon/outline-route.ts` module; entrypoint composition wraps the route handler around `routes.handle` ahead of the localhost-auth wrapper; UI updated to a two-pane layout with `prefers-color-scheme` + responsive collapse; outline pane re-fetches on every successful `tool-result` for `update_outline_section`.
- **What worked:**
  - 9 new outline-route integration tests pass: 200 happy path, 400 for missing/invalid/extra-segment slugs, 404 for unknown sermon, freshness (mid-test write reflected on next fetch), fall-through on non-`/outline` paths, fall-through on non-GET methods.
  - Full repo: **143 / 143 tests pass** (was 134 in Phase 1; +9).
  - `npm run check:conformance` exit 0 (contracts ✓ imports ✓ lock-in ✓ 14/14 conformance).
  - `npm run acceptance:check` exit 0; `npm run demo:provider-swap` unchanged.
  - Both project smokes (`demo:sermon-prep` stub, `demo:chat-with-docs` stub) pass.
- **What didn't work:** nothing material.
- **Decisions made (deviation from build plan):**
  - **Outline route lives outside `routes.ts`.** The build plan said "implement `GET /outline` in `routes.ts`." I implemented it as `src/tools/sermon/outline-route.ts` instead — a project-specific route handler the entrypoint wraps around `routes.handle` (mirrors the existing `wrapRoutesWithLocalhostAuth` pattern). Reason: putting a sermon-specific endpoint in shared gateway code couples the gateway to a specific project, which is exactly the drift the build-plan's Drift Considerations warned against. The wrapper pattern keeps `routes.ts` agnostic and lets each project mount its own auxiliary endpoints. **`routes.ts` was not modified in Phase 2 at all** — only the entrypoint script + a new sermon module.
  - **Path param instead of query param.** Build plan said `GET /outline?sermon=<slug>`. I used `GET /outline/<slug>` because the existing `http-listener.ts` strips the query string from `request.path` before routes see it. Path params are reachable without modifying the listener. Same protections (slug validation against `/^[a-z0-9][a-z0-9-]*$/`) apply.
  - **Outline fetch trigger.** UI re-fetches `GET /outline/<slug>` on every `tool-result` event whose name is `update_outline_section` and which has no `error` field. Belt-and-suspenders: also re-fetches on stream end (`done`), in case any tool-call result was buffered or missed.
- **Lessons learned:**
  - The wrapper-around-routes.handle pattern is the cleanest way to extend the gateway with project-specific endpoints without touching shared modules. Worth promoting to a documented pattern in the next round of template improvements (Phase 4 might do `wrapRoutesWithSermonPickerEndpoint` and `wrapRoutesWithSermonEditEndpoint` similarly).
  - The build plan's task wording can be wrong even when the architectural intent is right. Reading it as a contract is dangerous; reading it as a hypothesis to verify against the drift-guards before implementing is what the workflow is actually for.

**Manual verification (Phase 2 task 2.5) — for the user**

Restart the running sermon-prep server (or start one) — the outline pane should now appear on the right:

```bash
# Server should be running already. Hard-refresh http://127.0.0.1:3000/.
# Verify:
# 1. Two panes — chat left, outline right.
# 2. Outline pane shows the current outline.md content on page load.
# 3. Send a message that prompts the AI to update a section.
#    Outline pane should refresh and briefly flash within ~1s of the tool-result.
# 4. Edit ~/SermonPrep/<slug>/outline.md externally; the pane updates the next time
#    you send a chat message (or hard-refresh).
```

Reply PROCEED to start Phase 3 (in-place outline editing).

**2026-05-06 — Phase 1/2 hotfix: parallel-write race + slug pinning**

- **What was attempted:** fix two implementation bugs surfaced by Dave's first real Claude-via-OpenRouter run.
- **Symptoms:** chat ended with `[tool_error] Tool execution failed.` after the AI emitted 7 parallel `update_outline_section` calls in one turn. Audit logs showed multiple `outcome: "failure"` entries with `ENOENT: no such file or directory, rename '/Users/davidwaring/SermonPrep/say-yes-to-god/outline.md.tmp' -> '/Users/davidwaring/SermonPrep/say-yes-to-god/outline.md'`.
- **Root causes (two separate bugs in the same crash):**
  1. **Race condition in `writeOutlineAtomic`.** All parallel calls shared the temp filename `outline.md.tmp`. First-to-rename won; the rest ENOENT'd because the tmp was already moved. Even setting that aside, the read-modify-write inside `replaceOutlineSection` (parse → mutate one section → write) is not safe under concurrency: parallel calls would read the same "before" state and clobber each other.
  2. **Slug not pinned in the system prompt.** The active sermon slug (`SERMON` env var) was used by the entrypoint to scaffold the folder but never communicated to the model. Claude inferred a slug from conversation content (`say-yes-to-god` instead of the configured `acts-kingdom-focus`) and tried to write to a folder that didn't exist. The tool definition's example value ("e.g., 'acts-kingdom-focus'") was not enough — Claude treated it as an example, not a directive.
- **Fix:**
  1. Per-call random temp filename: `${target}.tmp.${randomBytes(6).toString("hex")}`. No two parallel writers share a name.
  2. Per-directory async mutex (`directoryLocks` map) wrapping `replaceOutlineSection`. Multiple section updates to the same sermon serialize through the queue; each sees the latest disk state before its own read-modify-write.
  3. System prompt now names the active sermon slug as a fixed instruction: *"The active sermon slug is **'<slug>'**. Always pass this exact string as the `sermon` argument to every tool call. Do not invent a different slug from conversation content; the slug is fixed for this session."*
- **Tests added (regression + assertions before fix):**
  - 7 parallel writes to the same sermon all land; every distinct section is persisted.
  - 20 parallel writes (with section repeats) all succeed; every section ends up non-empty.
  - No `.tmp` files remain after parallel writes.
  - System prompt contains the active slug verbatim and an instruction to use it.
- **Verification:** all 147 tests pass (was 143; +4 regression). `npm run check:conformance` exit 0. Both project smokes pass. Chat-with-docs regression intact.
- **Drift impact:** none. Both fixes are inside `src/tools/sermon/` and the system-prompt assembly. Engine, gateway routes, adapter, memory, auth, and conformance contracts all unchanged.
- **Decisions reaffirmed:**
  - **Implementation bug, not spec defect.** The spec said the system prompt assembles "current outline + congregation + voice"; the active slug should obviously have been in there too. That's an oversight, not a missing requirement. No `06-loop.md` pass needed.
  - **Mutex is keyed by sermon directory, not by sermon slug or globally.** Phase 4's eventual multi-sermon picker can run two pastors' updates in parallel without contention; only same-folder writes serialize.
- **Lessons learned:**
  - Tool-executor parallelism via `Promise.all` is a real architectural surface — write tools must be idempotent under concurrency, not just correct in isolation. Worth flagging in a future drift-guard pass: "any tool with `mutates_state: true` must defend against parallel invocation on the same target, because the engine emits parallel tool calls."
  - Tool parameter descriptions are not contracts. The model treats examples as suggestions. Fixed parameters (like the active sermon slug) belong in the system prompt as instructions, not as examples in tool descriptions.
  - The drift defenses on the engine side held perfectly: failure was visible (audit log entries), classified (`execution_failed`), terminal (loop emitted `tool_error` and stopped), and the sanitized error path didn't leak the stack trace to the chat reply (raw stack stayed in stderr; the user saw `[tool_error] Tool execution failed.`). The bug was in our tool, not the framework.

**2026-05-06 — Phase 3: In-place outline editing**

- **What was attempted:** all Phase 3 tasks (3.1 – 3.6): tests-first for edit tracker + PUT route + system-prompt edit notice; implementation of `src/tools/sermon/edit-tracker.ts`; extension of `src/tools/sermon/outline-route.ts` to handle PUT; wiring the tracker through the entrypoint so AI writes record `recordAiWrite` and PUT requests record `recordUserEdit`; UI rewrite to render each outline section as a textarea with a Save button.
- **What worked:**
  - 17 new tests pass (6 edit-tracker unit + 11 outline-edit integration). One existing Phase 2 test updated (PUT no longer falls through; it's now handled).
  - Full repo: **164 / 164 tests pass** (was 147 after the Phase 2 hotfix; +17).
  - `npm run check:conformance` exit 0; `npm run acceptance:check` exit 0; provider-swap demo unchanged.
  - Both project smokes pass; chat-with-docs regression intact.
  - The PUT route reuses the existing per-directory mutex (`replaceOutlineSection` already locks via Phase 2 hotfix), so simultaneous AI writes + user PUT can't race or corrupt the outline.
- **What didn't work:** nothing material.
- **Decisions made (build-time):**
  - **PUT body is JSON-encoded.** The shared `http-listener.ts` parses request bodies as JSON. Rather than introduce Content-Type-aware body parsing (which would touch shared gateway code), the UI sends `JSON.stringify(textareaValue)` and the route handler accepts the resulting string after the listener's JSON.parse. Same protection (the body is asserted to be a string in the route handler), zero listener changes.
  - **Path param shape:** `PUT /outline/<slug>/<section>`, mirroring `GET /outline/<slug>` from Phase 2. Both methods are handled by the same `createOutlineRouteHandler` factory; the handler dispatches by method.
  - **Edit tracker is in-memory only.** Restart loses the trail. Acceptable for v1 — restart implies a clean session anyway, and the AI's first system-prompt re-read of `outline.md` reflects whatever's on disk regardless of tracker state.
  - **Edit-notice block is sticky until the AI writes that section again.** Implementation: `sectionsEditedAheadOfAi(slug)` returns sections where `user_at > ai_at`. `recordAiWrite` updates `ai_at` to `now`, which clears the section from the ahead list. Idempotent; no separate "seen by AI" state needed.
  - **UI doesn't clobber a textarea while the pastor is typing.** `setSectionValue` checks dirty state + focus before overwriting. If the AI writes a section while the pastor is mid-edit on it, the new server value is captured as the new `lastSavedValue` (so dirty-detection stays correct) but the pastor's draft remains visible.
  - **Editable section list comes from the live outline, not the allowlist.** The UI parses the outline file's `## section` headings and renders one editable block per heading found. If the outline gains a section the UI doesn't know about, it just appears; no hardcoded section list in the JS.
- **Lessons learned:**
  - Wrapping the existing `replaceOutlineSection` (which already has the per-directory mutex from the Phase 2 hotfix) means the PUT route inherits the concurrency safety for free. Same primitive, two consumers. The mutex was the right abstraction.
  - The optional `edit_tracker` parameter on `createUpdateOutlineSectionTool`, `createReadOutlineTool`, `createOutlineRouteHandler`, and `assembleSermonSystemPrompt` is a small interface tax (four params per construction) but keeps the modules pure — no module-level singletons, no implicit coupling. Tests exercise both with-tracker and without-tracker paths.

**Manual verification (Phase 3 task 3.6) — for the user**

```bash
# In the running sermon-prep server's terminal:
# Ctrl+C
SERMON=acts-kingdom-focus OPENAI_API_KEY=<key> npm run start:sermon-prep
# Hard-refresh http://127.0.0.1:3000/
# Verify:
# 1. Each outline section renders as a textarea with a Save button.
# 2. Edit a section's text → status shows "unsaved" → click Save → status flips to "saved ✓" with a brief amber flash.
# 3. AI writes (via update_outline_section) refresh the textareas you're NOT actively editing.
# 4. Edit a section directly, then ask the AI a follow-up — the AI's next reply should reflect your edit (system prompt now includes the edit notice).
```

Reply PROCEED if Phase 3 looks good; that completes the MVP-MVP. Phase 4 (sermon picker + past-sermons archive) is the only remaining work.
