---
name: 05-test
description: Verify the build by running tests and the app. Two parts — (a) optional pre-build test plan generation, (b) per-phase verification with independent run of success criteria. Don't trust AI self-reports.
---

# Step 5 — Test

**Purpose:** Run the tests + run the app + see where it actually works and where it doesn't. Step 5 has two halves:

- **Part A — Test planning** (optional, before build): generate a separate `test-plan.md` if the feature is complex enough to need explicit test architecture
- **Part B — Per-phase verification** (after each build phase): independently run the phase's success criteria, capture actual output, decide pass/fail/loop

**Output:** Test results in chat + work-log entries in `build-plan.md`. Optionally `test-plan.md` if Part A runs.

---

## Part A — Test plan (optional, before build)

> **For simple builds (the mini-course chat-with-docs example, prototypes, single-feature work), skip Part A entirely.** The per-phase success criteria in `build-plan.md` are enough. Jump to Part B when each phase of step 4 finishes.

**Skip if:** the feature is simple, the build plan's per-phase success criteria are enough, or execution has already started.

**Run if:** the feature is security-sensitive, has multiple invariants from the spec, or touches enough surface that test architecture deserves to be written down separately.

### Part A prompt

```
Generate a test plan for this feature based on:
- spec.md (especially the Invariants & Edge Cases section)
- build-plan.md (especially the per-phase success criteria)
- The template's existing test infrastructure (read package.json scripts
  and any test/ directory structure)

Standing context: build target = template repo we have open. Reference =
personal-ai-architecture repo on my disk separately — ask me for the
path if you don't already know it.

Save the output as: test-plan.md (next to spec.md and build-plan.md).

Use the structure below.

# Test Plan: <Feature Name>

## Baseline Regression

### Always-Run Baseline

| # | Check | Command | Applies? |
|---|---|---|---|
| B-1 | Conformance check | `npm run check:conformance` | Yes (always) |
| B-2 | Type check | `<exact command from package.json scripts>` | Yes |
| B-3 | Test suite | `<exact test command>` | Yes |
| B-4 | <other from template> | `<command>` | <Yes/No> |

### Additional Conditional Checks

| # | Check | Command | Applies? | Why |
|---|---|---|---|---|
| C-1 | <e.g., contract conformance for new contract> | `<command>` | <Yes/No> | <Why> |

## Property Definitions

> Properties from spec.md's Invariants section. These drive
> property-based tests with fast-check.

| ID | Property | Always True | Spec Reference |
|---|---|---|---|
| P-1 | <Name> | <Formal: f(g(x)) == x for all x> | <Invariant from spec> |
| P-2 | <Name> | <Formal statement> | <Invariant> |

## Feature Tests by Phase

### Phase 1: <Phase name from build plan>

**Write these tests BEFORE implementing Phase 1:**

| Test | Type | File | Verifies | Spec Reference |
|---|---|---|---|---|
| <Test description> | Unit | `test/<area>.test.ts` | <What it proves> | <US-N / AC-N> |
| <Test description> | Integration | `test/<area>.int.test.ts` | <What it proves> | <US-N / AC-N> |
| <Test description> | Property | `test/<area>.prop.test.ts` | <P-N> | <Invariant> |

**Phase 1 Verification Commands:**

```bash
# Run phase 1 tests
<exact command>
# Expected: all green

# Run baseline
npm run check:conformance
<other baseline commands>
```

### Phase 2: <Phase name>
<same shape>

### Phase 3: <Phase name>
<same shape>

## Drift Tests

> From build-plan.md's Drift Considerations section. For each drift pattern flagged, define a test that catches it. Source: `docs/blueprints/drift/<Component>-drift-guard.md` in the reference repo (auto-check assertions).

| # | Component | Drift Pattern | Test | Expected Result |
|---|---|---|---|---|
| D-1 | <Component> | <Pattern from drift-guard> | <How to test it> | <Expected: pattern absent / boundary preserved> |

## Edge Case Tests

> From spec.md's Edge Cases section.

| # | Edge Case | Test Type | Expected Behavior |
|---|---|---|---|
| E-1 | <Edge case> | <Unit/Integration> | <What should happen> |

## Security Tests (if Medium/High risk per spec)

| # | Threat | Test | Expected Result |
|---|---|---|---|
| S-1 | <Threat from spec> | <How to test> | <Expected secure behavior> |

## Open Items

- <Test infrastructure not yet set up>
- <Dependencies to install: fast-check, etc.>

After generating, summarize coverage (counts by type, mapped to spec
acceptance criteria + invariants), flag any open items, and confirm
I'm ready to begin step 4 (Execute).
```

