declare const require: (id: string) => any;

const crypto = require("crypto") as {
  randomUUID?: () => string;
  randomBytes(size: number): { toString(encoding: string): string };
};

import {
  type CanonicalMessage,
  type GatewayConversationDetail,
  type GatewayConversationMessage,
  type GatewayConversationSummary,
  type MessageRole
} from "../types/contracts";

interface MemoryRecord<TValue = unknown> {
  key: string;
  value: TValue;
  created_at: string;
  updated_at: string;
}

interface MemoryListQuery {
  prefix?: string;
}

interface PersistedConversationValue {
  conversation_id: string;
  messages: CanonicalMessage[];
  metadata: Record<string, unknown>;
}

interface PersistedConversationMessage {
  message_id: string;
  role: MessageRole;
  content: string;
}

export interface GatewayMemoryContract {
  list<TValue = unknown>(query?: MemoryListQuery): Promise<MemoryRecord<TValue>[]>;
  read?<TValue = unknown>(key: string): Promise<MemoryRecord<TValue> | null>;
  write?<TValue = unknown>(key: string, value: TValue): Promise<MemoryRecord<TValue>>;
  getConversation?(
    conversationId: string
  ): Promise<MemoryRecord<PersistedConversationValue> | null>;
  saveConversation?(
    conversationId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>
  ): Promise<MemoryRecord<PersistedConversationValue>>;
}

export interface ConversationStoreConfig {
  memory: GatewayMemoryContract;
  conversation_id_factory?: () => string;
  message_id_factory?: () => string;
}

export interface AppendConversationMessageResult {
  conversation_id: string;
  message_id: string;
  messages: CanonicalMessage[];
}

export interface GatewayConversationStore {
  createConversation(metadata?: Record<string, unknown>): Promise<{ conversation_id: string }>;
  hasConversation(conversationId: string): Promise<boolean>;
  getConversationMessages(conversationId: string): Promise<CanonicalMessage[] | null>;
  appendMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string
  ): Promise<AppendConversationMessageResult>;
  listConversations(): Promise<GatewayConversationSummary[]>;
  getConversationDetail(conversationId: string): Promise<GatewayConversationDetail | null>;
}

const CONVERSATION_PREFIX = "conversations/";
const MESSAGE_INDEX_KEY = "message_index";

