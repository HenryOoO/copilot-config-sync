import * as vscode from 'vscode';
import { SyncEngine } from './core/engine';
import { GistBackend } from './storage/gist';
import { CategoryId } from './core/types';
import { SyncPanel, PanelState } from './ui/panel';
import { scanManifest, defaultSources } from './core/scanner';

const CONFIG_SECTION = 'copilotConfigSync';

const ALL_CATEGORIES: CategoryId[] = ['skills', 'instructions', 'agents', 'hooks', 'prompts', 'mcp', 'lmProviders'];

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
        await runSync(engine, panel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== 'passphrase required' && message !== 'cancelled') {
          vscode.window.showErrorMessage(`Copilot Config Sync: ${message}`);
        }
      }
    },
    async () => {
      try {
        await runOp(panel, '推送中…', async () => {
          const r = await engine.push();
          recordHistory(panel, 'push', r.files);
          await refreshPanel(engine, panel, backend);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== 'passphrase required' && message !== 'cancelled') {
          vscode.window.showErrorMessage(`Copilot Config Sync: ${message}`);
        }
      }
    },
    async () => {
      try {
        await runOp(panel, '拉取中…', async () => {
          const r = await engine.pull();
          recordHistory(panel, 'pull', r.files);
          await refreshPanel(engine, panel, backend);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== 'passphrase required' && message !== 'cancelled') {
          vscode.window.showErrorMessage(`Copilot Config Sync: ${message}`);
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
        await refreshPanel(engine, panel, backend);
        vscode.window.showInformationMessage('Copilot Config Sync: 已连接，可以开始同步了');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Copilot Config Sync: ${message}`);
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
        await refreshPanel(engine, panel, backend);
        vscode.window.showInformationMessage('Copilot Config Sync: 设置已保存');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Copilot Config Sync: ${message}`);
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

  void refreshPanel(engine, panel, backend);
}

async function runSync(engine: SyncEngine, panel: SyncPanel): Promise<string> {
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
      recordHistory(panel, choice.value, op.files);
    } else {
      const before = categoryCounts(engine);
      const pulled = await engine.pull();
      const pushed = await engine.push();
      result = pushed.result;
      const after = categoryCounts(engine);
      // one aggregated entry per sync: direction by net effect
      const files = (pulled.files || 0) + (pushed.files || 0);
      const detail: Record<string, number> = {};
      for (const cat of Object.keys({ ...before, ...after })) {
        const delta = (after[cat] || 0) - (before[cat] || 0);
        if (delta !== 0) {
          detail[cat] = delta;
        }
      }
      recordHistory(panel, 'push', files, Object.keys(detail).length ? detail : undefined);
    }
    panel.setState({ status: 'ok', lastSyncAt: new Date().toISOString() });
    return result;
  } catch (err) {
    panel.setState({ status: 'error' });
    throw err;
  }
}

function recordHistory(
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
  panel.setState({
    history: [entry, ...current].slice(0, 50),
  });
}

/** Per-category file counts from the current manifest. */
function categoryCounts(engine: SyncEngine): Record<string, number> {
  const manifest = scanManifest(defaultSources(), engine['opts'].deviceName);
  const out: Record<string, number> = {};
  for (const [cat, data] of Object.entries(manifest.categories)) {
    out[cat] = data.files.length;
  }
  return out;
}

async function runOp(panel: SyncPanel, title: string, fn: () => Promise<unknown>): Promise<void> {
  panel.setState({ status: 'syncing' });
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn);
    panel.setState({ status: 'ok', lastSyncAt: new Date().toISOString() });
  } catch (err) {
    panel.setState({ status: 'error' });
    throw err;
  }
}

async function refreshPanel(engine: SyncEngine, panel: SyncPanel, backend: GistBackend): Promise<void> {
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
  };
  panel.setState(state);
}

export function deactivate(): void {}