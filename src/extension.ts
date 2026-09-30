import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SyncEngine } from './core/engine';
import { GistBackend } from './storage/gist';
import { CategoryId } from './core/types';
import { SyncPanel, PanelState, DiscoveredModelView } from './ui/panel';
import { scanManifest, defaultSources, CATEGORY_INFO, lmProvidersPath } from './core/scanner';
import { discoverModels, discoverFromPricing, enrichModels, ApiType } from './core/discovery';
import { loadCatalog } from './core/modelCatalog';
import { resolveAll } from './core/knownModels';
import { applyDiscoveredModels, readProviderGroups, toModelEntry, CUSTOM_ENDPOINT_VENDOR } from './core/lmProviders';

const CONFIG_SECTION = 'copilotConfigSync';

const ALL_CATEGORIES: CategoryId[] = ['skills', 'instructions', 'agents', 'hooks', 'prompts', 'mcp', 'lmProviders'];

const RELEASE_API_URL = 'https://api.github.com/repos/HenryOoO/copilot-config-sync/releases/tags/latest';

function installCommand(url: string): string {
  return `curl -L -o /tmp/ccs.vsix ${url} && "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension /tmp/ccs.vsix`;
}

function codeCli(): string {
  return process.platform === 'darwin'
    ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
    : 'code';
}

/** Download the vsix and install it via the code CLI; resolves true on success. */
async function installVsix(url: string): Promise<boolean> {
  const tmp = '/tmp/copilot-config-sync-update.vsix';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(tmp, buf);
    const { execFile } = require('child_process') as typeof import('child_process');
    await new Promise<void>((resolve, reject) => {
      execFile(codeCli(), ['--install-extension', tmp, '--force'], (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || stdout || err)));
        } else {
          resolve();
        }
      });
    });
    return true;
  } catch {
    return false;
  }
}

function getEnabledCategories(): Record<CategoryId, boolean> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<Record<string, boolean>>('categories', {});
  const out = {} as Record<CategoryId, boolean>;
  for (const cat of ALL_CATEGORIES) {
    out[cat] = raw[cat] !== false;
  }
  return out;
}

function getDeviceName(): string {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<string>('deviceName', '') || require('os').hostname();
}

function getGistDescription(): string {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('gistDescription', 'copilot-config-sync');
}

