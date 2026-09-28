import * as vscode from 'vscode';
import { SyncEngine } from './core/engine';
import { GistBackend } from './storage/gist';
import { CategoryId } from './core/types';
import { SyncPanel, PanelState } from './ui/panel';
import { scanManifest, defaultSources } from './core/scanner';

const CONFIG_SECTION = 'copilotConfigSync';

const ALL_CATEGORIES: CategoryId[] = ['skills', 'instructions', 'agents', 'hooks', 'prompts', 'mcp', 'lmProviders'];

const RELEASE_API_URL = 'https://api.github.com/repos/HenryOoO/copilot-config-sync/releases/tags/latest';

function installCommand(url: string): string {
  return `curl -L -o /tmp/ccs.vsix ${url} && "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension /tmp/ccs.vsix`;
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
          panel.toast(`发现新版本 ${latest.version}，更新命令已复制到剪贴板`);
        }
      } catch {
        panel.setState({ checkingUpdate: false, updateChecked: true });
        panel.toast('无法获取最新版本信息', 'error');
      }
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
        panel.setState({ status: 'ok', lastSyncAt: new Date().toISOString() });
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
  const newest = versioned.sort((a, b) => b.name.localeCompare(a.name))[0];
  const version = /(\d+\.\d+\.\d+)/.exec(newest.name)![1];
  return { version, url: newest.url };
}