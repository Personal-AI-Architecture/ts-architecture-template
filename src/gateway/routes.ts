declare const require: (id: string) => any;

const crypto = require("crypto") as {
  randomUUID?: () => string;
  randomBytes(size: number): { toString(encoding: string): string };
};

import {
  type EngineActorHeaders,
  type EngineChatRequest,
  type EngineStreamEvent,
  type GatewayPublicMessageRequest,
  type GatewayStreamEvent,
  type ToolDefinition
} from "../types/contracts";
import { DEFAULT_CONTEXT_LIMITS, modelLimit, selectCompleteTurns, type ContextLimits } from "../types/context";
import { emitAuditLog } from "../types/audit";
import { toErrorDiagnostics, toSafeClientMessage } from "../types/safety";
import { type GatewayConversationStore } from "./conversation-store";

export interface GatewayEngineHandlerRequest {
  method: string;
  path: string;
  headers?: Record<string, string | string[] | undefined>;
  body: EngineChatRequest;
}

export interface GatewayEngineHandler {
  readonly context_limits?: ContextLimits;
  handle(request: GatewayEngineHandlerRequest): AsyncGenerator<EngineStreamEvent>;
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
  engine_handler: GatewayEngineHandler;
  current_model?: () => string;
  current_provider?: () => string;
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
): EngineActorHeaders | null {
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

export function createGatewayRoutes(config: GatewayRoutesConfig): GatewayRoutes {
  if (!config?.conversation_store) {
    throw new Error("Gateway routes require a conversation store.");
  }
  if (!config?.engine_handler) {
    throw new Error("Gateway routes require an engine handler.");
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
    const selectedModel = config.current_model?.() ?? "mock";
    const selectedProvider = config.current_provider?.() ?? "local";
    const limit = modelLimit(config.context_limits ?? config.engine_handler.context_limits ?? DEFAULT_CONTEXT_LIMITS, selectedProvider, selectedModel);
    if (limit === null) {
      return createJsonResponse(503, {
        code: "context_limit_unknown",
        message: "No safe context limit for selected provider and model."
      });
    }
    const selection = selectCompleteTurns(userMessage.messages, config.context_tools ?? [], limit);
    if (!selection) {
      return createJsonResponse(422, {
        code: "context_overflow",
        message: "Current message exceeds the selected model context window."
      });
    }

    const engineRequest: GatewayEngineHandlerRequest = {
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

    const stream = (async function* streamGatewayEvents(): AsyncGenerator<GatewayStreamEvent> {
      let assistantContent = "";
      let emittedDone = false;

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
        for await (const engineEvent of config.engine_handler.handle(engineRequest)) {
          if (engineEvent.event === "text-delta") {
            const data = cloneEventData(engineEvent.data) ?? {};
            const text = typeof data.text === "string" ? data.text : typeof data.content === "string" ? data.content : "";
            assistantContent += text;
            yield {
              event: "text-delta",
              data: {
                ...data,
                content: text
              }
            };
            continue;
          }

          if (
            engineEvent.event === "tool-call" ||
            engineEvent.event === "tool-result" ||
            engineEvent.event === "error"
          ) {
            const data = cloneEventData(engineEvent.data);
            if (engineEvent.event === "tool-result") {
              const approvals = pickApprovalData(data);
              if (approvals.approval_request) {
                yield {
                  event: "approval-request",
                  data: approvals.approval_request
                };
              }
              if (approvals.approval_result) {
                yield {
                  event: "approval-result",
                  data: approvals.approval_result
                };
              }
            }
            const publicData = stripApprovalData(data);
            yield {
              event: engineEvent.event,
              ...(publicData ? { data: publicData } : {})
            };
            if (engineEvent.event === "error") {
              return;
            }
            continue;
          }

          if (engineEvent.event === "done") {
          const assistantMessage = await config.conversation_store.appendMessage(
            conversationId,
            "assistant",
            assistantContent,
            { model: selectedModel, provider: selectedProvider }
          );
          const completionData: Record<string, unknown> = {
            finish_reason:
              typeof engineEvent.data?.finish_reason === "string" && engineEvent.data.finish_reason.length > 0
                ? engineEvent.data.finish_reason
                : "stop",
            message_id: assistantMessage.message_id
          };
          emittedDone = true;
          yield {
            event: "done",
            data: {
              ...(cloneEventData(engineEvent.data) ?? {}),
              ...completionData
            }
          };
          return;
          }
        }

        if (!emittedDone) {
          const assistantMessage = await config.conversation_store.appendMessage(
            conversationId,
            "assistant",
            assistantContent,
            { model: selectedModel, provider: selectedProvider }
          );
          const completionData: Record<string, unknown> = {
            finish_reason: "stop",
            message_id: assistantMessage.message_id
          };
          yield {
            event: "done",
            data: completionData
          };
        }
      } catch (error) {
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

      if (method === "POST" && (path === "/conversations/messages" || path === "/chat")) {
        return routeMessage(request);
      }

      if (method === "GET" && path === "/conversations") {
        const conversations = await config.conversation_store.listConversations();
        return createJsonResponse(200, {
          conversations,
          total: conversations.length
        });
      }

      const detailConversationId = conversationDetailPathConversationId(path);
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

      const messageConversationId = messageRoutePathConversationId(path);
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
