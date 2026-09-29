import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanManifest, SourceDir, defaultSources, vscodeUserDir, CATEGORY_INFO } from '../core/scanner';
import { packCategory, unpackCategory, chunkPayload, mergeChunks } from '../core/bundle';
import { sha256 } from '../core/hash';
import { Manifest } from '../core/types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-test-'));
}

test('scanManifest tolerates missing directories', () => {
  const manifest = scanManifest([]);
  assert.strictEqual(manifest.version, 1);
});

test('scanManifest picks up skills tree with exec bits', () => {
  const root = tmpDir();
  const skillDir = path.join(root, 'my-skill');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill\n');
  fs.mkdirSync(path.join(skillDir, 'scripts'));
  fs.writeFileSync(path.join(skillDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(skillDir, 'scripts', 'run.sh'), 0o755);

  const sources: SourceDir[] = [
    { category: 'skills', dir: root, suffixes: [], recursive: true },
  ];
  const manifest = scanManifest(sources, 'test-device');
  const files = manifest.categories.skills.files;
  assert.strictEqual(files.length, 2);
  const script = files.find((f) => f.path === 'my-skill/scripts/run.sh')!;
  assert.ok(script);
  assert.ok(script.executable);
  assert.strictEqual(script.hash, sha256(fs.readFileSync(path.join(skillDir, 'scripts', 'run.sh'))));
  const md = files.find((f) => f.path === 'my-skill/SKILL.md')!;
  assert.ok(!md.executable);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanManifest handles single-file sources', () => {
  const root = tmpDir();
  const mcpPath = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpPath, '{"servers":{}}');
  const sources: SourceDir[] = [
    { category: 'mcp', dir: mcpPath, suffixes: [], recursive: false },
  ];
  const manifest = scanManifest(sources);
  assert.strictEqual(manifest.categories.mcp.files.length, 1);
  assert.strictEqual(manifest.categories.mcp.files[0].path, 'mcp.json');
  fs.rmSync(root, { recursive: true, force: true });
});

test('defaultSources include verified paths', () => {
  const sources = defaultSources();
  const home = os.homedir();
  const user = vscodeUserDir();
  const dirs = sources.map((s) => s.dir);
  assert.ok(dirs.includes(path.join(home, '.agents', 'skills')));
  assert.ok(dirs.includes(path.join(home, '.copilot', 'instructions')));
  assert.ok(dirs.includes(path.join(user, 'mcp.json')));
  assert.ok(dirs.includes(path.join(user, 'chatLanguageModels.json')));
});

test('CATEGORY_INFO covers every source category with a label and description', () => {
  const categories = new Set(defaultSources().map((s) => s.category));
  for (const cat of categories) {
    const info = CATEGORY_INFO[cat];
    assert.ok(info, `missing CATEGORY_INFO for ${cat}`);
    assert.ok(info.label.length > 0, `empty label for ${cat}`);
    assert.ok(info.description.length > 0, `empty description for ${cat}`);
  }
  assert.deepStrictEqual(
    Object.keys(CATEGORY_INFO).sort(),
    [...categories].sort(),
    'CATEGORY_INFO keys must match defaultSources categories'
  );
});

test('pack/unpack round trip preserves content and exec bit', () => {
  const root = tmpDir();
  const skillDir = path.join(root, 'sk');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, 'a.md'), 'hello');
  fs.writeFileSync(path.join(skillDir, 'run.sh'), '#!/bin/sh');
  fs.chmodSync(path.join(skillDir, 'run.sh'), 0o755);

  const sources: SourceDir[] = [{ category: 'skills', dir: root, suffixes: [], recursive: true }];
  const manifest = scanManifest(sources);
  const payload = packCategory(manifest, 'skills', (rel) => path.join(root, ...rel.split('/')));
  assert.ok(payload);
  assert.strictEqual(payload.files.length, 2);

  const outDir = tmpDir();
  // unpack into a parent so relative paths (sk/a.md) land correctly
  const parent = tmpDir();
  fs.rmdirSync(parent);
  fs.renameSync(outDir, parent);
  unpackCategory(payload, parent);
  assert.strictEqual(fs.readFileSync(path.join(parent, 'sk', 'a.md'), 'utf8'), 'hello');
  const mode = fs.statSync(path.join(parent, 'sk', 'run.sh')).mode;
  assert.ok((mode & 0o111) !== 0, 'exec bit restored');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(parent, { recursive: true, force: true });
});

test('chunkPayload splits oversized payloads and mergeChunks restores them', () => {
  // base64 of 600k chars is ~800k chars; two such files exceed the 900k limit
  const big = 'x'.repeat(600_000);
  const b64 = Buffer.from(big).toString('base64');
  const payload = {
    files: [
      { path: 'a.txt', content: b64, hash: 'h1', executable: false },
      { path: 'b.txt', content: b64, hash: 'h2', executable: false },
      { path: 'c.txt', content: b64, hash: 'h3', executable: false },
    ],
  };
  const chunks = chunkPayload('skills', payload);
  // each file is ~800k base64 chars; two can never share a 900k chunk
  assert.strictEqual(Object.keys(chunks).length, 3);
  const merged = mergeChunks(chunks, 'skills');
  assert.ok(merged);
  assert.strictEqual(merged.files.length, 3);
  assert.deepStrictEqual(
    merged.files.map((f) => f.path),
    ['a.txt', 'b.txt', 'c.txt']
  );
});

test('manifest JSON round trip', () => {
  const manifest: Manifest = {
    version: 1,
    device: 'd',
    updatedAt: 'now',
    categories: {
      skills: { files: [{ path: 'a/SKILL.md', hash: 'h', size: 1, executable: false }] },
    } as Manifest['categories'],
  };
  const parsed = JSON.parse(JSON.stringify(manifest)) as Manifest;
  assert.strictEqual(parsed.categories.skills.files[0].path, 'a/SKILL.md');
});
