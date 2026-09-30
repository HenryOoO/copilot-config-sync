import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  authHeaders,
  discoverFromPricing,
  discoverModels,
  enrichModels,
  inferApiType,
  modelsUrl,
  normalizeBaseUrl,
  parseTags,
  pricingUrl,
} from '../core/discovery';
import { buildCatalogIndex } from '../core/modelCatalog';
import { DiscoveredModel } from '../core/discovery';
import { GUESS_DEFAULTS, resolveAll, resolveCapabilities } from '../core/knownModels';
import {
  applyDiscoveredModels,
  isSecretReference,
  mergeModels,
  readProviderGroups,
  staleModelIds,
  toModelEntry,
  writeProviderGroups,
} from '../core/lmProviders';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-discovery-'));
}

function fakeFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

// ── URL and header handling ────────────────────────────────────────────────

test('normalizeBaseUrl strips trailing slashes and API paths', () => {
  assert.strictEqual(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.strictEqual(normalizeBaseUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  assert.strictEqual(normalizeBaseUrl('https://api.example.com/v1/responses'), 'https://api.example.com/v1');
  assert.strictEqual(normalizeBaseUrl('  https://api.example.com  '), 'https://api.example.com');
});

test('modelsUrl appends /models without duplicating /v1', () => {
  assert.strictEqual(modelsUrl('https://api.example.com'), 'https://api.example.com/v1/models');
  assert.strictEqual(modelsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/models');
  assert.strictEqual(modelsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
});

test('authHeaders picks the right scheme per API type', () => {
  assert.strictEqual(authHeaders('k', 'chat-completions').Authorization, 'Bearer k');
  assert.strictEqual(authHeaders('k', 'responses').Authorization, 'Bearer k');
  const messages = authHeaders('k', 'messages');
  assert.strictEqual(messages['x-api-key'], 'k');
  assert.strictEqual(messages['anthropic-version'], '2023-06-01');
  assert.strictEqual(messages.Authorization, undefined);
  assert.strictEqual(authHeaders('').Authorization, undefined, 'no key means no auth header');
});

test('inferApiType reads New API supported_endpoint_types', () => {
  assert.strictEqual(inferApiType({ supported_endpoint_types: ['openai'] }), 'chat-completions');
  assert.strictEqual(inferApiType({ supported_endpoint_types: ['openai-response'] }), 'responses');
  assert.strictEqual(inferApiType({ supported_endpoint_types: ['anthropic'] }), 'messages');
  assert.strictEqual(inferApiType({ supported_endpoint_types: [] }), undefined);
  assert.strictEqual(inferApiType({}), undefined);
});

// ── Endpoint parsing ───────────────────────────────────────────────────────

test('discoverModels reads the OpenAI data[] shape', async () => {
  const result = await discoverModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: fakeFetch({ object: 'list', data: [{ id: 'b-model' }, { id: 'a-model' }] }),
  });
  assert.deepStrictEqual(result.models.map((m) => m.id), ['a-model', 'b-model'], 'sorted by id');
  assert.strictEqual(result.warnings.length, 1, 'warns that no capabilities came back');
});

test('discoverModels reads the models[] shape and skips malformed rows', async () => {
  const result = await discoverModels({
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: fakeFetch({ models: [{ id: 'ok' }, null, {}, { name: 'by-name' }] }),
  });
  assert.deepStrictEqual(result.models.map((m) => m.id), ['by-name', 'ok']);
});

test('discoverModels parses OpenRouter capability extensions', async () => {
  const result = await discoverModels({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
    fetchImpl: fakeFetch({
      data: [
        {
          id: 'vendor/model-x',
          name: 'Model X',
          context_length: 200_000,
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['tools', 'temperature'],
        },
      ],
    }),
  });
  const model = result.models[0];
  assert.strictEqual(model.contextWindow, 200_000);
  assert.strictEqual(model.vision, true);
  assert.strictEqual(model.toolCalling, true);
  assert.strictEqual(result.warnings.length, 0, 'no warning when capabilities were present');
});

test('discoverModels parses LiteLLM model_info extensions', async () => {
  const result = await discoverModels({
    baseUrl: 'https://litellm.example.com',
    apiKey: 'k',
    fetchImpl: fakeFetch({
      data: [
        {
          id: 'gpt-4o',
          model_info: {
            max_input_tokens: 128_000,
            max_output_tokens: 16_384,
            supports_vision: true,
            supports_function_calling: true,
          },
        },
      ],
    }),
  });
  const model = result.models[0];
  assert.strictEqual(model.contextWindow, 144_384, 'input + output');
  assert.strictEqual(model.vision, true);
  assert.strictEqual(model.toolCalling, true);
});

test('discoverModels surfaces HTTP failures with an actionable message', async () => {
  await assert.rejects(
    () => discoverModels({ baseUrl: 'https://api.example.com', apiKey: 'bad', fetchImpl: fakeFetch({}, 401) }),
    /HTTP 401/
  );
});

test('discoverModels rejects an unrecognized payload shape', async () => {
  await assert.rejects(
    () => discoverModels({ baseUrl: 'https://api.example.com', apiKey: 'k', fetchImpl: fakeFetch({ nope: true }) }),
    /无法识别/
  );
});

// ── New API public pricing fallback ────────────────────────────────────────

test('pricingUrl strips the /v1 suffix and targets /api/pricing', () => {
  assert.strictEqual(pricingUrl('https://api.example.com/v1'), 'https://api.example.com/api/pricing');
  assert.strictEqual(pricingUrl('https://api.example.com/v1/'), 'https://api.example.com/api/pricing');
  assert.strictEqual(pricingUrl('https://api.example.com'), 'https://api.example.com/api/pricing');
});

test('parseTags maps New API capability tags', () => {
  const caps = parseTags('Reasoning,Tools,Files,Open Weights,Vision,1M');
  assert.strictEqual(caps.toolCalling, true);
  assert.strictEqual(caps.vision, true);
  assert.strictEqual(caps.thinking, true);
  assert.strictEqual(caps.contextWindow, 1_000_000);
});

test('parseTags handles k-suffixed sizes and unknown tags', () => {
  assert.strictEqual(parseTags('128K').contextWindow, 128_000);
  assert.strictEqual(parseTags('200k').contextWindow, 200_000);
  assert.deepStrictEqual(parseTags(''), {});
  assert.deepStrictEqual(parseTags('Files,Open Weights'), {}, 'unknown tags are ignored');
});

test('discoverFromPricing reads model_name and tags', async () => {
  const result = await discoverFromPricing({
    baseUrl: 'https://api.example.com/v1',
    apiKey: '',
    fetchImpl: fakeFetch({
      data: [
        { model_name: 'glm-5.3-flash', tags: 'Reasoning,Tools,Vision,1M', supported_endpoint_types: ['openai'] },
        { model_name: 'plain-model' },
        { not_a_model: true },
      ],
    }),
  });
  assert.deepStrictEqual(result.models.map((m) => m.id), ['glm-5.3-flash', 'plain-model']);
  const glm = result.models[0];
  assert.strictEqual(glm.toolCalling, true);
  assert.strictEqual(glm.vision, true);
  assert.strictEqual(glm.contextWindow, 1_000_000);
  assert.strictEqual(result.warnings.length, 0, 'no warning when tags were present');
});

test('discoverFromPricing warns when no model carries tags', async () => {
  const result = await discoverFromPricing({
    baseUrl: 'https://api.example.com',
    apiKey: '',
    fetchImpl: fakeFetch({ data: [{ model_name: 'a' }, { model_name: 'b' }] }),
  });
  assert.strictEqual(result.warnings.length, 1);
});

test('discoverFromPricing ignores price fields entirely', async () => {
  const result = await discoverFromPricing({
    baseUrl: 'https://api.example.com',
    apiKey: '',
    fetchImpl: fakeFetch({
      data: [
        {
          model_name: 'glm-5.3-flash',
          tags: 'Tools,Vision,1M',
          // gateway billing multipliers, not real prices — must never surface
          model_ratio: 37.5,
          model_price: 0,
          completion_ratio: 1,
          quota_type: 0,
          cache_ratio: 0.1,
          image_ratio: 2,
        },
      ],
    }),
  });
  const model = result.models[0] as unknown as Record<string, unknown>;
  assert.deepStrictEqual(
    Object.keys(model).sort(),
    ['contextWindow', 'id', 'toolCalling', 'vision'],
    'only id and capability fields are produced'
  );
  for (const priceField of ['model_ratio', 'model_price', 'completion_ratio', 'quota_type', 'cache_ratio', 'image_ratio']) {
    assert.strictEqual(model[priceField], undefined, `${priceField} must not be carried over`);
  }
});

test('discoverFromPricing surfaces HTTP failures', async () => {
  await assert.rejects(
    () => discoverFromPricing({ baseUrl: 'https://api.example.com', apiKey: '', fetchImpl: fakeFetch({}, 403) }),
    /HTTP 403/
  );
});

test('enrichModels fills gaps without overwriting known values', () => {
  const models: DiscoveredModel[] = [
    { id: 'a', toolCalling: false },
    { id: 'b' },
    { id: 'c', vision: true },
  ];
  const extra: DiscoveredModel[] = [
    { id: 'a', toolCalling: true, vision: true },
    { id: 'b', contextWindow: 200_000 },
    { id: 'missing' },
  ];
  const filled = enrichModels(models, extra);
  assert.strictEqual(models[0].toolCalling, false, 'existing value wins');
  assert.strictEqual(models[0].vision, true, 'gap filled');
  assert.strictEqual(models[1].contextWindow, 200_000);
  assert.strictEqual(models[2].vision, true);
  assert.strictEqual(filled, 2, 'only the two genuine gaps were filled');
});

// ── Capability resolution ──────────────────────────────────────────────────

test('resolveCapabilities prefers endpoint values over the catalog', () => {
  const catalog = buildCatalogIndex({
    p: { models: { 'model-x': { name: 'Catalog X', tool_call: false, modalities: { input: ['text'] }, limit: { context: 32_000, output: 4_000 } } } },
  });
  const resolved = resolveCapabilities(
    { id: 'model-x', toolCalling: true, contextWindow: 200_000 },
    catalog
  );
  assert.strictEqual(resolved.toolCalling, true, 'endpoint wins');
  assert.strictEqual(resolved.sources.toolCalling, 'endpoint');
  assert.strictEqual(resolved.contextWindow, 200_000);
  assert.strictEqual(resolved.sources.contextWindow, 'endpoint');
  assert.strictEqual(resolved.vision, false, 'catalog fills the gap');
  assert.strictEqual(resolved.sources.vision, 'catalog');
  assert.strictEqual(resolved.name, 'Catalog X');
});

test('resolveCapabilities falls back to guesses when nothing is known', () => {
  const resolved = resolveCapabilities({ id: 'mystery-model' }, {});
  assert.strictEqual(resolved.toolCalling, GUESS_DEFAULTS.toolCalling);
  assert.strictEqual(resolved.vision, GUESS_DEFAULTS.vision);
  assert.strictEqual(resolved.contextWindow, GUESS_DEFAULTS.contextWindow);
  assert.strictEqual(resolved.maxOutputTokens, GUESS_DEFAULTS.maxOutputTokens);
  assert.strictEqual(resolved.name, 'mystery-model');
  assert.strictEqual(resolved.sources.toolCalling, 'guess');
});

test('resolveCapabilities clamps the output budget to the context window', () => {
  const resolved = resolveCapabilities({ id: 'm', contextWindow: 8_000, maxOutputTokens: 16_000 }, {});
  assert.strictEqual(resolved.maxOutputTokens, 8_000);
});

test('resolveAll keeps input order', () => {
  const resolved = resolveAll([{ id: 'b' }, { id: 'a' }], {});
  assert.deepStrictEqual(resolved.map((r) => r.name), ['b', 'a']);
});

// ── Writing chatLanguageModels.json ────────────────────────────────────────

test('mergeModels adds new ids and never overwrites existing entries', () => {
  const existing = {
    name: 'NewApi',
    vendor: 'customendpoint',
    models: [{ id: 'grok-4.7', name: 'Hand Tuned', url: 'u', toolCalling: false, vision: false, contextWindow: 1, maxOutputTokens: 1 }],
  };
  const { group, added, kept } = mergeModels(existing, 'NewApi', 'https://api.example.com/v1', [
    { id: 'grok-4.7', name: 'From Endpoint', url: 'u', toolCalling: true, vision: true, contextWindow: 500_000, maxOutputTokens: 16_000 },
    { id: 'glm-5.3-flash', name: 'GLM', url: 'u', toolCalling: true, vision: true, contextWindow: 1_000_000, maxOutputTokens: 16_000 },
  ]);
  assert.deepStrictEqual(added, ['glm-5.3-flash']);
  assert.deepStrictEqual(kept, ['grok-4.7']);
  const grok = group.models!.find((m) => m.id === 'grok-4.7')!;
  assert.strictEqual(grok.name, 'Hand Tuned', 'hand edits preserved');
  assert.strictEqual(grok.toolCalling, false);
  assert.deepStrictEqual(group.models!.map((m) => m.id), ['glm-5.3-flash', 'grok-4.7'], 'sorted');
});

test('mergeModels creates a group with the vendor and apiType on first use', () => {
  const { group } = mergeModels(undefined, 'MyEndpoint', 'https://api.example.com/v1', [], 'responses');
  assert.strictEqual(group.vendor, 'customendpoint');
  assert.strictEqual(group.apiType, 'responses');
  assert.deepStrictEqual(group.models, []);
});

test('staleModelIds reports models the endpoint no longer offers', () => {
  const group = { name: 'g', vendor: 'customendpoint', models: [{ id: 'a' } as never, { id: 'gone' } as never] };
  assert.deepStrictEqual(staleModelIds(group, ['a', 'b']), ['gone']);
  assert.deepStrictEqual(staleModelIds(undefined, ['a']), []);
});

test('toModelEntry omits optional fields when unset', () => {
  const entry = toModelEntry('m', { name: 'M', toolCalling: true, vision: false, contextWindow: 1000, maxOutputTokens: 100 }, 'u');
  assert.strictEqual(entry.apiType, undefined);
  assert.strictEqual(entry.thinking, undefined);
  assert.strictEqual(entry.supportsReasoningEffort, undefined);
  const rich = toModelEntry('m', { thinking: true, supportsReasoningEffort: ['low', 'high'] }, 'u', 'messages');
  assert.strictEqual(rich.thinking, true);
  assert.deepStrictEqual(rich.supportsReasoningEffort, ['low', 'high']);
  assert.strictEqual(rich.apiType, 'messages');
});

test('applyDiscoveredModels uses the VS Code command for a new group so the key stays out of the file', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'chatLanguageModels.json');
  writeProviderGroups(file, []);
  let command: string | undefined;
  let args: Record<string, unknown> | undefined;

  const result = await applyDiscoveredModels({
    file,
    groupName: 'NewApi',
    url: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    entries: [toModelEntry('m', { name: 'M' }, 'https://api.example.com/v1')],
    executeCommand: (async (cmd: string, a: Record<string, unknown>) => {
      command = cmd;
      args = a;
    }) as never,
  });

  assert.strictEqual(command, 'lm.addLanguageModelsProviderGroup');
  assert.strictEqual(args!.vendor, 'customendpoint');
  assert.strictEqual(args!.apiKey, 'sk-secret');
  assert.strictEqual(result.keyStoredSecurely, true);
  assert.strictEqual(result.keyOmitted, false);
  assert.deepStrictEqual(result.added, ['m']);
  assert.deepStrictEqual(readProviderGroups(file), [], 'file untouched when the command succeeds');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyDiscoveredModels edits the file for an existing group and preserves the secret reference', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'chatLanguageModels.json');
  writeProviderGroups(file, [
    {
      name: 'NewApi',
      vendor: 'customendpoint',
      apiKey: '${input:chat.lm.secret.abc123}',
      models: [{ id: 'existing', name: 'E', url: 'u', toolCalling: true, vision: false, contextWindow: 1, maxOutputTokens: 1 }],
    },
  ]);
  let commandCalled = false;

  const result = await applyDiscoveredModels({
    file,
    groupName: 'NewApi',
    url: 'https://api.example.com/v1',
    apiKey: 'sk-should-not-be-used',
    entries: [toModelEntry('fresh', { name: 'F' }, 'u')],
    executeCommand: (async () => {
      commandCalled = true;
      throw new Error('group already exists');
    }) as never,
  });

  assert.strictEqual(commandCalled, false, 'no point calling a command that cannot update');
  assert.strictEqual(result.keyStoredSecurely, true, 'existing secret reference preserved');
  assert.strictEqual(result.keyOmitted, false);
  const group = readProviderGroups(file)[0];
  assert.strictEqual(group.apiKey, '${input:chat.lm.secret.abc123}', 'key reference untouched');
  assert.deepStrictEqual(group.models!.map((m) => m.id), ['existing', 'fresh']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyDiscoveredModels never writes a plaintext key when the command fails', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'chatLanguageModels.json');
  writeProviderGroups(file, []);

  const result = await applyDiscoveredModels({
    file,
    groupName: 'NewApi',
    url: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    entries: [toModelEntry('m', { name: 'M' }, 'https://api.example.com/v1')],
    executeCommand: (async () => {
      throw new Error('command not found');
    }) as never,
  });

  assert.strictEqual(result.keyStoredSecurely, false);
  assert.strictEqual(result.keyOmitted, true, 'caller must ask the user to paste the key');
  const groups = readProviderGroups(file);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].vendor, 'customendpoint');
  assert.strictEqual(groups[0].apiKey, undefined, 'no plaintext key in the file');
  assert.ok(!JSON.stringify(groups).includes('sk-secret'), 'key never reaches the file');
  assert.strictEqual(groups[0].models!.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isSecretReference recognizes VS Code secret placeholders', () => {
  assert.strictEqual(isSecretReference('${input:chat.lm.secret.abc}'), true);
  assert.strictEqual(isSecretReference('${input:myApiKey}'), true);
  assert.strictEqual(isSecretReference('sk-plaintext'), false);
  assert.strictEqual(isSecretReference(undefined), false);
  assert.strictEqual(isSecretReference(42), false);
});

