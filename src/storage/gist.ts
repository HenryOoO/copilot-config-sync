import * as vscode from 'vscode';
import { Bundle } from '../core/types';
import { StorageBackend } from './backend';

const GITHUB_PROVIDER_ID = 'github';
const GIST_SCOPE = 'gist';
const GIST_FILENAME = 'manifest.json';
const API_BASE = 'https://api.github.com';

interface GistFile {
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

interface Gist {
  id: string;
  public: boolean;
  description?: string;
  files: Record<string, GistFile>;
}

/**
 * Gist-backed storage. One private gist holds the bundle files
 * (manifest.json + per-category chunk files).
 */
export class GistBackend implements StorageBackend {
  private gistId: string | undefined;

  constructor(
    private readonly secretStorage: vscode.SecretStorage,
    private readonly description: string
  ) {}

  async setGistId(id: string | undefined): Promise<void> {
    this.gistId = id;
    if (id) {
      await this.secretStorage.store('copilotConfigSync.gistId', id);
    } else {
      await this.secretStorage.delete('copilotConfigSync.gistId');
    }
  }

  async getGistId(): Promise<string | undefined> {
    if (this.gistId !== undefined) {
      return this.gistId;
    }
    this.gistId = (await this.secretStorage.get('copilotConfigSync.gistId')) || undefined;
    return this.gistId;
  }

  private async token(): Promise<string> {
    const session = await vscode.authentication.getSession('github', [GIST_SCOPE], {
      createIfNone: true,
    });
    return session.accessToken;
  }

  private async request(
    method: string,
    url: string,
    body?: unknown
  ): Promise<{ status: number; json: unknown; text: string }> {
    const token = await this.token();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'copilot-config-sync',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      const waitMin = Math.max(1, Math.ceil((reset - Date.now()) / 60000));
      throw new Error(`GitHub API rate limited; resets in ~${waitMin} min`);
    }
    if (res.status >= 400) {
      const message =
        (json as { message?: string } | undefined)?.message || `HTTP ${res.status}`;
      throw new Error(`GitHub API error: ${message}`);
    }
    return { status: res.status, json, text };
  }

  /** Find the sync gist by description, or create it. */
  async ensureGist(): Promise<string> {
    const existing = await this.getGistId();
    if (existing) {
      try {
        await this.request('GET', `${API_BASE}/gists/${existing}`);
        return existing;
      } catch {
        // gist gone (deleted remotely); fall through to search/create
        await this.setGistId(undefined);
      }
    }
    // explicit setting takes precedence over search
    const configured = vscode.workspace
      .getConfiguration('copilotConfigSync')
      .get<string>('gistId', '')
      .trim();
    if (configured) {
      await this.request('GET', `${API_BASE}/gists/${configured}`); // validate access
      await this.setGistId(configured);
      return configured;
    }
    // search user's gists for one with our description
    const { json } = await this.request('GET', `${API_BASE}/gists?per_page=100`);
    const gists = (Array.isArray(json) ? json : []) as Gist[];
    const found = gists.find((g) => g.description === this.description && !g.public);
    if (found) {
      await this.setGistId(found.id);
      return found.id;
    }
    const created = await this.request('POST', `${API_BASE}/gists`, {
      description: this.description,
      public: false,
      files: { [GIST_FILENAME]: { content: '{}' } },
    });
    const gist = created.json as Gist;
    await this.setGistId(gist.id);
    return gist.id;
  }

  /** Create a fresh gist with a user-chosen description (from setup UI). */
  async createGist(description: string): Promise<string> {
    const created = await this.request('POST', `${API_BASE}/gists`, {
      description,
      public: false,
      files: { [GIST_FILENAME]: { content: '{}' } },
    });
    const gist = created.json as Gist;
    await this.setGistId(gist.id);
    return gist.id;
  }

  /** Connect to an existing gist by id (from setup UI). */
  async connectGist(gistId: string): Promise<void> {
    await this.request('GET', `${API_BASE}/gists/${gistId.trim()}`); // validate access
    await this.setGistId(gistId.trim());
  }

