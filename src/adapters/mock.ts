import {
  type CanonicalMessage,
  type ModelAdapter,
  type ModelChatRequest,
  type ModelStreamChunk
} from "../types/contracts";

export interface MockAdapterConfig {
  response_text?: string;
  tool_call_triggers?: string[];
  scripted_chunks?: ModelStreamChunk[];
}

const DEFAULT_TOOL_TRIGGERS = ["tool", "call", "invoke", "use"];

function textFromMessage(message: CanonicalMessage | undefined): string {
  if (!message || typeof message.content !== "string") {
    return "";
  }
  return message.content.trim();
}

function toTextChunks(value: string): string[] {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return [];
  }

  const words = normalized.split(/\s+/g);
  const chunks: string[] = [];
  let buffer = "";

  for (const word of words) {
    const next = buffer.length > 0 ? `${buffer} ${word}` : word;
    if (next.length > 24 && buffer.length > 0) {
      chunks.push(`${buffer} `);
      buffer = word;
      continue;
    }
    buffer = next;
  }

  if (buffer.length > 0) {
    chunks.push(buffer);
  }

  return chunks;
}

function shouldEmitToolCall(request: ModelChatRequest, triggers: string[]): boolean {
  if (request.tools.length === 0) {
    return false;
  }

  const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
  const content = textFromMessage(lastUserMessage).toLowerCase();
  return triggers.some((trigger) => content.includes(trigger.toLowerCase()));
}

function containsDoneChunk(chunks: ModelStreamChunk[]): boolean {
  return chunks.some((chunk) => chunk.type === "done");
}

async function* streamScriptedChunks(chunks: ModelStreamChunk[]): AsyncGenerator<ModelStreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
  if (!containsDoneChunk(chunks)) {
    yield { type: "done" };
  }
}

function responseTextForRequest(request: ModelChatRequest, configured: string | undefined): string {
  if (configured && configured.trim().length > 0) {
    return configured;
  }

  const lastToolMessage = [...request.messages].reverse().find((message) => message.role === "tool");
  if (lastToolMessage) {
    return `Tool result received: ${textFromMessage(lastToolMessage)}`;
  }

  const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
  const userContent = textFromMessage(lastUserMessage);
  return userContent.length > 0 ? `Mock response: ${userContent}` : "Mock response";
}

export function createMockAdapter(config: MockAdapterConfig = {}): ModelAdapter {
  const toolCallTriggers =
    config.tool_call_triggers && config.tool_call_triggers.length > 0
      ? config.tool_call_triggers
      : DEFAULT_TOOL_TRIGGERS;

  return {
    name: "mock",
    async *stream(request: ModelChatRequest): AsyncGenerator<ModelStreamChunk> {
      if (config.scripted_chunks && config.scripted_chunks.length > 0) {
        yield* streamScriptedChunks(config.scripted_chunks);
        return;
      }

      if (shouldEmitToolCall(request, toolCallTriggers)) {
        const selectedTool = request.tools[0];
        yield {
          type: "tool-call",
          delta: {
            id: "mock-tool-call-1",
            type: "function",
            name: selectedTool.function.name,
            arguments: JSON.stringify({ input: "mock" })
          }
        };

        yield {
          type: "text-delta",
          delta: {
            text: `Calling tool ${selectedTool.function.name}`
          }
        };

        yield { type: "done" };
        return;
      }

      const text = responseTextForRequest(request, config.response_text);
      const chunks = toTextChunks(text);
      if (chunks.length === 0) {
        yield { type: "done" };
        return;
      }

      for (const chunk of chunks) {
        yield {
          type: "text-delta",
          delta: {
            text: chunk
          }
        };
      }

      yield { type: "done" };
    }
  };
}
