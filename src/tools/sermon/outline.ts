import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type ToolDefinition } from "../../types/contracts";
import { type EditTracker } from "./edit-tracker";

// Per-directory async mutex. Many tool calls in one turn can target the same
// sermon folder; the read-modify-write pipeline in replaceOutlineSection is
// not safe under unserialized parallelism. We queue calls per directory so
// every section update sees the latest state.
const directoryLocks = new Map<string, Promise<unknown>>();

async function withDirectoryLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const previous = directoryLocks.get(directory) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  directoryLocks.set(directory, next);
  try {
    return await next;
  } finally {
    if (directoryLocks.get(directory) === next) {
      directoryLocks.delete(directory);
    }
  }
}

export const OUTLINE_FILENAME = "outline.md";
export const SERMON_TOOL_SOURCE = "sermon";
export const UPDATE_OUTLINE_SECTION_TOOL_NAME = "update_outline_section";
export const READ_OUTLINE_TOOL_NAME = "read_outline";

export const OUTLINE_SECTIONS = [
  "topic",
  "big_idea",
  "anchor_scripture",
  "point_1",
  "point_2",
  "point_3",
  "conclusion",
  "call_to_response",
  "notes"
] as const;

export type OutlineSection = (typeof OUTLINE_SECTIONS)[number];

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_SECTIONS = new Set<string>(OUTLINE_SECTIONS);

export interface SermonToolOptions {
  sermon_root: string;
  edit_tracker?: EditTracker;
}

export interface UpdateOutlineSectionInput {
  sermon: unknown;
  section: unknown;
  content: unknown;
}

export interface UpdateOutlineSectionResult {
  ok: true;
  sermon: string;
  section: OutlineSection;
  preview: string;
}

export interface ReadOutlineInput {
  sermon: unknown;
}

export interface ReadOutlineResult {
  ok: true;
  sermon: string;
  content: string;
}

export interface UpdateOutlineSectionTool {
  definition: ToolDefinition;
  handler(input: UpdateOutlineSectionInput): Promise<UpdateOutlineSectionResult>;
}

export interface ReadOutlineTool {
  definition: ToolDefinition;
  handler(input: ReadOutlineInput): Promise<ReadOutlineResult>;
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

function assertSection(value: unknown): OutlineSection {
  if (typeof value !== "string") {
    throw new Error("section must be a string from the outline allowlist.");
  }
  if (!ALLOWED_SECTIONS.has(value)) {
    throw new Error(
      `Unknown section '${value}' — not in allowlist (${OUTLINE_SECTIONS.join(", ")}).`
    );
  }
  return value as OutlineSection;
}

function sermonDirOf(sermonRoot: string, slug: string): string {
  return path.join(path.resolve(sermonRoot), slug);
}

function outlinePathOf(sermonDir: string): string {
  return path.join(sermonDir, OUTLINE_FILENAME);
}

function defaultOutlineHeader(): string {
  return ["# Sermon Outline", ""].join("\n");
}

function emptySectionBlock(section: OutlineSection): string {
  return [`## ${section}`, "", ""].join("\n");
}

function buildScaffoldContent(): string {
  const blocks = OUTLINE_SECTIONS.map((section) => emptySectionBlock(section));
  return `${defaultOutlineHeader()}${blocks.join("\n")}\n`;
}

export async function scaffoldOutline(sermonDir: string): Promise<void> {
  const target = outlinePathOf(sermonDir);
  try {
    await fs.access(target);
    return;
  } catch {
    // proceed to create
  }
  await fs.mkdir(sermonDir, { recursive: true });
  await fs.writeFile(target, buildScaffoldContent(), "utf8");
}

export async function readOutline(sermonDir: string): Promise<string> {
  try {
    return await fs.readFile(outlinePathOf(sermonDir), "utf8");
  } catch {
    return "_(outline not yet generated)_\n";
  }
}

export async function parseOutlineSections(
  sermonDir: string
): Promise<Record<OutlineSection, string>> {
  const text = await readOutline(sermonDir);
  const result = OUTLINE_SECTIONS.reduce<Record<OutlineSection, string>>(
    (acc, section) => {
      acc[section] = "";
      return acc;
    },
    {} as Record<OutlineSection, string>
  );

  const lines = text.split(/\r?\n/g);
  let currentSection: OutlineSection | null = null;
  let buffer: string[] = [];

  function flush(): void {
    if (currentSection) {
      result[currentSection] = buffer.join("\n").trim();
    }
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = /^##\s+(\S+)\s*$/.exec(line);
    if (headingMatch) {
      flush();
      const candidate = headingMatch[1];
      currentSection = ALLOWED_SECTIONS.has(candidate) ? (candidate as OutlineSection) : null;
      continue;
    }
    if (currentSection) {
      buffer.push(line);
    }
  }
  flush();

  return result;
}

export async function writeOutlineAtomic(sermonDir: string, content: string): Promise<void> {
  await fs.mkdir(sermonDir, { recursive: true });
  const target = outlinePathOf(sermonDir);
  // Unique temp filename per call so concurrent writers don't share + race the rename.
  const tempPath = `${target}.tmp.${crypto.randomBytes(6).toString("hex")}`;
  await fs.writeFile(tempPath, content, "utf8");
  try {
    await fs.rename(tempPath, target);
  } catch (cause) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw cause;
  }
}