export function activate(context: vscode.ExtensionContext): void {
  const backend = new GistBackend(context.secrets, getGistDescription());
  const engine = new SyncEngine({
    backend,
    secretStorage: context.secrets,
    globalStorageUri: context.globalStorageUri,
    deviceName: getDeviceName(),
    enabledCategories: getEnabledCategories(),
  });

  const panel = new SyncPanel(
    context,
    async () => {
      try {
        await runSync(engine, panel, context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== 'passphrase required' && message !== 'cancelled') {
          panel.toast(message, 'error');
        }
      }
    },
    async (category, enabled) => {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const current = config.get<Record<string, boolean>>('categories', {});
      await config.update('categories', { ...current, [category]: enabled }, vscode.ConfigurationTarget.Global);
      engine['opts'].enabledCategories[category as CategoryId] = enabled;
    },
    async (mode, gistName, gistId, passphrase) => {
      try {
        if (mode === 'create') {
          await backend.createGist(gistName);
        } else {
          await backend.connectGist(gistId);
        }
        await backend.setPassphrase(passphrase);
        await refreshPanel(engine, panel, backend, context);
        panel.toast('已连接，可以开始同步了');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        panel.toast(message, 'error');
      }
    },
    async (settings) => {
      try {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        if (settings.gistName) {
          await config.update('gistDescription', settings.gistName, vscode.ConfigurationTarget.Global);
        }
        await config.update('gistId', settings.gistId, vscode.ConfigurationTarget.Global);
        if (settings.deviceName) {
          await config.update('deviceName', settings.deviceName, vscode.ConfigurationTarget.Global);
          engine['opts'].deviceName = settings.deviceName;
        }
        if (settings.passphrase) {
          await backend.setPassphrase(settings.passphrase);
        }
        // if gistId changed, reconnect
        await backend.setGistId(settings.gistId || undefined);
        await refreshPanel(engine, panel, backend, context);
        panel.toast('设置已保存');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        panel.toast(message, 'error');
      }
    },
    async () => {
      try {
        const latest = await fetchLatestVersion();
        const current = context.extension.packageJSON.version as string;
        panel.setState({
          version: current,
          update: latest ? { latest: latest.version, command: installCommand(latest.url) } : undefined,
          checkingUpdate: false,
          updateChecked: true,
        });
        if (!latest) {
          panel.toast('无法获取最新版本信息', 'error');
        } else if (latest.version === current) {
          panel.toast(`已是最新版本 (${current})`);
        } else {
          panel.confirmUpdate(latest.version);
        }
      } catch {
        panel.setState({ checkingUpdate: false, updateChecked: true });
        panel.toast('无法获取最新版本信息', 'error');
      }
    },
    async () => {
      const update = panel['state'].update;
      if (!update) {
        return;
      }
      // clear confirmUpdateFor so the modal stays closed during install
      panel.setState({ updating: true, confirmUpdateFor: undefined });
      const ok = await installVsix(update.command.match(/https:\S+\.vsix/)?.[0] || '');
      panel.setState({ updating: false });
      if (ok) {
        panel.promptReload();
      } else {
        panel.toast('自动更新失败，安装命令已复制到剪贴板，可在终端手动执行', 'error');
        await vscode.env.clipboard.writeText(update.command);
      }
    },
    () => {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    async (opts) => {
      await runDiscovery(panel, context, opts);
    },
    async (models) => {
      await applyDiscovery(panel, models);
    },
    async () => {
      const groups = existingGroups();
      return Promise.all(
        groups.map(async (g) => ({
          ...g,
          hasSavedKey: Boolean(await context.secrets.get(savedKeyId(g.name))),
        }))
      );
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'copilotConfigSync.panel',
      { resolveWebviewView: (view) => panel.resolveWebviewView(view) },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  void refreshPanel(engine, panel, backend, context);
  void autoCheckUpdate(context, panel);
}

/** Check for updates once on startup, throttled to once per 24h. Toasts only when outdated. */
async function autoCheckUpdate(context: vscode.ExtensionContext, panel: SyncPanel): Promise<void> {
  const KEY = 'copilotConfigSync.lastUpdateCheck';
  const now = Date.now();
  const last = context.globalState.get<number>(KEY, 0);
  if (now - last < 24 * 60 * 60 * 1000) {
    return;
  }
  await context.globalState.update(KEY, now);
  try {
    const latest = await fetchLatestVersion();
    const current = context.extension.packageJSON.version as string;
    panel.setState({
      version: current,
      update: latest ? { latest: latest.version, command: installCommand(latest.url) } : undefined,
      updateChecked: true,
    });
    if (latest && latest.version !== current) {
      panel.confirmUpdate(latest.version);
    }
  } catch {
    // silent: auto check should not bother the user on failure
  }
}

async function runSync(engine: SyncEngine, panel: SyncPanel, context: vscode.ExtensionContext): Promise<string> {
  panel.setState({ status: 'syncing' });
  try {
    const exists = await engine['opts'].backend.exists();
    let result: string;
    if (!exists) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '推送本机配置到云端', value: 'push' as const },
          { label: '从云端拉取配置到本机', value: 'pull' as const },
        ],
        { placeHolder: '还没有云端同步。选择初始方向：' }
      );
      if (!choice) {
        panel.setState({ status: 'idle' });
        return 'cancelled';
      }
      const op = choice.value === 'push' ? await engine.push() : await engine.pull();
      result = op.result;
      recordHistory(context, panel, choice.value, op.files, op.detail);
    } else {
      // decide direction automatically from a three-way diff
      const diff = await engine.diffStatus();
      if (diff.localOnly === 0 && diff.remoteOnly === 0 && diff.conflicts === 0) {
        // nothing changed: don't refresh lastSyncAt so the status line
        // keeps showing when the last real sync happened
        panel.setState({ status: 'ok' });
        panel.toast('本机与云端数据一致，无需同步');
        return 'up-to-date';
      }
      let pulled: Awaited<ReturnType<SyncEngine['pull']>> | undefined;
      let pushed: Awaited<ReturnType<SyncEngine['push']>> | undefined;
      if (diff.remoteOnly > 0 && diff.localOnly === 0 && diff.conflicts === 0) {
        // remote is newer: pull only
        pulled = await engine.pull();
        result = pulled.result;
      } else if (diff.localOnly > 0 && diff.remoteOnly === 0 && diff.conflicts === 0) {
        // local is newer: push only
        pushed = await engine.push();
        result = pushed.result;
      } else {
        // both sides changed (or conflicts): pull then push
        pulled = await engine.pull();
        pushed = await engine.push();
        result = pushed.result;
      }
      if (pulled && pulled.files > 0) {
        recordHistory(context, panel, 'pull', pulled.files, pulled.detail);
      }
      if (pushed && pushed.files > 0) {
        recordHistory(context, panel, 'push', pushed.files, pushed.detail);
      }
    }
    panel.setState({ status: 'ok', lastSyncAt: new Date().toISOString() });
    return result;
  } catch (err) {
    panel.setState({ status: 'error' });
    throw err;
  }
}

