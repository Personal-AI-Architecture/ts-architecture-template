import {
  type CanonicalMessage,
  type ModelAdapter,
  type ModelChatRequest,
  type ModelStreamChunk,
  type ToolDefinition
} from "../types/contracts";
import { emitAuditLog } from "../types/audit";
import { installOutboundNetworkGuard, withOutboundNetworkPermit } from "../types/network";
import { toErrorDiagnostics } from "../types/safety";

interface OpenAICompatibleToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAICompatibleMessage {
  role: string;
  content: string;
  tool_calls?: OpenAICompatibleToolCall[];
  tool_call_id?: string;
}

interface OpenAICompatibleTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAICompatiblePayload {
  model: string;
  messages: OpenAICompatibleMessage[];
  tools: OpenAICompatibleTool[];
  stream: true;
}

export interface OpenAICompatibleRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface OpenAICompatibleResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body?: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type OpenAICompatibleFetcher = (
  url: string,
  init: OpenAICompatibleRequestInit
) => Promise<OpenAICompatibleResponse>;

export interface OpenAICompatibleAdapterConfig {
  api_base_url: string;
  model: string;
  api_key?: string;
  default_headers?: Record<string, string>;
  fetcher?: OpenAICompatibleFetcher;
}

function mapMessage(message: CanonicalMessage): OpenAICompatibleMessage {
  if (message.role === "assistant") {
    return {
      role: message.role,
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
      role: message.role,
      content: message.content,
      tool_call_id: message.tool_call_id
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function mapTool(tool: ToolDefinition): OpenAICompatibleTool {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  return null;
}

async function* parseSseChunks(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    const decoded = decoder.decode(chunk, { stream: true });
    buffer += decoded;

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const dataLines = rawEvent
        .split(/\r?\n/g)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0);

      for (const dataLine of dataLines) {
        if (dataLine === "[DONE]") {
          return;
        }

        try {
          yield JSON.parse(dataLine) as unknown;
        } catch {
          continue;
        }
      }

      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  const tail = decoder.decode();
  if (tail.length > 0) {
    buffer += tail;
  }

  const trimmed = buffer.trim();
  if (trimmed.length > 0) {
    const line = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (line.length > 0 && line !== "[DONE]") {
      try {
        yield JSON.parse(line) as unknown;
      } catch {
        // ignore incomplete tail
      }
    }
  }
}

export function mapModelRequestToOpenAIPayload(
  request: ModelChatRequest,
  model: string
): OpenAICompatiblePayload {
  return {
    model,
    messages: request.messages.map((message) => mapMessage(message)),
    tools: request.tools.map((tool) => mapTool(tool)),
    stream: true
  };
}

export function mapOpenAIChunkToModelChunk(payload: unknown): ModelStreamChunk | null {
  const root = asRecord(payload);
  if (!root) {
    return null;
  }

  if (typeof root.type === "string") {
    const typedChunk: ModelStreamChunk = {
      type: root.type,
      delta: asRecord(root.delta) ?? undefined
    };
    return typedChunk;
  }

  const choices = asArray(root.choices);
  if (choices.length === 0) {
    return null;
  }

  const firstChoice = asRecord(choices[0]);
  if (!firstChoice) {
    return null;
  }

  const finishReason = toStringValue(firstChoice.finish_reason);
  if (finishReason.length > 0) {
    return { type: "done", delta: { reason: finishReason } };
  }

  const delta = asRecord(firstChoice.delta);
  if (!delta) {
    return null;
  }

  const content = toStringValue(delta.content);
  if (content.length > 0) {
    return {
      type: "text-delta",
      delta: {
        text: content
      }
    };
  }

  const toolCalls = asArray(delta.tool_calls);
  if (toolCalls.length > 0) {
    const firstToolCall = asRecord(toolCalls[0]);
    const functionRecord = firstToolCall ? asRecord(firstToolCall.function) : null;
    return {
      type: "tool-call",
      delta: {
        id: toStringValue(firstToolCall?.id),
        type: toStringValue(firstToolCall?.type),
        name: toStringValue(functionRecord?.name),
        arguments: toStringValue(functionRecord?.arguments)
      }
    };
  }

  return null;
}

async function defaultFetcher(url: string, init: OpenAICompatibleRequestInit): Promise<OpenAICompatibleResponse> {
  const candidateFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidateFetch !== "function") {
    throw new Error("Global fetch is unavailable; provide an OpenAI-compatible fetcher.");
  }

  const response = await (candidateFetch as (input: string, options: unknown) => Promise<unknown>)(url, init);
  const asResponse = response as OpenAICompatibleResponse;
  if (
    !asResponse ||
    typeof asResponse.ok !== "boolean" ||
    typeof asResponse.status !== "number" ||
    typeof asResponse.text !== "function" ||
    typeof asResponse.json !== "function"
  ) {
    throw new Error("Fetcher returned an invalid response object.");
  }

  return asResponse;
}

function toAsyncIterableBody(value: unknown): AsyncIterable<Uint8Array> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const iteratorFactory = (record as Record<string, unknown>)[Symbol.asyncIterator as unknown as string];
  if (typeof iteratorFactory === "function") {
    return record as unknown as AsyncIterable<Uint8Array>;
  }

  const maybeIterable = value as AsyncIterable<unknown>;
  if (typeof maybeIterable?.[Symbol.asyncIterator] === "function") {
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        for await (const chunk of maybeIterable) {
          const normalized = asUint8Array(chunk);
          if (normalized) {
            yield normalized;
          }
        }
      }
    };
  }

  return null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function createOpenAICompatibleAdapter(config: OpenAICompatibleAdapterConfig): ModelAdapter {
  if (!config.api_base_url || config.api_base_url.trim().length === 0) {
    throw new Error("OpenAI-compatible adapter requires api_base_url.");
  }
  if (!config.model || config.model.trim().length === 0) {
    throw new Error("OpenAI-compatible adapter requires model.");
  }

  const fetcher = config.fetcher ?? defaultFetcher;
  const endpoint = `${normalizeBaseUrl(config.api_base_url)}/chat/completions`;
  installOutboundNetworkGuard();

  return {
    name: "openai-compatible",
    async *stream(request: ModelChatRequest): AsyncGenerator<ModelStreamChunk> {
      const payload = mapModelRequestToOpenAIPayload(request, config.model);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...config.default_headers
      };

      if (config.api_key && config.api_key.trim().length > 0) {
        headers.authorization = `Bearer ${config.api_key}`;
      }

      let response: OpenAICompatibleResponse;
      try {
        response = await withOutboundNetworkPermit(
          {
            channel: "provider",
            operation: "model.stream",
            target: endpoint
          },
          async () => {
            emitAuditLog({
              category: "network",
              action: "provider_request",
              outcome: "success",
              target: endpoint,
              details: {
                adapter: "openai-compatible"
              }
            });
            return fetcher(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(payload)
            });
          }
        );
      } catch (error) {
        emitAuditLog({
          category: "network",
          action: "provider_request",
          outcome: "failure",
          target: endpoint,
          diagnostics: toErrorDiagnostics(error)
        });
        throw error;
      }

      if (!response.ok) {
        const details = await response.text();
        const suffix = details.trim().length > 0 ? `: ${details}` : "";
        emitAuditLog({
          category: "network",
          action: "provider_response",
          outcome: "failure",
          target: endpoint,
          details: {
            status: response.status,
            status_text: response.statusText
          }
        });
        throw new Error(`Provider request failed (${response.status} ${response.statusText})${suffix}`);
      }

      const body = toAsyncIterableBody(response.body);
      if (body) {
        for await (const chunkPayload of parseSseChunks(body)) {
          const mapped = mapOpenAIChunkToModelChunk(chunkPayload);
          if (mapped) {
            yield mapped;
          }
        }

        emitAuditLog({
          category: "network",
          action: "provider_response",
          outcome: "success",
          target: endpoint
        });
        yield { type: "done" };
        return;
      }

      const payloadBody = await response.json();
      const mapped = mapOpenAIChunkToModelChunk(payloadBody);
      if (mapped) {
        yield mapped;
      }
      yield { type: "done" };
      emitAuditLog({
        category: "network",
        action: "provider_response",
        outcome: "success",
        target: endpoint
      });
    }
  };
}
