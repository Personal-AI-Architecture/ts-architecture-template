declare const require: (id: string) => any;

const crypto = require("crypto") as {
  randomUUID?: () => string;
  randomBytes(size: number): { toString(encoding: string): string };
};

import {
  type EngineActorHeaders,
  type EngineChatRequest,
  type EngineStreamEvent,
  type GatewayCompletionPayload,
  type GatewayPublicMessageRequest,
  type GatewayStreamEvent
} from "../types/contracts";
import { emitAuditLog } from "../types/audit";
import { toErrorDiagnostics, toSafeClientMessage } from "../types/safety";
import { type GatewayConversationStore } from "./conversation-store";
import { STATIC_CHAT_HTML } from "./static-chat";

export interface GatewayEngineHandlerRequest {
  method: string;
  path: string;
  headers?: Record<string, string | string[] | undefined>;
  body: EngineChatRequest;
}

export interface GatewayEngineHandler {
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
  /**
   * Optional override for the static HTML served by `GET /`. When omitted,
   * the chat-with-docs UI is served (default behaviour). Each composition
   * (entrypoint script) chooses which UI to serve via this knob — keeps
   * routes.ts agnostic to the active project.
   */
  static_html?: string;
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
  if (typeof content !== "string" || content.trim().length === 0) {
    return {
      ok: false,
      message: "Public message request content must be a non-empty string."
    };
  }

  const metadata = body.metadata;
  if (!isObjectLike(metadata)) {
    return {
      ok: false,
      message: "Public message request metadata must be an object."
    };
  }

  return {
    ok: true,
    value: {
      content: content,
      metadata: { ...metadata }
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
        error: {
          code: "invalid_request",
          message: parsed.message
        }
      });
    }

    const actorHeaders = extractActorHeaders(request.headers);
    if (!actorHeaders) {
      return createJsonResponse(401, {
        error: {
          code: "missing_actor_headers",
          message: "Missing required actor headers."
        }
      });
    }

    let conversationId = requestedConversationId;
    if (!conversationId) {
      const created = await config.conversation_store.createConversation(parsed.value.metadata);
      conversationId = created.conversation_id;
    } else {
      const exists = await config.conversation_store.hasConversation(conversationId);
      if (!exists) {
        return createJsonResponse(404, {
          error: {
            code: "conversation_not_found",
            message: `Conversation ${conversationId} was not found.`
          }
        });
      }
    }

    const userMessage = await config.conversation_store.appendMessage(
      conversationId,
      "user",
      parsed.value.content
    );
    const correlationId = toCorrelationId(parsed.value.metadata);

    const engineRequest: GatewayEngineHandlerRequest = {
      method: "POST",
      path: "/engine/chat",
      headers: {
        "X-Actor-ID": actorHeaders["X-Actor-ID"],
        "X-Actor-Permissions": actorHeaders["X-Actor-Permissions"]
      },
      body: {
        messages: userMessage.messages,
        metadata: {
          correlation_id: correlationId,
          conversation_id: conversationId,
          client_context: parsed.value.metadata
        }
      }
    };

    const stream = (async function* streamGatewayEvents(): AsyncGenerator<GatewayStreamEvent> {
      let assistantContent = "";
      let emittedDone = false;

      try {
        for await (const engineEvent of config.engine_handler.handle(engineRequest)) {
          if (engineEvent.event === "text-delta") {
            const data = cloneEventData(engineEvent.data) ?? {};
            const text = typeof data.text === "string" ? data.text : "";
            assistantContent += text;
            yield {
              event: "text-delta",
              data
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
            assistantContent
          );
          const completion: GatewayCompletionPayload = {
            conversation_id: conversationId,
            message_id: assistantMessage.message_id
          };
          const completionData: Record<string, unknown> = {
            conversation_id: completion.conversation_id,
            message_id: completion.message_id
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
            assistantContent
          );
          const completion: GatewayCompletionPayload = {
            conversation_id: conversationId,
            message_id: assistantMessage.message_id
          };
          const completionData: Record<string, unknown> = {
            conversation_id: completion.conversation_id,
            message_id: completion.message_id
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

      if (method === "GET" && path === "/") {
        return {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: config.static_html ?? STATIC_CHAT_HTML
        };
      }

      if (method === "POST" && path === "/chat") {
        return routeMessage(request);
      }

      if (method === "GET" && path === "/conversations") {
        const conversations = await config.conversation_store.listConversations();
        return createJsonResponse(200, { conversations });
      }

      const detailConversationId = conversationDetailPathConversationId(path);
      if (method === "GET" && detailConversationId) {
        const detail = await config.conversation_store.getConversationDetail(detailConversationId);
        if (!detail) {
          return createJsonResponse(404, {
            error: {
              code: "conversation_not_found",
              message: `Conversation ${detailConversationId} was not found.`
            }
          });
        }
        return createJsonResponse(200, detail);
      }

      const messageConversationId = messageRoutePathConversationId(path);
      if (method === "POST" && messageConversationId) {
        return routeMessage(request, messageConversationId);
      }

      return createJsonResponse(404, {
        error: {
          code: "not_found",
          message: "Gateway route not found."
        }
      });
    }
  };
}
