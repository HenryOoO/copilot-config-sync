import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Bundle,
  CategoryId,
  ConflictFile,
  ConflictSet,
  Manifest,
} from './types';
import { scanManifest, SourceDir, defaultSources } from './scanner';
import { packCategory, unpackCategory } from './bundle';
import { StorageBackend } from '../storage/backend';
import {
  decryptSensitiveFields,
  decryptValue,
  deriveKey,
  encryptSensitiveFields,
  generateSalt,
  isEncryptedValue,
} from './crypto';

const JSON_CATEGORIES: CategoryId[] = ['mcp', 'lmProviders'];

export interface EngineOptions {
  backend: StorageBackend;
  secretStorage: vscode.SecretStorage;
  globalStorageUri: vscode.Uri;
  deviceName: string;
  enabledCategories: Record<CategoryId, boolean>;
  sources?: SourceDir[];
}

/** Resolve a manifest relative path back to an absolute path on disk. */
function makeResolver(sources: SourceDir[]): (category: CategoryId, rel: string) => string | undefined {
  return (category, rel) => {
    for (const src of sources) {
      if (src.category !== category) {
        continue;
      }
      if (src.dir.endsWith('.json')) {
        if (path.basename(src.dir) === rel) {
          return src.dir;
        }
        continue;
      }
      const abs = path.join(src.dir, ...rel.split('/'));
      if (fs.existsSync(abs)) {
        return abs;
      }
    }
    return undefined;
  };
}

function categoryBaseDir(sources: SourceDir[], category: CategoryId): string | undefined {
  // for unpacking we need a base dir per category; prefer the first source of that category
  const src = sources.find((s) => s.category === category);
  if (!src) {
    return undefined;
  }
  // single-file sources (mcp.json, chatLanguageModels.json) unpack into their parent dir
  return src.dir.endsWith('.json') ? path.dirname(src.dir) : src.dir;
}

export class SyncEngine {
  constructor(private readonly opts: EngineOptions) {}

  private async getPassphraseKey(createSalt?: string): Promise<{ key: Buffer; salt: string }> {
    let salt = createSalt;
    let stored = await this.opts.secretStorage.get('copilotConfigSync.passphrase');
    if (!stored) {
      stored = await vscode.window.showInputBox({
        prompt: 'Set a sync passphrase (used to encrypt sensitive fields). It cannot be recovered if lost.',
        password: true,
        ignoreFocusOut: true,
      });
      if (!stored) {
        throw new Error('passphrase required');
      }
      await this.opts.secretStorage.store('copilotConfigSync.passphrase', stored);
    }
    if (!salt) {
      salt = (await this.opts.secretStorage.get('copilotConfigSync.kdfSalt')) || undefined;
      if (!salt) {
        salt = generateSalt();
        await this.opts.secretStorage.store('copilotConfigSync.kdfSalt', salt);
      }
    }
    return { key: deriveKey(stored, salt), salt };
  }

  private scanLocal(): Manifest {
    return scanManifest(this.opts.sources || defaultSources(), this.opts.deviceName);
  }

  private async readRemoteBundle(decrypt = true): Promise<Bundle | undefined> {
    const remote = await this.opts.backend.read();
    if (!remote) {
      return undefined;
    }
    if (decrypt && remote.kdfSalt) {
      const { key } = await this.getPassphraseKey(remote.kdfSalt);
      for (const payload of Object.values(remote.categories)) {
        if (!payload) {
          continue;
        }
        for (const file of payload.files) {
          if (file.path.endsWith('.json')) {
            try {
              const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
              decryptSensitiveFields(parsed, key);
              file.content = Buffer.from(JSON.stringify(parsed, null, 2), 'utf8').toString('base64');
            } catch {
              // not JSON or wrong passphrase; leave as-is
            }
          }
        }
      }
    }
    return remote;
  }

