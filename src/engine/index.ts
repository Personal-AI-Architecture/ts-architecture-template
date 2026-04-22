import {
  type CanonicalMessage,
  type EngineChatRequest,
  type EngineStreamEvent,
  type ModelAdapter,
  type ModelChatRequest,
  type ToolCall,
  type ToolDefinition
} from "../types/contracts";
import { emitAuditLog } from "../types/audit";
import { toErrorDiagnostics } from "../types/safety";
import { createErrorEvent, createDoneEvent, toProviderErrorEvent, toStreamEventFromModelChunk } from "./stream";
import { createToolExecutor, type ToolExecutor } from "./tool-executor";

export interface AgentLoopConfig {
  model_adapter: ModelAdapter;
  tools: ToolDefinition[];
  tool_executor?: ToolExecutor;
  allowed_tool_sources?: string[];
}

export interface AgentLoop {
  run(request: EngineChatRequest): AsyncGenerator<EngineStreamEvent>;
}

export interface EngineChatHandlerRequest {
  method: string;
  path: string;
  headers?: Record<string, string | string[] | undefined>;
  body: EngineChatRequest;
}

export interface EngineChatHandler {
  handle(request: EngineChatHandlerRequest): AsyncGenerator<EngineStreamEvent>;
}

interface ToolCallState {
  id: string;
  type: "function";
  name: string;
  arguments: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function copyToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }
  }));
}

function copyMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls?.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments
          }
        }))
      };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id
      };
    }

    return {
      role: message.role,
      content: message.content
    };
  });
}

function toModelRequest(messages: CanonicalMessage[], tools: ToolDefinition[]): ModelChatRequest {
  return {
    messages: copyMessages(messages),
    tools,
    stream: true
  };
}

function hasCorrelationId(request: EngineChatRequest): boolean {
  return typeof request?.metadata?.correlation_id === "string" && request.metadata.correlation_id.trim().length > 0;
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  headerName: string
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const target = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }

    if (Array.isArray(value)) {
      return value.find((item) => typeof item === "string" && item.trim().length > 0);
    }

    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  }

  return undefined;
}

function hasActorHeaders(headers: Record<string, string | string[] | undefined> | undefined): boolean {
  const actorId = readHeaderValue(headers, "X-Actor-ID");
  const actorPermissions = readHeaderValue(headers, "X-Actor-Permissions");
  return Boolean(actorId && actorPermissions);
}

