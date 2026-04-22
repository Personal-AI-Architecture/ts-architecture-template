export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface BaseMessage {
  role: MessageRole;
  content: string;
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

export interface ToolDefinitionFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: ToolDefinitionFunction;
  source?: string;
  mutates_state?: boolean;
  required_permissions?: string[];
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
  content: string;
  metadata: Record<string, unknown>;
}

export interface GatewayCompletionPayload {
  conversation_id: string;
  message_id: string;
}

export interface GatewayConversationSummary {
  conversation_id: string;
  created_at: string;
  updated_at: string;
}

export interface GatewayConversationMessage {
  message_id: string;
  role: MessageRole;
  content: string;
}

export interface GatewayConversationDetail {
  conversation_id: string;
  messages: GatewayConversationMessage[];
}

export interface GatewayStreamEvent<TData = Record<string, unknown>> {
  event: GatewayStreamEventName;
  data?: TData;
}

export interface GatewayListConversationsResponse {
  conversations: GatewayConversationSummary[];
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

export interface EngineChatRequest {
  messages: CanonicalMessage[];
  metadata: EngineRequestMetadata;
}

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

export interface ModelChatRequest {
  messages: CanonicalMessage[];
  tools: ToolDefinition[];
  stream: true;
}

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
