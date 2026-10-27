declare const require: (id: string) => any;

const crypto = require("crypto") as {
  randomUUID?: () => string;
  randomBytes(size: number): { toString(encoding: string): string };
};

import {
  type AgentLoopActorHeaders,
  type AgentLoopChatRequest,
  type AgentLoopStreamEvent,
  type CanonicalMessage,
  type ContentPart,
  type GatewayPublicMessageRequest,
  type GatewayStreamEvent,
  type ToolDefinition
} from "../types/contracts";
import { DEFAULT_CONTEXT_LIMITS, modelLimit, selectCompleteTurns, type ContextLimits } from "../types/context";
import { emitAuditLog } from "../types/audit";
import { toErrorDiagnostics, toSafeClientMessage } from "../types/safety";
import { type GatewayConversationStore } from "./conversation-store";

export interface GatewayAgentLoopHandlerRequest {
  method: string;
  path: string;
  headers?: Record<string, string | string[] | undefined>;
  body: AgentLoopChatRequest;
}

export interface GatewayAgentLoopHandler {
  readonly context_limits?: ContextLimits;
  handle(request: GatewayAgentLoopHandlerRequest): AsyncGenerator<AgentLoopStreamEvent>;
}

export interface GatewayRouteRequest {
  method: string;
  path: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface GatewayRouteResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  stream?: AsyncGenerator<GatewayStreamEvent>;
}

export interface GatewayRoutes {
  handle(request: GatewayRouteRequest): Promise<GatewayRouteResponse>;
}

export interface GatewayRoutesConfig {
  conversation_store: GatewayConversationStore;
  agent_loop_handler: GatewayAgentLoopHandler;
  current_model?: () => string;
  current_provider?: () => string;
  current_selection?: () => Promise<{ model: string; provider: string }>;
  context_limits?: ContextLimits;
  context_tools?: ToolDefinition[];
}

const STREAM_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive"
};

function createIdentifier(prefix: string): string {
  const uuid = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined;
  if (uuid) {
    return `${prefix}_${uuid}`;
  }
  const random = crypto.randomBytes(10).toString("hex");
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMethod(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function findHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }

    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim().length > 0);
      if (first) {
        return first.trim();
      }
      continue;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function extractActorHeaders(
  headers: Record<string, string | string[] | undefined> | undefined
): AgentLoopActorHeaders | null {
  const actorId = findHeaderValue(headers, "X-Actor-ID");
  const actorPermissions = findHeaderValue(headers, "X-Actor-Permissions");

  if (!actorId || !actorPermissions) {
    return null;
  }

  return {
    "X-Actor-ID": actorId,
    "X-Actor-Permissions": actorPermissions
  };
}

function messageRoutePathConversationId(pathname: string): string | null {
  const match = /^\/conversations\/([^/]+)\/messages$/.exec(pathname);
  if (!match) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function conversationDetailPathConversationId(pathname: string): string | null {
  const match = /^\/conversations\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function parsePublicMessageRequest(
  body: unknown
): { ok: true; value: GatewayPublicMessageRequest } | { ok: false; message: string } {
  if (!isObjectLike(body)) {
    return {
      ok: false,
      message: "Public message request must be an object with content and metadata."
    };
  }

  if (Object.prototype.hasOwnProperty.call(body, "messages")) {
    return {
      ok: false,
      message: "Public message request must not include a messages array."
    };
  }

  const keys = Object.keys(body);
  const allowedKeys = new Set(["content", "metadata"]);
  for (const key of keys) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        message: `Unexpected request field: ${key}.`
      };
    }
  }

  const content = body.content;
  if (!Array.isArray(content) || content.length === 0 || content.some((part) => {
    if (!isObjectLike(part)) return true;
    if ("extensions" in part && !isObjectLike(part.extensions)) return true;
    const allowed = part.type === "text"
      ? new Set(["type", "text", "extensions"])
      : part.type === "image" || part.type === "file"
        ? new Set(["type", "url", "name", "mime_type", "extensions"])
        : null;
    if (!allowed || Object.keys(part).some((key) => !allowed.has(key))) return true;
    if (part.type === "text") return typeof part.text !== "string";
    if (part.type === "image" || part.type === "file") return typeof part.url !== "string";
    return true;
  })) {
    return {
      ok: false,
      message: "Public message request content must be a non-empty array of content parts."
    };
  }

  const metadata = body.metadata;
  if (metadata !== undefined && !isObjectLike(metadata)) {
    return {
      ok: false,
      message: "Public message request metadata must be an object when provided."
    };
  }

  return {
    ok: true,
    value: {
      content: content as GatewayPublicMessageRequest["content"],
      ...(metadata ? { metadata: { ...metadata } } : {})
    }
  };
}

