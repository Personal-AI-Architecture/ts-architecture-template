declare const require: (id: string) => any;

const fs = require("fs").promises as {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding?: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  writeFile(path: string, data: string, encoding?: string): Promise<void>;
};
const path = require("path") as {
  join(...parts: string[]): string;
};

import { type CanonicalMessage } from "../types/contracts";
import {
  createApprovalGate,
  type ApprovalDecider,
  type ApprovalEvaluation,
  type ApprovalMode
} from "../types/approval";
import { emitAuditLog } from "../types/audit";
import { toErrorDiagnostics } from "../types/safety";
import { exportMemoryData, type MemoryExportPayload } from "./export";
import {
  appendMemoryHistoryRecord,
  assertMemoryHistoryReady,
  initializeMemoryHistory,
  readMemoryHistory,
  type MemoryHistoryQuery,
  type MemoryHistoryRecord
} from "./history";

export interface MemoryToolsConfig {
  memory_root: string;
  approvals?: {
    mode?: ApprovalMode;
    decide?: ApprovalDecider;
  };
}

export interface MemoryRecord<TValue = unknown> {
  key: string;
  value: TValue;
  created_at: string;
  updated_at: string;
}

export interface ConversationRecord {
  conversation_id: string;
  messages: CanonicalMessage[];
  metadata: Record<string, unknown>;
}

export type MemoryEditPatch = Record<string, unknown>;

export interface MemoryListQuery {
  prefix?: string;
}

export interface MemorySearchQuery {
  query: string;
  limit?: number;
}

export interface MemoryTools {
  read<TValue = unknown>(key: string): Promise<MemoryRecord<TValue> | null>;
  write<TValue = unknown>(key: string, value: TValue): Promise<MemoryRecord<TValue>>;
  edit<TValue = unknown>(key: string, patch: MemoryEditPatch): Promise<MemoryRecord<TValue>>;
  delete(key: string): Promise<boolean>;
  search<TValue = unknown>(query: MemorySearchQuery): Promise<MemoryRecord<TValue>[]>;
  list<TValue = unknown>(query?: MemoryListQuery): Promise<MemoryRecord<TValue>[]>;
  history(query?: MemoryHistoryQuery): Promise<MemoryHistoryRecord[]>;
  export(): Promise<MemoryExportPayload>;
  saveConversation(
    conversationId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>
  ): Promise<MemoryRecord<ConversationRecord>>;
  getConversation(conversationId: string): Promise<MemoryRecord<ConversationRecord> | null>;
  appendConversationMessage(
    conversationId: string,
    message: CanonicalMessage
  ): Promise<MemoryRecord<ConversationRecord>>;
}

const RECORDS_DIRECTORY = "records";
const CONVERSATION_PREFIX = "conversations/";

function nowIso(): string {
  return new Date().toISOString();
}

function toConversationKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}${conversationId}`;
}

function assertNonEmptyKey(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error("Memory key must be a non-empty string.");
  }
}

function encodedFileName(key: string): string {
  return `${encodeURIComponent(key)}.json`;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergePatch(currentValue: unknown, patch: MemoryEditPatch): unknown {
  if (isObjectLike(currentValue)) {
    return { ...currentValue, ...patch };
  }
  return { ...patch };
}

function isMemoryRecord(value: unknown): value is MemoryRecord<unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as MemoryRecord<unknown>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.created_at === "string" &&
    typeof candidate.updated_at === "string"
  );
}

async function createRecordsDirectory(memoryRoot: string): Promise<string> {
  const directory = path.join(memoryRoot, RECORDS_DIRECTORY);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function readStoredRecord(recordsDir: string, key: string): Promise<MemoryRecord<unknown> | null> {
  const filePath = path.join(recordsDir, encodedFileName(key));
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isMemoryRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStoredRecord(recordsDir: string, record: MemoryRecord<unknown>): Promise<void> {
  const filePath = path.join(recordsDir, encodedFileName(record.key));
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function deleteStoredRecord(recordsDir: string, key: string): Promise<void> {
  const filePath = path.join(recordsDir, encodedFileName(key));
  await fs.rm(filePath, { force: true });
}

async function readAllRecords(recordsDir: string): Promise<MemoryRecord<unknown>[]> {
  const files = (await fs.readdir(recordsDir)).filter((name) => name.endsWith(".json"));
  const records: MemoryRecord<unknown>[] = [];

  for (const fileName of files) {
    const fullPath = path.join(recordsDir, fileName);
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isMemoryRecord(parsed)) {
      records.push(parsed);
    }
  }

  return records;
}

function serializeForSearch(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function buildMemoryApprovalGate(config: MemoryToolsConfig["approvals"] | undefined) {
  const customDecide = config?.decide;

  return createApprovalGate({
    mode: config?.mode,
    decide: async (request) => {
      const key = typeof request.metadata?.key === "string" ? request.metadata.key : "";
      if (key.startsWith(CONVERSATION_PREFIX)) {
        return {
          approved: true,
          reason: "Conversation persistence is auto-approved."
        };
      }

      if (typeof customDecide === "function") {
        return customDecide(request);
      }

      return false;
    }
  });
}

export async function createMemoryTools(config: MemoryToolsConfig): Promise<MemoryTools> {
  if (!config.memory_root || config.memory_root.trim().length === 0) {
    throw new Error("Memory root must be configured.");
  }

  const recordsDir = await createRecordsDirectory(config.memory_root);
  const historyHandle = await initializeMemoryHistory(config.memory_root);
  await assertMemoryHistoryReady(historyHandle);
  const approvalGate = buildMemoryApprovalGate(config.approvals);

  async function requireWriteApproval(
    operation: "write" | "edit" | "delete",
    key: string
  ): Promise<ApprovalEvaluation> {
    const evaluation = await approvalGate.evaluate({
      action: `memory.${operation}`,
      target: key,
      reason: `Memory ${operation} operation requires approval.`,
      metadata: {
        key
      }
    });

    emitAuditLog({
      category: "memory",
      action: "approval_request",
      outcome: "success",
      target: key,
      details: {
        operation,
        approval_id: evaluation.approval_request.approval_id
      }
    });

    emitAuditLog({
      category: "memory",
      action: "approval_result",
      outcome: evaluation.approval_result.approved ? "allow" : "deny",
      target: key,
      details: {
        operation,
        approval_id: evaluation.approval_result.approval_id,
        reason: evaluation.approval_result.reason
      }
    });

    if (!evaluation.approval_result.approved) {
      throw new Error(`Memory ${operation} operation requires approval.`);
    }

    return evaluation;
  }

  async function read<TValue = unknown>(key: string): Promise<MemoryRecord<TValue> | null> {
    assertNonEmptyKey(key);
    const record = await readStoredRecord(recordsDir, key);
    return record as MemoryRecord<TValue> | null;
  }

  async function write<TValue = unknown>(key: string, value: TValue): Promise<MemoryRecord<TValue>> {
    assertNonEmptyKey(key);
    try {
      await requireWriteApproval("write", key);
      const current = await readStoredRecord(recordsDir, key);
      const timestamp = nowIso();
      const next: MemoryRecord<TValue> = {
        key,
        value,
        created_at: current ? current.created_at : timestamp,
        updated_at: timestamp
      };

      await writeStoredRecord(recordsDir, next as MemoryRecord<unknown>);
      await appendMemoryHistoryRecord(historyHandle, {
        operation: "write",
        key,
        previous_state: current ? current.value : null,
        next_state: value
      });

      emitAuditLog({
        category: "memory",
        action: "write",
        outcome: "success",
        target: key
      });

      return next;
    } catch (error) {
      emitAuditLog({
        category: "memory",
        action: "write",
        outcome: "failure",
        target: key,
        diagnostics: toErrorDiagnostics(error)
      });
      throw error;
    }
  }

  async function edit<TValue = unknown>(key: string, patch: MemoryEditPatch): Promise<MemoryRecord<TValue>> {
    assertNonEmptyKey(key);
    try {
      const current = await readStoredRecord(recordsDir, key);
      if (!current) {
        throw new Error(`Cannot edit missing memory key: ${key}`);
      }

      await requireWriteApproval("edit", key);
      const mergedValue = mergePatch(current.value, patch) as TValue;
      const next: MemoryRecord<TValue> = {
        key,
        value: mergedValue,
        created_at: current.created_at,
        updated_at: nowIso()
      };

      await writeStoredRecord(recordsDir, next as MemoryRecord<unknown>);
      await appendMemoryHistoryRecord(historyHandle, {
        operation: "edit",
        key,
        previous_state: current.value,
        next_state: mergedValue
      });

      emitAuditLog({
        category: "memory",
        action: "edit",
        outcome: "success",
        target: key
      });

      return next;
    } catch (error) {
      emitAuditLog({
        category: "memory",
        action: "edit",
        outcome: "failure",
        target: key,
        diagnostics: toErrorDiagnostics(error)
      });
      throw error;
    }
  }

  async function remove(key: string): Promise<boolean> {
    assertNonEmptyKey(key);
    try {
      const current = await readStoredRecord(recordsDir, key);
      if (!current) {
        return false;
      }

      await requireWriteApproval("delete", key);
      await deleteStoredRecord(recordsDir, key);
      await appendMemoryHistoryRecord(historyHandle, {
        operation: "delete",
        key,
        previous_state: current.value,
        next_state: null
      });

      emitAuditLog({
        category: "memory",
        action: "delete",
        outcome: "success",
        target: key
      });

      return true;
    } catch (error) {
      emitAuditLog({
        category: "memory",
        action: "delete",
        outcome: "failure",
        target: key,
        diagnostics: toErrorDiagnostics(error)
      });
      throw error;
    }
  }

  async function list<TValue = unknown>(query: MemoryListQuery = {}): Promise<MemoryRecord<TValue>[]> {
    const all = await readAllRecords(recordsDir);
    const filtered = query.prefix
      ? all.filter((record) => record.key.startsWith(query.prefix ?? ""))
      : all;
    return filtered as MemoryRecord<TValue>[];
  }

  async function search<TValue = unknown>(query: MemorySearchQuery): Promise<MemoryRecord<TValue>[]> {
    const normalizedQuery = query.query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const all = await readAllRecords(recordsDir);
    const matching = all.filter((record) => {
      const keyText = record.key.toLowerCase();
      const valueText = serializeForSearch(record.value).toLowerCase();
      return keyText.includes(normalizedQuery) || valueText.includes(normalizedQuery);
    });

    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : matching.length;
    return matching.slice(0, limit) as MemoryRecord<TValue>[];
  }

  async function history(query: MemoryHistoryQuery = {}): Promise<MemoryHistoryRecord[]> {
    return readMemoryHistory(historyHandle, query);
  }

  async function exportOperation(): Promise<MemoryExportPayload> {
    try {
      const payload = await exportMemoryData({ memory_root: config.memory_root });
      emitAuditLog({
        category: "memory",
        action: "export",
        outcome: "success",
        details: {
          entry_count: payload.entries.length,
          conversation_count: payload.conversations.length
        }
      });
      return payload;
    } catch (error) {
      emitAuditLog({
        category: "memory",
        action: "export",
        outcome: "failure",
        diagnostics: toErrorDiagnostics(error)
      });
      throw error;
    }
  }

  async function saveConversation(
    conversationId: string,
    messages: CanonicalMessage[],
    metadata: Record<string, unknown> = {}
  ): Promise<MemoryRecord<ConversationRecord>> {
    const conversationValue: ConversationRecord = {
      conversation_id: conversationId,
      messages,
      metadata
    };
    return write<ConversationRecord>(toConversationKey(conversationId), conversationValue);
  }

  async function getConversation(
    conversationId: string
  ): Promise<MemoryRecord<ConversationRecord> | null> {
    return read<ConversationRecord>(toConversationKey(conversationId));
  }

  async function appendConversationMessage(
    conversationId: string,
    message: CanonicalMessage
  ): Promise<MemoryRecord<ConversationRecord>> {
    const existing = await getConversation(conversationId);
    const nextMessages = existing ? [...existing.value.messages, message] : [message];
    const existingMetadata = existing ? existing.value.metadata : {};

    return saveConversation(conversationId, nextMessages, existingMetadata);
  }

  return {
    read,
    write,
    edit,
    delete: remove,
    search,
    list,
    history,
    export: exportOperation,
    saveConversation,
    getConversation,
    appendConversationMessage
  };
}
