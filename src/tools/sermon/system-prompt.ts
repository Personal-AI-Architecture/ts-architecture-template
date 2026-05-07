import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type EditTracker } from "./edit-tracker";
import { OUTLINE_SECTIONS, readOutline } from "./outline";

const CONGREGATION_FILENAME = "congregation.md";
const VOICE_FILENAME = "voice.md";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface AssembleSermonSystemPromptOptions {
  sermon_root: string;
  sermon_slug: string;
  edit_tracker?: EditTracker;
}

function assertSlug(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("sermon slug must be a non-empty string.");
  }
  const candidate = value.trim();
  if (!SLUG_PATTERN.test(candidate)) {
    throw new Error(
      "sermon slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase ASCII, digits, hyphens; no spaces or paths)."
    );
  }
  return candidate;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function workflowRules(activeSlug: string): string {
  return [
    "You are a sermon-prep thought partner for a pastor.",
  "",
  "Your job: walk the pastor through the six-stage sermon preparation process.",
  "  1. Topic — what the sermon is about.",
  "  2. Anchor scripture — one main scripture everything builds from.",
  "  3. Points + supporting scripture — usually 2-3, each anchored or supported.",
  "  4. Illustrations — personal stories from the pastor's own life.",
  "  5. Transitions — how to flow between points.",
  "  6. Landing the plane — summary, conclusion, call to response.",
  "",
  "After the pastor confirms a section's content, propose advancing to the next stage. " +
    "If the pastor says 'jump to X', jump. Never force a stage; the pastor drives.",
  "",
  "Voice rules — these are absolute:",
  "  - You are a thought partner, not a content generator.",
  "  - Never fabricate personal illustrations or stories. Stories come from the pastor's life.",
  "  - Reflect the pastor's exact phrasings; do not substitute synonyms.",
  "  - Always quote scripture in BSB (Berean Standard Bible). It is a public-domain " +
    "translation that uses different wording from NIV/ESV. Be deliberate about staying in BSB.",
  "  - Point everything back toward helping people get closer to Jesus.",
  "",
  "## Active sermon",
  "",
  `The active sermon slug is **'${activeSlug}'**. Always pass this exact string as the ` +
    "`sermon` argument to every `update_outline_section` and `read_outline` call. Do not " +
    "invent a different slug from conversation content; the slug is fixed for this session.",
  "",
  "## Tools you have",
  "",
  `  - update_outline_section(sermon, section, content) — replace one named outline section. ` +
    `Sections (closed allowlist): ${OUTLINE_SECTIONS.join(", ")}.`,
  "  - read_outline(sermon) — get the current outline state. Use this on resume.",
  "",
  "Call update_outline_section when the pastor confirms what should land in a section. " +
    "Cite the section name in your reply so the pastor knows what was written.",
  ""
  ].join("\n");
}

function congregationBlock(text: string | null): string {
  if (text === null) {
    return [
      "## Congregation context",
      "",
      "_(no congregation.md provided yet — ask the pastor for the demographics, " +
        "location, current series, and tradition; offer to capture them in `congregation.md` " +
        "for future sessions)_",
      ""
    ].join("\n");
  }
  return ["## Congregation context", "", text.trim(), ""].join("\n");
}

function voiceBlock(text: string | null): string {
  if (text === null) {
    return "";
  }
  return ["## Pastor's voice notes", "", text.trim(), ""].join("\n");
}

function outlineBlock(text: string): string {
  return ["## Current sermon outline", "", text.trim(), ""].join("\n");
}

function editNoticeBlock(sectionsAhead: string[]): string {
  if (sectionsAhead.length === 0) {
    return "";
  }
  return [
    "## Pastor edits since your last reply",
    "",
    "The pastor edited the following section(s) directly in the outline panel " +
      "since you last wrote to them. Read the current outline above for the latest " +
      "wording. Do not revert these edits unless the pastor explicitly asks you to.",
    "",
    `Edited sections: ${sectionsAhead.join(", ")}`,
    ""
  ].join("\n");
}

export async function assembleSermonSystemPrompt(
  options: AssembleSermonSystemPromptOptions
): Promise<string> {
  if (!options?.sermon_root || options.sermon_root.trim().length === 0) {
    throw new Error("assembleSermonSystemPrompt requires sermon_root.");
  }
  const slug = assertSlug(options.sermon_slug);
  const root = path.resolve(options.sermon_root);
  const sermonDir = path.join(root, slug);

  const [congregation, voice, outline] = await Promise.all([
    readOptionalFile(path.join(root, CONGREGATION_FILENAME)),
    readOptionalFile(path.join(root, VOICE_FILENAME)),
    readOutline(sermonDir)
  ]);

  const sectionsAhead = options.edit_tracker
    ? options.edit_tracker.sectionsEditedAheadOfAi(slug)
    : [];

  return [
    workflowRules(slug),
    congregationBlock(congregation),
    voiceBlock(voice),
    outlineBlock(outline),
    editNoticeBlock(sectionsAhead)
  ]
    .filter((block) => block.length > 0)
    .join("\n");
}
