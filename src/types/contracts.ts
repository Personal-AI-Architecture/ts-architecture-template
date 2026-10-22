export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image" | "file"; url: string; name?: string; mime_type?: string }
  | { type: "tool_call"; id: string; source_id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; tool_call_id: string; result: unknown; is_error?: boolean };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Internal marker retained only when a legacy provider payload was malformed. */
  invalid_arguments?: boolean;
}

export interface BaseMessage {
  role: MessageRole;
  content: string | ContentPart[];
}

export interface SystemMessage extends BaseMessage {
  role: "system";
}

export interface UserMessage extends BaseMessage {
  role: "user";
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  tool_calls?: ToolCall[];
}

export interface ToolMessage extends BaseMessage {
  role: "tool";
  tool_call_id: string;
}

export type CanonicalMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  source?: string;
  category?: "always-send" | "discoverable";
  mutates_state?: boolean;
  required_permissions?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseArguments(value: unknown): { arguments: Record<string, unknown>; invalid: boolean } {
  const record = asRecord(value);
  if (record) {
    return { arguments: record, invalid: false };
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      const parsedRecord = asRecord(parsed);
      return parsedRecord ? { arguments: parsedRecord, invalid: false } : { arguments: {}, invalid: true };
    } catch {
      return { arguments: {}, invalid: true };
    }
  }

  return { arguments: {}, invalid: false };
}

/** Accepts PAA tool definitions and legacy OpenAI-shaped template inputs. */
export function normalizeToolDefinition(value: unknown): ToolDefinition | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const legacyFunction = asRecord(record.function);
  const source = legacyFunction ?? record;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  const description = typeof source.description === "string" ? source.description : "";
  const parameters = asRecord(source.parameters) ?? {};
  if (!name) {
    return undefined;
  }

  return {
    name,
    description,
    parameters,
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(record.category === "always-send" || record.category === "discoverable"
      ? { category: record.category }
      : {}),
    ...(record.mutates_state === true ? { mutates_state: true } : {}),
    ...(Array.isArray(record.required_permissions)
      ? { required_permissions: record.required_permissions.filter((item): item is string => typeof item === "string") }
      : {})
  };
}

/** Accepts PAA tool calls and legacy OpenAI-shaped provider inputs. */
export function normalizeToolCall(value: unknown): ToolCall | undefined {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") {
    return undefined;
  }

  const legacyFunction = asRecord(record.function);
  const source = legacyFunction ?? record;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) {
    return undefined;
  }

  const parsed = parseArguments(source.arguments);
  return {
    id: record.id,
    name,
    arguments: parsed.arguments,
    ...(parsed.invalid ? { invalid_arguments: true } : {})
  };
}

export type GatewayStreamEventName =
  | "text-delta"
  | "tool-call"
  | "tool-result"
  | "approval-request"
  | "approval-result"
  | "done"
  | "error";

export interface GatewayPublicMessageRequest {
  content: ContentPart[];
  metadata?: Record<string, unknown>;
}

export interface GatewayConversationSummary {
  id: string;
  created_at: string;
  updated_at: string;
  title?: string;
  message_count?: number;
}

export interface GatewayConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: ContentPart[];
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayConversationDetail {
  id: string;
  messages: GatewayConversationMessage[];
  title?: string;
  created_at: string;
  updated_at: string;
}

export interface GatewayStreamEvent<TData = Record<string, unknown>> {
  event: GatewayStreamEventName;
  data?: TData;
}

export interface GatewayListConversationsResponse {
  conversations: GatewayConversationSummary[];
  total: number;
  limit?: number;
  offset?: number;
}

export interface EngineRequestMetadata {
  correlation_id: string;
  conversation_id?: string;
  trigger?: string;
  client_context?: Record<string, unknown>;
  actor_id?: string;
  actor_permissions?: string[] | string;
  allowed_tool_sources?: string[];
}

export interface EngineRequest {
  messages: CanonicalMessage[];
  metadata?: EngineRequestMetadata;
  model?: string;
  auth_context?: Record<string, unknown>;
}

export type EngineChatRequest = EngineRequest & {
  metadata: EngineRequestMetadata;
};

export interface EngineActorHeaders {
  "X-Actor-ID": string;
  "X-Actor-Permissions": string;
}

export type EngineStreamEventName =
  | "text-delta"
  | "tool-call"
  | "tool-result"
  | "done"
  | "error";

export type EngineStreamErrorCode =
  | "provider_error"
  | "tool_error"
  | "context_overflow";

export interface EngineStreamEvent<TData = Record<string, unknown>> {
  event: EngineStreamEventName;
  data?: TData;
}

export interface CompletionRequest {
  messages: CanonicalMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export type ModelChatRequest = CompletionRequest & {
  tools: ToolDefinition[];
  stream: true;
};

export interface ModelStreamChunk {
  type: string;
  delta?: Record<string, unknown>;
}

export interface ModelAdapter {
  readonly name: string;
  stream(request: ModelChatRequest): AsyncGenerator<ModelStreamChunk>;
}

export interface RuntimeConfiguration {
  memory_root: string;
  provider_adapter: string;
  auth_mode: string;
  tool_sources: string[];
}