function createIdentifier(prefix: string): string {
  const uuid = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined;
  if (uuid) {
    return `${prefix}_${uuid}`;
  }
  const random = crypto.randomBytes(10).toString("hex");
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function toConversationKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}${conversationId}`;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidRole(value: unknown): value is MessageRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function isCanonicalMessage(value: unknown): value is CanonicalMessage {
  if (!isObjectLike(value)) {
    return false;
  }
  return isValidRole(value.role) && typeof value.content === "string";
}

function normalizeCanonicalMessages(value: unknown): CanonicalMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => isCanonicalMessage(entry));
}

function readMessageIndex(metadata: Record<string, unknown>): PersistedConversationMessage[] {
  const raw = metadata[MESSAGE_INDEX_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }

  const parsed: PersistedConversationMessage[] = [];
  for (const candidate of raw) {
    if (!isObjectLike(candidate)) {
      continue;
    }
    if (
      typeof candidate.message_id !== "string" ||
      !isValidRole(candidate.role) ||
      typeof candidate.content !== "string"
    ) {
      continue;
    }
    parsed.push({
      message_id: candidate.message_id,
      role: candidate.role,
      content: candidate.content
    });
  }

  return parsed;
}

function normalizeConversationRecord(
  record: MemoryRecord<unknown> | null
): MemoryRecord<PersistedConversationValue> | null {
  if (!record || !isObjectLike(record.value)) {
    return null;
  }

  const value = record.value;
  if (
    typeof value.conversation_id !== "string" ||
    !Array.isArray(value.messages) ||
    !isObjectLike(value.metadata)
  ) {
    return null;
  }

  return {
    key: record.key,
    created_at: record.created_at,
    updated_at: record.updated_at,
    value: {
      conversation_id: value.conversation_id,
      messages: normalizeCanonicalMessages(value.messages),
      metadata: value.metadata
    }
  };
}

function toConversationSummary(
  record: MemoryRecord<PersistedConversationValue>
): GatewayConversationSummary {
  return {
    conversation_id: record.value.conversation_id,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function toConversationMessage(
  conversationId: string,
  message: CanonicalMessage,
  index: number,
  persistedIndex: PersistedConversationMessage[]
): GatewayConversationMessage {
  const persisted = persistedIndex[index];
  const fallbackId = `${conversationId}-msg-${index + 1}`;

  return {
    message_id: persisted?.message_id ?? fallbackId,
    role: message.role,
    content: message.content
  };
}

function createUserOrAssistantMessage(role: "user" | "assistant", content: string): CanonicalMessage {
  return {
    role,
    content
  };
}

export function createGatewayConversationStore(config: ConversationStoreConfig): GatewayConversationStore {
  if (!config?.memory) {
    throw new Error("Conversation store requires a memory contract.");
  }

  const createConversationId = config.conversation_id_factory ?? (() => createIdentifier("conv"));
  const createMessageId = config.message_id_factory ?? (() => createIdentifier("msg"));

  async function readConversation(
    conversationId: string
  ): Promise<MemoryRecord<PersistedConversationValue> | null> {
    if (typeof config.memory.getConversation === "function") {
      const stored = await config.memory.getConversation(conversationId);
      return normalizeConversationRecord(stored);
    }

    if (typeof config.memory.read === "function") {
      const stored = await config.memory.read<PersistedConversationValue>(toConversationKey(conversationId));
      return normalizeConversationRecord(stored);
    }

    return null;
  }

  async function saveConversation(
    conversationId: string,
    messages: CanonicalMessage[],
    metadata: Record<string, unknown>
  ): Promise<MemoryRecord<PersistedConversationValue>> {
    if (typeof config.memory.saveConversation === "function") {
      return config.memory.saveConversation(conversationId, messages, metadata);
    }

    if (typeof config.memory.write !== "function") {
      throw new Error("Memory contract must provide saveConversation or write.");
    }

    return config.memory.write<PersistedConversationValue>(toConversationKey(conversationId), {
      conversation_id: conversationId,
      messages,
      metadata
    });
  }

  return {
    async createConversation(metadata: Record<string, unknown> = {}): Promise<{ conversation_id: string }> {
      const conversationId = createConversationId();
      const initialMetadata: Record<string, unknown> = {
        ...metadata,
        [MESSAGE_INDEX_KEY]: []
      };

      await saveConversation(conversationId, [], initialMetadata);
      return { conversation_id: conversationId };
    },

    async hasConversation(conversationId: string): Promise<boolean> {
      const record = await readConversation(conversationId);
      return Boolean(record);
    },

    async getConversationMessages(conversationId: string): Promise<CanonicalMessage[] | null> {
      const record = await readConversation(conversationId);
      if (!record) {
        return null;
      }
      return [...record.value.messages];
    },

    async appendMessage(
      conversationId: string,
      role: "user" | "assistant",
      content: string
    ): Promise<AppendConversationMessageResult> {
      const existing = await readConversation(conversationId);
      if (!existing) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }

      const nextMessage = createUserOrAssistantMessage(role, content);
      const messageId = createMessageId();
      const nextMessages = [...existing.value.messages, nextMessage];
      const metadata = {
        ...existing.value.metadata
      };
      const messageIndex = [
        ...readMessageIndex(metadata),
        {
          message_id: messageId,
          role: nextMessage.role,
          content: nextMessage.content
        }
      ];
      metadata[MESSAGE_INDEX_KEY] = messageIndex;

      await saveConversation(conversationId, nextMessages, metadata);

      return {
        conversation_id: conversationId,
        message_id: messageId,
        messages: nextMessages
      };
    },

    async listConversations(): Promise<GatewayConversationSummary[]> {
      const records = await config.memory.list<PersistedConversationValue>({ prefix: CONVERSATION_PREFIX });
      const conversations = records
        .map((record) => normalizeConversationRecord(record as MemoryRecord<unknown>))
        .filter((record): record is MemoryRecord<PersistedConversationValue> => Boolean(record))
        .map((record) => toConversationSummary(record))
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at));

      return conversations;
    },

    async getConversationDetail(conversationId: string): Promise<GatewayConversationDetail | null> {
      const record = await readConversation(conversationId);
      if (!record) {
        return null;
      }

      const messageIndex = readMessageIndex(record.value.metadata);
      const messages = record.value.messages.map((message, index) =>
        toConversationMessage(conversationId, message, index, messageIndex)
      );

      return {
        conversation_id: conversationId,
        messages
      };
    }
  };
}
