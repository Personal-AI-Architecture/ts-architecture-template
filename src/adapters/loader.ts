import { type ModelAdapter, type RuntimeConfiguration } from "../types/contracts";
import { createMockAdapter, type MockAdapterConfig } from "./mock";
import {
  createOpenAICompatibleAdapter,
  type OpenAICompatibleAdapterConfig
} from "./openai-compatible";

export interface AdapterLoaderConfig {
  runtime: RuntimeConfiguration;
  mock?: MockAdapterConfig;
  openai_compatible?: OpenAICompatibleAdapterConfig;
}

function normalizeProviderAdapter(value: string): string {
  return value.trim().toLowerCase();
}

function assertRuntimeConfig(runtime: RuntimeConfiguration): void {
  if (!runtime || typeof runtime.provider_adapter !== "string") {
    throw new Error("Runtime configuration must include provider_adapter.");
  }

  if (runtime.provider_adapter.trim().length === 0) {
    throw new Error("Runtime configuration provider_adapter must be non-empty.");
  }
}

export function loadModelAdapter(config: AdapterLoaderConfig): ModelAdapter {
  if (!config || !config.runtime) {
    throw new Error("Adapter loader requires runtime configuration.");
  }

  assertRuntimeConfig(config.runtime);
  const provider = normalizeProviderAdapter(config.runtime.provider_adapter);

  switch (provider) {
    case "mock":
    case "local":
      return createMockAdapter(config.mock);
    case "openai-compatible":
    case "openai":
      if (!config.openai_compatible) {
        throw new Error(
          "OpenAI-compatible adapter selected but openai_compatible configuration was not provided."
        );
      }
      return createOpenAICompatibleAdapter(config.openai_compatible);
    default:
      throw new Error(`Unsupported provider adapter: ${config.runtime.provider_adapter}`);
  }
}
