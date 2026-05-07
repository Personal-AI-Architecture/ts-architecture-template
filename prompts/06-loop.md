---
name: 06-loop
description: When the test reveals something the spec or build plan got wrong, run the loop — capture what was learned, update spec.md / build-plan.md, then resume execute. Get the upfront work right and the loop stays small; the loop is your safety net, not the primary work surface.
---

# Step 6 — Loop

**Purpose:** Close the iteration loop. When step 5's verification reveals something the spec or build plan got wrong, this is where the learning gets captured, the artifacts get updated, and execute resumes with the corrections applied.

**Most of the work is upfront — getting the spec and build plan right is where most of the time goes. The loop is the safety net for what the upfront missed.**

**Output:** Updates to `spec.md` and/or `build-plan.md`, then back to step 4 (Execute) on the affected phase.

---

## When to run this

Run the loop when verification (step 5) reveals one of:

- **A missed requirement.** *"The test exposed a case the spec didn't think about — empty document corpora, multi-byte characters, model timeouts."*
- **A wrong assumption.** *"The spec said tool calls would be synchronous; the test showed we need async."*
- **A new invariant.** *"While building Phase 2 we discovered a property that must always hold but wasn't in the spec."*
- **A phase that's wrong-shaped.** *"Phase 3 turned out to be two phases. The build plan needs to split."*
- **A drift-guard check failed.** *"The build introduced a pattern the drift-guard prohibits — Engine accumulated product-specific logic, request metadata became a hidden config channel, etc. The build plan's Drift Considerations missed this; we need to add a defense."*
- **A "this works but it feels wrong" moment.** *"Acceptance criteria pass but the result is not what we wanted."*

**Don't run the loop for routine bug fixes** — those go in step 4. The loop is for things that change the *plan*, not just the *implementation*.

---

## The prompt

```
We just finished verification for Phase <N> and it revealed something
the spec or build plan got wrong. Run a quick loop pass.

Hard gates (do not auto-proceed even in auto mode):
- After step 3 below (proposing edits), STOP. Do NOT apply any edits to
  spec.md or build-plan.md until I type "approved". Show me the diffs
  first, wait for explicit approval, then apply.
- After step 4 (applying approved edits), STOP. Do NOT resume step 4
  (Execute) yourself. I'll decide what comes next (resume / rollback /
  skip).

1. Summarize what the verification revealed
   - What test or check exposed it?
   - Was it a missed requirement, wrong assumption, new invariant, or
     phase-shape problem?
   - Quote the actual evidence (test output, observed behavior, etc.)

2. Categorize the change
   - Spec change: the spec needs new/changed user stories, invariants,
     edge cases, or boundaries
   - Build plan change: the spec is fine but the phasing, tasks, or
     success criteria need updating
   - Both: spec and build plan both need adjustment

3. Propose specific edits
   - For each affected file, show the exact section + the proposed
     diff (old text → new text). Don't apply yet — let me approve.
   - For new content, use the same template structure the original
     spec/build-plan uses.
   - **Hard gate.** Stop and wait for me to type "approved" before
     touching either file.

4. After approval, apply the edits and append a changelog entry to
   each updated file:

   In spec.md:
   | <YYYY-MM-DD> | <One-line summary of change> | Loop after Phase <N> verification |

   In build-plan.md:
   | <YYYY-MM-DD> | <One-line summary of change> | Loop after Phase <N> verification |

5. Stop and confirm what to do next. Don't pick yourself — wait for me
   to choose:
   - Resume Phase <N> with the updates applied (most common)
   - Roll back code from Phase <N> if the update changed enough that
     the existing implementation no longer fits
   - Skip ahead to a different phase if the update reorders things

Standing context (do not drift): build target = template repo we have
open. Reference = personal-ai-architecture repo on my disk separately —
ask me for the path if you don't already know it. At no point should
we drift from the architecture.

When generating or regenerating a chat or web UI (only if the build
includes one):
- Default to a dark theme with a system font stack
  (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`),
  readable contrast (no white-on-white, no low-contrast grey-on-grey),
  and comfortable spacing and line-height. Don't ship a bland or
  hard-to-read starting point.
- At the bottom of the page, include a small, low-emphasis footer link:
  `Built on <a href="https://github.com/Personal-AI-Architecture/the-architecture" target="_blank" rel="noopener">The Personal AI Architecture</a>`

Keep this lightweight. The loop is for capturing what we learned and
updating artifacts; the real work happens back in step 4 (Execute).
```

---

## Direction notes

**A healthy loop:**
- **Fast.** 3-5 minutes from "verification flagged something" to "spec + build plan updated, resuming execute."
- **Small.** A 10-line spec edit, a one-row build-plan changelog entry. If the loop is rewriting half the spec, that's a sign the original interview missed something fundamental — consider going back to step 1. **Get the spec and build plan right upfront and the loop stays small.**
- **Visible.** The changelog entries show the trail. Anyone reading the spec or build plan a month later can see what changed and why.

**An unhealthy loop:**
- **Skipped.** *"Eh, the test passed close enough."* The loop is the mechanism that pre-empts *"what if the AI gets it wrong?"* — skipping it means hoping.
- **Massive.** Loop turns into a 30-minute rewrite. That's not a loop; that's "the spec was wrong from the start." Consider a step-1 redo on the affected scope.
- **Silent.** Spec gets edited but no changelog entry; build plan loses traceability. Future-you (or another agent reading the spec later) won't know why the change happened.

**Categorize the learning** — for the in-loop case, just answer two questions:
1. **One-off, or will it happen again?** One-off → just update spec/build-plan. Will repeat → also note it in your project's notes for future builds (e.g., *"in any feature touching Memory, always include an empty-state edge case"*).
2. **Did the spec lack something, or did the build-plan lack something?** Spec → add user story / invariant / edge case. Build plan → adjust phase shape / task list / success criteria. If both, do both.

**After the loop:**
- **Most common:** resume step 4 (Execute) on the same phase with the updates applied.
- **Sometimes:** roll back the phase's code and re-execute from the updated build plan (`git restore` if you've been committing per-phase, or just delete the new files the agent wrote).
- **Rarely:** skip ahead because the update reordered phases.

Whichever path, you're back in step 4 — and step 5 will run again at the end of the phase. The cycle continues until the feature is done.

---

## A note on the loop and the "never touch a line of code" promise

The loop is what makes the *"build whatever you want and never touch a line of code"* North Star real. Without it, the promise reduces to *"hope the AI gets it right the first time."* With it, the promise is *"if the AI gets it wrong, the process catches it and you direct the fix in plain English."*

You direct. The agent codes. Loop closes.
