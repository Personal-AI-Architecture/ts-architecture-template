import type { ToolDefinition } from "../types/contracts";

export interface McpToolSourceConfig {
  id: string;
  url: string;
  headers?: Record<string, string>;
}

export interface McpToolSource {
  discover(): Promise<ToolDefinition[]>;
  call(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
}

/** The configured identity is authoritative; an MCP server never supplies it. */
export function createMcpToolSource(config: McpToolSourceConfig, transport: typeof fetch = fetch): McpToolSource {
  if (!config.id.trim() || !/^https?:\/\//.test(config.url)) throw new Error("Invalid MCP source configuration.");
  let sessionId: string | undefined;
  let initialized = false;
  let nextId = 1;
  const knownNames = new Set<string>();

  async function send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await transport(config.url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-03-26",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        ...config.headers
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
    });
    if (!response.ok) throw new Error(`MCP request failed (${response.status}).`);
    sessionId = response.headers.get("Mcp-Session-Id") ?? sessionId;
    const body = await response.text();
    const message = response.headers.get("content-type")?.includes("text/event-stream")
      ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).map((line) => JSON.parse(line)).find((item) => item?.result || item?.error)
      : JSON.parse(body);
    if (!message || message.error || typeof message.result !== "object" || message.result === null) {
      throw new Error("MCP response was invalid or returned an error.");
    }
    return message.result;
  }

  async function initialize(): Promise<void> {
    if (initialized) return;
    await send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paa-template", version: "0.1.0" } });
    const response = await transport(config.url, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-03-26", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}), ...config.headers },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });
    if (!response.ok) throw new Error(`MCP initialization failed (${response.status}).`);
    initialized = true;
  }

  return {
    async discover() {
      await initialize();
      const definitions: ToolDefinition[] = [];
      knownNames.clear();
      let cursor: string | undefined;
      do {
        const result = await send("tools/list", cursor ? { cursor } : {});
        for (const entry of Array.isArray(result.tools) ? result.tools : []) {
          if (!entry || typeof entry.name !== "string" || !entry.name.trim()) continue;
          knownNames.add(entry.name);
          definitions.push({ name: entry.name, description: typeof entry.description === "string" ? entry.description : "", parameters: typeof entry.inputSchema === "object" && entry.inputSchema !== null ? entry.inputSchema : {}, source: config.id, source_kind: "mcp", category: "discoverable" });
        }
        cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      } while (cursor);
      return definitions;
    },
    async call(name, arguments_) {
      if (!knownNames.has(name)) throw new Error("Tool was not discovered from this source.");
      return send("tools/call", { name, arguments: arguments_ });
    }
  };
}