function recordHistory(
  context: vscode.ExtensionContext,
  panel: SyncPanel,
  direction: 'push' | 'pull',
  files: number,
  detail?: Record<string, number>
): void {
  const current = panel['state'].history || [];
  const entry: PanelState['history'][number] = {
    category: 'sync',
    files,
    direction: direction === 'push' ? 'up' : 'down',
    at: new Date().toISOString(),
    detail,
  };
  const history = [entry, ...current].slice(0, 50);
  panel.setState({ history });
  void context.globalState.update('copilotConfigSync.history', history);
}

function loadHistory(context: vscode.ExtensionContext): PanelState['history'] {
  return context.globalState.get<PanelState['history']>('copilotConfigSync.history', []);
}

async function refreshPanel(engine: SyncEngine, panel: SyncPanel, backend: GistBackend, context: vscode.ExtensionContext): Promise<void> {
  const manifest = scanManifest(defaultSources(), engine['opts'].deviceName);
  const counts: Record<string, number> = {};
  for (const [cat, data] of Object.entries(manifest.categories)) {
    if (cat === 'skills') {
      // count skills (SKILL.md entries), not files
      counts[cat] = data.files.filter((f) => f.path.toLowerCase().endsWith('/skill.md') || f.path.toLowerCase() === 'skill.md').length;
    } else {
      counts[cat] = data.files.length;
    }
  }
  const gistId = await backend.getGistId();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const state: Partial<PanelState> = {
    counts,
    enabled: engine['opts'].enabledCategories as Record<string, boolean>,
    categoryInfo: CATEGORY_INFO,
    gistId,
    gistName: config.get<string>('gistDescription', 'copilot-config-sync'),
    deviceName: engine['opts'].deviceName,
    hasPassphrase: Boolean(await engine['opts'].secretStorage.get('copilotConfigSync.passphrase')),
    status: gistId ? 'ok' : 'not-setup',
    version: context.extension.packageJSON.version as string,
    history: loadHistory(context),
  };
  panel.setState(state);
}

export function deactivate(): void {}

/** Where the models.dev catalog is cached between sessions. */
function catalogCacheFile(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'model-catalog.json');
}

/**
 * API key for the in-flight discovery flow. Held in extension memory only —
 * never round-tripped through the webview state.
 */
let pendingDiscoveryKey = '';

/** Secret-storage key under which we cache a group's API key for reuse. */
function savedKeyId(groupName: string): string {
  return `discovery.key.${groupName}`;
}

