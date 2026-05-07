---
name: 04-execute
description: Hand the build plan to your coding agent and let it run. The agent works phase by phase, tests-first, with the conformance check as the safety net.
---

# Step 4 — Execute

**Purpose:** The agent takes the build plan and **runs it**. The user doesn't write code; they direct. The agent works phase by phase, tests-first, stopping for verify after each phase.

**Output:** Code changes across the template, plus entries in `build-plan.md`'s work log.

---

## The prompt

```
Execute the build plan we just produced.

Standing context (do not drift from this):
- Build target: the template repo we have open.
- Reference: the personal-ai-architecture repo on my disk separately —
  ask me for the path if you don't already know it.
- At no point should we drift from the architecture. Always match against
  the reference for drift.
- TypeScript only. Match version constraints in build-plan.md "Environment
  & Version Constraints".

When generating a chat or web UI (only if the build includes one):
- Default to a dark theme with a system font stack
  (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`),
  readable contrast (no white-on-white, no low-contrast grey-on-grey),
  and comfortable spacing and line-height. Don't ship a bland or
  hard-to-read starting point — the user should be able to use it
  without restyling first.
- At the bottom of the page, include a small, low-emphasis footer link:
  `Built on <a href="https://github.com/Personal-AI-Architecture/the-architecture" target="_blank" rel="noopener">The Personal AI Architecture</a>`

Hard gates (do not auto-proceed even in auto mode):
- After each phase finishes, STOP and wait for me to type "PROCEED"
  before starting the next phase. Don't auto-advance.
- If you need a new top-level package, STOP and wait for me to type
  "approved" before installing.
- If you get stuck or hit something unexpected, STOP and ask me.
  Don't guess your way through it.
- If verification reveals a spec or build-plan defect (not just an
  implementation bug), STOP and tell me to run prompts/06-loop.md.
  Don't paper over the defect by tweaking implementation.

Process for each phase:
1. Read the phase's task list in build-plan.md, re-read the spec.md
   user stories this phase implements (user-facing goal stays in
   sight), and re-read the build-plan's Drift Considerations section
   for the components this phase touches.
2. Before implementing anything in a component, read its drift-guard
   at `docs/blueprints/drift/<Component>-drift-guard.md` in the
   reference repo. Don't introduce any of the prohibited patterns or
   shortcuts listed there. AI agents introduce drift constantly — the
   drift-guards are how you avoid it.
3. Tests-first: write the tests listed for the phase BEFORE implementing.
4. Implement the tasks until the tests pass.
5. Run the phase's success criteria verification commands.
6. Run `npm run check:conformance` to confirm no architectural drift.
7. Append a work log entry to build-plan.md under "Work Log":
   - What was attempted
   - What worked
   - What didn't work (if anything)
   - Decisions made
   - Lessons learned
8. Update the phase's status in build-plan.md to Complete (both in the
   Schedule Overview table at the top and on the phase block itself).
   This is your self-attestation that the phase is done — the user will
   independently verify next.
9. **Hard gate.** Stop. Wait for the user to run `prompts/05-test.md`
   (Part B) as the independent verification pass and then type "PROCEED".
   Do not start the next phase without that explicit signal — not even
   in auto mode.
10. When all phases are complete and the user has verified the final
    phase, stop and confirm everything is verified before considering
    the build done.

Important behaviors:
- Don't drift from the architecture. The drift-guards in
  `docs/blueprints/drift/` are explicit about prohibited patterns —
  product-specific logic in the Engine, request metadata as hidden
  config, bypassing Auth, inlining provider logic in the loop, etc.
  Read them before each component you touch.
- Don't skip tests-first ordering within a phase. Write the phase's
  tests first, then implement until they pass — don't skip ahead to
  implementation.
- Don't refactor things outside the build plan's scope, even if "it
  would be cleaner." Refactoring belongs in a separate spec.
- Don't claim "tests pass" without actually running them and showing
  the output.

Start with Phase 1.
```

---

## Direction notes

**Two-layer verification.** Verification happens twice per phase, on purpose:

1. **The agent self-verifies** during step 4 (this prompt) — runs the success-criteria commands, runs conformance, captures actual output, marks the phase Complete in `build-plan.md`.
2. **The user independently verifies** by running [`05-test.md`](05-test.md) Part B — re-runs every command in their own terminal, captures actual output, decides PROCEED / LOOP / FIX / INVESTIGATE.

Don't skip layer 2. AI-generated code has higher logic-error rates than human-written code, and the most common failure mode is the agent reporting "tests pass" without actually running them. Belt and suspenders.

The user's job during execute is to watch, intervene when the agent goes off course, and run [`05-test.md`](05-test.md) after each phase.

**Catching drift early:** if the agent starts writing JavaScript instead of TypeScript, invents a new component instead of using an existing one, or violates a pattern from the drift-guards (product-specific logic in the Engine, request metadata as runtime config, bypassing Auth, inlining provider logic in the loop), intervene fast. The earlier you catch it, the less rework. The drift-guards in `docs/blueprints/drift/` are the canonical list of what to watch for.

**When the agent gets something wrong** (this is normal — real software is never built right on the first try):
1. Show the error in the conversation. Don't hide it; don't quietly correct and move on. *"You're using the wrong contract here — it should be `MemoryWriteRequest` from `contracts/memory.ts`, not the inline shape you wrote."*
2. Let the agent fix it. Don't fix it yourself. The point of this process is the agent does the work — including fixing its own mistakes.

If the same error keeps happening, that's a signal the spec or build plan was unclear. Note it for [`06-loop.md`](06-loop.md).

**When to stop and run [`06-loop.md`](06-loop.md):** when verification reveals something the spec or build plan got wrong — a missed edge case, an invariant the spec didn't anticipate, a phase that's bigger than estimated and needs splitting. Don't paper over these. Stop, update the spec/build-plan, then resume execute.

**Next:** after each phase passes verification, run [`05-test.md`](05-test.md) Part B. If the verification reveals a gap in the plan, run [`06-loop.md`](06-loop.md). After the final phase passes verification, run the full app and walk the user stories end to end.
