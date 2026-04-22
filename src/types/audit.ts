export type AuditOutcome = "allow" | "deny" | "success" | "failure";

export interface StructuredAuditEntry {
  category: string;
  action: string;
  outcome: AuditOutcome;
  actor_id?: string;
  correlation_id?: string;
  target?: string;
  details?: Record<string, unknown>;
  diagnostics?: unknown;
}

export interface StructuredAuditRecord extends StructuredAuditEntry {
  timestamp: string;
}

export interface AuditLogger {
  log(entry: StructuredAuditEntry): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getProcessLike(): { stderr?: { write(message: string): unknown } } {
  const candidate = globalThis as {
    process?: { stderr?: { write(message: string): unknown } };
  };
  return candidate.process ?? {};
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      category: "audit",
      action: "serialization_failed",
      outcome: "failure",
      timestamp: nowIso()
    });
  }
}

function writeLine(line: string): void {
  const stderr = getProcessLike().stderr;
  if (stderr && typeof stderr.write === "function") {
    stderr.write(line);
  }
}

export function createAuditLogger(): AuditLogger {
  return {
    log(entry: StructuredAuditEntry): void {
      const record: StructuredAuditRecord = {
        timestamp: nowIso(),
        ...entry
      };
      writeLine(`${safeJson(record)}\n`);
    }
  };
}

const DEFAULT_AUDIT_LOGGER = createAuditLogger();

export function emitAuditLog(entry: StructuredAuditEntry): void {
  DEFAULT_AUDIT_LOGGER.log(entry);
}
