import {
  type EngineRequestMetadata,
  type ToolCall,
  type ToolDefinition
} from "../types/contracts";
import { createApprovalGate, type ApprovalEvaluation, type ApprovalGate } from "../types/approval";
import { emitAuditLog } from "../types/audit";
import { toErrorDiagnostics } from "../types/safety";

export interface ToolExecutionContext {
  metadata: EngineRequestMetadata;
}

export type ToolHandler = (
  input: unknown,
  context: ToolExecutionContext
) => Promise<unknown> | unknown;

export interface ToolExecutionSuccess {
  ok: true;
  tool_call: ToolCall;
  output: unknown;
  content: string;
  approval_request?: ApprovalEvaluation["approval_request"];
  approval_result?: ApprovalEvaluation["approval_result"];
}

export interface ToolExecutionFailure {
  ok: false;
  tool_call: ToolCall;
  message: string;
  failure_code?: "tool_not_allowed" | "scope_violation" | "unauthorized" | "approval_denied" | "execution_failed";
  approval_request?: ApprovalEvaluation["approval_request"];
  approval_result?: ApprovalEvaluation["approval_result"];
}

export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure;

export interface ToolExecutor {
  executeMany(toolCalls: ToolCall[], context: ToolExecutionContext): Promise<ToolExecutionResult[]>;
}

export interface ToolExecutorConfig {
  tools: ToolDefinition[];
  handlers?: Record<string, ToolHandler>;
  allowed_tool_sources?: string[];
  approval_gate?: ApprovalGate;
}

interface RegisteredTool {
  name: string;
  source?: string;
  mutates_state: boolean;
  required_permissions: string[];
}

function parseToolArguments(raw: string): unknown {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Tool call arguments must be valid JSON.");
  }
}

function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function configuredToolNames(tools: ToolDefinition[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (typeof name === "string" && name.trim().length > 0) {
      names.add(name.trim());
    }
  }
  return names;
}

function normalizeSource(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function inferSourceFromToolName(name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const match = /^([a-z0-9]+)[_:-]/.exec(normalized);
  if (match && match[1]) {
    return match[1];
  }
  return undefined;
}

function normalizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const values = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (normalized.length > 0) {
      values.add(normalized);
    }
  }
  return [...values];
}

function inferMutatesState(tool: ToolDefinition): boolean {
  if (tool.mutates_state === true) {
    return true;
  }

  const toolName = tool.function.name.toLowerCase();
  if (/(write|edit|delete|update|create|save|remove)/.test(toolName)) {
    return true;
  }

  return normalizePermissions(tool.required_permissions).some((permission) => /:(write|edit|delete)\b/.test(permission));
}

function buildRegistry(tools: ToolDefinition[]): Map<string, RegisteredTool> {
  const registry = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    const name = tool?.function?.name?.trim();
    if (!name) {
      continue;
    }
    registry.set(name, {
      name,
      source: normalizeSource(tool.source) ?? inferSourceFromToolName(name),
      mutates_state: inferMutatesState(tool),
      required_permissions: normalizePermissions(tool.required_permissions)
    });
  }
  return registry;
}

function normalizeSourceList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values = new Set<string>();
  for (const entry of value) {
    const source = normalizeSource(entry);
    if (source) {
      values.add(source);
    }
  }
  return [...values];
}

function parseActorPermissions(value: unknown): Set<string> {
  const values = new Set<string>();

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        values.add(entry.trim());
      }
    }
    return values;
  }

  if (typeof value !== "string") {
    return values;
  }

  for (const entry of value.split(",")) {
    const normalized = entry.trim();
    if (normalized.length > 0) {
      values.add(normalized);
    }
  }
  return values;
}

function hasPermission(actorPermissions: Set<string>, permission: string): boolean {
  if (actorPermissions.has("*") || actorPermissions.has(permission)) {
    return true;
  }

  const split = permission.split(":");
  if (split.length === 2) {
    const [resource] = split;
    if (actorPermissions.has(`${resource}:*`)) {
      return true;
    }
  }

  return false;
}

function canAccessTool(requiredPermissions: string[], actorPermissions: Set<string>): boolean {
  if (requiredPermissions.length === 0) {
    return true;
  }
  if (actorPermissions.size === 0) {
    return false;
  }
  return requiredPermissions.some((permission) => hasPermission(actorPermissions, permission));
}

function withinAllowedSources(source: string | undefined, allowedSources: string[]): boolean {
  if (allowedSources.length === 0) {
    return true;
  }
  if (!source) {
    return false;
  }
  return allowedSources.includes(source);
}

function resolveAllowedSources(configuredSources: string[], metadata: EngineRequestMetadata): string[] {
  const metadataSources = normalizeSourceList(metadata.allowed_tool_sources);
  if (configuredSources.length === 0) {
    return metadataSources;
  }
  if (metadataSources.length === 0) {
    return configuredSources;
  }
  const metadataSet = new Set(metadataSources);
  return configuredSources.filter((source) => metadataSet.has(source));
}

function toToolFailure(
  toolCall: ToolCall,
  failureCode: ToolExecutionFailure["failure_code"] = "execution_failed",
  approval?: ApprovalEvaluation
): ToolExecutionFailure {
  return {
    ok: false,
    tool_call: toolCall,
    message: "Tool execution failed.",
    failure_code: failureCode,
    ...(approval ? approval : {})
  };
}