---

## Part B — Per-phase verification (after each build phase)

This is the part that runs **after** each phase of the build, while step 4 (Execute) is in progress.

### Part B prompt

```
Verify that Phase <N> of the build plan is actually complete.

Hard gate (do not auto-proceed even in auto mode): after producing the
verification report, STOP. Do NOT decide PROCEED / LOOP / FIX yourself —
that's my decision. Do NOT auto-update build-plan.md status. Do NOT
start the next phase. Wait for me to type my decision explicitly.

Read build-plan.md, find Phase <N>, and extract the Success Criteria
table. For each criterion:
1. Run the verification command using your shell tool.
2. Capture the actual output and exit code.
3. Compare against the Expected Result.
4. Mark pass / fail.

Independent verification rules:
- Run every command yourself; don't accept "tests should pass" or "I've
  verified this."
- Run the full test suite for the phase, not just the changed files.
- Capture actual output; don't paraphrase.
- When in doubt about pass/fail, ask me.

Always-run baseline (run these regardless of phase):
- `npm run check:conformance` — the architecture's safety net. If this
  fails, the build introduced drift; do NOT mark the phase complete.
- Drift-guard checks for any component this phase touched. The
  build-plan's Drift Considerations section names them; the underlying
  patterns live in `docs/blueprints/drift/<Component>-drift-guard.md`
  in the reference repo. If any drift-guard check fails, run step 6
  (Loop) — the build plan's defenses missed something.
- If `test-plan.md` exists, also run the baseline checks listed there.

Report format:

## Verification: Phase <N> — <Phase name>

| # | Criterion | Status | Notes |
|---|---|---|---|
| 1 | <Description> | PASS / FAIL / SKIP | <Brief note> |
| 2 | ... | ... | ... |

### Baseline Results

| Check | Status | Notes |
|---|---|---|
| Conformance check | PASS / FAIL | <output excerpt if fail> |
| <Other baseline> | PASS / FAIL | <note> |

### Summary

- Criteria passed: X/Y
- Baseline: PASS / FAIL
- Recommendation:
  - PROCEED — all criteria met; ready for next phase
  - LOOP — verification revealed something the spec or build plan got
    wrong; recommend running step 6 (06-loop.md)
  - FIX — implementation issue; recommend re-running step 4 (Execute) on
    this phase before moving on
  - INVESTIGATE — mixed results; review failures before deciding

For any FAIL, show:
- Command that ran
- Expected result
- Actual output (truncated if long)
- Suggestion if obvious

Don't auto-update build-plan.md status during this verification pass — the agent already updated it during step 4 (Execute) based on its own run; this verification pass is the human-in-the-loop check. Stop after the report and wait for me to type PROCEED, LOOP, or FIX. This is a hard gate — do not pick a recommendation and act on it yourself, even in auto mode.
```

---

## Direction notes

**Why "independent verification" matters:** AI-generated code has higher logic-error rates than human-written code, and the most common failure mode is the agent reporting "tests pass" without actually running them. The verification prompt tells the agent to run every command itself — but the user should run them too, in their own terminal, before declaring a phase complete. Belt and suspenders.

**What NOT to accept as verification:**
- *"The tests should pass now."*
- *"I've verified this works."*
- *"This matches the expected behavior."*
- *"The implementation is complete."*

**What TO accept:** actual test command output showing pass/fail counts, build output showing successful compilation, conformance check output showing all checks green, optional coverage report with actual percentages.

**Coverage gate (optional):** if the project uses coverage tooling and you want to enforce a minimum, the convention is **70% statements / branches / functions / lines**. Most PAA template builds won't hit this threshold on day one — that's fine. Add it when the project graduates from prototype to production.

**Mixed verification (4/5 pass, 1 fail):** the question is *"did the test reveal a real gap (loop) or just an implementation bug (fix)?"*
- **Real gap → LOOP.** *"The test revealed our spec didn't account for empty-document corpora — we need to update the spec, then re-execute."* Run [`06-loop.md`](06-loop.md).
- **Implementation bug → FIX.** *"The test caught a typo in the contract usage — agent fixes it, we re-verify, we move on."* Re-run step 4 on this phase.

If unsure, default to LOOP — safer to capture the learning than paper over it.

**Next:** all criteria pass + baseline passes = next phase (step 4) or finish. Anything fails or feels off = [`06-loop.md`](06-loop.md).
