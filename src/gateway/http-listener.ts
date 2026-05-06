import * as http from "node:http";
import { type AddressInfo } from "node:net";

import {
  type GatewayRouteRequest,
  type GatewayRouteResponse,
  type GatewayRoutes
} from "./routes";

const DEFAULT_BIND_ADDRESS = "127.0.0.1";
const DEFAULT_PORT = 0;
const MAX_REQUEST_BYTES = 1_048_576;

export interface HttpListenerConfig {
  routes: GatewayRoutes;
  bind_address?: string;
  port?: number;
  allow_non_local_bind?: boolean;
}

export interface HttpListener {
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
}

interface ResolvedBind {
  address: string;
  port: number;
}

function resolveBindAddress(bindAddress: string | undefined, allowNonLocalBind: boolean): string {
  const normalized = (bindAddress ?? DEFAULT_BIND_ADDRESS).trim();
  const asAddress = normalized.toLowerCase() === "localhost" ? DEFAULT_BIND_ADDRESS : normalized;
  if (asAddress.length === 0) {
    return DEFAULT_BIND_ADDRESS;
  }
  if (!allowNonLocalBind && asAddress !== DEFAULT_BIND_ADDRESS) {
    throw new Error(
      `Listener bind address must default to localhost (${DEFAULT_BIND_ADDRESS}); set allow_non_local_bind=true to override.`
    );
  }
  return asAddress;
}

function resolveBind(config: HttpListenerConfig): ResolvedBind {
  const allowNonLocalBind = Boolean(config.allow_non_local_bind);
  return {
    address: resolveBindAddress(config.bind_address, allowNonLocalBind),
    port: typeof config.port === "number" && Number.isFinite(config.port) ? config.port : DEFAULT_PORT
  };
}

function decodeRequestPath(rawUrl: string): { path: string } {
  const url = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  const queryIndex = url.indexOf("?");
  const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  return { path };
}

function copyHeaders(message: http.IncomingMessage): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(message.headers)) {
    headers[key] = value as string | string[] | undefined;
  }
  return headers;
}

async function readRequestBody(message: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    message.on("data", (chunk: Buffer) => {
      if (aborted) {
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        aborted = true;
        message.destroy();
        reject(new Error("Request body too large."));
        return;
      }
      chunks.push(chunk);
    });
    message.on("end", () => {
      if (aborted) {
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    message.on("error", (error) => {
      if (aborted) {
        return;
      }
      reject(error);
    });
  });
}

function parseJsonBodyOrNull(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function applyHeaders(
  response: http.ServerResponse,
  headers: Record<string, string> | undefined
): void {
  if (!headers) {
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    response.setHeader(key, value);
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: { code: "internal_error", message: "Response could not be serialized." } });
  }
}

function writeJsonOrText(response: http.ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  if (typeof body === "string") {
    response.end(body);
    return;
  }
  if (body === undefined || body === null) {
    response.end();
    return;
  }
  if (Buffer.isBuffer(body)) {
    response.end(body);
    return;
  }
  response.end(safeJsonStringify(body));
}

function formatSseEvent(event: { event: string; data?: unknown }): string {
  const lines: string[] = [];
  lines.push(`event: ${event.event}`);
  if (event.data !== undefined && event.data !== null) {
    const payload = typeof event.data === "string" ? event.data : safeJsonStringify(event.data);
    for (const dataLine of payload.split(/\r?\n/g)) {
      lines.push(`data: ${dataLine}`);
    }
  } else {
    lines.push("data: {}");
  }
  return `${lines.join("\n")}\n\n`;
}

async function streamResponse(
  response: http.ServerResponse,
  routeResponse: GatewayRouteResponse
): Promise<void> {
  if (!routeResponse.stream) {
    return;
  }
  for await (const event of routeResponse.stream) {
    response.write(formatSseEvent(event));
  }
  response.end();
}

function isStreamingResponse(routeResponse: GatewayRouteResponse): boolean {
  return Boolean(routeResponse.stream);
}

export function createHttpListener(config: HttpListenerConfig): HttpListener {
  if (!config?.routes) {
    throw new Error("HTTP listener requires a routes object.");
  }

  const bind = resolveBind(config);
  let server: http.Server | null = null;

  async function handleHttpRequest(
    rawRequest: http.IncomingMessage,
    rawResponse: http.ServerResponse
  ): Promise<void> {
    const method = (rawRequest.method ?? "GET").toUpperCase();
    const { path } = decodeRequestPath(rawRequest.url ?? "/");
    const headers = copyHeaders(rawRequest);

    let body: unknown;
    try {
      const raw = await readRequestBody(rawRequest);
      const parsed = parseJsonBodyOrNull(raw);
      if (!parsed.ok) {
        rawResponse.statusCode = 400;
        rawResponse.setHeader("Content-Type", "application/json");
        rawResponse.end(
          safeJsonStringify({
            error: { code: "invalid_request", message: "Request body is not valid JSON." }
          })
        );
        return;
      }
      body = parsed.value;
    } catch (error) {
      rawResponse.statusCode = 400;
      rawResponse.setHeader("Content-Type", "application/json");
      rawResponse.end(
        safeJsonStringify({
          error: {
            code: "invalid_request",
            message: error instanceof Error ? error.message : "Request body could not be read."
          }
        })
      );
      return;
    }

    const routeRequest: GatewayRouteRequest = {
      method,
      path,
      headers,
      body
    };

    let routeResponse: GatewayRouteResponse;
    try {
      routeResponse = await config.routes.handle(routeRequest);
    } catch {
      rawResponse.statusCode = 500;
      rawResponse.setHeader("Content-Type", "application/json");
      rawResponse.end(
        safeJsonStringify({ error: { code: "internal_error", message: "Gateway request failed." } })
      );
      return;
    }

    applyHeaders(rawResponse, routeResponse.headers);

    if (isStreamingResponse(routeResponse)) {
      rawResponse.statusCode = routeResponse.status;
      try {
        await streamResponse(rawResponse, routeResponse);
      } catch {
        if (!rawResponse.writableEnded) {
          rawResponse.end();
        }
      }
      return;
    }

    writeJsonOrText(rawResponse, routeResponse.status, routeResponse.body);
  }

  return {
    async start(): Promise<AddressInfo> {
      if (server) {
        throw new Error("HTTP listener is already running.");
      }
      const httpServer = http.createServer((req, res) => {
        handleHttpRequest(req, res).catch(() => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
          }
          if (!res.writableEnded) {
            res.end(
              safeJsonStringify({ error: { code: "internal_error", message: "Gateway request failed." } })
            );
          }
        });
      });
      server = httpServer;

      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen({ host: bind.address, port: bind.port }, () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });

      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP listener could not resolve its address.");
      }
      return address;
    },
    async stop(): Promise<void> {
      if (!server) {
        return;
      }
      const closing = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        closing.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        closing.closeAllConnections?.();
      });
    }
  };
}
