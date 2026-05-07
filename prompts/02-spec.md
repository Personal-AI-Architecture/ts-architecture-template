---
name: 02-spec
description: Generate a feature specification document from the interview output. Produces a spec.md with user stories, invariants, scope, security, and explicit AI boundaries.
---

# Step 2 — Spec

**Purpose:** Write the filled-in spec to disk. The interview in step 1 was anchored to the template below, so the agent should already have everything it needs — this step just commits the agreed-upon answers as `spec.md`.

**Output:** A `spec.md` file in the project directory inside the template repo.

**Scaling:** the template below is scaled for production features (security risk levels, property-based test invariants, full failure-mode tables). For prototypes or simple builds, fill in what applies and leave or delete what doesn't — the agent should follow the user's lead.

---

## The prompt

```
Write the spec for the feature we just interviewed on.

Standing context (do not drift from this):
- Build target: the template repo we have open.
- Reference: the personal-ai-architecture repo on my disk separately —
  ask me for the path if you don't already know it.
- Save the output as: spec.md (or projects/<feature-name>/spec.md
  if we have a project subdirectory).

Use the template below — the same one you read during the interview.
Fill in every section using the answers we agreed on. For sections
without clear information, mark `[TODO: needs clarification]` or
`[TBD: to be decided during build plan]` — do not invent details.

After saving, summarize what's captured, list any TODOs or open
questions, and ask if anything needs adjustment before we move to
step 3 (build plan).

# Spec: <Feature Name>

## Overview

### What we're building
<2-3 sentence description>

### Target user
- Who: <persona>
- Technical level: <Beginner / Intermediate / Advanced>
- Context: <when/where they use this>

### Problem statement
<What pain point does this solve? What's the current workaround?>

## User Stories

> Each user story = a concrete way the feature delivers value, with
> acceptance criteria specific enough that the agent can test against them.

### US-1: <Primary Flow Name>

As a <persona>, I want to <action> so that <outcome>.

**Steps:**
1. User <action>
2. System <response>
3. User <action>
4. System <response>

**Acceptance Criteria (Given-When-Then):**

```gherkin
Given <initial context>
When <action performed>
Then <expected outcome>
And <additional outcome if applicable>
```

```gherkin
Given <edge case context>
When <action performed>
Then <expected behavior>
```

### US-2: <Secondary Flow Name>

<same shape as US-1>

## Invariants & Edge Cases

### Properties that must always hold
> These drive property-based tests later. Properties are statements that
> must be true for ALL inputs, not just specific examples.

- <e.g., "Saving a configuration and then loading it always returns identical fields">
- <e.g., "A tool call respects Auth gating — unauthenticated requests are always rejected">
- <e.g., "Memory writes are durable across restart">

### Edge cases to test
- Empty input / no data
- Maximum length / volume
- Invalid or malformed input
- Concurrent access / race conditions
- Network failure mid-operation
- Unicode, special characters, emoji

### Failure modes
| Scenario | Expected behavior |
|---|---|
| <External service unavailable> | <Graceful degradation, retry, or error message> |
| <Invalid user input> | <Validation error, no data corruption> |
| <Partial operation failure> | <Rollback / cleanup, no orphaned state> |

## Detailed Requirements

### Core functionality
- <Requirement 1 — be specific>
- <Requirement 2>

### User interface
- <UI element 1 — describe appearance and behavior>
- <UI element 2>

### Data & state
- What is stored?
- What persists across sessions?
- What is temporary?

## Scope

### Feature type
- [ ] Prototype — proving feasibility, skip polish
- [ ] Production — full implementation with error handling

### PAA components touched
- [ ] Memory
- [ ] Agent Loop
- [ ] Auth
- [ ] Gateway
- [ ] External — Models (which providers?)
- [ ] External — Clients (which interfaces?)
- [ ] External — Tools (which capabilities?)

### MVP scope (v1)

**Included:**
- <Essential feature 1>
- <Essential feature 2>

**Out of scope for v1:**
- <Nice-to-have>
- <Future idea>

## Technical Context

### Integration points
- Which contracts does this feature use or extend? (Gateway API, Model API,
  any internal contracts in the template)
- Which adapters are touched? (mock, OpenAI-compatible, custom)
- Any new schemas, endpoints, or tool definitions?

### Dependencies
- Existing PAA components this depends on
- External APIs or services
- New packages needed

### Constraints
- Performance requirements
- Local-first / offline requirements
- Compatibility (Node version, browser, mobile, etc.)

## Test Strategy

### Test levels required
- [ ] Unit — pure logic, transformations, validators
- [ ] Integration — API endpoints, contracts, adapter behavior
- [ ] Property-based — invariants from above (fast-check for TypeScript)
- [ ] E2E — critical user flows from User Stories

### Verification approach
- Agent self-verification: how will the coding agent verify its own work?
  (test suite? `npm run check:conformance`? manual run?)
- Human verification: what requires manual review? (UX feel, visual
  design, "does this feel right")
- Production monitoring: what metrics or alerts will tell us this is
  working?

### Baseline impact
- Always-run checks affected: <which baseline commands apply>
  (start with `npm run check:conformance` — the template's safety net)
- Additional checks triggered: <e.g., new contract = contract conformance test>

## Security Considerations

### Risk level
- [ ] Low — no user input, no new APIs, no sensitive data
- [ ] Medium — handles user input, new endpoints, or stores user data
- [ ] High — executes user code, touches auth/credentials, or exposes
  new network surfaces

### Threat assessment
- User input: does this feature accept input? How is it validated?
- Code execution: does this run user-provided code? Sandboxed?
- Data sensitivity: what sensitive data is handled? How protected?
- Network surface: new APIs or external calls? Authenticated?
- Blast radius: if compromised, what's exposed?

### Required mitigations
- <e.g., input sanitization, rate limiting>
- <e.g., sandbox isolation, egress filtering>

## Explicit Boundaries

> For AI agents: these define what is OUT OF SCOPE. Do not modify, touch,
> or refactor anything in these areas.

### Do not modify
- <File or folder paths that should not change>
- <Components that are off-limits for this feature>

### Do not introduce
- <Patterns or libraries to avoid>
- <Architectural approaches that aren't appropriate here>

### Out of scope (even if related)
- <Related feature that should NOT be implemented as part of this>
- <Refactoring that seems helpful but is not requested>

## Open Questions

- <Question 1 — needs answer before proceeding>
- <Question 2>

## Success Definition

When this feature is complete, users will be able to:
1. <Outcome 1>
2. <Outcome 2>
3. <Outcome 3>

---

## Changelog

> Append a row each time the spec changes. Step 6 (Loop) appends here when verification reveals something the spec missed.

| Date | Change | Source |
|---|---|---|
| <YYYY-MM-DD> | Initial spec | Interview <date> + spec generation |
```

---

## Direction notes

Quality bar before moving on:

- [ ] Overview is clear (someone could understand the feature in 30 seconds)
- [ ] Target user is specific (not generic "users")
- [ ] Problem statement explains the *pain*, not just the solution
- [ ] User stories describe *specific* flows with concrete acceptance criteria
- [ ] Invariants are statements that must hold *for all inputs*, not specific examples
- [ ] Edge cases catalog the things that *will* break the simple version
- [ ] MVP scope is clearly bounded — what's in AND what's out
- [ ] Security risk level is assessed (or marked N/A with reason)
- [ ] Explicit boundaries tell the agent what NOT to touch
- [ ] Open questions capture anything unresolved

If the agent generated a spec that's too vague or invented details that didn't come from the interview: send it back. *"This is too generic. The interview said X, Y, Z — rewrite section <N> with that specific information."*

**Next:** when the spec lands, run [`03-build-plan.md`](03-build-plan.md) to generate the phased build plan.
