declare const require: (id: string) => any;

const path = require("path") as {
  resolve(...parts: string[]): string;
};

import { type RuntimeConfiguration } from "../types/contracts";

type EnvironmentMap = Record<string, string | undefined>;

export interface RuntimeConfigurationScope {
  memory_root?: string;
  provider_adapter?: string;
  auth_mode?: string;
  tool_sources?: string[] | string;
  [key: string]: unknown;
}

export interface RuntimeConfigurationByEnvironment {
  default?: RuntimeConfigurationScope;
  [environment: string]: RuntimeConfigurationScope | undefined;
}

export interface RuntimeConfigurationLoaderOptions {
  environment?: string;
  runtime_config?: RuntimeConfigurationByEnvironment;
  env?: EnvironmentMap;
  cwd?: string;
}

const DEFAULT_ENVIRONMENT = "development";
const DEFAULT_PROVIDER_ADAPTER = "mock";
const DEFAULT_AUTH_MODE = "enforced";
const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(secret|token|password|credential|api[_-]?key|private[_-]?key)([_-]|$)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{16,}/,
  /AIza[0-9A-Za-z\-_]{20,}/
];

function getProcessLike(): { env?: EnvironmentMap; cwd?: () => string } {
  const candidate = globalThis as {
    process?: { env?: EnvironmentMap; cwd?: () => string };
  };
  return candidate.process ?? {};
}

function getDefaultEnv(): EnvironmentMap {
  return getProcessLike().env ?? {};
}

function getDefaultCwd(): string {
  const cwd = getProcessLike().cwd;
  if (typeof cwd === "function") {
    return cwd();
  }
  return ".";
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEnvironment(value: string | undefined): string {
  const normalized = toTrimmedString(value)?.toLowerCase();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_ENVIRONMENT;
}

function toScopedEnvPrefix(environment: string): string {
  return environment.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
}

function readEnvOverride(
  env: EnvironmentMap,
  environment: string,
  key: "MEMORY_ROOT" | "PROVIDER_ADAPTER" | "AUTH_MODE" | "TOOL_SOURCES"
): string | undefined {
  const scopedKey = `${toScopedEnvPrefix(environment)}_${key}`;
  const candidates = [scopedKey, `RUNTIME_${key}`, key];
  for (const candidate of candidates) {
    const value = toTrimmedString(env[candidate]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeToolSources(value: unknown): string[] {
  const rawValues: string[] = [];

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        rawValues.push(entry);
      }
    }
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === "string") {
              rawValues.push(entry);
            }
          }
        }
      } catch {
        // fall back to comma-separated parsing below
      }
    }

    if (rawValues.length === 0) {
      for (const entry of trimmed.split(",")) {
        rawValues.push(entry);
      }
    }
  }

  const deduped = new Set<string>();
  for (const candidate of rawValues) {
    const normalized = candidate.trim();
    if (normalized.length > 0) {
      deduped.add(normalized);
    }
  }

  return [...deduped];
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function collectSecretLocations(
  value: unknown,
  pointer: string,
  output: string[],
  seen: Set<unknown>
): void {
  if (typeof value === "string" && looksLikeSecretValue(value)) {
    output.push(pointer);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectSecretLocations(value[index], `${pointer}[${index}]`, output, seen);
    }
    return;
  }

  if (!isObjectLike(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const nextPointer = `${pointer}.${key}`;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output.push(nextPointer);
    }
    collectSecretLocations(nested, nextPointer, output, seen);
  }
}

export function assertNoSecretLikeValues(value: unknown, label: string): void {
  const findings: string[] = [];
  collectSecretLocations(value, "$", findings, new Set<unknown>());
  if (findings.length > 0) {
    const unique = [...new Set(findings)];
    throw new Error(`${label} contains secret-looking values at: ${unique.join(", ")}`);
  }
}

function resolveScope(
  config: RuntimeConfigurationByEnvironment | undefined,
  environment: string
): RuntimeConfigurationScope {
  const defaults = config?.default ?? {};
  const scoped = config?.[environment] ?? {};
  return {
    ...defaults,
    ...scoped
  };
}

export function loadRuntimeConfiguration(
  options: RuntimeConfigurationLoaderOptions = {}
): RuntimeConfiguration {
  const env = options.env ?? getDefaultEnv();
  const environment = normalizeEnvironment(
    options.environment ?? toTrimmedString(env.RUNTIME_ENV) ?? toTrimmedString(env.NODE_ENV)
  );
  const cwd = options.cwd ?? getDefaultCwd();

  if (options.runtime_config) {
    assertNoSecretLikeValues(options.runtime_config, "Tracked runtime configuration");
  }

  const scope = resolveScope(options.runtime_config, environment);
  const memoryRootOverride = readEnvOverride(env, environment, "MEMORY_ROOT");
  const providerOverride = readEnvOverride(env, environment, "PROVIDER_ADAPTER");
  const authModeOverride = readEnvOverride(env, environment, "AUTH_MODE");
  const toolSourcesOverride = readEnvOverride(env, environment, "TOOL_SOURCES");

  const memoryRoot =
    memoryRootOverride ??
    toTrimmedString(scope.memory_root) ??
    path.resolve(cwd, ".runtime-memory", environment);
  const providerAdapter =
    (providerOverride ?? toTrimmedString(scope.provider_adapter) ?? DEFAULT_PROVIDER_ADAPTER).toLowerCase();
  const authMode = (authModeOverride ?? toTrimmedString(scope.auth_mode) ?? DEFAULT_AUTH_MODE).toLowerCase();
  const toolSources = normalizeToolSources(toolSourcesOverride ?? scope.tool_sources ?? []);

  if (memoryRoot.trim().length === 0) {
    throw new Error("Runtime configuration memory_root must be non-empty.");
  }
  if (providerAdapter.trim().length === 0) {
    throw new Error("Runtime configuration provider_adapter must be non-empty.");
  }
  if (authMode.trim().length === 0) {
    throw new Error("Runtime configuration auth_mode must be non-empty.");
  }

  return {
    memory_root: memoryRoot,
    provider_adapter: providerAdapter,
    auth_mode: authMode,
    tool_sources: toolSources
  };
}
