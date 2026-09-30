import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCatalogIndex,
  isCacheStale,
  loadCatalog,
  lookupCatalog,
  normalizeModelId,
  readCatalogCache,
  writeCatalogCache,
  CATALOG_VERSION,
} from '../core/modelCatalog';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-catalog-'));
  return path.join(dir, 'model-catalog.json');
}

/** A single well-populated provider, for field-mapping assertions. */
const SINGLE = {
  zai: {
    id: 'zai',
    models: {
      'glm-5.3-flash': {
        name: 'GLM-5.3-Flash',
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 1_000_000, output: 131_072 },
      },
    },
  },
};

/** Two providers listing the same model with conflicting metadata. */
const SAMPLE = {
  zai: {
    id: 'zai',
    models: {
      'glm-5.3-flash': {
        name: 'GLM-5.3-Flash',
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 1_000_000, output: 131_072 },
      },
    },
  },
  'some-gateway': {
    id: 'some-gateway',
    models: {
      // same id, poorer metadata: must not win the merge
      'glm-5.3-flash': {
        name: 'GLM 5.3 Flash',
        tool_call: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 32_000, output: 4_000 },
      },
    },
  },
  xai: {
    id: 'xai',
    models: {
      'grok-4.7': {
        name: 'Grok 4.7',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 500_000, output: 500_000 },
      },
    },
  },
};

test('normalizeModelId strips prefixes, variants and date stamps', () => {
  assert.strictEqual(normalizeModelId('openai/gpt-4o'), 'gpt-4o');
  assert.strictEqual(normalizeModelId('GLM-5.3-Flash'), 'glm-5.3-flash');
  assert.strictEqual(normalizeModelId('deepseek-chat:free'), 'deepseek-chat');
  assert.strictEqual(normalizeModelId('gpt-4o-latest'), 'gpt-4o');
  assert.strictEqual(normalizeModelId('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet');
  assert.strictEqual(normalizeModelId('  grok-4.7  '), 'grok-4.7');
});

test('buildCatalogIndex maps models.dev fields onto our capability shape', () => {
  const index = buildCatalogIndex(SINGLE);
  const glm = index['glm-5.3-flash'];
  assert.ok(glm);
  assert.strictEqual(glm.name, 'GLM-5.3-Flash');
  assert.strictEqual(glm.toolCalling, true);
  assert.strictEqual(glm.vision, true);
  assert.strictEqual(glm.contextWindow, 1_000_000);
  assert.strictEqual(glm.maxOutputTokens, 131_072);
  assert.strictEqual(glm.thinking, true);
  assert.deepStrictEqual(glm.supportsReasoningEffort, ['low', 'high', 'max']);
});

test('buildCatalogIndex resolves conflicting duplicates by majority vote', () => {
  const index = buildCatalogIndex(SAMPLE);
  // one provider says tool_call=true/1M, the other says false/32k: a 1-1 tie
  // resolves toward the safer defaults (tools on, vision off) and the modal window
  assert.strictEqual(index['glm-5.3-flash'].toolCalling, true);
  assert.strictEqual(index['glm-5.3-flash'].vision, false);
  assert.strictEqual(index['glm-5.3-flash'].contextWindow, 1_000_000);
});

test('buildCatalogIndex uses a majority vote so one outlier cannot inflate values', () => {
  const index = buildCatalogIndex({
    a: { models: { m: { tool_call: true, modalities: { input: ['text'] }, limit: { context: 1_000_000, output: 16_000 } } } },
    b: { models: { m: { tool_call: true, modalities: { input: ['text'] }, limit: { context: 1_000_000, output: 16_000 } } } },
    // a gateway that over-reports the window and claims vision
    c: { models: { m: { tool_call: true, modalities: { input: ['text', 'image'] }, limit: { context: 1_050_000, output: 1_048_576 } } } },
  });
  const m = index['m'];
  assert.strictEqual(m.contextWindow, 1_000_000, 'modal value wins over the outlier');
  assert.strictEqual(m.maxOutputTokens, 16_000);
  assert.strictEqual(m.vision, false, 'majority vote rejects the lone vision claim');
});

test('buildCatalogIndex clamps an output budget that exceeds the window', () => {
  const index = buildCatalogIndex({
    a: { models: { m: { tool_call: true, modalities: { input: ['text'] }, limit: { context: 8_000, output: 64_000 } } } },
  });
  assert.strictEqual(index['m'].maxOutputTokens, 8_000);
});

test('buildCatalogIndex tolerates malformed payloads', () => {
  assert.deepStrictEqual(buildCatalogIndex(null), {});
  assert.deepStrictEqual(buildCatalogIndex('nope'), {});
  assert.deepStrictEqual(buildCatalogIndex({ p: { models: 'bad' } }), {});
  assert.deepStrictEqual(buildCatalogIndex({ p: { models: { m: null } } }), {});
});

test('lookupCatalog matches exactly and via a size-suffix stem', () => {
  const index = buildCatalogIndex(SAMPLE);
  assert.ok(lookupCatalog(index, 'glm-5.3-flash'));
  assert.ok(lookupCatalog(index, 'zai/glm-5.3-flash'), 'provider prefix tolerated');
  assert.strictEqual(lookupCatalog(index, 'totally-unknown-model'), undefined);
});

test('catalog cache round trips and reports staleness', () => {
  const file = tmpFile();
  const index = buildCatalogIndex(SAMPLE);
  writeCatalogCache(file, index);

  const cache = readCatalogCache(file);
  assert.ok(cache);
  assert.strictEqual(cache.version, CATALOG_VERSION);
  assert.strictEqual(cache.models['grok-4.7'].contextWindow, 500_000);
  assert.strictEqual(isCacheStale(cache), false);
  assert.strictEqual(isCacheStale(cache, -1), true, 'negative max age is always stale');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('readCatalogCache rejects a version mismatch or missing file', () => {
  const file = tmpFile();
  assert.strictEqual(readCatalogCache(file), undefined);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 99, models: {} }));
  assert.strictEqual(readCatalogCache(file), undefined);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('loadCatalog uses a fresh cache without hitting the network', async () => {
  const file = tmpFile();
  writeCatalogCache(file, buildCatalogIndex(SAMPLE));
  let called = false;
  const models = await loadCatalog({
    cacheFile: file,
    fetchImpl: (async () => {
      called = true;
      throw new Error('should not fetch');
    }) as unknown as typeof fetch,
  });
  assert.strictEqual(called, false);
  assert.ok(models['glm-5.3-flash']);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('loadCatalog falls back to a stale cache when the network fails', async () => {
  const file = tmpFile();
  writeCatalogCache(file, buildCatalogIndex(SAMPLE));
  const models = await loadCatalog({
    cacheFile: file,
    maxAgeMs: -1, // force a refresh attempt
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch,
  });
  assert.ok(models['grok-4.7'], 'stale cache still served');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('loadCatalog returns an empty index when offline with no cache', async () => {
  const file = tmpFile();
  const models = await loadCatalog({
    cacheFile: file,
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch,
  });
  assert.deepStrictEqual(models, {});
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('loadCatalog writes the cache after a successful fetch', async () => {
  const file = tmpFile();
  const models = await loadCatalog({
    cacheFile: file,
    fetchImpl: (async () => ({
      ok: true,
      json: async () => SAMPLE,
    })) as unknown as typeof fetch,
  });
  assert.ok(models['glm-5.3-flash']);
  assert.ok(readCatalogCache(file), 'cache persisted');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
