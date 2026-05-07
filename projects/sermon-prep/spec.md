# Spec: Sermon Prep Tool

## Overview

### What we're building

A localhost web prototype on the PAA template that walks pastors through a 6-stage sermon preparation conversation, building an outline document on disk as the conversation progresses. The pastor drives — the AI is a thought partner, never a content generator. Each sermon is a folder under a configurable `SERMON_ROOT`; `outline.md` is the canonical artifact. Phase 1 ships chat-only; later phases add a read-only outline pane, in-place editing, a sermon picker, and past-sermons archive integration.

This is the prototype that validates the workflow before porting into BrainDrive (D33). Same staging pattern as `chat-with-docs/` — sibling project on the template, prove the end-to-end flow, then port the validated UX into the BrainDrive product.

### Target user

- **Primary:** Matt Bluehouse (real pastor, Open Scroll content/theology partner). Non-technical. The end-to-end UX needs to feel like a thought partner, not a chatbot.
- **Secondary:** Dave W (template author). Validates polish, architecture fitness, and drift defenses.
- **Technical level:** Matt is non-technical (mobile-first audience for the eventual BrainDrive port). Dave is advanced.
- **Context:** localhost on Dave's laptop initially; potentially Matt's laptop with a guided setup.

### Problem statement

Sermon prep is the most laborious part of a pastor's role and the part most pastors don't enjoy. The traditional rule is one hour of study per minute of preaching. Many pastors are a one-person show — preaching, pastoral care, administration — and sermon prep is where they feel most overwhelmed. The hardest parts aren't the theology. They're the craft: finding illustrations that connect, writing transitions that flow, and landing the plane at the end.

Existing workarounds (ChatGPT, generic curricula, downloaded sermon notes) lack guardrails, don't pull from the pastor's voice, and don't help the pastor surface what's already in *them*. A guided conversational tool helps the pastor get their own ideas, voice, and stories on the page so they spend their time on rehearsal and presence with the congregation.

## User Stories

### US-1: Walk through a new sermon end-to-end

As Matt, I want to start a new sermon and have the AI walk me through the 6 stages, so that I leave the session with an outline ready for rehearsal.

**Steps:**
1. User starts the server pointed at a sermon (`SERMON=acts-kingdom-focus npm start`).
2. User opens browser, sees the chat.
3. AI introduces the 6-stage process and asks the pastor where they're starting (given topic? received? still discovering?).
4. User and AI converse through each stage. As decisions land, the AI calls `update_outline_section` and reports what it just wrote.
5. AI proposes stage transitions; user confirms.
6. By session end, `outline.md` reflects all 6 stages.

**Acceptance Criteria:**

```gherkin
Given SERMON=test-sermon, congregation.md exists, the sermon folder is fresh
When the user submits "I want to preach on saying yes to God"
Then the AI begins the topic stage
And eventually emits update_outline_section(section: "topic", ...)
And outline.md exists at SERMON_ROOT/test-sermon/outline.md with the topic section populated
And the AI does not write any other section before the pastor moves on
```

```gherkin
Given the conversation has covered all 6 stages
When the conversation ends
Then outline.md contains every required section in the documented format
And the conversation history is persisted via the existing memory tool, keyed by sermon slug
```

### US-2: Resume an in-progress sermon

As Matt, I want to come back to a sermon I started yesterday, see the current outline state, and continue from where I left off without re-explaining what I already decided.

**Steps:**
1. User restarts the server for the same sermon.
2. AI reads the persisted conversation history + the current `outline.md`.
3. AI's first reply summarizes what's done and proposes the next unfilled stage.

**Acceptance Criteria:**

```gherkin
Given outline.md has topic + big_idea + anchor_scripture filled but no points yet
When the user starts the server and types "let's continue"
Then the AI's first response references the existing topic and asks about points
And does NOT re-ask for topic, big idea, or anchor scripture
```

### US-3: Pastor edits the outline directly

As Matt, I want to open `outline.md` in my editor and tweak wording between sessions, and have the AI pick up my edits next time we talk.

**Steps:**
1. User edits `outline.md` externally (Phase 1) or in the UI panel (Phase 3).
2. User re-engages with the AI.
3. AI re-reads the outline; subsequent suggestions reflect the edit.

