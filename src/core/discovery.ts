import { ModelCapabilities } from './modelCatalog';

/** API protocol a custom endpoint speaks. Mirrors VS Code's `apiType`. */
export type ApiType = 'chat-completions' | 'responses' | 'messages';

export interface DiscoveredModel extends ModelCapabilities {
  id: string;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  /** Non-fatal notes, e.g. an endpoint that returned no capability metadata. */
  warnings: string[];
}

export interface DiscoverOptions {
  baseUrl: string;
  apiKey: string;
  apiType?: ApiType;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/** Strip a trailing slash and any API path the user may have pasted in. */
export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  url = url.replace(/\/(chat\/completions|responses|messages)$/, '');
  return url;
}

/** Build the model-list URL for a base URL, tolerating an explicit `/v1`. */
export function modelsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * New API's public pricing endpoint. It needs no API key when the instance has
 * `pricing.requireAuth = false`, and unlike `/v1/models` it carries capability
 * tags and the supported endpoint types.
 */
export function pricingUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl).replace(/\/v\d+$/, '');
  return `${base}/api/pricing`;
}

/** Map a New API capability tag onto our capability shape. */
export function parseTags(tags: string): ModelCapabilities {
  const caps: ModelCapabilities = {};
  const list = tags
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  for (const tag of list) {
    if (tag === 'tools' || tag === 'function calling' || tag === 'tool calling') {
      caps.toolCalling = true;
    } else if (tag === 'vision' || tag === 'multimodal') {
      caps.vision = true;
    } else if (tag === 'reasoning' || tag === 'thinking') {
      caps.thinking = true;
    } else {
      // context-size tags look like "1M", "128K", "200k"
      const size = /^(\d+(?:\.\d+)?)\s*([mk])$/.exec(tag);
      if (size) {
        const n = Number(size[1]);
        caps.contextWindow = Math.round(n * (size[2] === 'm' ? 1_000_000 : 1_000));
      }
    }
  }
  return caps;
}

/**
 * Fetch the model list from New API's public pricing endpoint. Used as a
 * fallback when `/v1/models` rejects an anonymous request.
 *
 * Only `model_name` and `tags` are read. The endpoint's price fields
 * (`model_ratio`, `model_price`, `completion_ratio`, `quota_type`, ...) are
 * deliberately ignored: they are gateway billing multipliers, not real prices,
 * and `chatLanguageModels.json` has no field to hold them anyway.
 */
export async function discoverFromPricing(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const url = pricingUrl(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`公开模型列表请求失败 (HTTP ${res.status})`);
  }
  const payload = (await res.json()) as { data?: unknown };
  if (!Array.isArray(payload.data)) {
    throw new Error('公开模型列表格式无法识别');
  }

  const models: DiscoveredModel[] = [];
  let sawCapabilities = false;
  for (const raw of payload.data) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.model_name === 'string' ? entry.model_name : undefined;
    if (!id) {
      continue;
    }
    const caps = typeof entry.tags === 'string' ? parseTags(entry.tags) : {};
    if (Object.keys(caps).length > 0) {
      sawCapabilities = true;
    }
    models.push({ id, ...caps });
  }
  models.sort((a, b) => (a.id < b.id ? -1 : 1));

  const warnings: string[] = [];
  if (!sawCapabilities && models.length > 0) {
    warnings.push('公开模型列表未提供能力标签，能力值将来自在线模型表或推测值');
  }
  return { models, warnings };
}

/** Auth headers per API protocol. */
export function authHeaders(apiKey: string, apiType: ApiType = 'chat-completions'): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!apiKey) {
    return headers;
  }
  if (apiType === 'messages') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Read capability hints from non-standard fields some gateways add to
 * `/v1/models` (OpenRouter, LiteLLM, New API). Returns only what it finds.
 */