  /** Compare local manifest against remote manifest + base manifest. */
  computeConflicts(local: Manifest, remote: Manifest | undefined, base: Manifest | undefined): ConflictSet {
    const set: ConflictSet = { conflicts: [], localOnly: [], remoteOnly: [], localDeleted: [], remoteDeleted: [] };
    if (!remote) {
      return set; // first sync: everything is "local only"
    }
    const categories = new Set<string>([
      ...Object.keys(local.categories),
      ...Object.keys(remote.categories),
    ]);
    for (const category of categories) {
      const cat = category as CategoryId;
      const localFiles = indexBy(local.categories[cat]);
      const remoteFiles = indexBy(remote.categories[cat]);
      const baseFiles = indexBy(base?.categories[cat]);
      const paths = new Set<string>([...localFiles.keys(), ...remoteFiles.keys()]);
      for (const p of paths) {
        const l = localFiles.get(p);
        const r = remoteFiles.get(p);
        const b = baseFiles.get(p);
        const file: ConflictFile = {
          category: cat,
          path: p,
          localHash: l?.hash,
          remoteHash: r?.hash,
          baseHash: b?.hash,
        };
        const localChanged = l && (!b || l.hash !== b.hash);
        const remoteChanged = r && (!b || r.hash !== b.hash);
        if (l && r) {
          if (localChanged && remoteChanged && l.hash !== r.hash) {
            set.conflicts.push(file);
          } else if (localChanged && !remoteChanged) {
            set.localOnly.push(file);
          } else if (remoteChanged && !localChanged) {
            set.remoteOnly.push(file);
          }
        } else if (!l && r) {
          if (!b || b.hash !== r.hash) {
            set.localDeleted.push(file);
          }
        } else if (l && !r) {
          if (!b || b.hash !== l.hash) {
            set.remoteDeleted.push(file);
          }
        }
      }
    }
    return set;
  }

  /** Push local state to the remote bundle, resolving conflicts via UI when needed. */
  async push(): Promise<{
    result: 'pushed' | 'conflict-resolved' | 'cancelled';
    files: number;
    detail: Record<string, number>;
  }> {
    const local = this.scanLocal();
    const remoteBundle = await this.readRemoteBundle();
    const remoteManifest = remoteBundle ? manifestFromBundle(remoteBundle) : undefined;
    const base = await this.loadBase();
    const conflicts = this.computeConflicts(local, remoteManifest, base);

    if (remoteManifest && (conflicts.conflicts.length > 0 || conflicts.remoteOnly.length > 0 || conflicts.localDeleted.length > 0)) {
      const action = await this.resolveConflicts(conflicts, local, remoteBundle!);
      if (action === 'cancelled') {
        return { result: 'cancelled', files: 0, detail: {} };
      }
    }

    const bundle = await this.buildBundle(local);
    const detail = bundleDiffDetail(remoteBundle, bundle);
    await this.opts.backend.write(bundle);
    await this.saveBase(local);
    const hadConflicts =
      conflicts.conflicts.length > 0 ||
      conflicts.remoteOnly.length > 0 ||
      conflicts.localDeleted.length > 0;
    const files = Object.values(detail).reduce((n, c) => n + c, 0);
    return { result: hadConflicts ? 'conflict-resolved' : 'pushed', files, detail };
  }