**Acceptance Criteria:**

```gherkin
Given outline.md was edited externally to change "saying yes to God" to "obedience"
When the user re-engages with the AI
Then the AI's next response uses the edited topic wording
And does not propose reverting it
```

### US-4 (Phase 4): Pick or create a sermon from the UI

As Matt, I want to open the app and see a list of my sermons, click one to continue, or click "+ New" to start fresh — without restarting the server.

**Steps:**
1. User opens `http://127.0.0.1:3000/`.
2. UI lists existing sermons in `SERMON_ROOT/`.
3. User clicks a sermon → enters chat scoped to that sermon.
4. Or: clicks "+ New" → enters a slug → folder is created → enters chat.

(Phase 4 only. Phase 1–3 use the `SERMON` env var.)

## Invariants & Edge Cases

### Properties that must always hold

- **Pastor-as-driver:** the AI never fabricates personal illustrations or stories. Topics, points, illustrations come from the pastor's words. The system prompt enforces this; verification is manual.
- **Section-vocabulary closure:** `update_outline_section(section, content)` only accepts values from a fixed allowlist (`topic`, `big_idea`, `anchor_scripture`, `point_1`, `point_2`, `point_3`, `conclusion`, `call_to_response`, `notes`). Unknown sections are rejected at the tool boundary, not in the model.
- **Active sermon slug pinned:** the entrypoint reads `SERMON` once at startup and threads the resulting slug into the system prompt as a fixed instruction (*"The active sermon slug is **'<slug>'**. Always pass this exact string..."*). The model cannot invent a different slug from conversation content; tool calls with the wrong slug will write to a folder the entrypoint never scaffolded. (Surfaced and locked in by the Phase 1 hotfix; was implicit before.)
- **Outline writes safe under parallel invocation:** the model can emit many `update_outline_section` calls in a single turn (`Promise.all` in the engine). Per-call random temp filenames + a per-sermon-directory async mutex serialize the read-modify-write so every call sees the latest disk state and no parallel writer races the rename. (Phase 1 hotfix invariant.)
- **Edit notice persists until the AI writes the edited section:** when the pastor edits a section in the UI (Phase 3 PUT), the in-memory edit tracker records the timestamp; subsequent system-prompt assemblies include a notice listing those sections. The notice clears for a section only when the AI's next `update_outline_section` for that section overwrites the user-edit timestamp. Restart loses the tracker (acceptable for v1 — restart implies a clean session).
- **Path containment:** all reads/writes happen inside `SERMON_ROOT/<current-sermon>/` (and the sibling `congregation.md` / `voice.md` at `SERMON_ROOT/`). Section names cannot encode paths.
- **Atomic outline writes:** `outline.md` is written via temp-file + rename. A crashed write never leaves a partial file; the prior outline remains valid.
- **Conversation persistence:** the existing memory tool persists per-sermon conversation history (D35 — one conversation per sermon).
- **System prompt freshness:** every chat turn re-reads `outline.md` + `congregation.md` + `voice.md` from disk before assembling the system prompt. External edits are picked up without restart.
- **Gateway contract preservation:** public `{ content, metadata }` shape, `done` payload IDs, `X-Conversation-ID` header, all unchanged.
- **Scripture attribution:** the system prompt instructs BSB. v1 does not enforce this with a tool — pastor verifies. Drift is acceptable until we observe it's a problem.

### Edge cases to test

- Empty sermon folder (no `outline.md` yet) → scaffold on first run.
- Outline edited externally between sessions.
- Pastor jumps stages out of order ("forget topic, let's talk illustrations").
- AI emits `update_outline_section` with an unknown section (e.g., `point_4` when only 3 are scoped) → tool rejects, model recovers.
- Path-attack-shaped input (e.g., `section: "../../etc/passwd"`) → rejected by the section allowlist (no path component possible).
- Unicode / emoji in sermon content (names, places, inflections).
- Long content — sermons can run several pages of notes.
- Missing `congregation.md` → AI prompts pastor to fill it; chat continues with a placeholder.
- Missing `voice.md` → optional file; absence is silently OK.
- Cloud provider outage / rate limit → graceful error to the user; conversation can resume.