  /** True if a passphrase is already stored. */
  async hasPassphrase(): Promise<boolean> {
    return Boolean(await this.secretStorage.get('copilotConfigSync.passphrase'));
  }

  /** Store the passphrase (called from setup UI). */
  async setPassphrase(passphrase: string): Promise<void> {
    await this.secretStorage.store('copilotConfigSync.passphrase', passphrase);
  }

  async read(): Promise<Bundle | undefined> {
    const id = await this.ensureGist();
    const { json } = await this.request('GET', `${API_BASE}/gists/${id}`);
    const gist = json as Gist;
    const manifestRaw = gist.files[GIST_FILENAME]?.content;
    if (!manifestRaw || gist.files[GIST_FILENAME]?.truncated) {
      return undefined;
    }
    let manifest: Bundle;
    try {
      manifest = JSON.parse(manifestRaw) as Bundle;
    } catch {
      throw new Error('Remote manifest.json is corrupt');
    }
    // chunk files are stored as separate gist files; fetch their raw content
    const chunkFiles: Record<string, unknown> = {};
    for (const [name, file] of Object.entries(gist.files)) {
      if (name === GIST_FILENAME) {
        continue;
      }
      let parsed: unknown;
      if (file.truncated && file.raw_url) {
        // >1MB gist files are truncated in the API; fetch raw content instead
        const raw = await fetch(file.raw_url);
        parsed = JSON.parse(await raw.text());
      } else if (file.content) {
        try {
          parsed = JSON.parse(file.content);
        } catch {
          continue; // non-JSON chunk; skip
        }
      } else {
        continue;
      }
      // unwrap {category: {files: [...]}} and merge same-category chunks
      const [category, payload] = Object.entries(parsed as Record<string, unknown>)[0] || ['', undefined];
      if (
        payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { files?: unknown }).files)
      ) {
        const cat = category as keyof Bundle['categories'];
        const existing = chunkFiles[category] as { files: unknown[] } | undefined;
        const files = (payload as { files: unknown[] }).files;
        chunkFiles[category] = { files: existing ? [...existing.files, ...files] : files };
        void cat;
      }
    }
    return { ...manifest, categories: { ...manifest.categories, ...(chunkFiles as Bundle['categories']) } };
  }

  async write(bundle: Bundle): Promise<void> {
    const id = await this.ensureGist();
    const { categories, ...manifestRest } = bundle;
    const files: Record<string, { content: string }> = {
      [GIST_FILENAME]: { content: JSON.stringify({ ...manifestRest, categories: {} }, null, 2) },
    };
    for (const [category, payload] of Object.entries(categories)) {
      if (!payload) {
        continue;
      }
      const total = payload.files.reduce((n, f) => n + f.content.length, 0);
      if (total <= 900_000) {
        files[`${category}.json`] = { content: JSON.stringify({ [category]: payload }) };
      } else {
        // chunk
        let current: typeof payload.files = [];
        let size = 0;
        let index = 1;
        const flush = () => {
          if (current.length) {
            files[`${category}-${index}.json`] = {
              content: JSON.stringify({ [category]: { files: current } }),
            };
            index += 1;
            current = [];
            size = 0;
          }
        };
        for (const f of payload.files) {
          if (size + f.content.length > 900_000) {
            flush();
          }
          current.push(f);
          size += f.content.length;
        }
        flush();
      }
    }
    await this.request('PATCH', `${API_BASE}/gists/${id}`, { files });
  }

  async delete(): Promise<void> {
    const id = await this.getGistId();
    if (!id) {
      return;
    }
    await this.request('DELETE', `${API_BASE}/gists/${id}`);
    await this.setGistId(undefined);
  }

  async exists(): Promise<boolean> {
    const id = await this.getGistId();
    if (!id) {
      return false;
    }
    try {
      const { json } = await this.request('GET', `${API_BASE}/gists/${id}`);
      const gist = json as Gist;
      return Boolean(gist.files[GIST_FILENAME]);
    } catch {
      return false;
    }
  }
}