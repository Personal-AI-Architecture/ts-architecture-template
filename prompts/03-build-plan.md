---
name: 03-build-plan
description: Generate a phased build plan from the spec, with tests-first ordering, success criteria, and exit criteria for each phase. Produces build-plan.md.
---

# Step 3 — Build Plan

**Purpose:** Generate a phased build plan from the spec. Each phase = a testable unit of work with explicit success criteria. The template below is the contract — fill it in using the spec.

**Output:** A `build-plan.md` file next to `spec.md`.

**Scaling:** the template below is scaled for multi-phase production features. For prototypes or simple builds, one or two phases may be enough — keep the tests-first ordering, drop the depth that doesn't apply.

---

## The prompt

```
Generate a build plan for the feature we just specced.

Standing context (do not drift from this):
- Build target: the template repo we have open.
- Reference: the personal-ai-architecture repo on my disk separately —
  ask me for the path if you don't already know it. Read its primers
  under docs/ai/ before designing.
- Read the spec.md before designing.
- Save the output as: build-plan.md (next to spec.md).

Your task:
1. Use the template below as the contract for what a complete build
   plan looks like. Fill in every section using the spec.
2. Phase the work into testable units. Each phase = a unit of
   functionality that can be built, tested, and verified independently.
   Don't pad with phases; don't bundle unrelated work in one phase.
   Tests-first ordering inside every phase: write tests before
   implementation.
3. For each phase, define specific, verifiable success criteria with
   copy-pasteable verification commands (not vague "tests pass"). Always
   include `npm run check:conformance` — that's the architecture's
   safety net.
4. Stay within the architecture — Memory / Agent Loop / Auth / Gateway,
   with externals (Models / Clients / Tools) plugged in via the existing
   contracts and adapters. Pin versions of any new dependencies.
5. **Identify drift risks before designing.** For each PAA component
   this build touches, read the corresponding drift-guard at
   `docs/blueprints/drift/<Component>-drift-guard.md` in the reference
   repo. List the drift patterns that apply to this build in the Drift
   Considerations section, and add success criteria that detect them
   where possible. AI agents introduce drift constantly — the build
   plan is where you set the defenses.

After generating, summarize the architecture, list the phases, flag any
open items, and ask if anything needs adjustment before we move to step
4 (execute).

# Build Plan: <Feature Name>

**Status:** Not Started

---

## Overview

<2-3 sentence summary of what we're building and why.>

See `spec.md` for detailed requirements and user stories.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| <Decision 1> | <Choice> | <Why> |
| <Decision 2> | <Choice> | <Why> |

## Architecture

### Component Diagram

<Brief written description showing how the new feature fits into the
existing PAA components.>

### Components Touched

#### 1. <Component name — e.g., Agent Loop>
- Purpose in this feature: <what it does>
- Files: <which files in the template are modified or added>
- Contract changes: <if any contracts are extended>

#### 2. <Component name>
- ...

### Data Flow

1. User <action>
2. <Component A> <processes/routes>
3. <Component B> <handles/stores>
4. Response flows back to user

---

## Implementation Roadmap

### Schedule Overview

| Phase | Goal | Status |
|---|---|---|
| 1 | <Goal> | Not Started |
| 2 | <Goal> | Not Started |
| 3 | <Goal> | Not Started |

### Phase 1: <Name>

**Goal:** <One sentence>

**Tasks (tests-first ordering):**

| # | Task | US | Status |
|---|---|---|---|
| 1.1 | Write tests for Phase 1 acceptance criteria | — | Not Started |
| 1.2 | <Implementation task 1> | US-1, US-3 | Not Started |
| 1.3 | <Implementation task 2> | US-2 | Not Started |
| 1.4 | Run Phase 1 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| Phase 1 tests pass | `<exact test command>` | All green |
| <Feature criterion> | `<exact command>` | <Expected output> |
| Conformance check passes | `npm run check:conformance` | All green |

**Exit Criteria:** <What must be true to move to Phase 2>

### Phase 2: <Name>

<same shape as Phase 1>

### Phase 3: <Name>

<same shape as Phase 1>

---

## Technical Details

### Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript | Pinned by the template |
| Runtime | Node | Match template's `package.json` engines |
| Test framework | <vitest / jest / node:test — match what the template ships> | |
| Property-based | fast-check (only if spec has invariants requiring property tests) | |

### Environment & Version Constraints

> Pin versions to prevent the agent from drifting to incompatible versions
> during implementation.

| Dependency | Required Version | Notes |
|---|---|---|
| Node | <version from template> | Match the template's engines field |
| TypeScript | <version from template> | Match the template's tsconfig and dependencies |
| <new package> | <pinned version> | <why needed> |

### Contracts & Schemas (if applicable)

<Describe any new contracts or extensions to existing ones. Reference the
contract files in the reference repo when applicable.>

### Adapters & Externals (if applicable)

<Which model adapter? Which client? Which tools?>

---

## Drift Considerations

> Drift = the agent introduces patterns that violate component boundaries or contract shapes (e.g., product-specific logic in the Engine, request metadata as runtime config, bypassing Auth, inlining provider logic). For each component this build touches, identify the drift patterns most likely to apply and how the build plan defends against them.

> Source: `docs/blueprints/drift/<Component>-drift-guard.md` in the reference repo. Read the relevant drift-guards before filling this in.

| Component | Drift Pattern | How We Prevent It |
|---|---|---|
| <Engine / Memory / Auth / Gateway / etc> | <Pattern from the drift-guard> | <Test, contract check, explicit boundary, or success-criterion command> |
| ... | ... | ... |

## Security Considerations

| Threat | Mitigation |
|---|---|
| <Threat 1 from spec> | <How we handle it> |
| <Threat 2 from spec> | <How we handle it> |

## Open Items

- <Question or decision needed>
- <Research needed>

## Completion Checklist

- [ ] All phases complete
- [ ] All tests passing
- [ ] Conformance check passes (`npm run check:conformance`)
- [ ] Drift-guard checks pass (no drift patterns from §Drift Considerations slipped in)
- [ ] No linting errors
- [ ] Spec acceptance criteria all covered by tests
- [ ] Work log updated

---

## Changelog

> Append a row each time the build plan changes. Step 6 (Loop) appends here when verification reveals something the build plan got wrong.

| Date | Change | Source |
|---|---|---|
| <YYYY-MM-DD> | Initial build plan | Generated from spec.md |

## Work Log

> Filled in during step 4 — Execute. The agent appends a new entry per
> phase (or per significant decision/issue) so future-you knows what was
> built and why.

**<YYYY-MM-DD> — <Phase / Task Name>**
- What was attempted:
- What worked:
- What didn't work:
- Decisions made:
- Lessons learned:

---

*Next: Run step 4 (`04-execute.md`) to hand the build plan to the agent
and let it run. Run step 5 (`05-test.md`) after each phase to verify.
If verification reveals something missed, run step 6 (`06-loop.md`)
to update the spec + build plan and try again.*
```

