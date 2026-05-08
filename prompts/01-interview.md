---
name: 01-interview
description: Interview the user to gather everything needed to fill in the spec template. The spec at 02-spec.md is the contract; the interview is whatever questions it takes to populate it.
---

# Step 1 — Interview

**Purpose:** Interview the user to gather everything needed to fill in the spec template. The spec is the source of truth for *what success looks like* — the interview's job is to produce enough alignment that step 2 can write a confident spec.

**Output:** A shared understanding (in the chat) ready to be written as `spec.md` in step 2.

---

## The prompt

```
You are interviewing me about a feature I want to build on the
Personal AI Architecture template.

Standing context:
- Build target: the template repo we have open.
- Reference: the personal-ai-architecture repo on my disk separately —
  ask me for the path if you don't already know it. Read its primers
  under docs/ai-agent-docs/ for architectural context. Don't drift from
  the architecture; always match against the reference.

Your task:
1. Read the spec template at prompts/02-spec.md to understand what a
   complete spec looks like — every section it asks for, every field
   it wants filled in.
2. Interview me to gather everything you need to fill that template
   in confidently. Adapt your questions to what I'm building and to my
   technical level. Don't expect me to know architecture terms (PAA
   components, contracts, adapters) — translate those into plain-language
   questions and propose your mappings back to me when you have a clear
   picture.
3. Ask 2-4 related questions at a time. Wait for my answers. Go deep on
   interesting answers. Challenge assumptions. Avoid vague questions.
4. Stop when you can fill in every required section of the spec template
   with confidence (or mark it [TODO: needs clarification] / [TBD: to be
   decided during build plan]). Don't invent details.

Capture "I haven't decided yet" answers as open questions — don't force
a decision in the interview.

When you stop, summarize what you learned, list any open questions, and
confirm I'm ready to move to step 2 (generate the spec).
```

---

## Direction notes

The spec template (`02-spec.md`) is the contract. If the agent can't fill in a required section confidently, the interview isn't done.

Push back when the agent's questions feel off:
- *"Skip this — you can infer from what I've said."* (over-asking)
- *"You haven't asked about <X>; that matters here."* (under-asking)
- *"That's too technical — ask me in plain language."* (using jargon)
- *"That's your job to figure out from what I said."* (asking the user to do the architectural mapping)

**Next:** when the interview lands, run [`02-spec.md`](02-spec.md) to write the filled-in spec.
