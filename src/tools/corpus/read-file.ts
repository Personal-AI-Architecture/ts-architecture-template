import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type ToolDefinition } from "../../types/contracts";

export const READ_FILE_TOOL_NAME = "read_file";
export const CORPUS_TOOL_SOURCE = "corpus";
const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);

export interface CreateReadFileToolOptions {
  corpus_root: string;
}

export interface ReadFileInput {
  path: unknown;
}

export interface ReadFileResult {
  ok: true;
  path: string;
  content: string;
}

export interface ReadFileTool {
  definition: ToolDefinition;
  handler(input: ReadFileInput): Promise<ReadFileResult>;
}

function buildDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: READ_FILE_TOOL_NAME,
      description:
        "Read a UTF-8 text file from the configured documents corpus. " +
        "Use this to load the full content of a file referenced in agent.md. " +
        "Path may be relative to the corpus or absolute inside it.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path of the file to read, relative to the corpus folder (e.g., 'notes/architecture.md')."
          }
        },
        required: ["path"],
        additionalProperties: false
      }
    },
    source: CORPUS_TOOL_SOURCE,
    mutates_state: false,
    required_permissions: []
  };
}

async function realPathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

function isInside(resolvedRoot: string, resolvedTarget: string): boolean {
  if (resolvedTarget === resolvedRoot) {
    return true;
  }
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolvedTarget.startsWith(prefix);
}

export function createReadFileTool(options: CreateReadFileToolOptions): ReadFileTool {
  if (!options?.corpus_root || options.corpus_root.trim().length === 0) {
    throw new Error("read_file requires a non-empty corpus_root.");
  }

  const definition = buildDefinition();

  async function handler(input: ReadFileInput): Promise<ReadFileResult> {
    if (!input || typeof input !== "object") {
      throw new Error("read_file requires an object input with a path field.");
    }
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      throw new Error("read_file requires a non-empty string path.");
    }

    const corpusRoot = path.resolve(options.corpus_root);
    const realCorpusRoot = await realPathOrSelf(corpusRoot);

    const requestedPath = input.path;
    const resolvedRequested = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(realCorpusRoot, requestedPath);
    const realRequested = await realPathOrSelf(resolvedRequested);

    if (!isInside(realCorpusRoot, realRequested)) {
      throw new Error(`Path is outside the corpus folder: ${requestedPath}`);
    }

    const extension = path.extname(realRequested).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`Unsupported file type for read_file: ${extension || "(none)"}`);
    }

    let content: string;
    try {
      content = await fs.readFile(realRequested, "utf8");
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        throw new Error(`File not found in corpus: ${requestedPath}`);
      }
      throw cause;
    }

    const relative = path.relative(realCorpusRoot, realRequested) || path.basename(realRequested);
    return {
      ok: true,
      path: relative,
      content
    };
  }

  return { definition, handler };
}