function parseActorPermissionsHeader(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function initializeToolCallState(delta: Record<string, unknown>, fallbackId: string): ToolCallState {
  const id = toStringValue(delta.id).trim();
  const name = toStringValue(delta.name);
  const type = toStringValue(delta.type) === "function" ? "function" : "function";
  const args = toStringValue(delta.arguments);

  return {
    id: id.length > 0 ? id : fallbackId,
    type,
    name,
    arguments: args
  };
}

function mergeToolCallState(
  current: ToolCallState,
  delta: Record<string, unknown>,
  fallbackId: string
): ToolCallState {
  const id = toStringValue(delta.id).trim();
  const name = toStringValue(delta.name);
  const type = toStringValue(delta.type);
  const args = toStringValue(delta.arguments);

  return {
    id: id.length > 0 ? id : current.id || fallbackId,
    type: type === "function" ? "function" : current.type,
    name: name.length > 0 ? name : current.name,
    arguments: args.length > 0 ? `${current.arguments}${args}` : current.arguments
  };
}

function upsertToolCallState(toolCalls: ToolCallState[], delta: Record<string, unknown>): ToolCallState {
  const deltaId = toStringValue(delta.id).trim();
  const fallbackId = `tool-call-${toolCalls.length + 1}`;

  if (deltaId.length > 0) {
    const existingIndex = toolCalls.findIndex((toolCall) => toolCall.id === deltaId);
    if (existingIndex >= 0) {
      const next = mergeToolCallState(toolCalls[existingIndex], delta, fallbackId);
      toolCalls[existingIndex] = next;
      return next;
    }

    const created = initializeToolCallState(delta, fallbackId);
    toolCalls.push(created);
    return created;
  }

  if (toolCalls.length === 0) {
    const created = initializeToolCallState(delta, fallbackId);
    toolCalls.push(created);
    return created;
  }

  const lastIndex = toolCalls.length - 1;
  const next = mergeToolCallState(toolCalls[lastIndex], delta, fallbackId);
  toolCalls[lastIndex] = next;
  return next;
}

function toToolCalls(states: ToolCallState[]): ToolCall[] {
  return states
    .filter((state) => state.name.trim().length > 0)
    .map((state) => ({
      id: state.id,
      type: "function",
      function: {
        name: state.name,
        arguments: state.arguments
      }
    }));
}

function appendAssistantMessage(messages: CanonicalMessage[], text: string, toolCalls: ToolCall[]): void {
  if (text.length === 0 && toolCalls.length === 0) {
    return;
  }

  messages.push({
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  });
}

export function createAgentLoop(config: AgentLoopConfig): AgentLoop {
  if (!config?.model_adapter) {
    throw new Error("Agent loop requires a model adapter.");
  }

  const configuredTools = copyToolDefinitions(config.tools ?? []);
  const toolExecutor =
    config.tool_executor ??
    createToolExecutor({
      tools: configuredTools,
      allowed_tool_sources: config.allowed_tool_sources
    });

  return {
    async *run(request: EngineChatRequest): AsyncGenerator<EngineStreamEvent> {
      const messages = copyMessages(request.messages ?? []);
      let nextModelRequest = toModelRequest(request.messages, configuredTools);

      while (true) {
        let assistantText = "";
        let doneDelta: Record<string, unknown> | undefined;
        const toolCallStates: ToolCallState[] = [];

        try {
          for await (const chunk of config.model_adapter.stream(nextModelRequest)) {
            if (chunk.type === "done") {
              doneDelta = asRecord(chunk.delta);
              break;
            }

            if (chunk.type === "error") {
              const event = toStreamEventFromModelChunk(chunk);
              if (event) {
                yield event;
              }
              return;
            }

            if (chunk.type === "text-delta") {
              const data = asRecord(chunk.delta) ?? {};
              const text = toStringValue(data.text);
              assistantText += text;
            }

            if (chunk.type === "tool-call") {
              const data = asRecord(chunk.delta) ?? {};
              const next = upsertToolCallState(toolCallStates, data);
              yield {
                event: "tool-call",
                data: {
                  id: next.id,
                  type: next.type,
                  name: next.name,
                  arguments: next.arguments
                }
              };
              continue;
            }

            const mapped = toStreamEventFromModelChunk(chunk);
            if (mapped && mapped.event !== "done") {
              yield mapped;
            }
          }
        } catch (error) {
          emitAuditLog({
            category: "engine",
            action: "provider_stream_error",
            outcome: "failure",
            correlation_id: request.metadata.correlation_id,
            actor_id: typeof request.metadata.actor_id === "string" ? request.metadata.actor_id : undefined,
            diagnostics: toErrorDiagnostics(error)
          });
          yield toProviderErrorEvent(error);
          return;
        }

        const toolCalls = toToolCalls(toolCallStates);
        appendAssistantMessage(messages, assistantText, toolCalls);

        if (toolCalls.length === 0) {
          yield createDoneEvent(doneDelta);
          return;
        }

        let executionResults;
        try {
          executionResults = await toolExecutor.executeMany(toolCalls, { metadata: request.metadata });
        } catch (error) {
          emitAuditLog({
            category: "engine",
            action: "tool_execution_error",
            outcome: "failure",
            correlation_id: request.metadata.correlation_id,
            actor_id: typeof request.metadata.actor_id === "string" ? request.metadata.actor_id : undefined,
            diagnostics: toErrorDiagnostics(error)
          });
          yield createErrorEvent("tool_error");
          return;
        }

        let hasFailure = false;

        for (const result of executionResults) {
          const toolName = result.tool_call.function.name;
          const toolCallId = result.tool_call.id;
          const approvalFields = {
            ...(result.approval_request ? { approval_request: result.approval_request } : {}),
            ...(result.approval_result ? { approval_result: result.approval_result } : {})
          };

          if (!result.ok) {
            hasFailure = true;
            if (Object.keys(approvalFields).length > 0 || result.failure_code) {
              yield {
                event: "tool-result",
                data: {
                  id: toolCallId,
                  name: toolName,
                  error: result.failure_code ?? "tool_error",
                  ...approvalFields
                }
              };
            }
            continue;
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: result.content
          });

          yield {
            event: "tool-result",
            data: {
              id: toolCallId,
              name: toolName,
              output: result.output,
              ...approvalFields
            }
          };
        }

        if (hasFailure) {
          yield createErrorEvent("tool_error");
          return;
        }

        nextModelRequest = toModelRequest(messages, configuredTools);
      }
    }
  };
}

export function createEngineChatHandler(config: AgentLoopConfig): EngineChatHandler {
  const loop = createAgentLoop(config);

  return {
    async *handle(request: EngineChatHandlerRequest): AsyncGenerator<EngineStreamEvent> {
      const method = typeof request?.method === "string" ? request.method.toUpperCase() : "";
      if (method !== "POST" || request?.path !== "/engine/chat") {
        yield createErrorEvent("provider_error", "Invalid engine chat endpoint request.");
        return;
      }

      if (!hasActorHeaders(request.headers)) {
        yield createErrorEvent("provider_error", "Missing required engine actor headers.");
        return;
      }

      if (!request?.body || !Array.isArray(request.body.messages) || !hasCorrelationId(request.body)) {
        yield createErrorEvent("provider_error", "Invalid engine chat request payload.");
        return;
      }

      const actorId = readHeaderValue(request.headers, "X-Actor-ID");
      const actorPermissions = readHeaderValue(request.headers, "X-Actor-Permissions");
      const bodyWithActorMetadata: EngineChatRequest = {
        ...request.body,
        metadata: {
          ...request.body.metadata,
          ...(actorId ? { actor_id: actorId } : {}),
          actor_permissions: parseActorPermissionsHeader(actorPermissions)
        }
      };

      yield* loop.run(bodyWithActorMetadata);
    }
  };
}