  /** Pull remote state to disk, backing up overwritten files. */
  async pull(): Promise<{
    result: 'pulled' | 'up-to-date' | 'cancelled';
    files: number;
    detail: Record<string, number>;
  }> {
    const remoteBundle = await this.readRemoteBundle();
    if (!remoteBundle) {
      throw new Error('Nothing has been pushed yet');
    }
    const local = this.scanLocal();
    const remoteManifest = manifestFromBundle(remoteBundle);
    const base = await this.loadBase();
    const conflicts = this.computeConflicts(local, remoteManifest, base);
    if (
      conflicts.remoteOnly.length === 0 &&
      conflicts.localDeleted.length === 0 &&
      conflicts.conflicts.length === 0
    ) {
      return { result: 'up-to-date', files: 0, detail: {} };
    }
    if (conflicts.conflicts.length > 0) {
      const action = await this.resolveConflicts(conflicts, local, remoteBundle);
      if (action === 'cancelled') {
        return { result: 'cancelled', files: 0, detail: {} };
      }
    }
    const sources = this.opts.sources || defaultSources();
    const backupDir = path.join(this.opts.globalStorageUri.fsPath, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    let restored = 0;
    const detail: Record<string, number> = {};
    for (const [category, payload] of Object.entries(remoteBundle.categories)) {
      if (!payload) {
        continue;
      }
      const cat = category as CategoryId;
      if (!this.opts.enabledCategories[cat]) {
        continue;
      }
      const baseDir = categoryBaseDir(sources, cat);
      if (!baseDir) {
        continue;
      }
      // backup files that will be overwritten
      const localFiles = indexBy(local.categories[cat]);
      const changed = payload.files.filter((f) => localFiles.get(f.path)?.hash !== f.hash);
      for (const file of changed) {
        const abs = path.join(baseDir, ...file.path.split('/'));
        if (fs.existsSync(abs)) {
          const rel = path.join(cat, file.path);
          const dest = path.join(backupDir, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(abs, dest);
        }
      }
      const written = unpackCategory({ files: changed }, baseDir);
      if (written.length > 0) {
        detail[cat] = written.length;
      }
      restored += written.length;
    }
    await this.saveBase(remoteManifest);
    return { result: 'pulled', files: restored, detail };
  }

  /**
   * Read-only three-way comparison of local vs remote, without touching disk.
   * Used by "sync now" to decide direction automatically.
   *
   * Pass `{ silent: true }` for background checks: sensitive fields are left
   * encrypted and compared by the hashes already stored in the bundle, so no
   * passphrase prompt can appear.
   */
  async diffStatus(opts: { silent?: boolean } = {}): Promise<{
    localOnly: number;
    remoteOnly: number;
    conflicts: number;
    localDeleted: number;
    remoteDeleted: number;
    detail: Record<string, number>;
  }> {
    const local = this.scanLocal();
    const remoteBundle = await this.readRemoteBundle(!opts.silent);
    if (!remoteBundle) {
      return { localOnly: -1, remoteOnly: 0, conflicts: 0, localDeleted: 0, remoteDeleted: 0, detail: {} };
    }
    const remoteManifest = manifestFromBundle(remoteBundle);
    const base = await this.loadBase();
    const conflicts = this.computeConflicts(local, remoteManifest, base);
    const detail: Record<string, number> = {};
    const bump = (file: ConflictFile) => {
      detail[file.category] = (detail[file.category] || 0) + 1;
    };
    for (const f of conflicts.localOnly) {
      bump(f);
    }
    for (const f of conflicts.remoteOnly) {
      bump(f);
    }
    for (const f of conflicts.conflicts) {
      bump(f);
    }
    for (const f of conflicts.localDeleted) {
      bump(f);
    }
    for (const f of conflicts.remoteDeleted) {
      bump(f);
    }
    return {
      localOnly: conflicts.localOnly.length + conflicts.remoteDeleted.length,
      remoteOnly: conflicts.remoteOnly.length + conflicts.localDeleted.length,
      conflicts: conflicts.conflicts.length,
      localDeleted: conflicts.localDeleted.length,
      remoteDeleted: conflicts.remoteDeleted.length,
      detail,
    };
  }

  private async buildBundle(local: Manifest): Promise<Bundle> {
    const sources = this.opts.sources || defaultSources();
    const resolve = makeResolver(sources);
    const categories: Bundle['categories'] = {};
    for (const category of Object.keys(local.categories) as CategoryId[]) {
      if (!this.opts.enabledCategories[category]) {
        continue;
      }
      const payload = packCategory(local, category, (rel) => resolve(category, rel));
      if (payload) {
        categories[category] = payload;
      }
    }
    const bundle: Bundle = {
      version: 1,
      device: local.device,
      updatedAt: new Date().toISOString(),
      categories,
    };
    // encrypt sensitive fields inside JSON category files
    const hasSensitive = JSON.stringify(bundle).match(/"(api[-_]?key|token|secret|password|authorization)"\s*:\s*"(?!ENC:)[^"]{8,}"/i);
    if (hasSensitive) {
      const { key, salt } = await this.getPassphraseKey();
      bundle.kdfSalt = salt;
      for (const [category, payload] of Object.entries(categories)) {
        if (!payload || !JSON_CATEGORIES.includes(category as CategoryId)) {
          continue;
        }
        for (const file of payload.files) {
          try {
            const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
            encryptSensitiveFields(parsed, key);
            file.content = Buffer.from(JSON.stringify(parsed, null, 2), 'utf8').toString('base64');
          } catch {
            // not JSON; skip
          }
        }
      }
    }
    return bundle;
  }

  /** Show conflict resolution UI; mutates `local`/`remoteBundle` per user choices. */
  private async resolveConflicts(
    conflicts: ConflictSet,
    local: Manifest,
    remoteBundle: Bundle
  ): Promise<'resolved' | 'cancelled'> {
    const items = conflicts.conflicts.map((c) => ({
      label: `${c.category}/${c.path}`,
      description: 'changed on both sides',
      file: c,
      picked: true,
    }));
    if (items.length > 0) {
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Files changed on both sides. Pick files to resolve (Enter to open diff, Esc to cancel).',
        ignoreFocusOut: true,
      });
      if (!picked) {
        return 'cancelled';
      }
      for (const item of picked) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Use local', value: 'local' as const },
            { label: 'Use remote', value: 'remote' as const },
            { label: 'Skip this file', value: 'skip' as const },
          ],
          { placeHolder: item.label, ignoreFocusOut: true }
        );
        if (!choice || choice.value === 'skip') {
          continue;
        }
        if (choice.value === 'local') {
          // drop remote version
          dropFromPayload(remoteBundle, item.file.category, item.file.path);
        } else {
          // overwrite local file with remote content
          await this.writeRemoteFileToLocal(remoteBundle, item.file);
        }
      }
    }
    return 'resolved';
  }

  private async writeRemoteFileToLocal(bundle: Bundle, file: ConflictFile): Promise<void> {
    const sources = this.opts.sources || defaultSources();
    const payload = bundle.categories[file.category];
    if (!payload) {
      return;
    }
    const entry = payload.files.find((f) => f.path === file.path);
    if (!entry) {
      return;
    }
    // resolve the exact target so single-file sources land on their own path
    const abs = makeResolver(sources)(file.category, file.path);
    if (abs) {
      unpackCategory({ files: [entry] }, path.dirname(abs));
      return;
    }
    const baseDir = categoryBaseDir(sources, file.category);
    if (baseDir) {
      unpackCategory({ files: [entry] }, baseDir);
    }
  }

  private baseUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.opts.globalStorageUri, 'base-manifest.json');
  }

  private async loadBase(): Promise<Manifest | undefined> {
    try {
      const data = await vscode.workspace.fs.readFile(this.baseUri());
      return JSON.parse(Buffer.from(data).toString('utf8')) as Manifest;
    } catch {
      return undefined;
    }
  }

  private async saveBase(manifest: Manifest): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.opts.globalStorageUri);
    await vscode.workspace.fs.writeFile(
      this.baseUri(),
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
    );
  }
}

