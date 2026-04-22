import { type RuntimeConfiguration } from "../types/contracts";
import { installOutboundNetworkGuard } from "../types/network";
import { assertNoSecretLikeValues } from "./loader";

export type RuntimeBootStage =
  | "load_runtime_config"
  | "load_adapter_config"
  | "discover_tools"
  | "mount_memory"
  | "verify_memory_history"
  | "read_preferences"
  | "mark_runtime_ready";

export interface RuntimeBootDependencies<
  TAdapterConfig = unknown,
  TDiscoveredTools = unknown,
  TMemoryHandle = unknown,
  TPreferences = Record<string, unknown>
> {
  load_runtime_config(): Promise<RuntimeConfiguration>;
  load_adapter_config(runtime: RuntimeConfiguration): Promise<TAdapterConfig>;
  discover_tools(input: {
    runtime: RuntimeConfiguration;
    adapter_config: TAdapterConfig;
  }): Promise<TDiscoveredTools>;
  mount_memory(runtime: RuntimeConfiguration): Promise<TMemoryHandle>;
  verify_memory_history(input: {
    runtime: RuntimeConfiguration;
    memory: TMemoryHandle;
  }): Promise<void>;
  read_preferences(input: {
    runtime: RuntimeConfiguration;
    memory: TMemoryHandle;
  }): Promise<TPreferences>;
}

export interface RuntimeBootOptions<TAdapterConfig = unknown, TDiscoveredTools = unknown> {
  bind_address?: string;
  allow_non_local_bind?: boolean;
  assert_outbound_network_ready?: (input: {
    runtime: RuntimeConfiguration;
    adapter_config: TAdapterConfig;
    tools: TDiscoveredTools;
  }) => Promise<void> | void;
}

export interface RuntimeBootResult<
  TAdapterConfig = unknown,
  TDiscoveredTools = unknown,
  TMemoryHandle = unknown,
  TPreferences = Record<string, unknown>
> {
  ready: true;
  ready_at: string;
  bind_address: string;
  offline_mode: boolean;
  runtime_config: RuntimeConfiguration;
  adapter_config: TAdapterConfig;
  tools: TDiscoveredTools;
  memory: TMemoryHandle;
  preferences: TPreferences;
}

const DEFAULT_BIND_ADDRESS = "127.0.0.1";
const OFFLINE_PROVIDER_SET = new Set(["mock", "local"]);

function nowIso(): string {
  return new Date().toISOString();
}

function toProvider(value: string): string {
  return value.trim().toLowerCase();
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveBindAddress(bindAddress: string | undefined, allowNonLocalBind: boolean): string {
  const normalized = (bindAddress ?? DEFAULT_BIND_ADDRESS).trim();
  const asAddress = normalized.toLowerCase() === "localhost" ? DEFAULT_BIND_ADDRESS : normalized;
  if (asAddress.length === 0) {
    return DEFAULT_BIND_ADDRESS;
  }

  if (!allowNonLocalBind && asAddress !== DEFAULT_BIND_ADDRESS) {
    throw new Error(`Runtime bind address must default to localhost (${DEFAULT_BIND_ADDRESS}).`);
  }

  return asAddress;
}

function assertDistinctConfigurationLayers(
  runtime: RuntimeConfiguration,
  adapterConfig: unknown,
  preferences: unknown
): void {
  if (isObjectLike(adapterConfig) && Object.is(adapterConfig, runtime)) {
    throw new Error("Adapter configuration must be distinct from runtime configuration.");
  }
  if (isObjectLike(preferences) && Object.is(preferences, runtime)) {
    throw new Error("Memory preferences must be distinct from runtime configuration.");
  }
  if (isObjectLike(adapterConfig) && isObjectLike(preferences) && Object.is(adapterConfig, preferences)) {
    throw new Error("Memory preferences must be distinct from adapter configuration.");
  }
}

function toRuntimeBootError(stage: RuntimeBootStage, cause: unknown): RuntimeBootError {
  if (cause instanceof RuntimeBootError) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RuntimeBootError(stage, message, cause);
}

export class RuntimeBootError extends Error {
  readonly stage: RuntimeBootStage;
  readonly ready: false;
  readonly cause: unknown;

  constructor(stage: RuntimeBootStage, message: string, cause: unknown) {
    super(`Runtime boot failed during ${stage}: ${message}`);
    this.name = "RuntimeBootError";
    this.stage = stage;
    this.ready = false;
    this.cause = cause;
  }
}

export async function bootRuntime<
  TAdapterConfig = unknown,
  TDiscoveredTools = unknown,
  TMemoryHandle = unknown,
  TPreferences = Record<string, unknown>
>(
  dependencies: RuntimeBootDependencies<TAdapterConfig, TDiscoveredTools, TMemoryHandle, TPreferences>,
  options: RuntimeBootOptions<TAdapterConfig, TDiscoveredTools> = {}
): Promise<RuntimeBootResult<TAdapterConfig, TDiscoveredTools, TMemoryHandle, TPreferences>> {
  let stage: RuntimeBootStage = "load_runtime_config";
  installOutboundNetworkGuard();

  try {
    const runtime = await dependencies.load_runtime_config();

    stage = "load_adapter_config";
    const adapterConfig = await dependencies.load_adapter_config(runtime);

    stage = "discover_tools";
    const tools = await dependencies.discover_tools({
      runtime,
      adapter_config: adapterConfig
    });

    const provider = toProvider(runtime.provider_adapter);
    const offlineMode = OFFLINE_PROVIDER_SET.has(provider);
    if (!offlineMode && options.assert_outbound_network_ready) {
      await options.assert_outbound_network_ready({
        runtime,
        adapter_config: adapterConfig,
        tools
      });
    }

    stage = "mount_memory";
    const memory = await dependencies.mount_memory(runtime);

    stage = "verify_memory_history";
    await dependencies.verify_memory_history({
      runtime,
      memory
    });

    stage = "read_preferences";
    const preferences = await dependencies.read_preferences({
      runtime,
      memory
    });
    assertNoSecretLikeValues(preferences, "Memory preferences");
    assertDistinctConfigurationLayers(runtime, adapterConfig, preferences);

    stage = "mark_runtime_ready";
    return {
      ready: true,
      ready_at: nowIso(),
      bind_address: resolveBindAddress(options.bind_address, Boolean(options.allow_non_local_bind)),
      offline_mode: offlineMode,
      runtime_config: runtime,
      adapter_config: adapterConfig,
      tools,
      memory,
      preferences
    };
  } catch (error) {
    throw toRuntimeBootError(stage, error);
  }
}
