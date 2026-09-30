import * as fs from 'fs';
import * as path from 'path';

/** Where a capability value came from, so the UI can show its provenance. */
export type CapabilitySource = 'catalog' | 'endpoint' | 'guess';

/** Capability fields we can fill in for a model. */
export interface ModelCapabilities {
  name?: string;
  toolCalling?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoningEffort?: string[];
  thinking?: boolean;
}

/** Capabilities plus a per-field provenance map. */
export interface ResolvedCapabilities extends ModelCapabilities {
  sources: Partial<Record<keyof ModelCapabilities, CapabilitySource>>;
}

export const CATALOG_URL = 'https://models.dev/api.json';
export const CATALOG_VERSION = 1;
/** Refresh the cached catalog after this long. */
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export interface CatalogCache {
  version: number;
  fetchedAt: string;
  models: Record<string, ModelCapabilities>;
}

/**
 * Normalize a model id for fuzzy lookup: drop a provider prefix, a `:variant`
 * suffix, and trailing `-latest` / `-preview` / date stamps.
 */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .trim()
    .replace(/^[a-z0-9_.-]+\//, '')
    .replace(/:(free|beta|latest|extended|thinking)$/, '')
    .replace(/-(latest|preview|beta|exp)$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Extract the reasoning effort levels a catalog entry advertises. */
function effortLevels(reasoningOptions: unknown): string[] | undefined {
  if (!Array.isArray(reasoningOptions)) {
    return undefined;
  }
  for (const option of reasoningOptions) {
    if (option && typeof option === 'object' && (option as { type?: string }).type === 'effort') {
      const values = (option as { values?: unknown }).values;
      if (Array.isArray(values) && values.every((v) => typeof v === 'string')) {
        return values as string[];
      }
    }
  }
  return undefined;
}

/** Map one models.dev model record onto our capability shape. */
function toCapabilities(model: Record<string, unknown>): ModelCapabilities {
  const modalities = (model.modalities ?? {}) as { input?: unknown };
  const input = Array.isArray(modalities.input) ? (modalities.input as string[]) : [];
  const limit = (model.limit ?? {}) as { context?: unknown; output?: unknown };
  const effort = effortLevels(model.reasoning_options);
  const caps: ModelCapabilities = {
    name: typeof model.name === 'string' ? model.name : undefined,
    toolCalling: asBool(model.tool_call),
    vision: input.includes('image'),
    contextWindow: asNumber(limit.context),
    maxOutputTokens: asNumber(limit.output),
    thinking: asBool(model.reasoning),
  };
  if (effort) {
    caps.supportsReasoningEffort = effort;
  }
  return caps;
}

/**
 * Aggregate the entries a model id has across providers.
 *
 * Gateways re-list the same model with inflated or missing numbers, so a plain
 * "take the max" is unreliable. Booleans use a majority vote and numbers use
 * the most frequently reported value, which tracks the real spec far better.
 */
function aggregate(entries: ModelCapabilities[]): ModelCapabilities {
  /**
   * Majority vote. On a tie the `tieBreak` wins: tool calling defaults to true
   * so agent mode stays usable, while vision defaults to false because sending
   * images to a non-vision model fails outright.
   */
  const majority = (
    pick: (c: ModelCapabilities) => boolean | undefined,
    tieBreak: boolean
  ): boolean | undefined => {
    const votes = entries.map(pick).filter((v): v is boolean => v !== undefined);
    if (votes.length === 0) {
      return undefined;
    }
    const yes = votes.filter(Boolean).length;
    if (yes * 2 === votes.length) {
      return tieBreak;
    }
    return yes * 2 > votes.length;
  };

  const mode = (pick: (c: ModelCapabilities) => number | undefined): number | undefined => {
    const counts = new Map<number, number>();
    for (const value of entries.map(pick)) {
      if (value !== undefined) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    let best: number | undefined;
    let bestCount = 0;
    for (const [value, count] of counts) {
      // tie-break toward the larger window
      if (count > bestCount || (count === bestCount && best !== undefined && value > best)) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  };

  const mostCommonName = (): string | undefined => {
    const counts = new Map<string, number>();
    for (const name of entries.map((c) => c.name)) {
      if (name) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [name, count] of counts) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    return best;
  };

  const mostCommonEffort = (): string[] | undefined => {
    const counts = new Map<string, { value: string[]; count: number }>();
    for (const effort of entries.map((c) => c.supportsReasoningEffort)) {
      if (effort?.length) {
        const key = effort.join(',');
        const seen = counts.get(key);
        counts.set(key, { value: effort, count: (seen?.count ?? 0) + 1 });
      }
    }
    let best: string[] | undefined;
    let bestCount = 0;
    for (const { value, count } of counts.values()) {
      if (count > bestCount || (count === bestCount && best !== undefined && value.length > best.length)) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  };

  const out: ModelCapabilities = {
    name: mostCommonName(),
    toolCalling: majority((c) => c.toolCalling, true),
    vision: majority((c) => c.vision, false),
    thinking: majority((c) => c.thinking, false),
    contextWindow: mode((c) => c.contextWindow),
    maxOutputTokens: mode((c) => c.maxOutputTokens),
    supportsReasoningEffort: mostCommonEffort(),
  };
  // an output budget larger than the window is always a listing artifact
  if (out.contextWindow && out.maxOutputTokens && out.maxOutputTokens > out.contextWindow) {
    out.maxOutputTokens = out.contextWindow;
  }
  return out;
}

/**
 * Build a slim `normalizedId -> capabilities` index from a models.dev payload.
 * Duplicate ids across providers are aggregated into one entry.
 */
export function buildCatalogIndex(raw: unknown): Record<string, ModelCapabilities> {
  const buckets: Record<string, ModelCapabilities[]> = {};
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  for (const provider of Object.values(raw as Record<string, unknown>)) {
    const models = (provider as { models?: unknown })?.models;
    if (!models || typeof models !== 'object') {
      continue;
    }
    for (const [id, model] of Object.entries(models as Record<string, unknown>)) {
      if (!model || typeof model !== 'object') {
        continue;
      }
      const key = normalizeModelId(id);
      if (!key) {
        continue;
      }
      (buckets[key] ??= []).push(toCapabilities(model as Record<string, unknown>));
    }
  }
  const index: Record<string, ModelCapabilities> = {};
  for (const [key, entries] of Object.entries(buckets)) {
    index[key] = aggregate(entries);
  }
  return index;
}

/** Look up a model id, trying the exact normalized form first. */
export function lookupCatalog(
  index: Record<string, ModelCapabilities>,
  modelId: string
): ModelCapabilities | undefined {
  const key = normalizeModelId(modelId);
  if (!key) {
    return undefined;
  }
  const direct = index[key];
  if (direct) {
    return direct;
  }
  // tolerate a trailing size/version qualifier the catalog spells differently
  const stem = key.replace(/-(flash|mini|nano|turbo|pro|max|plus|air)$/, '');
  return stem !== key ? index[stem] : undefined;
}

export function readCatalogCache(cacheFile: string): CatalogCache | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CatalogCache;
    if (parsed?.version !== CATALOG_VERSION || !parsed.models) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeCatalogCache(cacheFile: string, models: Record<string, ModelCapabilities>): void {
  const cache: CatalogCache = {
    version: CATALOG_VERSION,
    fetchedAt: new Date().toISOString(),
    models,
  };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
}

export function isCacheStale(cache: CatalogCache, maxAgeMs = CATALOG_MAX_AGE_MS): boolean {
  const age = Date.now() - new Date(cache.fetchedAt).getTime();
  return !Number.isFinite(age) || age > maxAgeMs;
}

export interface LoadCatalogOptions {
  cacheFile: string;
  maxAgeMs?: number;
  /** Override the catalog endpoint. */
  catalogUrl?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Force a network refresh even when the cache is fresh. */
  forceRefresh?: boolean;
}

/**
 * Return the model catalog, preferring a fresh cache and falling back to a
 * stale cache when the network is unavailable. Never throws.
 */
export async function loadCatalog(opts: LoadCatalogOptions): Promise<Record<string, ModelCapabilities>> {
  const cached = readCatalogCache(opts.cacheFile);
  if (cached && !opts.forceRefresh && !isCacheStale(cached, opts.maxAgeMs)) {
    return cached.models;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(opts.catalogUrl || CATALOG_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      throw new Error(`catalog HTTP ${res.status}`);
    }
    const index = buildCatalogIndex(await res.json());
    if (Object.keys(index).length === 0) {
      throw new Error('catalog payload had no models');
    }
    writeCatalogCache(opts.cacheFile, index);
    return index;
  } catch {
    // offline or upstream failure: a stale catalog still beats guessing
    return cached?.models ?? {};
  }
}