test('applyDiscoveredModels merges into an existing group without duplicating', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'chatLanguageModels.json');
  writeProviderGroups(file, [
    { name: 'NewApi', vendor: 'customendpoint', models: [{ id: 'existing', name: 'E', url: 'u', toolCalling: true, vision: false, contextWindow: 1, maxOutputTokens: 1 }] },
  ]);

  const result = await applyDiscoveredModels({
    file,
    groupName: 'NewApi',
    url: 'https://api.example.com/v1',
    apiKey: '',
    entries: [
      toModelEntry('existing', { name: 'E' }, 'u'),
      toModelEntry('fresh', { name: 'F' }, 'u'),
    ],
  });

  assert.deepStrictEqual(result.added, ['fresh']);
  assert.deepStrictEqual(result.kept, ['existing']);
  const groups = readProviderGroups(file);
  assert.strictEqual(groups.length, 1, 'no duplicate group');
  assert.deepStrictEqual(groups[0].models!.map((m) => m.id), ['existing', 'fresh']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readProviderGroups tolerates a missing or malformed file', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(readProviderGroups(path.join(dir, 'nope.json')), []);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.deepStrictEqual(readProviderGroups(bad), []);
  fs.writeFileSync(bad, '{"not":"an array"}');
  assert.deepStrictEqual(readProviderGroups(bad), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