function createJsonResponse(status: number, body: unknown): GatewayRouteResponse {
  return {
    status,
    headers: {
      "Content-Type": "application/json"
    },
    body
  };
}

function toCorrelationId(metadata: Record<string, unknown>): string {
  const existing = metadata.correlation_id;
  if (typeof existing === "string" && existing.trim().length > 0) {
    return existing.trim();
  }
  return createIdentifier("corr");
}

function toSafeErrorEvent(message: string): GatewayStreamEvent {
  return {
    event: "error",
    data: {
      _event_type: "error",
      code: "provider_error",
      message: toSafeClientMessage(message, "Model provider failed to complete the stream.")
    }
  };
}

function cloneEventData(data: unknown): Record<string, unknown> | undefined {
  if (!isObjectLike(data)) {
    return undefined;
  }
  return { ...data };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function pickApprovalData(data: Record<string, unknown> | undefined): {
  approval_request?: Record<string, unknown>;
  approval_result?: Record<string, unknown>;
} {
  if (!data) {
    return {};
  }

  const approvalRequest = asRecord(data.approval_request);
  const approvalResult = asRecord(data.approval_result);

  return {
    ...(approvalRequest ? { approval_request: approvalRequest } : {}),
    ...(approvalResult ? { approval_result: approvalResult } : {})
  };
}

function stripApprovalData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  const { approval_request: _approvalRequest, approval_result: _approvalResult, ...rest } = data;
  return rest;
}