function renderOutline(
  sections: Record<OutlineSection, string>,
  sermonSlug: string
): string {
  const header = [`# Sermon: ${sermonSlug}`, ""].join("\n");
  const blocks = OUTLINE_SECTIONS.map((section) => {
    const body = sections[section];
    const block = body.length > 0 ? body : "";
    return [`## ${section}`, "", block, ""].join("\n");
  });
  return `${header}${blocks.join("\n")}`;
}

export async function replaceOutlineSection(
  sermonDir: string,
  section: string,
  content: string
): Promise<void> {
  const validatedSection = assertSection(section);
  // Serialize parallel section updates to the same sermon folder. The read-
  // modify-write here is not safe under concurrency: parallel calls would
  // each read the same "before" state and clobber each other on write.
  await withDirectoryLock(sermonDir, async () => {
    const current = await parseOutlineSections(sermonDir);
    current[validatedSection] = typeof content === "string" ? content : String(content ?? "");
    const slug = path.basename(sermonDir);
    const next = renderOutline(current, slug);
    await writeOutlineAtomic(sermonDir, next);
  });
}

function buildUpdateDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: UPDATE_OUTLINE_SECTION_TOOL_NAME,
      description:
        "Replace one named section of the sermon outline. Section name must be from the closed allowlist " +
        "(topic, big_idea, anchor_scripture, point_1, point_2, point_3, conclusion, call_to_response, notes). " +
        "Use this when the pastor has confirmed a piece of the outline.",
      parameters: {
        type: "object",
        properties: {
          sermon: {
            type: "string",
            description: "Sermon slug (lowercase ASCII, digits, hyphens; e.g., 'acts-kingdom-focus')."
          },
          section: {
            type: "string",
            enum: [...OUTLINE_SECTIONS],
            description: "Outline section to replace."
          },
          content: {
            type: "string",
            description: "Markdown body for the section, in the pastor's voice."
          }
        },
        required: ["sermon", "section", "content"],
        additionalProperties: false
      }
    },
    source: SERMON_TOOL_SOURCE,
    mutates_state: true,
    required_permissions: []
  };
}

function buildReadDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: READ_OUTLINE_TOOL_NAME,
      description:
        "Return the current sermon outline as markdown. Use this when resuming a session or " +
        "before writing, to know what's already in place.",
      parameters: {
        type: "object",
        properties: {
          sermon: {
            type: "string",
            description: "Sermon slug (lowercase ASCII, digits, hyphens)."
          }
        },
        required: ["sermon"],
        additionalProperties: false
      }
    },
    source: SERMON_TOOL_SOURCE,
    mutates_state: false,
    required_permissions: []
  };
}

export function createUpdateOutlineSectionTool(
  options: SermonToolOptions
): UpdateOutlineSectionTool {
  if (!options?.sermon_root || options.sermon_root.trim().length === 0) {
    throw new Error("update_outline_section requires a non-empty sermon_root.");
  }

  return {
    definition: buildUpdateDefinition(),
    async handler(input): Promise<UpdateOutlineSectionResult> {
      if (!input || typeof input !== "object") {
        throw new Error("update_outline_section requires an object input.");
      }
      const slug = assertSlug(input.sermon);
      const section = assertSection(input.section);
      if (typeof input.content !== "string") {
        throw new Error("update_outline_section requires a string content field.");
      }
      const sermonDir = sermonDirOf(options.sermon_root, slug);
      await scaffoldOutline(sermonDir);
      await replaceOutlineSection(sermonDir, section, input.content);
      if (options.edit_tracker) {
        options.edit_tracker.recordAiWrite(slug, section);
      }
      const preview =
        input.content.length > 120 ? `${input.content.slice(0, 120)}…` : input.content;
      return { ok: true, sermon: slug, section, preview };
    }
  };
}

export function createReadOutlineTool(options: SermonToolOptions): ReadOutlineTool {
  if (!options?.sermon_root || options.sermon_root.trim().length === 0) {
    throw new Error("read_outline requires a non-empty sermon_root.");
  }

  return {
    definition: buildReadDefinition(),
    async handler(input): Promise<ReadOutlineResult> {
      if (!input || typeof input !== "object") {
        throw new Error("read_outline requires an object input.");
      }
      const slug = assertSlug(input.sermon);
      const sermonDir = sermonDirOf(options.sermon_root, slug);
      const content = await readOutline(sermonDir);
      return { ok: true, sermon: slug, content };
    }
  };
}
