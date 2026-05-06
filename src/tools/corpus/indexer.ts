import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type ModelAdapter, type ModelChatRequest } from "../../types/contracts";

export const AGENT_INDEX_FILENAME = "agent.md";
export const SUMMARY_MAX_CHARS = 240;
const SOURCE_EXTENSION = ".md";
const SUMMARY_INPUT_LIMIT = 16_000;
const TRUNCATION_MARKER = "…";

export interface BuildIndexOptions {
  corpus_root: string;
  model_adapter: ModelAdapter;
  generated_at?: Date;
}

interface CorpusFile {
  relative_path: string;
  absolute_path: string;
  mtime: Date;
}

async function assertCorpusFolder(corpusRoot: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(corpusRoot);
  } catch (cause) {
    throw new Error(`Corpus folder is missing or unreadable: ${corpusRoot}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Corpus folder is not a directory: ${corpusRoot}`);
  }
}

async function listMarkdownFiles(corpusRoot: string): Promise<CorpusFile[]> {
  const entries = await fs.readdir(corpusRoot, { withFileTypes: true });
  const files: CorpusFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === AGENT_INDEX_FILENAME) {
      continue;
    }
    if (path.extname(entry.name).toLowerCase() !== SOURCE_EXTENSION) {
      continue;
    }
    const absolutePath = path.join(corpusRoot, entry.name);
    const stat = await fs.stat(absolutePath);
    files.push({
      relative_path: entry.name,
      absolute_path: absolutePath,
      mtime: stat.mtime
    });
  }
  files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return files;
}

export async function isIndexStale(corpusRoot: string): Promise<boolean> {
  await assertCorpusFolder(corpusRoot);

  const indexPath = path.join(corpusRoot, AGENT_INDEX_FILENAME);
  let indexStat;
  try {
    indexStat = await fs.stat(indexPath);
  } catch {
    return true;
  }

  const files = await listMarkdownFiles(corpusRoot);
  for (const file of files) {
    if (file.mtime.getTime() > indexStat.mtime.getTime()) {
      return true;
    }
  }
  return false;
}

async function streamSummary(adapter: ModelAdapter, request: ModelChatRequest): Promise<string> {
  let buffer = "";
  for await (const chunk of adapter.stream(request)) {
    if (chunk.type === "text-delta") {
      const delta = chunk.delta as { text?: unknown } | undefined;
      const text = typeof delta?.text === "string" ? delta.text : "";
      buffer += text;
    }
    if (chunk.type === "error") {
      const delta = chunk.delta as { message?: unknown } | undefined;
      const message = typeof delta?.message === "string" ? delta.message : "Adapter error during summary.";
      throw new Error(message);
    }
  }
  return buffer.trim();
}

export function truncateSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "";
  }
  if (collapsed.length <= SUMMARY_MAX_CHARS) {
    return collapsed;
  }
  const reserve = TRUNCATION_MARKER.length;
  const sliceLength = SUMMARY_MAX_CHARS - reserve;
  const head = collapsed.slice(0, sliceLength);
  const lastSpace = head.lastIndexOf(" ");
  const cutAt = lastSpace > sliceLength * 0.6 ? lastSpace : sliceLength;
  return `${head.slice(0, cutAt).trimEnd()}${TRUNCATION_MARKER}`;
}

function summaryPromptForFile(relativePath: string, body: string): ModelChatRequest {
  const truncated =
    body.length > SUMMARY_INPUT_LIMIT
      ? `${body.slice(0, SUMMARY_INPUT_LIMIT)}\n\n[...truncated...]`
      : body;

  const userContent = [
    `Summarize this markdown note in no more than 30 words.`,
    `Output a single line. No headings. No bullet points. No quotation marks.`,
    `file: ${relativePath}`,
    ``,
    truncated
  ].join("\n");

  return {
    messages: [
      {
        role: "system",
        content:
          "You are a terse indexer. For each note, output one short summary line of at most 30 words. " +
          "Do not invent topics that are not present in the document. Do not include headings, lists, or quotes."
      },
      {
        role: "user",
        content: userContent
      }
    ],
    tools: [],
    stream: true
  };
}

function formatHeader(corpusRoot: string, generatedAt: Date, fileCount: number): string {
  return [
    "# Document Index",
    "",
    `Generated: ${generatedAt.toISOString()}`,
    `Source: ${corpusRoot}`,
    `Files: ${fileCount}`,
    ""
  ].join("\n");
}

function formatSection(file: CorpusFile, summary: string): string {
  const safeSummary = summary.length > 0 ? summary : "_(no summary produced)_";
  return [`## ${file.relative_path}`, "", safeSummary, ""].join("\n");
}

export async function buildIndex(options: BuildIndexOptions): Promise<string> {
  await assertCorpusFolder(options.corpus_root);

  const files = await listMarkdownFiles(options.corpus_root);
  const generatedAt = options.generated_at ?? new Date();
  const sections: string[] = [];

  for (const file of files) {
    const body = await fs.readFile(file.absolute_path, "utf8");
    const rawSummary = await streamSummary(
      options.model_adapter,
      summaryPromptForFile(file.relative_path, body)
    );
    sections.push(formatSection(file, truncateSummary(rawSummary)));
  }

  const header = formatHeader(options.corpus_root, generatedAt, files.length);
  return `${header}\n${sections.join("\n")}`.trim() + "\n";
}

export interface EnsureCorpusIndexOptions {
  corpus_root: string;
  model_adapter: ModelAdapter;
}

export interface EnsureCorpusIndexResult {
  regenerated: boolean;
}

export async function ensureCorpusIndex(
  options: EnsureCorpusIndexOptions
): Promise<EnsureCorpusIndexResult> {
  const stale = await isIndexStale(options.corpus_root);
  if (!stale) {
    return { regenerated: false };
  }
  const content = await buildIndex({
    corpus_root: options.corpus_root,
    model_adapter: options.model_adapter
  });
  await writeIndexAtomic(options.corpus_root, content);
  return { regenerated: true };
}

export async function writeIndexAtomic(corpusRoot: string, content: string): Promise<void> {
  await assertCorpusFolder(corpusRoot);
  const indexPath = path.join(corpusRoot, AGENT_INDEX_FILENAME);
  const tempPath = path.join(corpusRoot, `${AGENT_INDEX_FILENAME}.tmp`);
  await fs.writeFile(tempPath, content, "utf8");
  try {
    await fs.rename(tempPath, indexPath);
  } catch (cause) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failure; surface the original cause
    }
    throw cause;
  }
}
