declare const require: (id: string) => any;

const fs = require("fs").promises as {
  appendFile(path: string, data: string, encoding?: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding?: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean }>;
  writeFile(path: string, data: string, encoding?: string): Promise<void>;
};
const path = require("path") as {
  join(...parts: string[]): string;
};

export type MemoryChangeOperation = "write" | "edit" | "delete";

export interface MemoryHistoryMetadata {
  schema_version: number;
  initialized_at: string;
}

export interface MemoryHistoryRecord {
  id: string;
  timestamp: string;
  operation: MemoryChangeOperation;
  key: string;
  previous_state: unknown;
  next_state: unknown;
}

export interface MemoryHistoryHandle {
  directory: string;
  metadata_path: string;
  log_path: string;
}

export interface MemoryHistoryQuery {
  key?: string;
  limit?: number;
}

const HISTORY_DIRECTORY = "history";
const HISTORY_METADATA_FILE = "meta.json";
const HISTORY_LOG_FILE = "changes.jsonl";
const HISTORY_SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function makeRecordId(): string {
  const random = Math.random().toString(16).slice(2, 10);
  return `chg_${Date.now()}_${random}`;
}

function safeParseJsonLine(line: string): MemoryHistoryRecord | null {
  try {
    const parsed = JSON.parse(line) as MemoryHistoryRecord;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.id !== "string" || typeof parsed.operation !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function ensureWritableFile(filePath: string): Promise<void> {
  try {
    await fs.appendFile(filePath, "", "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`History file is not writable (${filePath}): ${reason}`);
  }
}

async function ensureExistingFile(filePath: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`Expected file at ${filePath}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Required history file is unavailable (${filePath}): ${reason}`);
  }
}

async function createMetadataFileIfMissing(filePath: string): Promise<void> {
  try {
    await ensureExistingFile(filePath);
  } catch {
    const metadata: MemoryHistoryMetadata = {
      schema_version: HISTORY_SCHEMA_VERSION,
      initialized_at: nowIso()
    };
    await fs.writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
}

async function createLogFileIfMissing(filePath: string): Promise<void> {
  try {
    await ensureExistingFile(filePath);
  } catch {
    await fs.writeFile(filePath, "", "utf8");
  }
}

export async function initializeMemoryHistory(memoryRoot: string): Promise<MemoryHistoryHandle> {
  const directory = path.join(memoryRoot, HISTORY_DIRECTORY);
  const metadataPath = path.join(directory, HISTORY_METADATA_FILE);
  const logPath = path.join(directory, HISTORY_LOG_FILE);

  try {
    await fs.mkdir(directory, { recursive: true });
    await createMetadataFileIfMissing(metadataPath);
    await createLogFileIfMissing(logPath);
    await ensureExistingFile(metadataPath);
    await ensureExistingFile(logPath);
    await ensureWritableFile(logPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to establish memory version history: ${reason}`);
  }

  return {
    directory,
    metadata_path: metadataPath,
    log_path: logPath
  };
}

export async function assertMemoryHistoryReady(handle: MemoryHistoryHandle): Promise<void> {
  await ensureExistingFile(handle.metadata_path);
  await ensureExistingFile(handle.log_path);
  await ensureWritableFile(handle.log_path);
}

export async function appendMemoryHistoryRecord(
  handle: MemoryHistoryHandle,
  input: Omit<MemoryHistoryRecord, "id" | "timestamp">
): Promise<MemoryHistoryRecord> {
  await assertMemoryHistoryReady(handle);

  const record: MemoryHistoryRecord = {
    id: makeRecordId(),
    timestamp: nowIso(),
    operation: input.operation,
    key: input.key,
    previous_state: input.previous_state,
    next_state: input.next_state
  };

  await fs.appendFile(handle.log_path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function readMemoryHistory(
  handle: MemoryHistoryHandle,
  query: MemoryHistoryQuery = {}
): Promise<MemoryHistoryRecord[]> {
  await assertMemoryHistoryReady(handle);
  const raw = await fs.readFile(handle.log_path, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const records: MemoryHistoryRecord[] = [];

  for (const line of lines) {
    const parsed = safeParseJsonLine(line);
    if (parsed) {
      records.push(parsed);
    }
  }

  const filtered = query.key ? records.filter((record) => record.key === query.key) : records;
  if (typeof query.limit === "number" && query.limit >= 0) {
    return filtered.slice(-query.limit);
  }
  return filtered;
}