function appendTextPart(parts: ContentPart[], text: string): void {
  if (text.length === 0) {
    return;
  }
  const previous = parts[parts.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  parts.push({ type: "text", text });
}

function parseToolResultOutput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function createGatewayRoutes(config: GatewayRoutesConfig): GatewayRoutes {
  if (!config?.conversation_store) {
    throw new Error("Gateway routes require a conversation store.");
  }
  if (!config?.agent_loop_handler) {
    throw new Error("Gateway routes require an Agent Loop handler.");
  }

  async function routeMessage(
    request: GatewayRouteRequest,
    requestedConversationId?: string
  ): Promise<GatewayRouteResponse> {
    const parsed = parsePublicMessageRequest(request.body);
    if (!parsed.ok) {
      return createJsonResponse(400, {
        code: "invalid_request",
        message: parsed.message
      });
    }

    const actorHeaders = extractActorHeaders(request.headers);
    if (!actorHeaders) {
      return createJsonResponse(401, {
        code: "missing_actor_headers",
        message: "Missing required actor headers."
      });
    }

    const requestMetadata = parsed.value.metadata ?? {};
    let selectedModel: string;
    let selectedProvider: string;
    try {
      const selection = config.current_selection
        ? await config.current_selection()
        : { model: config.current_model?.() ?? "mock", provider: config.current_provider?.() ?? "local" };
      selectedModel = selection.model;
      selectedProvider = selection.provider;
      if (!selectedModel || !selectedProvider) throw new Error("Missing model or provider preference.");
    } catch {
      return createJsonResponse(503, {
        code: "selection_unavailable",
        message: "Current model and provider preferences are unavailable."
      });
    }
    const limit = modelLimit(config.context_limits ?? config.agent_loop_handler.context_limits ?? DEFAULT_CONTEXT_LIMITS, selectedProvider, selectedModel);
    if (limit === null) {
      return createJsonResponse(503, {
        code: "context_limit_unknown",
        message: "No safe context limit for selected provider and model."
      });
    }
    let conversationId = requestedConversationId;
    if (!conversationId) {
      const created = await config.conversation_store.createConversation(requestMetadata);
      conversationId = created.conversation_id;
    } else {
      const exists = await config.conversation_store.hasConversation(conversationId);
      if (!exists) {
        return createJsonResponse(404, {
          code: "conversation_not_found",
          message: `Conversation ${conversationId} was not found.`
        });
      }
    }

    const userMessage = await config.conversation_store.appendMessage(
      conversationId,
      "user",
      parsed.value.content
    );
    const correlationId = toCorrelationId(requestMetadata);
    const selection = selectCompleteTurns(userMessage.messages, config.context_tools ?? [], limit);
    if (!selection) {
      return createJsonResponse(422, {
        code: "context_overflow",
        message: "Current message exceeds the selected model context window."
      });
    }

    const agentLoopRequest: GatewayAgentLoopHandlerRequest = {
      method: "POST",
      path: "/agent-loop/chat",
      headers: {
        "X-Actor-ID": actorHeaders["X-Actor-ID"],
        "X-Actor-Permissions": actorHeaders["X-Actor-Permissions"]
      },
      body: {
        messages: selection.messages,
        model: selectedModel,
        provider: selectedProvider,
        auth_context: {
          actor: { id: actorHeaders["X-Actor-ID"], type: "owner", display_name: actorHeaders["X-Actor-ID"], status: "active", created: new Date().toISOString() },
          authentication_id: createIdentifier("authn"),
          authenticated_at: new Date().toISOString(),
          correlation_id: correlationId
        },
        metadata: {
          correlation_id: correlationId,
          conversation_id: conversationId,
          client_context: requestMetadata
        }
      }
    };
    const persistedConversationId = conversationId;

    const stream = (async function* streamGatewayEvents(): AsyncGenerator<GatewayStreamEvent> {
      let assistantContent = "";
      let emittedDone = false;
      let lastAssistantMessageId: string | undefined;
      const pendingMessages: CanonicalMessage[] = [];
      let assistantParts: ContentPart[] = [];
      let assistantToolCalls: Record<string, Extract<ContentPart, { type: "tool_call" }>> = {};

      function flushAssistantMessage(force = false): void {
        if (assistantParts.length === 0 && !force) {
          return;
        }
        if (assistantParts.length === 0) {
          assistantParts = [{ type: "text", text: "" }];
        }
        const toolCalls = Object.values(assistantToolCalls).map((part) => ({
          id: part.id,
          source_id: part.source_id,
          name: part.name,
          arguments: part.arguments
        }));
        pendingMessages.push({
          role: "assistant",
          content: [...assistantParts],
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        });
        assistantParts = [];
        assistantToolCalls = {};
      }

      async function persistPendingMessages(): Promise<void> {
        if (pendingMessages.length === 0) {
          return;
        }
        const messagesToPersist = pendingMessages.splice(0, pendingMessages.length);
        const result = await config.conversation_store.appendMessages(
          persistedConversationId,
          messagesToPersist,
          { model: selectedModel, provider: selectedProvider }
        );
        for (let index = messagesToPersist.length - 1; index >= 0; index -= 1) {
          if (messagesToPersist[index].role === "assistant") {
            lastAssistantMessageId = result.message_ids[index];
            break;
          }
        }
      }

      try {
        if (selection.omitted_turn_count > 0) {
          yield {
            event: "context_notice",
            data: {
              _event_type: "context_notice",
              action: "omitted",
              omitted_turn_count: selection.omitted_turn_count,
              message: "Older conversation turns were omitted from this reply's working context."
            }
          };
        }
        for await (const agentLoopEvent of config.agent_loop_handler.handle(agentLoopRequest)) {
          if (agentLoopEvent.event === "text-delta") {
            const data = cloneEventData(agentLoopEvent.data) ?? {};
            const text = typeof data.text === "string" ? data.text : typeof data.content === "string" ? data.content : "";
            assistantContent += text;
            appendTextPart(assistantParts, text);
            yield {
              event: "text-delta",
              data: {
                ...data,
                _event_type: "text-delta",
                content: text
              }
            };
            continue;
          }

          if (
            agentLoopEvent.event === "tool-call" ||
            agentLoopEvent.event === "tool-result" ||
            agentLoopEvent.event === "error"
          ) {
            const data = cloneEventData(agentLoopEvent.data);
            if (agentLoopEvent.event === "tool-call" && data) {
              const id = typeof data.id === "string" ? data.id : "";
              const sourceId = typeof data.source_id === "string" ? data.source_id : "";
              const name = typeof data.name === "string" ? data.name : "";
              const argumentsValue = isObjectLike(data.arguments) ? data.arguments : {};
              if (id && sourceId && name) {
                const part: Extract<ContentPart, { type: "tool_call" }> = {
                  type: "tool_call",
                  id,
                  source_id: sourceId,
                  name,
                  arguments: argumentsValue
                };
                assistantToolCalls[id] = part;
                const existingIndex = assistantParts.findIndex(
                  (candidate) => candidate.type === "tool_call" && candidate.id === id
                );
                if (existingIndex >= 0) {
                  assistantParts[existingIndex] = part;
                } else {
                  assistantParts.push(part);
                }
              }
            }
            if (agentLoopEvent.event === "tool-result") {
              flushAssistantMessage();
              if (data && typeof data.id === "string" && data.id.length > 0) {
                const isError = typeof data.error === "string" && data.error.length > 0;
                const result = isError ? data.error : parseToolResultOutput(data.output);
                pendingMessages.push({
                  role: "tool",
                  tool_call_id: data.id,
                  content: [{
                    type: "tool_result",
                    tool_call_id: data.id,
                    result,
                    ...(isError ? { is_error: true } : {})
                  }]
                });
              }
              const approvals = pickApprovalData(data);
              if (approvals.approval_request) {
                yield {
                  event: "approval-request",
                  data: { ...approvals.approval_request, _event_type: "approval-request" }
                };
              }
              if (approvals.approval_result) {
                yield {
                  event: "approval-result",
                  data: { ...approvals.approval_result, _event_type: "approval-result" }
                };
              }
            }
            const publicData = stripApprovalData(data);
            yield {
              event: agentLoopEvent.event,
              data: { ...(publicData ?? {}), _event_type: agentLoopEvent.event }
            };
            if (agentLoopEvent.event === "error") {
              flushAssistantMessage();
              await persistPendingMessages();
              return;
            }
            continue;
          }

          if (agentLoopEvent.event === "done") {
          flushAssistantMessage(assistantContent.length > 0 || pendingMessages.length === 0);
          await persistPendingMessages();
          const completionData: Record<string, unknown> = {
            finish_reason:
              typeof agentLoopEvent.data?.finish_reason === "string" && agentLoopEvent.data.finish_reason.length > 0
                ? agentLoopEvent.data.finish_reason
                : "stop",
            ...(lastAssistantMessageId ? { message_id: lastAssistantMessageId } : {})
          };
          emittedDone = true;
          yield {
            event: "done",
            data: {
              ...(cloneEventData(agentLoopEvent.data) ?? {}),
              ...completionData,
              _event_type: "done"
            }
          };
          return;
          }
        }

        if (!emittedDone) {
          flushAssistantMessage(assistantContent.length > 0 || pendingMessages.length === 0);
          await persistPendingMessages();
          const completionData: Record<string, unknown> = {
            finish_reason: "stop",
            ...(lastAssistantMessageId ? { message_id: lastAssistantMessageId } : {})
          };
          yield {
            event: "done",
            data: { ...completionData, _event_type: "done" }
          };
        }
      } catch (error) {
        flushAssistantMessage();
        await persistPendingMessages();
        emitAuditLog({
          category: "gateway",
          action: "stream_failure",
          outcome: "failure",
          correlation_id: correlationId,
          actor_id: actorHeaders["X-Actor-ID"],
          diagnostics: toErrorDiagnostics(error)
        });
        yield toSafeErrorEvent("Model provider failed to complete the stream.");
      }
    })();

    return {
      status: 200,
      headers: {
        ...STREAM_HEADERS,
        "X-Conversation-ID": conversationId
      },
      stream
    };
  }

  return {
    async handle(request: GatewayRouteRequest): Promise<GatewayRouteResponse> {
      const method = normalizeMethod(request?.method);
      const path = typeof request?.path === "string" ? request.path : "";
      const routePath = path.split("?", 1)[0];

      if (method === "POST" && (routePath === "/conversations/messages" || routePath === "/chat")) {
        return routeMessage(request);
      }

      if (method === "GET" && routePath === "/conversations") {
        const query = new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");
        const limit = query.has("limit") ? Number(query.get("limit")) : 20;
        const offset = query.has("offset") ? Number(query.get("offset")) : 0;
        const from = query.get("from");
        const to = query.get("to");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 ||
            (from !== null && Number.isNaN(Date.parse(from))) || (to !== null && Number.isNaN(Date.parse(to)))) {
          return createJsonResponse(400, { code: "invalid_request", message: "Invalid conversation filter." });
        }
        const conversations = await config.conversation_store.listConversations();
        const search = (query.get("search") ?? "").toLowerCase();
        const filtered = [];
        for (const conversation of conversations) {
          if (from !== null && Date.parse(conversation.created_at) < Date.parse(from)) continue;
          if (to !== null && Date.parse(conversation.created_at) > Date.parse(to)) continue;
          if (search) {
            const detail = await config.conversation_store.getConversationDetail(conversation.id);
            if (!detail || !JSON.stringify(detail.messages).toLowerCase().includes(search)) continue;
          }
          filtered.push(conversation);
        }
        return createJsonResponse(200, {
          conversations: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset
        });
      }

      const detailConversationId = conversationDetailPathConversationId(routePath);
      if (method === "GET" && detailConversationId) {
        const detail = await config.conversation_store.getConversationDetail(detailConversationId);
        if (!detail) {
          return createJsonResponse(404, {
            code: "conversation_not_found",
            message: `Conversation ${detailConversationId} was not found.`
          });
        }
        return createJsonResponse(200, detail);
      }

      const messageConversationId = messageRoutePathConversationId(routePath);
      if (method === "POST" && messageConversationId) {
        return routeMessage(request, messageConversationId);
      }

      return createJsonResponse(404, {
        code: "not_found",
        message: "Gateway route not found."
      });
    }
  };
}