function indexBy<T extends { path: string; hash: string }>(cat: { files: T[] } | undefined): Map<string, { hash: string }> {
  const map = new Map<string, { hash: string }>();
  if (cat) {
    for (const f of cat.files) {
      map.set(f.path, { hash: f.hash });
    }
  }
  return map;
}

function manifestFromBundle(bundle: Bundle): Manifest {
  const categories: Manifest['categories'] = {} as Manifest['categories'];
  for (const [category, payload] of Object.entries(bundle.categories)) {
    if (!payload) {
      continue;
    }
    categories[category as CategoryId] = {
      files: payload.files.map((f) => ({
        path: f.path,
        hash: f.hash,
        size: 0,
        executable: f.executable,
      })),
    };
  }
  return {
    version: 1,
    device: bundle.device,
    updatedAt: bundle.updatedAt,
    categories,
  };
}

function dropFromPayload(bundle: Bundle, category: CategoryId, path: string): void {
  const payload = bundle.categories[category];
  if (payload) {
    payload.files = payload.files.filter((f) => f.path !== path);
  }
}

/** Per-category count of files whose content differs between two bundles. */
function bundleDiffDetail(before: Bundle | undefined, after: Bundle): Record<string, number> {
  const detail: Record<string, number> = {};
  const categories = new Set<string>([
    ...Object.keys(before?.categories || {}),
    ...Object.keys(after.categories),
  ]);
  for (const category of categories) {
    const cat = category as CategoryId;
    const beforeFiles = indexBy(before?.categories[cat]);
    const afterFiles = indexBy(after.categories[cat]);
    let changed = 0;
    for (const p of new Set<string>([...beforeFiles.keys(), ...afterFiles.keys()])) {
      const b = beforeFiles.get(p)?.hash;
      const a = afterFiles.get(p)?.hash;
      if (b !== a) {
        changed += 1;
      }
    }
    if (changed > 0) {
      detail[cat] = changed;
    }
  }
  return detail;
}