/**
 * Existing custom-endpoint groups, so the form can prefill instead of asking
 * the user to retype a URL they already configured.
 */
function existingGroups(): Array<{ name: string; url: string; apiType?: string; hasSavedKey: boolean }> {
  return readProviderGroups(lmProvidersPath())
    .filter((g) => g.vendor === CUSTOM_ENDPOINT_VENDOR)
    .map((g) => ({
      name: g.name,
      url: g.models?.[0]?.url ?? '',
      apiType: g.apiType,
      hasSavedKey: false,
    }));
}

/** Ids already configured for a group, so the UI can mark them as existing. */
function existingModelIds(groupName: string): Set<string> {
  const groups = readProviderGroups(lmProvidersPath());
  const group = groups.find((g) => g.vendor === CUSTOM_ENDPOINT_VENDOR && g.name === groupName);
  return new Set((group?.models ?? []).map((m) => m.id));
}

/**
 * Fetch the endpoint's model list, enrich it from the online catalog, and hand
 * the result to the panel for review.
 */
async function runDiscovery(
  panel: SyncPanel,
  context: vscode.ExtensionContext,
  opts: { baseUrl: string; apiKey: string; apiType: string; groupName: string; useSavedKey?: boolean }
): Promise<void> {
  panel.setState({
    discovery: {
      phase: 'loading',
      baseUrl: opts.baseUrl,
      apiType: opts.apiType,
      groupName: opts.groupName,
    },
  });
  // fall back to the key cached from a previous run for this group
  let apiKey = opts.apiKey;
  if (!apiKey && opts.useSavedKey) {
    apiKey = (await context.secrets.get(savedKeyId(opts.groupName))) ?? '';
  }
  pendingDiscoveryKey = apiKey;
  try {
    const apiType = opts.apiType as ApiType;
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const catalogPromise = loadCatalog({
      cacheFile: catalogCacheFile(context),
      catalogUrl: config.get<string>('discovery.catalogUrl'),
      maxAgeMs: config.get<number>('discovery.catalogMaxAgeDays', 7) * 24 * 60 * 60 * 1000,
    });
    let result;
    try {
      result = await discoverModels({ baseUrl: opts.baseUrl, apiKey, apiType });
      // New API's public pricing list carries capability tags that /v1/models
      // lacks, so merge them in when available.
      try {
        const pricing = await discoverFromPricing({ baseUrl: opts.baseUrl, apiKey: '', apiType });
        if (enrichModels(result.models, pricing.models) > 0) {
          result.warnings.push('已用公开模型列表补充能力标签');
        }
      } catch {
        // pricing is optional; ignore failures
      }
    } catch (err) {
      // New API rejects anonymous /v1/models but serves a public pricing list
      // that also carries capability tags. Only fall back when we have no key.
      if (apiKey) {
        throw err;
      }
      result = await discoverFromPricing({ baseUrl: opts.baseUrl, apiKey: '', apiType });
      result.warnings.push('已改用公开模型列表（无需密钥）');
    }
    const catalog = await catalogPromise;
    // remember the key so the next discovery run does not ask for it again
    if (apiKey) {
      await context.secrets.store(savedKeyId(opts.groupName), apiKey);
    }
    const resolved = resolveAll(result.models, catalog, {
      contextWindow: config.get<number>('discovery.defaultContextWindow'),
      maxOutputTokens: config.get<number>('discovery.defaultMaxOutputTokens'),
    });
    const existing = existingModelIds(opts.groupName);
    const models: DiscoveredModelView[] = result.models.map((model, i) => {
      const caps = resolved[i];
      return {
        id: model.id,
        name: caps.name || model.id,
        toolCalling: caps.toolCalling ?? true,
        vision: caps.vision ?? false,
        contextWindow: caps.contextWindow ?? 128_000,
        maxOutputTokens: caps.maxOutputTokens ?? 16_000,
        supportsReasoningEffort: caps.supportsReasoningEffort,
        sources: caps.sources as Record<string, string>,
        // pre-select only what is not configured yet
        selected: !existing.has(model.id),
        existing: existing.has(model.id),
      };
    });
    const warnings = [...result.warnings];
    if (Object.keys(catalog).length === 0) {
      warnings.push('在线模型表不可用（离线且无缓存），能力值来自端点或推测');
    }
    panel.setState({
      discovery: {
        phase: 'list',
        baseUrl: opts.baseUrl,
        apiType: opts.apiType,
        groupName: opts.groupName,
        models,
        warnings,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // a cached key that no longer works must not be reused silently
    const usedSavedKey = !opts.apiKey && Boolean(apiKey);
    if (usedSavedKey) {
      await context.secrets.delete(savedKeyId(opts.groupName));
    }
    panel.setState({
      discovery: {
        phase: 'form',
        baseUrl: opts.baseUrl,
        apiType: opts.apiType,
        groupName: opts.groupName,
        error: usedSavedKey ? `${message}（已保存的密钥可能已失效，请重新填写）` : message,
      },
    });
  }
}

/** Write the selected models into chatLanguageModels.json. */
async function applyDiscovery(panel: SyncPanel, models: DiscoveredModelView[]): Promise<void> {
  const state = panel['state'].discovery;
  if (!state?.baseUrl || !state.groupName) {
    return;
  }
  panel.setState({ discovery: { ...state, phase: 'applying' } });
  const apiType = state.apiType as ApiType;
  const entries = models.map((m) =>
    toModelEntry(
      m.id,
      {
        name: m.name,
        toolCalling: m.toolCalling,
        vision: m.vision,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        supportsReasoningEffort: m.supportsReasoningEffort,
      },
      state.baseUrl!,
      apiType
    )
  );
  try {
    const result = await applyDiscoveredModels({
      file: lmProvidersPath(),
      groupName: state.groupName,
      url: state.baseUrl,
      apiKey: pendingDiscoveryKey,
      apiType,
      entries,
      executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    });
    pendingDiscoveryKey = '';
    panel.setState({
      discovery: {
        ...state,
        phase: 'done',
        result: { added: result.added.length, kept: result.kept.length },
        keyStoredSecurely: result.keyStoredSecurely,
        keyOmitted: result.keyOmitted,
      },
    });
    pendingDiscoveryKey = '';
    panel.toast(
      `已写入 ${result.added.length} 个模型` +
        (result.kept.length ? `，跳过 ${result.kept.length} 个已存在的` : '')
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panel.setState({ discovery: { ...state, phase: 'list', error: message } });
  }
}

/** Fetch the newest VSIX asset from the "latest" release via the GitHub API. */
async function fetchLatestVersion(): Promise<{ version: string; url: string } | undefined> {
  const res = await fetch(RELEASE_API_URL, {
    headers: { 'User-Agent': 'copilot-config-sync', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return undefined;
  }
  const release = (await res.json()) as { assets?: Array<{ name?: string; browser_download_url?: string }> };
  const versioned = (release.assets || [])
    .map((a) => ({ name: a.name || '', url: a.browser_download_url || '' }))
    .filter((a) => /^copilot-config-sync-\d+\.\d+\.\d+\.vsix$/.test(a.name) && a.url);
  if (versioned.length === 0) {
    return undefined;
  }
  // numeric-aware sort: 0.1.10 must beat 0.1.9 (plain string compare fails here)
  const verOf = (name: string): [number, number, number] => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(name)!;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const newest = versioned.sort((a, b) => {
    const va = verOf(a.name);
    const vb = verOf(b.name);
    for (let i = 0; i < 3; i++) {
      if (va[i] !== vb[i]) {
        return vb[i] - va[i];
      }
    }
    return 0;
  })[0];
  const version = /(\d+\.\d+\.\d+)/.exec(newest.name)![1];
  return { version, url: newest.url };
}