function endpointCapabilities(entry: Record<string, unknown>): ModelCapabilities {
  const caps: ModelCapabilities = {};

  // OpenRouter: context_length, architecture.input_modalities, supported_parameters
  const contextLength = asNumber(entry.context_length);
  if (contextLength) {
    caps.contextWindow = contextLength;
  }
  const architecture = entry.architecture as { input_modalities?: unknown } | undefined;
  if (Array.isArray(architecture?.input_modalities)) {
    caps.vision = (architecture!.input_modalities as string[]).includes('image');
  }
  const supported = entry.supported_parameters;
  if (Array.isArray(supported)) {
    caps.toolCalling = (supported as string[]).includes('tools');
  }

  // LiteLLM /v1/model/info style payloads
  const info = entry.model_info as Record<string, unknown> | undefined;
  if (info) {
    const maxInput = asNumber(info.max_input_tokens);
    const maxOutput = asNumber(info.max_output_tokens);
    if (maxInput && maxOutput) {
      caps.contextWindow = maxInput + maxOutput;
    }
    if (typeof info.supports_vision === 'boolean') {
      caps.vision = info.supports_vision;
    }
    if (typeof info.supports_function_calling === 'boolean') {
      caps.toolCalling = info.supports_function_calling;
    }
  }

  // New API's supported_endpoint_types carries the protocol, not capabilities;
  // see inferApiType() for that.
  if (typeof entry.name === 'string' && entry.name) {
    caps.name = entry.name;
  }
  return caps;
}

/** Infer the API protocol from New API's `supported_endpoint_types`. */
export function inferApiType(entry: Record<string, unknown>): ApiType | undefined {
  const endpoints = entry.supported_endpoint_types;
  if (!Array.isArray(endpoints)) {
    return undefined;
  }
  const list = endpoints as string[];
  if (list.includes('anthropic')) {
    return 'messages';
  }
  if (list.includes('openai-response')) {
    return 'responses';
  }
  if (list.includes('openai')) {
    return 'chat-completions';
  }
  return undefined;
}

/** Merge capability hints from `extra` into `models` without overwriting known values. */
export function enrichModels(models: DiscoveredModel[], extra: DiscoveredModel[]): number {
  const byId = new Map(extra.map((m) => [m.id, m]));
  let enriched = 0;
  for (const model of models) {
    const other = byId.get(model.id);
    if (!other) {
      continue;
    }
    for (const key of ['toolCalling', 'vision', 'thinking', 'contextWindow', 'maxOutputTokens'] as const) {
      if (model[key] === undefined && other[key] !== undefined) {
        (model as unknown as Record<string, unknown>)[key] = other[key];
        enriched += 1;
      }
    }
  }
  return enriched;
}

/**
 * Fetch the model list from an OpenAI-compatible endpoint. Accepts both the
 * `{ data: [...] }` and `{ models: [...] }` shapes.
 */
export async function discoverModels(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const url = modelsUrl(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: 'GET',
    headers: authHeaders(opts.apiKey, opts.apiType),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`模型列表请求失败 (HTTP ${res.status})，请检查 Base URL 与 API Key`);
  }
  const payload = (await res.json()) as { data?: unknown; models?: unknown };
  const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : undefined;
  if (!list) {
    throw new Error('端点返回的模型列表格式无法识别（既没有 data 也没有 models 数组）');
  }

  const models: DiscoveredModel[] = [];
  let sawCapabilities = false;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : undefined;
    if (!id) {
      continue;
    }
    const caps = endpointCapabilities(entry);
    if (Object.keys(caps).length > 0) {
      sawCapabilities = true;
    }
    models.push({ id, ...caps });
  }
  models.sort((a, b) => (a.id < b.id ? -1 : 1));

  const warnings: string[] = [];
  if (!sawCapabilities && models.length > 0) {
    warnings.push('端点未返回能力元数据，工具调用/视觉/上下文长度将来自在线模型表或推测值');
  }
  return { models, warnings };
}
