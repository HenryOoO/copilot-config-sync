import * as vscode from 'vscode';

export interface PanelState {
  status: 'idle' | 'syncing' | 'ok' | 'error' | 'not-setup';
  lastSyncAt?: string;
  lastSyncDevice?: string;
  gistId?: string;
  counts: Record<string, number>;
  enabled: Record<string, boolean>;
  history: Array<{ category: string; files: number; direction: 'up' | 'down'; at: string }>;
}

export class SyncPanel {
  private view: vscode.WebviewView | undefined;
  private state: PanelState;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onSyncNow: () => Promise<void>,
    private readonly onPush: () => Promise<void>,
    private readonly onPull: () => Promise<void>,
    private readonly onToggleCategory: (category: string, enabled: boolean) => Promise<void>,
    private readonly onReset: () => Promise<void>
  ) {
    this.state = {
      status: 'idle',
      counts: {},
      enabled: {},
      history: [],
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'syncNow':
          await this.onSyncNow();
          break;
        case 'push':
          await this.onPush();
          break;
        case 'pull':
          await this.onPull();
          break;
        case 'toggle':
          await this.onToggleCategory(msg.category, msg.enabled);
          break;
        case 'reset':
          await this.onReset();
          break;
        case 'ready':
          this.postState();
          break;
      }
    });
  }

  setState(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    this.postState();
  }

  private postState(): void {
    this.view?.webview.postMessage({ type: 'state', state: this.state });
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --pulse-speed: 1.6s;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-sideBar-foreground);
    background: var(--vscode-sideBar-background);
    padding: 14px 14px 20px;
    user-select: none;
  }

  /* ── header ── */
  .brand {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 4px;
  }
  .brand .glyph {
    width: 22px; height: 22px; border-radius: 6px;
    display: grid; place-items: center;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-weight: 700; font-size: 12px; letter-spacing: -0.5px;
  }
  .brand h1 {
    font-size: 13px; font-weight: 600; letter-spacing: 0.2px;
    color: var(--vscode-sideBar-foreground);
  }
  .statusline {
    display: flex; align-items: center; gap: 6px;
    font-size: 11.5px; color: var(--vscode-descriptionForeground);
    margin: 6px 0 12px 30px;
  }
  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--vscode-charts-green);
    flex: none;
  }
  .dot.syncing { background: var(--vscode-charts-yellow); animation: blink 1s infinite; }
  .dot.warn { background: var(--vscode-charts-orange); }
  .dot.off { background: var(--vscode-charts-gray, #888); }
  @keyframes blink { 50% { opacity: 0.35; } }

  /* ── signature: sync pulse ── */
  .pulse {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    border-radius: 8px;
    margin-bottom: 12px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .pulse .endpoint {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    display: flex; flex-direction: column; gap: 2px; align-items: center;
  }
  .pulse .endpoint .codicon-ish { font-size: 15px; line-height: 1; }
  .track {
    flex: 1; height: 3px; border-radius: 2px;
    background: var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    position: relative; overflow: hidden;
  }
  .track .flow {
    position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, var(--vscode-focusBorder, var(--vscode-button-background)), transparent);
    transform: translateX(-100%);
    animation: flow var(--pulse-speed) linear infinite;
    opacity: 0;
  }
  .pulse.syncing .track .flow { opacity: 1; }
  .pulse.ok .track .flow { animation: none; opacity: 0; }
  .pulse.ok .track::after {
    content: ''; position: absolute; inset: 0;
    background: var(--vscode-charts-green); border-radius: 2px;
    animation: settle 0.5s ease-out;
  }
  @keyframes flow { to { transform: translateX(100%); } }
  @keyframes settle { from { transform: scaleX(0); transform-origin: left; } }
  @media (prefers-reduced-motion: reduce) {
    .track .flow { animation: none; }
    .dot.syncing { animation: none; }
  }

  /* ── actions ── */
  .actions { display: flex; gap: 8px; margin-bottom: 16px; }
  button {
    font-family: var(--vscode-font-family);
    font-size: 12px; font-weight: 500;
    border: none; border-radius: 5px;
    padding: 6px 12px; cursor: pointer;
    transition: filter 0.12s;
  }
  button:hover { filter: brightness(1.12); }
  button:active { filter: brightness(0.92); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .primary {
    flex: 1;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:disabled { opacity: 0.5; cursor: default; }

  /* ── sections ── */
  .section-title {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.8px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 6px 2px;
  }
  .cat-list {
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2));
    border-radius: 8px; overflow: hidden;
    margin-bottom: 16px;
  }
  .cat {
    display: flex; align-items: center; gap: 9px;
    padding: 7px 11px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .cat:hover { background: var(--vscode-list-hoverBackground); }
  .cat + .cat { border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15)); }
  .cat input[type="checkbox"] {
    accent-color: var(--vscode-checkbox-background, var(--vscode-focusBorder));
    width: 14px; height: 14px; cursor: pointer;
  }
  .cat .name { flex: 1; font-size: 12.5px; }
  .cat .count {
    font-size: 11px; font-variant-numeric: tabular-nums;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 9px; padding: 1px 7px;
  }
  .cat.off .name { opacity: 0.55; }

  /* ── history ── */
  .history { display: flex; flex-direction: column; gap: 3px; }
  .h-item {
    display: flex; align-items: center; gap: 8px;
    font-size: 11.5px; color: var(--vscode-descriptionForeground);
    padding: 3px 2px;
  }
  .h-item .arrow { font-size: 11px; width: 14px; text-align: center; }
  .h-item .cat-name { color: var(--vscode-sideBar-foreground); }
  .h-item .time { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.75; }
  .empty {
    font-size: 11.5px; color: var(--vscode-descriptionForeground);
    padding: 8px 2px; font-style: italic;
  }

  /* ── footer ── */
  .footer {
    margin-top: 18px; padding-top: 10px;
    border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
    display: flex; justify-content: space-between; align-items: center;
  }
  .footer .gist {
    font-size: 10.5px; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 70%;
  }
  .footer .reset {
    background: none; color: var(--vscode-errorForeground);
    font-size: 10.5px; padding: 2px 6px; cursor: pointer;
  }
  .footer .reset:hover { text-decoration: underline; filter: none; }
</style>
</head>
<body>
  <div class="brand">
    <div class="glyph">⇄</div>
    <h1>Copilot Config Sync</h1>
  </div>
  <div class="statusline"><span class="dot" id="dot"></span><span id="statusText">…</span></div>

  <div class="pulse" id="pulse">
    <div class="endpoint"><span class="codicon-ish">⌂</span>本机</div>
    <div class="track"><div class="flow"></div></div>
    <div class="endpoint"><span class="codicon-ish">☁</span>云端</div>
  </div>

  <div class="actions">
    <button class="primary" id="syncBtn">立即同步</button>
    <button class="secondary" id="pushBtn">推送</button>
    <button class="secondary" id="pullBtn">拉取</button>
  </div>

  <div class="section-title">同步内容</div>
  <div class="cat-list" id="cats"></div>

  <div class="section-title">最近同步</div>
  <div id="history"><div class="empty">还没有同步记录</div></div>

  <div class="footer">
    <span class="gist" id="gist">未连接</span>
    <button class="reset" id="resetBtn">重置</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  function render(state) {
    const dot = $('dot'), text = $('statusText'), pulse = $('pulse');
    dot.className = 'dot';
    pulse.className = 'pulse';
    const syncBtn = $('syncBtn');
    syncBtn.disabled = state.status === 'syncing';
    $('pushBtn').disabled = state.status === 'syncing';
    $('pullBtn').disabled = state.status === 'syncing';
    switch (state.status) {
      case 'syncing':
        dot.classList.add('syncing'); text.textContent = '同步中…'; pulse.classList.add('syncing');
        break;
      case 'ok': {
        dot.classList.add(''); text.textContent = '已同步' + (state.lastSyncAt ? ' · ' + relTime(state.lastSyncAt) : '');
        pulse.classList.add('ok');
        break;
      }
      case 'warn': dot.classList.add('warn'); text.textContent = '有冲突待处理'; break;
      case 'not-setup': dot.classList.add('off'); text.textContent = '未设置 — 点击「立即同步」开始'; break;
      default: text.textContent = '空闲';
    }
    // categories
    const cats = Object.keys(state.counts);
    const catList = $('cat-list-placeholder');
    const listEl = document.getElementById('cats');
    listEl.innerHTML = cats.map((c) => {
      const on = state.enabled[c] !== false;
      return '<div class="cat' + (on ? '' : ' off') + '" data-cat="' + c + '">' +
        '<input type="checkbox" ' + (on ? 'checked' : '') + ' aria-label="' + c + '">' +
        '<span class="name">' + label(c) + '</span>' +
        '<span class="count">' + (state.counts[c] || 0) + '</span>' +
        '</div>';
    }).join('');
    listEl.querySelectorAll('.cat').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') {
          vscode.postMessage({ type: 'toggle', category: el.dataset.cat, enabled: e.target.checked });
        }
      });
    });
    // history
    const hist = document.getElementById('history');
    if (state.history && state.history.length) {
      hist.innerHTML = state.history.slice(0, 5).map((h) =>
        '<div class="h-item"><span class="arrow">' + (h.direction === 'up' ? '↑' : '↓') + '</span>' +
        '<span class="cat-name">' + label(h.category) + '</span>' +
        '<span>' + h.files + ' 文件</span>' +
        '<span class="time">' + relTime(h.at) + '</span></div>'
      ).join('');
    } else {
      hist.innerHTML = '<div class="empty">还没有同步记录</div>';
    }
    $('gist').textContent = state.gistId ? 'gist ' + state.gistId.slice(0, 10) + '…' : '未连接';
  }

  function label(c) {
    const names = { skills: 'Skills', instructions: 'Instructions', agents: 'Agents', hooks: 'Hooks', prompts: 'Prompts', mcp: 'MCP Servers', lmProviders: 'LM Providers' };
    return names[c] || c;
  }
  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  window.addEventListener('message', (e) => {
    if (e.data.type === 'state') render(e.data.state);
  });
  document.getElementById('syncBtn').addEventListener('click', () => vscode.postMessage({ type: 'syncNow' }));
  document.getElementById('pushBtn').addEventListener('click', () => vscode.postMessage({ type: 'push' }));
  document.getElementById('pullBtn').addEventListener('click', () => vscode.postMessage({ type: 'pull' }));
  document.getElementById('resetBtn').addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}