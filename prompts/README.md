# PAA Process Prompts

Six prompt files for the **5-step + loop process** for building on the Personal AI Architecture template.

> Full walkthrough: PAA mini-course Lesson 3. This README is a workflow reference, not the tutorial.

## Workflows

### Pre-build alignment (steps 1–3)

Run interview → spec → build plan as one orchestrated workflow with pause-for-approval gates between steps:

```
Walk me through pre-build alignment. Stop and wait for me to explicitly
type "go" before moving to each subsequent step. This is a hard gate —
do not auto-proceed even in auto mode.

1. Read prompts/01-interview.md and interview me.
2. Wait for "go", then read prompts/02-spec.md and produce the spec from
   our conversation.
3. Wait for "go", then read prompts/03-build-plan.md and produce the
   build plan from the spec.
```

### Individual steps

Or invoke any single step directly:

```
Read prompts/0X-NAME.md and start the step.
```

## Files

| Step | File | What it produces |
|---|---|---|
| 1. Interview | [`01-interview.md`](01-interview.md) | Alignment between you and your agent on *what success looks like* |
| 2. Spec | [`02-spec.md`](02-spec.md) | A `spec.md` with user stories, invariants, scope, security |
| 3. Build plan | [`03-build-plan.md`](03-build-plan.md) | A `build-plan.md` with phased architecture, tests-first ordering, success criteria |
| 4. Execute | [`04-execute.md`](04-execute.md) | The agent runs the build plan; code lands in the template |
| 5. Test | [`05-test.md`](05-test.md) | Conformance checks pass, the app runs, you see what works and what doesn't |
| ↻ Loop | [`06-loop.md`](06-loop.md) | When the test reveals something missed: update `spec.md` + `build-plan.md`, run again |

## Where the artifacts go

| Step | Output location |
|---|---|
| 1. Interview | Conversation in chat (nothing written to disk) |
| 2. Spec | `spec.md` in the template repo (or your project subdirectory inside it) |
| 3. Build plan | `build-plan.md` next to `spec.md` |
| 4. Execute | Code changes across the template + entries in `build-plan.md` work log |
| 5. Test | Test output in chat + entries in `build-plan.md` work log + (optionally) `test-plan.md` |
| ↻ Loop | Updates to `spec.md` + `build-plan.md`, then re-run from step 4 |

## Standing context (assumed by every prompt)

```
Context: the template repo we have open.
Reference: the `personal-ai-architecture` repo on disk separately —
ask the user for the path if you don't already know it.
At no point should we drift from the architecture.
Always match against the reference.
```

## Notes for the agent

If the user lands you here without specifying a workflow or step, ask which one they want to run.
