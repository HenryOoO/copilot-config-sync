import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SyncEngine } from '../core/engine';
import { Bundle, Manifest } from '../core/types';
import { scanManifest, SourceDir } from '../core/scanner';
import { sha256 } from '../core/hash';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-engine-'));
}

function hashOf(content: string): string {
  return sha256(Buffer.from(content, 'utf8'));
}

function manifestOf(files: Record<string, string>, device = 'd'): Manifest {
  const categories: Manifest['categories'] = {} as Manifest['categories'];
  for (const [p, content] of Object.entries(files)) {
    const cat = p.split('/')[0] as keyof Manifest['categories'];
    categories[cat] = categories[cat] || { files: [] };
    categories[cat].files.push({
      path: p.slice(cat.length + 1),
      hash: hashOf(content),
      size: content.length,
      executable: false,
    });
  }
  return { version: 1, device, updatedAt: 'now', categories };
}

function bundleOf(manifest: Manifest): Bundle {
  const categories: Bundle['categories'] = {};
  for (const [cat, data] of Object.entries(manifest.categories)) {
    categories[cat as keyof Bundle['categories']] = {
      files: data.files.map((f) => ({
        path: f.path,
        content: Buffer.from('x', 'utf8').toString('base64'),
        hash: f.hash,
        executable: f.executable,
      })),
    };
  }
  return { version: 1, device: manifest.device, updatedAt: manifest.updatedAt, categories };
}

function makeEngine(remote: Bundle | undefined, base: Manifest | undefined, sources: SourceDir[]): SyncEngine {
  const engine = new SyncEngine({
    backend: {
      read: async () => remote,
      write: async () => {},
      delete: async () => {},
      exists: async () => Boolean(remote),
    },
    secretStorage: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      onDidChange: undefined as never,
      keys: async () => [],
    },
    globalStorageUri: { fsPath: tmpDir() } as never,
    deviceName: 'test-device',
    enabledCategories: { skills: true, instructions: true, agents: true, hooks: true, prompts: true, mcp: true, lmProviders: true },
    sources,
  });
  // stub base manifest storage
  (engine as unknown as { loadBase: () => Promise<Manifest | undefined> }).loadBase = async () => base;
  (engine as unknown as { saveBase: (m: Manifest) => Promise<void> }).saveBase = async () => {};
  return engine;
}

test('diffStatus: identical sides report zero changes', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'a.md'), 'same');
  const sources: SourceDir[] = [{ category: 'skills', dir: root, suffixes: [], recursive: true }];
  const local = scanManifest(sources, 'd');
  const engine = makeEngine(bundleOf(local), local, sources);
  return engine.diffStatus().then((diff) => {
    assert.strictEqual(diff.localOnly, 0);
    assert.strictEqual(diff.remoteOnly, 0);
    assert.strictEqual(diff.conflicts, 0);
    assert.strictEqual(Object.keys(diff.detail).length, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('diffStatus: local-only change detected as push direction', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'a.md'), 'same');
  const sources: SourceDir[] = [{ category: 'skills', dir: root, suffixes: [], recursive: true }];
  const base = scanManifest(sources, 'd');
  fs.writeFileSync(path.join(root, 'a.md'), 'changed locally');
  const local = scanManifest(sources, 'd');
  const engine = makeEngine(bundleOf(base), base, sources);
  return engine.diffStatus().then((diff) => {
    assert.strictEqual(diff.localOnly, 1);
    assert.strictEqual(diff.remoteOnly, 0);
    assert.strictEqual(diff.detail.skills, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('diffStatus: remote-only change detected as pull direction', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'a.md'), 'same');
  const sources: SourceDir[] = [{ category: 'skills', dir: root, suffixes: [], recursive: true }];
  const base = scanManifest(sources, 'd');
  const remoteManifest = manifestOf({ 'skills/a.md': 'changed remotely' });
  const engine = makeEngine(bundleOf(remoteManifest), base, sources);
  return engine.diffStatus().then((diff) => {
    assert.strictEqual(diff.localOnly, 0);
    assert.strictEqual(diff.remoteOnly, 1);
    assert.strictEqual(diff.detail.skills, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('diffStatus: no remote bundle means initial push', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'a.md'), 'same');
  const sources: SourceDir[] = [{ category: 'skills', dir: root, suffixes: [], recursive: true }];
  const engine = makeEngine(undefined, undefined, sources);
  return engine.diffStatus().then((diff) => {
    assert.strictEqual(diff.localOnly, -1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