### Failure modes

| Scenario | Expected behavior |
|---|---|
| OpenRouter unreachable / API key invalid | Clear error at boot (when adapter performs its readiness check) and at chat time; pastor sees an error message in the UI rather than a hang |
| `SERMON_ROOT` missing | Boot fails with a clear error |
| `SERMON` env var missing (Phase 1–3) | Boot fails with a clear error; Phase 4: server boots into picker mode |
| `outline.md` malformed (no recognizable section headers) | AI re-reads from disk on next turn; `update_outline_section` REPLACES the named section by regenerating the whole file from a parsed-and-merged model — never tries to merge mid-section |
| `update_outline_section` called with unknown section | Tool returns structured failure with `failure_code: "unknown_section"`; engine surfaces the failure to the model so it can retry |
| Concurrent restart while server is mid-write | Atomic temp-file + rename ensures no torn outline |
| Cloud egress denied (network guard) | Adapter raises clearly; boot fails with the configured endpoint named |

## Detailed Requirements

### Core functionality

- **Sermon folder:** `SERMON_ROOT/<sermon-slug>/`. Created on first run if missing. `<sermon-slug>` from the `SERMON` env var (Phase 1–3) or from the picker UI (Phase 4).
- **Outline file:** `SERMON_ROOT/<sermon-slug>/outline.md`. Pre-populated on first creation with section headers and empty bodies. Body sections are the AI-writable surface.
- **Congregation file:** `SERMON_ROOT/congregation.md`. Single global file for v1 — describes Matt's congregation (location, demographics, current series, tone). Pastor-edited.
- **Voice file:** `SERMON_ROOT/voice.md`. Single global file for v1 — pastor jots phrases, framings, recurring themes. ~10 minutes one-time effort. Captures voice signal without requiring a full sermon archive (Phase 4).
- **`update_outline_section(section, content)` tool:** replaces the named section in `outline.md`. Section name must be in the closed allowlist. Atomic write. Returns the resulting section content for confirmation. `mutates_state: true`, `source: "sermon"`. Auto-approved by an approval gate scoped to this source (single-user localhost; AI invokes it routinely; pattern mirrors memory tools' conversation-persistence auto-approval).
- **`read_outline()` tool:** returns the current `outline.md` content. `mutates_state: false`, `source: "sermon"`. Used when resuming a session or when the AI wants to verify state before writing.
- **System prompt:** assembled per chat turn. Includes (a) the 6-stage workflow rules, (b) voice rules (thought partner, never fabricate, BSB attribution), (c) congregation context from `congregation.md`, (d) voice signal from `voice.md`, (e) current outline contents from `outline.md`, (f) stage-detection guidance ("after the pastor confirms a section, propose advancing; if the pastor says 'jump to X', jump").
- **Conversation persistence:** existing memory tools (no changes). One conversation per sermon (D35); conversation key = sermon slug.
- **Model:** OpenRouter API via the existing `openai-compatible` adapter, default model `anthropic/claude-sonnet-4.5` (env-overridable). Cloud egress to `https://openrouter.ai/api/v1`.

### User interface (phased)

- **Phase 1:** single-pane chat UI (same shape as chat-with-docs). Pastor opens `outline.md` in their editor to see/edit the outline.
- **Phase 2:** two-pane — chat left, read-only outline preview right. Outline panel re-fetches `GET /outline` whenever the SSE stream emits a `tool-result` for `update_outline_section`.
- **Phase 3:** outline panel becomes editable. `PUT /outline/<section>` saves edits. The next chat turn's system prompt notes "the pastor edited <section> directly since your last reply" so the AI doesn't try to revert.
- **Phase 4:** `GET /` becomes a sermon picker (list + "+ New"); chat URL becomes `/sermon/<slug>`. Past-sermons archive integration (read-only).

### Data & state

- **On disk:** `SERMON_ROOT/<slug>/outline.md` per sermon; `SERMON_ROOT/congregation.md`, `SERMON_ROOT/voice.md` global. Memory tool stores conversation history per sermon under the existing memory root.
- **Temporary / in-memory:** outline + congregation + voice loaded fresh per chat turn; tool-call results during a single turn.
- **Configuration:** `SERMON_ROOT` (env var; default `~/SermonPrep`), `SERMON` (env var; required Phase 1–3), `OPENAI_API_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` (existing adapter knobs).

## Scope

### Feature type

- [x] Prototype — proving the 6-stage flow + outline-write pattern
- [ ] Production — eventual goal; v1 is the prototype that validates the workflow before porting to BrainDrive

### PAA components touched

- [ ] Memory _(unchanged — conversation persistence reused)_
- [x] Agent Loop _(uses the existing tool-call loop; adds `update_outline_section` + `read_outline` tools through `AgentLoopConfig.tools`)_
- [ ] Auth _(unchanged — localhost shim same as chat-with-docs)_
- [x] Gateway _(serves new web UI; new routes in Phase 2 (`GET /outline`) and Phase 3 (`PUT /outline/<section>`))_
- [x] External — Models _(OpenRouter via existing `openai-compatible` adapter — config only, no adapter changes)_
- [x] External — Clients _(new sermon-prep web UI)_
- [x] External — Tools _(new `update_outline_section` (write) + `read_outline` (read), `source: "sermon"`)_

### MVP scope (v1 = Phase 1)

**Included:**

- Single sermon at a time via `SERMON` env var
- Chat UI (single pane, same shape as chat-with-docs)
- 6-stage workflow guided by the system prompt
- `update_outline_section` (with closed section allowlist + auto-approval) and `read_outline` tools
- `outline.md` written atomically; scaffolded on first run
- Global `congregation.md` and `voice.md` read fresh per chat turn
- Conversation persistence per sermon (existing memory tool)
- OpenRouter Claude as the configured model (config-only)
- Existing gateway/engine/adapter/memory contracts preserved
- `npm run check:conformance` continues to pass

**Phase 2:** Read-only outline preview pane.
**Phase 3:** In-place outline editing in the UI.
**Phase 4:** Sermon picker page; past-sermons archive integration.

**Out of scope for v1 entirely:**

- Multi-conversation per sermon
- BrainDrive integration (this is the prototype; the BrainDrive port comes after)
- Multiple translations (BSB only — D31)
- RAG / vector search / embeddings (per D30 — model uses internal scripture knowledge)
- A `lookup_scripture` tool (deferred unless Phase 1 surfaces real attribution drift; OQ3 chose system-prompt-only)
- Audio input
- Sermon series / liturgical calendar integration
- Auth UI / multi-user
- Past sermons archive (Phase 4)
- Per-sermon `congregation.md` override (post-MVP hybrid)

## Technical Context

### Integration points

- **Gateway API:** unchanged at the public contract. Phase 2 adds `GET /outline?sermon=<slug>`; Phase 3 adds `PUT /outline/<section>`; Phase 4 adds `GET /sermons` + `POST /sermons`. Public chat shape stays `{ content, metadata }`.
- **Engine handoff:** unchanged. System-prompt assembly happens at the engine-handler wiring layer (mirroring chat-with-docs), not inside the loop.
- **Model API:** unchanged. OpenRouter is OpenAI-compatible; the existing adapter handles `tools` parameter forwarding and tool-call delta parsing without modification.
- **Tools:** new `update_outline_section`, `read_outline` registered via the existing `AgentLoopConfig.tools` + `ToolExecutor.handlers` injection. `source: "sermon"`. No new component.
- **Approval gate:** the existing `ApprovalGate` is configured to auto-approve writes for `source: "sermon"` (mirrors the conversation-persistence auto-approval pattern in memory tools). This is the first real exercise of the approval-gate path the template's tool-executor already supports.

### Dependencies

- **Existing PAA components:** Engine (loop + tool executor), Gateway (routes + streaming + http listener from chat-with-docs Phase 2), Adapters (`openai-compatible`), Memory (conversation history), Auth (localhost stub).
- **External services:** OpenRouter API at `https://openrouter.ai/api/v1` (cloud egress). API key required.
- **No new packages.** The sermon-prep tools live in `src/tools/sermon/` (mirrors the `src/tools/corpus/` pattern from chat-with-docs).

### Constraints

- **Local UI / cloud model:** the gateway/UI bind `127.0.0.1`. Outbound is restricted to the configured OpenRouter endpoint by the existing network guard.
- **Node:** `>=20 <21`.
- **TypeScript:** match template's `^5.9.x`.
- **Atomic writes** for `outline.md` (temp + rename).
- **Closed section vocabulary** — section names are an enum, not a free-form string.
- **Secret hygiene:** `OPENAI_API_KEY` is env-only; the existing `assertNoSecretLikeValues` defends tracked config from holding secrets.

## Test Strategy

### Test levels required

- [x] Unit — section-allowlist validation, atomic write, outline parse + section-replace, system-prompt assembly with all three context files
- [x] Integration — boot reads/creates sermon folder; chat turn round-trips through engine with `update_outline_section`; resume-from-existing-outline path
- [ ] Property-based — not justified for v1
- [x] E2E — single happy-path: pastor sends "preach on X", AI walks 6 stages, `outline.md` ends up populated; restart picks up state

### Verification approach

- **Agent self-verification:** existing `npm run check:conformance` + new test files. Smoke script (`npm run demo:sermon-prep -- --adapter=stub`) drives a scripted multi-turn conversation that exercises all 9 sections.
- **Human verification:** Matt + Dave actually use the tool to draft a real sermon. Subjective gates: did the conversation feel like a thought partner? Was the voice Matt's? Were the points his points?
- **Production monitoring:** N/A (single-user prototype).

### Baseline impact

- `npm run check:conformance` and `npm run acceptance:check` continue to gate. New conformance tests if any contract extends (Phase 2 might if `GET /outline` becomes part of the public surface — Phase 1 is purely internal).

## Security Considerations

### Risk level

- [ ] Low
- [x] Medium — handles user input (chat), stores user data on disk (sermon outlines, congregation context), and **routes sensitive content to a cloud LLM provider via API key**
- [ ] High

The prototype runs on a single user's machine with the gateway bound to localhost, so blast radius is bounded. The two real surfaces are (a) the `update_outline_section` tool — narrow, allowlisted, path-contained; and (b) cloud egress to OpenRouter carrying pastor stories and congregation context.

### Threat assessment

- **User input:** chat input from a single trusted user. Validated by the existing public message parser.
- **Code execution:** none. Tools are typed and finite (one write, one read).
- **Data sensitivity:** sermon notes contain personal stories; `congregation.md` contains demographics and pastoral context. Both are sent to OpenRouter with each chat turn (system-prompt injection). Pastor must consent to cloud routing.
- **Network surface:** gateway binds `127.0.0.1`. Outbound goes only to the configured OpenRouter endpoint. The existing outbound network guard enforces.
- **API key handling:** `OPENAI_API_KEY` is env-only, never written to disk by this build. The loader's `assertNoSecretLikeValues` defends tracked configuration from accidentally holding it.
- **Blast radius:** at worst, a misbehaving model could attempt to call `update_outline_section` with malicious content. The closed section allowlist prevents path traversal; outline content is text and never executed.

### Required mitigations

- Section vocabulary allowlist on `update_outline_section` (the same-named field cannot encode a path).
- Atomic writes for `outline.md`.
- Path containment within `SERMON_ROOT` for any disk read.
- Localhost-default binding (existing).
- API key only via env var; never written, never logged. Adapter's authorization header is constructed at request time and not persisted.
- README explicitly notes that pastor content leaves the machine when using OpenRouter.

## Explicit Boundaries

### Do not modify

- Public gateway request shape (`{ content, metadata }`).
- Streaming `done` payload (`conversation_id`, `message_id`) and `X-Conversation-ID` header.
- `POST /engine/chat` internal handoff.
- Provider-specific code outside `src/adapters/`.
- Component boundaries (`scripts/check-imports.ts`).
- Lock-in checks.
- Anything in `projects/chat-with-docs/` — that build is independent.

### Do not introduce

- A new "fifth component" for sermon-prep, outlines, or pastoral logic. Tools register through the existing executor; the system prompt + outline-write logic live in `src/tools/sermon/`.
- Runtime provider/model/tool overrides via engine request metadata.
- A vector store, embeddings library, or RAG framework (D30).
- A frontend framework (vanilla HTML/JS only).
- A scripture-lookup tool in v1 (OQ3a).
- A file watcher (the system re-reads files per chat turn).
- Networked egress to anywhere except the configured OpenRouter endpoint.
- `0.0.0.0` binding or non-localhost defaults.
- Per-pastor authentication / multi-user UI.

### Out of scope (even if related)

- Refactoring `projects/chat-with-docs/` or its code.
- Modifying the BrainDrive product directly (the port comes after this prototype).
- Building a sermon catalog, search, or analytics surface.
- Voice / audio input.
- Liturgical calendar integration.
- Sermon series planning UI.

## Open Questions

- **Model capability under sermon-prep load:** Claude via OpenRouter is the default; `anthropic/claude-sonnet-4.5` is the configured model. Validation deferred to Phase 1 manual pass — does the conversational quality meet Matt's bar? If not, swap to a more capable Claude tier (`claude-opus-4.7` or whatever is current). The openai-compatible adapter swap is config-only.
- **Voice mimicking from `voice.md` alone:** v1 skips the past-sermon archive. Hypothesis: a curated `voice.md` (~10 min effort) plus the live conversation is enough voice signal. If the AI sounds generic in Phase 1 manual pass, escalate to Phase 4 archive earlier than planned.
- **BSB attribution accuracy:** the model is asked to quote BSB but may default to ESV/NIV. v1 has no enforcement — pastor verifies. Loop to a `lookup_scripture` tool only if substantial drift is observed.
- **Stage-detection signals:** when the AI proposes advancing a stage. System-prompt-tunable; not a spec-level invariant. Iterate during Phase 1.
- **Approval gate for `update_outline_section`:** ✅ resolved 2026-05-06. Auto-approval scoped strictly to `source: "sermon"` via `createSermonApprovalGate()`; non-sermon sources are denied. Negative test in `test/integration/sermon-tools.test.js` proves a `mutates_state: true` tool from a different source is denied.
- **Concurrent edit during AI write (originally a Phase 3 question):** ✅ resolved 2026-05-07 (Phase 3 implementation). At the disk layer, the per-directory mutex serializes writes so the last writer wins atomically. At the UI layer, `setSectionValue` checks dirty state + focus before overwriting a textarea — if the pastor is mid-edit, the AI write updates the underlying baseline (so dirty-detection stays correct) but does NOT clobber the visible draft. The next chat turn's system prompt includes a `## Pastor edits since your last reply` block so the AI sees the divergence and doesn't try to revert.

## Success Definition

When v1 (Phase 1) is complete, Matt will be able to:

1. Run `SERMON=<slug> npm start` (with `OPENAI_API_KEY` and `OPENAI_MODEL` env vars set), open `http://127.0.0.1:3000/`, and converse with the AI through the 6-stage workflow.
2. End the session with an `outline.md` reflecting all 6 stages — topic, big idea, anchor scripture, points + scripture + illustrations, conclusion, call to response — in his voice.
3. Restart the server, ask to continue, and have the AI pick up from his last state without re-asking what's already decided.
4. Edit `outline.md` in his editor between sessions and have the AI honor the edits.
5. Run `npm run check:conformance` and have it pass.

When the build is fully complete (Phase 4), Matt will additionally be able to:

6. Open the picker, click into any of his sermons (or create a new one), without restarting the server.
7. See the live outline alongside the chat, edit it in place, and have the AI respond to his edits.
8. Reference past sermons for theme continuity, with the AI surfacing relevant prior framings.

---

## Changelog

| Date | Change | Source |
|---|---|---|
| 2026-05-06 | Initial spec | Interview 2026-05-06 + spec generation; seeded by `~/BrainDrive-Library/projects/ideas/ai-bible/sermon-prep-tool.md` (D38) |
| 2026-05-07 | Added 3 invariants surfaced by Phase 1-3 build (Active sermon slug pinned; Outline writes safe under parallel invocation; Edit notice persists until AI writes); marked 2 Open Questions resolved (sermon approval-gate scoping; concurrent-edit-during-AI-write) | Phase 1 hotfix + Phase 3 implementation |
