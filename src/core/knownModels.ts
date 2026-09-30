import { CapabilitySource, lookupCatalog, ModelCapabilities, ResolvedCapabilities } from './modelCatalog';
import { DiscoveredModel } from './discovery';

/** Fallback values used when neither the catalog nor the endpoint knows. */
export const GUESS_DEFAULTS = {
  toolCalling: true,
  vision: false,
  contextWindow: 128_000,
  maxOutputTokens: 16_000,
} as const;

/** Overridable subset of the guess defaults, from user settings. */
export interface GuessOverrides {
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Merge capability sources for one model. Precedence, highest first:
 *   1. endpoint extension fields (the gateway knows what it actually serves)
 *   2. the online catalog (models.dev)
 *   3. heuristic defaults
 * Every field records where its value came from.
 */
export function resolveCapabilities(
  model: DiscoveredModel,
  catalog: Record<string, ModelCapabilities>,
  overrides: GuessOverrides = {}
): ResolvedCapabilities {
  const fromCatalog = lookupCatalog(catalog, model.id) ?? {};
  const sources: ResolvedCapabilities['sources'] = {};
  const guessContext = overrides.contextWindow ?? GUESS_DEFAULTS.contextWindow;
  const guessOutput = overrides.maxOutputTokens ?? GUESS_DEFAULTS.maxOutputTokens;

  /** Pick the first defined value and record where it came from. */
  const pick = <T>(
    key: keyof ModelCapabilities,
    endpointValue: T | undefined,
    catalogValue: T | undefined,
    fallback?: T
  ): T | undefined => {
    if (endpointValue !== undefined) {
      sources[key] = 'endpoint';
      return endpointValue;
    }
    if (catalogValue !== undefined) {
      sources[key] = 'catalog';
      return catalogValue;
    }
    if (fallback !== undefined) {
      sources[key] = 'guess';
      return fallback;
    }
    return undefined;
  };

  const out: ResolvedCapabilities = {
    sources,
    name: pick('name', model.name, fromCatalog.name, model.id),
    toolCalling: pick('toolCalling', model.toolCalling, fromCatalog.toolCalling, GUESS_DEFAULTS.toolCalling),
    vision: pick('vision', model.vision, fromCatalog.vision, GUESS_DEFAULTS.vision),
    contextWindow: pick('contextWindow', model.contextWindow, fromCatalog.contextWindow, guessContext),
    maxOutputTokens: pick('maxOutputTokens', model.maxOutputTokens, fromCatalog.maxOutputTokens, guessOutput),
    thinking: pick('thinking', model.thinking, fromCatalog.thinking),
    supportsReasoningEffort: pick(
      'supportsReasoningEffort',
      model.supportsReasoningEffort,
      fromCatalog.supportsReasoningEffort
    ),
  };

  // never let the output budget exceed the context window
  if (out.contextWindow && out.maxOutputTokens && out.maxOutputTokens > out.contextWindow) {
    out.maxOutputTokens = out.contextWindow;
  }
  return out;
}

/** Resolve a whole discovered list, preserving order. */
export function resolveAll(
  models: DiscoveredModel[],
  catalog: Record<string, ModelCapabilities>,
  overrides: GuessOverrides = {}
): ResolvedCapabilities[] {
  return models.map((m) => resolveCapabilities(m, catalog, overrides));
}

/** Human-readable label for a capability source, for the panel UI. */
export const SOURCE_LABELS: Record<CapabilitySource, string> = {
  catalog: '在线表',
  endpoint: '端点',
  guess: '推测',
};
