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
      await runSync(engine, panel);
    },
    async () => {
      await runOp(panel, '推送中…', () => engine.push());
    },
    async () => {
      await runOp(panel, '拉取中…', () => engine.pull());
    },
    async (category, enabled) => {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const current = config.get<Record<string, boolean>>('categories', {});
      await config.update('categories', { ...current, [category]: enabled }, vscode.ConfigurationTarget.Global);
      engine['opts'].enabledCategories[category as CategoryId] = enabled;
    },
    async () => {
      const confirm = await vscode.window.showWarningMessage(
        '删除远端同步？本地文件不受影响。',
        { modal: true },
        '删除'
      );
      if (confirm !== '删除') {
        return;
      }
      await backend.delete();
      panel.setState({ status: 'not-setup', gistId: undefined, history: [] });
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'copilotConfigSync.panel',
      { resolveWebviewView: (view) => panel.resolveWebviewView(view) },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.text = '$(cloud-upload) Copilot Sync';
  statusBar.tooltip = 'Copilot Config Sync';
  statusBar.command = 'copilotConfigSync.syncNow';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const wrap = (title: string, fn: () => Promise<string>) => async () => {
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn);
      statusBar.text = '$(cloud-upload) Copilot Sync ✓';
      vscode.window.showInformationMessage(`Copilot Config Sync: ${result}`);
    } catch (err) {
      statusBar.text = '$(cloud-upload) Copilot Sync ⚠';
      const message = err instanceof Error ? err.message : String(err);
      if (message !== 'passphrase required' && message !== 'cancelled') {
        vscode.window.showErrorMessage(`Copilot Config Sync: ${message}`);
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotConfigSync.syncNow', wrap('Syncing Copilot config…', () => runSync(engine, panel))),
    vscode.commands.registerCommand(
      'copilotConfigSync.push',
      wrap('Pushing Copilot config…', async () => {
        const r = await engine.push();
        await refreshPanel(engine, panel, backend);
        return String(r);
      })
    ),
    vscode.commands.registerCommand(
      'copilotConfigSync.pull',
      wrap('Pulling Copilot config…', async () => {
        const r = await engine.pull();
        await refreshPanel(engine, panel, backend);
        return String(r);
      })
    ),
    vscode.commands.registerCommand('copilotConfigSync.showStatus', async () => {
      const gistId = await backend.getGistId();
      vscode.window.showInformationMessage(gistId ? `Sync gist: ${gistId}` : 'No remote sync yet. Run "Copilot Sync: Push" first.');
    }),
    vscode.commands.registerCommand('copilotConfigSync.resetSync', async () => {
      const confirm = await vscode.window.showWarningMessage('Delete the remote sync bundle? Local files are not touched.', { modal: true }, 'Delete');
      if (confirm !== 'Delete') {
        return;
      }
      await backend.delete();
      panel.setState({ status: 'not-setup', gistId: undefined, history: [] });
    })
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
      result = choice.value === 'push' ? String(await engine.push()) : String(await engine.pull());
    } else {
      await engine.pull();
      result = String(await engine.push());
    }
    panel.setState({ status: 'ok', lastSyncAt: new Date().toISOString() });
    return result;
  } catch (err) {
    panel.setState({ status: 'error' });
    throw err;
  }
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
    counts[cat] = data.files.length;
  }
  const gistId = await backend.getGistId();
  const state: Partial<PanelState> = {
    counts,
    enabled: engine['opts'].enabledCategories as Record<string, boolean>,
    gistId,
    status: gistId ? 'ok' : 'not-setup',
  };
  panel.setState(state);
}

export function deactivate(): void {}