export function createToolExecutor(config: ToolExecutorConfig): ToolExecutor {
  const handlers = config.handlers ?? {};
  const allowedToolNames = configuredToolNames(config.tools);
  const toolRegistry = buildRegistry(config.tools);
  const configuredAllowedSources = normalizeSourceList(config.allowed_tool_sources);
  const approvalGate = config.approval_gate ?? createApprovalGate();

  return {
    async executeMany(toolCalls: ToolCall[], context: ToolExecutionContext): Promise<ToolExecutionResult[]> {
      const actorPermissions = parseActorPermissions(context.metadata.actor_permissions);
      const allowedSources = resolveAllowedSources(configuredAllowedSources, context.metadata);

      const jobs = toolCalls.map(async (toolCall): Promise<ToolExecutionResult> => {
        const toolName = toolCall.function.name;
        const registeredTool = toolRegistry.get(toolName);

        emitAuditLog({
          category: "tool",
          action: "tool_call",
          outcome: "success",
          target: toolName,
          correlation_id: context.metadata.correlation_id,
          actor_id: typeof context.metadata.actor_id === "string" ? context.metadata.actor_id : undefined,
          details: {
            stage: "received"
          }
        });

        if (!allowedToolNames.has(toolName)) {
          emitAuditLog({
            category: "tool",
            action: "tool_call",
            outcome: "deny",
            target: toolName,
            correlation_id: context.metadata.correlation_id,
            actor_id: typeof context.metadata.actor_id === "string" ? context.metadata.actor_id : undefined,
            details: {
              reason: "tool_not_allowed"
            }
          });
          return toToolFailure(toolCall, "tool_not_allowed");
        }

        if (!withinAllowedSources(registeredTool?.source, allowedSources)) {
          emitAuditLog({
            category: "tool",
            action: "tool_scope_check",
            outcome: "deny",
            target: toolName,
            correlation_id: context.metadata.correlation_id,
            actor_id: typeof context.metadata.actor_id === "string" ? context.metadata.actor_id : undefined,
            details: {
              source: registeredTool?.source,
              allowed_sources: allowedSources
            }
          });
          return toToolFailure(toolCall, "scope_violation");
        }

        if (!canAccessTool(registeredTool?.required_permissions ?? [], actorPermissions)) {
          emitAuditLog({
            category: "tool",
            action: "tool_authorization_check",
            outcome: "deny",
            target: toolName,
            correlation_id: context.metadata.correlation_id,
            actor_id: typeof context.metadata.actor_id === "string" ? context.metadata.actor_id : undefined,
            details: {
              required_permissions: registeredTool?.required_permissions ?? []
            }
          });
          return toToolFailure(toolCall, "unauthorized");
        }

        const handler = handlers[toolName];
        if (typeof handler !== "function") {
          return toToolFailure(toolCall, "tool_not_allowed");
        }

        let approval: ApprovalEvaluation | undefined;
        if (registeredTool?.mutates_state) {
          approval = await approvalGate.evaluate({
            action: "tool.execute.write",
            target: toolName,
            reason: `Tool ${toolName} performs a write operation.`,
            metadata: {
              tool_source: registeredTool.source ?? null,
              correlation_id: context.metadata.correlation_id
            }
          });

          emitAuditLog({
            category: "tool",
            action: "approval_request",
            outcome: "success",
            target: toolName,
            correlation_id: context.metadata.correlation_id,
            actor_id: typeof context.metadata.actor_id === "string" ? context.metadata.actor_id : undefined,
            details: {
              approval_id: approval.approval_request.approval_id,
              action: approval.approval_request.action,
              reason: approval.approval_request.reason
            }
          });

          emitAuditLog({
            category: "tool",
            action: "approval_result",
            outcome: approval.approval_result.approved ? "allow" : "deny",
            target: toolName,
            correlation_id: context.metadata.correlation_id,
            actor_id: typeof context.metadata.actor_id === "string" ? context.metadata.actor_id : undefined,
            details: {
              approval_id: approval.approval_result.approval_id,
              approved: approval.approval_result.approved,
              reason: approval.approval_result.reason
            }
          });

          if (!approval.approval_result.approved) {
            return toToolFailure(toolCall, "approval_denied", approval);
          }
        }

        try {
          const input = parseToolArguments(toolCall.function.arguments);
          const output = await handler(input, context);
          emitAuditLog({
            category: "tool",
            action: "tool_call",
            outcome: "success",
            target: toolName,
            correlation_id: context.metadata.correlation_id,
            actor_id: typeof context.metadata.actor_id === "string" ? context.metadata.actor_id : undefined,
            details: {
              stage: "completed"
            }
          });
          return {
            ok: true,
            tool_call: toolCall,
            output,
            content: serializeToolOutput(output),
            ...(approval ? approval : {})
          };
        } catch (error) {
          emitAuditLog({
            category: "tool",
            action: "tool_call",
            outcome: "failure",
            target: toolName,
            correlation_id: context.metadata.correlation_id,
            actor_id: typeof context.metadata.actor_id === "string" ? context.metadata.actor_id : undefined,
            diagnostics: toErrorDiagnostics(error)
          });
          return toToolFailure(toolCall, "execution_failed", approval);
        }
      });

      return Promise.all(jobs);
    }
  };
}
