const SECRET_PATTERN = /(token|secret|password|api[_-]?key|sk-[a-z0-9]{6,})/i;
const PATH_PATTERN = /([A-Za-z]:\\|\/[A-Za-z0-9._-]+)/;
const STACK_PATTERN = /\bat\b.+:\d+:\d+/i;

export interface ErrorDiagnostics {
  name: string;
  message: string;
  stack?: string;
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isClientSafe(message: string): boolean {
  if (message.length === 0 || message.length > 200) {
    return false;
  }
  if (/[\r\n]/.test(message)) {
    return false;
  }
  if (SECRET_PATTERN.test(message)) {
    return false;
  }
  if (PATH_PATTERN.test(message)) {
    return false;
  }
  if (STACK_PATTERN.test(message)) {
    return false;
  }
  return true;
}

export function toSafeClientMessage(raw: unknown, fallback: string): string {
  const candidate = toTrimmedString(raw);
  if (!candidate) {
    return fallback;
  }
  return isClientSafe(candidate) ? candidate : fallback;
}

export function toErrorDiagnostics(error: unknown): ErrorDiagnostics {
  if (error instanceof Error) {
    const diagnostics: ErrorDiagnostics = {
      name: error.name,
      message: error.message
    };
    if (typeof error.stack === "string" && error.stack.trim().length > 0) {
      diagnostics.stack = error.stack;
    }
    return diagnostics;
  }

  return {
    name: "Error",
    message: toTrimmedString(error) || String(error)
  };
}