---

## Direction notes

Quality bar before moving on:

- [ ] Each phase is independently testable
- [ ] Each phase has tests-first ordering (write tests *before* implement)
- [ ] Success criteria are specific commands with expected outputs (not vague "tests pass")
- [ ] Conformance check (`npm run check:conformance`) is in every phase's success criteria
- [ ] **Drift Considerations section is filled in** — the agent has read the relevant drift-guards and called out which patterns apply (don't accept "no drift patterns apply" without justification — that usually means the agent didn't read them)
- [ ] Exit criteria are concrete (not "feels done")
- [ ] Versions of new dependencies are pinned (no `^` or `~`)
- [ ] Open items capture anything still unresolved

Common things to push back on:
- *"Phase N is too big — break it into smaller phases."*
- *"Phase N's verification is too vague — give me an exact command."*
- *"You skipped tests-first inside Phase N — write the tests first."*
- *"You introduced a dependency the spec didn't mention — justify or remove."*
- *"You skipped the drift-guards. Read `docs/blueprints/drift/<Component>-drift-guard.md` for each component and fill in the Drift Considerations section."*

For complex features (security-sensitive, multiple components, lots of invariants), it's worth running an explicit test-plan pass before the build — see [`05-test.md`](05-test.md) Part A. For most builds, the test commands embedded in the build plan's success criteria are enough.

**Next:** when the build plan lands, run [`04-execute.md`](04-execute.md) to hand it to the agent.
