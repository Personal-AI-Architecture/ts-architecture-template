import { type CanonicalMessage, type ToolDefinition } from "./contracts";

export type ContextLimits = Record<string, Record<string, number>>;

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = { local: { mock: 8192 } };

export function modelLimit(limits: ContextLimits, provider: string, model: string): number | null {
  const value = limits[provider]?.[model];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** UTF-8 bytes conservatively upper-bound ordinary token counts. */
export function contextCost(messages: CanonicalMessage[], tools: ToolDefinition[] = []): number {
  return new TextEncoder().encode(JSON.stringify({ messages, tools })).length + 384;
}

export function selectCompleteTurns(
  messages: CanonicalMessage[],
  tools: ToolDefinition[],
  limit: number
): { messages: CanonicalMessage[]; omitted_turn_count: number } | null {
  const turns: CanonicalMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  let selected: CanonicalMessage[] = [];
  let kept = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const candidate = [...turns[index], ...selected];
    if (contextCost(candidate, tools) > limit) {
      if (kept === 0) return null;
      break;
    }
    selected = candidate;
    kept += 1;
  }
  return { messages: selected, omitted_turn_count: turns.length - kept };
}
