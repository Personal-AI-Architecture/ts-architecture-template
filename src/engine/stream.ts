import {
  type EngineStreamErrorCode,
  type EngineStreamEvent,
  type EngineStreamEventName,
  type ModelStreamChunk
} from "../types/contracts";
import { toSafeClientMessage } from "../types/safety";

const ALLOWED_ENGINE_EVENTS: EngineStreamEventName[] = [
  "text-delta",
  "tool-call",
  "tool-result",
  "done",
  "error"
];

const CONTEXT_OVERFLOW_PATTERN =
  /(maximum\s+context|context\s+(window|length)|too\s+many\s+tokens|token\s+limit|prompt\s+too\s+long)/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function defaultErrorMessage(code: EngineStreamErrorCode): string {
  if (code === "context_overflow") {
    return "Context window exceeded. Reduce prompt size or start a new conversation.";
  }
  if (code === "tool_error") {
    return "Tool execution failed.";
  }
  return "Model provider failed to complete the stream.";
}

export function isAllowedEngineEventName(value: string): value is EngineStreamEventName {
  return ALLOWED_ENGINE_EVENTS.includes(value as EngineStreamEventName);
}

export function createTextDeltaEvent(data: Record<string, unknown>): EngineStreamEvent {
  return {
    event: "text-delta",
    data
  };
}

export function createToolCallEvent(data: Record<string, unknown>): EngineStreamEvent {
  return {
    event: "tool-call",
    data
  };
}

export function createToolResultEvent(data: Record<string, unknown>): EngineStreamEvent {
  return {
    event: "tool-result",
    data
  };
}

export function createDoneEvent(data?: Record<string, unknown>): EngineStreamEvent {
  if (!data) {
    return { event: "done" };
  }

  return {
    event: "done",
    data
  };
}

export function createErrorEvent(
  code: EngineStreamErrorCode,
  overrideMessage?: string
): EngineStreamEvent<{ code: EngineStreamErrorCode; message: string }> {
  const message = toSafeClientMessage(overrideMessage, defaultErrorMessage(code));
  return {
    event: "error",
    data: {
      code,
      message
    }
  };
}

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : toStringValue(error);
  if (!message) {
    return false;
  }
  return CONTEXT_OVERFLOW_PATTERN.test(message);
}

export function classifyProviderErrorCode(error: unknown): EngineStreamErrorCode {
  return isContextOverflowError(error) ? "context_overflow" : "provider_error";
}

export function toProviderErrorEvent(error: unknown): EngineStreamEvent {
  return createErrorEvent(classifyProviderErrorCode(error));
}

export function toErrorEventFromChunk(chunk: ModelStreamChunk): EngineStreamEvent {
  const delta = asRecord(chunk.delta);
  const rawCode = toStringValue(delta?.code);
  const rawMessage = toStringValue(delta?.message);

  if (rawCode === "tool_error") {
    return createErrorEvent("tool_error", rawMessage);
  }
  if (rawCode === "context_overflow") {
    return createErrorEvent("context_overflow", rawMessage);
  }

  if (rawMessage && CONTEXT_OVERFLOW_PATTERN.test(rawMessage)) {
    return createErrorEvent("context_overflow", rawMessage);
  }

  return createErrorEvent("provider_error", rawMessage);
}

export function toStreamEventFromModelChunk(chunk: ModelStreamChunk): EngineStreamEvent | null {
  const data = asRecord(chunk.delta) ?? {};

  if (chunk.type === "text-delta") {
    return createTextDeltaEvent(data);
  }

  if (chunk.type === "tool-call") {
    return createToolCallEvent(data);
  }

  if (chunk.type === "tool-result") {
    return createToolResultEvent(data);
  }

  if (chunk.type === "error") {
    return toErrorEventFromChunk(chunk);
  }

  if (chunk.type === "done") {
    return createDoneEvent(data);
  }

  return null;
}
