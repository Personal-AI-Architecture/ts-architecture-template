declare const require: (id: string) => any;

const fs = require("fs").promises as {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding?: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
};
const path = require("path") as {
  join(...parts: string[]): string;
};

import {
  type MemoryHistoryMetadata,
  type MemoryHistoryRecord,
  type MemoryHistoryHandle,
  initializeMemoryHistory,
  readMemoryHistory
} from "./history";

interface StoredRecord {
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

export interface MemoryExportOptions {
  memory_root: string;
}

export interface MemoryExportPayload {
  exported_at: string;
  memory_root: string;
  entries: StoredRecord[];
  conversations: StoredRecord[];
  history: MemoryHistoryRecord[];
  history_metadata: MemoryHistoryMetadata;
}

const RECORDS_DIRECTORY = "records";
const CONVERSATION_PREFIX = "conversations/";

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as StoredRecord;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.created_at === "string" &&
    typeof candidate.updated_at === "string"
  );
}

async function ensureRecordsDirectory(memoryRoot: string): Promise<string> {
  const recordsPath = path.join(memoryRoot, RECORDS_DIRECTORY);
  await fs.mkdir(recordsPath, { recursive: true });
  return recordsPath;
}

async function readRecordFile(filePath: string): Promise<StoredRecord | null> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return isStoredRecord(parsed) ? parsed : null;
}

async function readHistoryMetadata(handle: MemoryHistoryHandle): Promise<MemoryHistoryMetadata> {
  const raw = await fs.readFile(handle.metadata_path, "utf8");
  const parsed = JSON.parse(raw) as MemoryHistoryMetadata;
  return parsed;
}

export async function exportMemoryData(options: MemoryExportOptions): Promise<MemoryExportPayload> {
  const recordsPath = await ensureRecordsDirectory(options.memory_root);
  const files = (await fs.readdir(recordsPath)).filter((name) => name.endsWith(".json"));
  const records: StoredRecord[] = [];

  for (const fileName of files) {
    const fullPath = path.join(recordsPath, fileName);
    const record = await readRecordFile(fullPath);
    if (record) {
      records.push(record);
    }
  }

  const historyHandle = await initializeMemoryHistory(options.memory_root);
  const [history, historyMetadata] = await Promise.all([
    readMemoryHistory(historyHandle),
    readHistoryMetadata(historyHandle)
  ]);

  const entries = records.filter((record) => !record.key.startsWith(CONVERSATION_PREFIX));
  const conversations = records.filter((record) => record.key.startsWith(CONVERSATION_PREFIX));

  return {
    exported_at: new Date().toISOString(),
    memory_root: options.memory_root,
    entries,
    conversations,
    history,
    history_metadata: historyMetadata
  };
}
