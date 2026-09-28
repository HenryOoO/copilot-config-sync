import * as vscode from 'vscode';

export interface PanelState {
  status: 'idle' | 'syncing' | 'ok' | 'error' | 'not-setup';
  lastSyncAt?: string;
  gistId?: string;
  gistName?: string;
  deviceName?: string;
  hasPassphrase?: boolean;
  counts: Record<string, number>;
  enabled: Record<string, boolean>;
  history: Array<{ category: string; files: number; direction: 'up' | 'down'; at: string; detail?: Record<string, number> }>;
  version?: string;
  update?: { latest: string; command: string };
  checkingUpdate?: boolean;
  /** true after at least one update check in this session. */
  updateChecked?: boolean;
  /** Transient in-panel toast; replaces native bottom-right messages. */
  toast?: { text: string; kind: 'info' | 'error'; seq: number };
}

export class SyncPanel {
  private view: vscode.WebviewView | undefined;
  private state: PanelState;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onSyncNow: () => Promise<void>,
    private readonly onToggleCategory: (category: string, enabled: boolean) => Promise<void>,
    private readonly onSetup: (mode: 'create' | 'connect', gistName: string, gistId: string, passphrase: string) => Promise<void>,
    private readonly onSaveSettings: (settings: { gistName: string; gistId: string; deviceName: string; passphrase?: string }) => Promise<void>,
    private readonly onCheckUpdate: () => Promise<void>
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
        case 'toggle':
          await this.onToggleCategory(msg.category, msg.enabled);
          break;
        case 'setup':
          await this.onSetup(msg.mode, msg.gistName, msg.gistId, msg.passphrase);
          break;
        case 'saveSettings':
          await this.onSaveSettings(msg.settings);
          break;
        case 'checkUpdate':
          this.setState({ checkingUpdate: true });
          this.onCheckUpdate();
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

  /** Show a transient toast inside the panel instead of a native message. */
  toast(text: string, kind: 'info' | 'error' = 'info'): void {
    this.setState({ toast: { text, kind, seq: (this.state.toast?.seq || 0) + 1 } });
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
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-sideBar-foreground);
    background: var(--vscode-sideBar-background);
    padding: 14px 14px 28px;
    user-select: none;
    position: relative;
  }

  /* ── header ── */
  .statusline {
    display: flex; align-items: center; gap: 6px;
    font-size: 11.5px; color: var(--vscode-descriptionForeground);
    margin: 2px 0 12px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-charts-green); flex: none; }
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
  .track-wrap {
    flex: 1; position: relative;
    display: flex; flex-direction: column; align-items: center;
  }
  .label-row {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 3px;
  }
  .track-label {
    font-size: 9.5px; font-weight: 600; letter-spacing: 0.5px;
    color: var(--vscode-sideBar-foreground);
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    padding: 0 6px;
    white-space: nowrap;
    line-height: 1.4;
  }
  .pulse.ok .track-label { color: var(--vscode-charts-green); }
  .pulse.off .track-label { color: var(--vscode-charts-gray, #888); }
  .ver-btn {
    background: none; border: none; cursor: pointer;
    font-family: var(--vscode-font-family);
    font-size: 9.5px; font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: var(--vscode-descriptionForeground);
    padding: 0 2px; line-height: 1.4;
    white-space: nowrap;
  }
  .ver-btn:hover { color: var(--vscode-sideBar-foreground); text-decoration: underline; filter: none; }
  .ver-btn:disabled { cursor: default; text-decoration: none; opacity: 0.6; }
  .track {
    width: 100%; height: 3px; border-radius: 2px;
    background: var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    position: relative; overflow: hidden;
  }
  .track .flow {
    position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, var(--vscode-focusBorder, var(--vscode-button-background)), transparent);
    transform: translateX(-100%);
    animation: flow 1.6s linear infinite;
    opacity: 0;
  }
  .pulse.syncing .track .flow { opacity: 1; }
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
  .primary { flex: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }

  /* ── sections ── */
  .section-title {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.8px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 6px 2px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .section-title .manage {
    background: none; border: none; cursor: pointer;
    font-size: 10.5px; letter-spacing: 0.4px;
    color: var(--vscode-focusBorder, var(--vscode-button-background));
    padding: 0 2px; text-transform: none; font-weight: 500;
  }
  .section-title .manage:hover { text-decoration: underline; filter: none; }

  .cat-list {
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2));
    border-radius: 8px; overflow: hidden;
    margin-bottom: 16px;
  }
  .cat-list.hidden { display: none; }
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
    width: 14px; height: 14px; cursor: pointer; pointer-events: none;
  }
  .cat .name { flex: 1; font-size: 12.5px; }
  .cat .count {
    font-size: 11px; font-variant-numeric: tabular-nums;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 9px; padding: 1px 7px;
  }
  .cat.off .name { opacity: 0.55; }
  .cat-actions { display: flex; gap: 8px; margin: 8px 2px 16px; }
  .cat-actions.hidden { display: none; }

  /* ── history (scrollable, lazy) ── */
  .history {
    display: flex; flex-direction: column; gap: 3px;
    max-height: 132px; overflow-y: auto;
    padding-right: 2px;
  }
  .history::-webkit-scrollbar { width: 8px; }
  .history::-webkit-scrollbar-thumb { background: var(--vscode-editorWidget-border, rgba(128,128,128,0.3)); border-radius: 4px; }
  .h-item {
    display: flex; align-items: center; gap: 8px;
    font-size: 11.5px; color: var(--vscode-descriptionForeground);
    padding: 3px 4px; flex: none;
    border-radius: 4px; cursor: pointer;
  }
  .h-item:hover { background: var(--vscode-list-hoverBackground); }
  .h-item:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .h-item .arrow { font-size: 11px; width: 14px; text-align: center; }
  .h-item .cat-name { color: var(--vscode-sideBar-foreground); }
  .h-item .time { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.75; }
  .empty { font-size: 11.5px; color: var(--vscode-descriptionForeground); padding: 8px 2px; font-style: italic; }

  /* ── setup (first-run) ── */
  .setup { margin-bottom: 16px; }
  .setup .hint {
    font-size: 11.5px; color: var(--vscode-descriptionForeground);
    line-height: 1.5; margin-bottom: 12px;
  }
  .field { margin-bottom: 10px; }
  .field label {
    display: block; font-size: 11px; font-weight: 600;
    color: var(--vscode-sideBar-foreground); margin-bottom: 4px;
  }
  .field input {
    width: 100%;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px; padding: 5px 8px;
    outline: none;
  }
  .field input:focus { border-color: var(--vscode-focusBorder); }
  .field .sub { font-size: 10.5px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .mode-row { display: flex; gap: 6px; margin-bottom: 12px; }
  .mode-row button {
    flex: 1; padding: 5px 8px; font-size: 11.5px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-radius: 5px;
  }
  .mode-row button.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .setup .error {
    font-size: 11px; color: var(--vscode-errorForeground);
    margin: 4px 0 8px; min-height: 14px;
  }
  .hidden { display: none; }

  /* ── global settings ── */
  .settings {
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2));
    border-radius: 8px;
    padding: 10px 11px;
    margin-bottom: 8px;
  }
  .dirty-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--vscode-charts-green);
    display: inline-block;
  }
  .dirty-dot.hidden { display: none; }

  /* ── in-panel toast ── */
  .toast {
    position: fixed; left: 50%; bottom: 14px;
    transform: translateX(-50%);
    max-width: calc(100% - 24px);
    padding: 7px 12px;
    border-radius: 6px;
    font-size: 11.5px;
    line-height: 1.45;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    z-index: 200;
    animation: toast-in 0.18s ease-out;
    user-select: text;
  }
  .toast.error { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  .toast.leaving { animation: toast-out 0.25s ease-in forwards; }
  @keyframes toast-in { from { opacity: 0; transform: translate(-50%, 6px); } }
  @keyframes toast-out { to { opacity: 0; transform: translate(-50%, 6px); } }

  /* ── detail modal ── */
  .modal-mask {
    position: absolute; inset: 0;
    background: rgba(0,0,0,0.4);
    display: grid; place-items: center;
    z-index: 100;
  }
  .modal-mask.hidden { display: none; }
  .modal {
    width: 240px; max-height: 320px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    border-radius: 8px;
    padding: 12px;
    display: flex; flex-direction: column;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }
  .modal h2 {
    font-size: 12px; font-weight: 600; margin-bottom: 2px;
  }
  .modal-x {
    position: absolute; top: 6px; right: 8px;
    background: none; border: none;
    font-size: 16px; line-height: 1;
    color: var(--vscode-descriptionForeground);
    padding: 2px 6px; cursor: pointer;
  }
  .modal-x:hover { color: var(--vscode-sideBar-foreground); filter: none; }
  .modal { position: relative; }
  .modal .sub { font-size: 10.5px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  .modal .rows { overflow-y: auto; flex: 1; }
  .modal .row {
    display: flex; align-items: center; gap: 8px;
    font-size: 11.5px; padding: 4px 2px;
  }
  .modal .row .name { flex: 1; }
  .modal .row .n { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  .modal .close {
    margin-top: 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    align-self: flex-end;
  }
</style>
</head>
<body>
  <div class="statusline"><span class="dot" id="dot"></span><span id="statusText">…</span></div>
  <div class="toast hidden" id="toast"></div>

  <!-- setup: shown when not connected -->
  <div class="setup" id="setup">
    <div class="hint">连接一个私有 Gist 来保存你的 Copilot 配置。口令用于加密配置中的敏感字段，<b>丢失后无法恢复</b>。</div>
    <div class="mode-row">
      <button id="modeCreate" class="active">新建 Gist</button>
      <button id="modeConnect">连接已有</button>
    </div>
    <div class="field" id="fieldName">
      <label>Gist 名称</label>
      <input type="text" id="gistName" value="copilot-config-sync" placeholder="copilot-config-sync">
      <div class="sub">用于识别你的同步仓库</div>
    </div>
    <div class="field hidden" id="fieldGistId">
      <label>Gist ID</label>
      <input type="text" id="gistIdInput" placeholder="粘贴 gist id（网址最后一段）">
    </div>
    <div class="field">
      <label>同步口令</label>
      <input type="password" id="passphrase" placeholder="设置一个口令">
      <div class="sub">加密敏感字段（API key 等）。仅存本机钥匙串，不会上传。</div>
    </div>
    <div class="field hidden" id="fieldPassphrase2">
      <label>确认口令</label>
      <input type="password" id="passphrase2" placeholder="再输入一次">
    </div>
    <div class="error" id="setupError"></div>
    <div class="actions" style="margin-bottom:0">
      <button class="primary" id="setupBtn">初始化</button>
    </div>
  </div>

  <!-- connected: main UI -->
  <div id="main" class="hidden">
    <div class="pulse" id="pulse">
      <div class="endpoint"><span class="codicon-ish">⌂</span>本机</div>
      <div class="track-wrap"><div class="label-row"><span class="track-label" id="trackLabel"></span><button class="ver-btn" id="verBtn" title="点击检查更新"></button></div><div class="track"><div class="flow"></div></div></div>
      <div class="endpoint"><span class="codicon-ish">☁</span>云端</div>
    </div>

    <div class="actions">
      <button class="primary" id="syncBtn" style="width:100%">立即同步</button>
    </div>

    <div class="section-title">
      <span>同步内容</span>
      <span id="manageArea">
        <button class="manage" id="manageBtn">管理</button>
        <button class="manage hidden" id="manageSave">保存</button>
        <button class="manage hidden" id="manageCancel">取消</button>
      </span>
    </div>
    <div class="cat-list" id="cats"></div>

    <div class="section-title"><span>最近同步</span></div>
    <div class="history" id="history"><div class="empty">还没有同步记录</div></div>

    <div class="modal-mask hidden" id="modalMask">
      <div class="modal" role="dialog" aria-modal="true">
        <button class="modal-x" id="modalX" aria-label="关闭">×</button>
        <h2 id="modalTitle">同步详情</h2>
        <div class="sub" id="modalSub"></div>
        <div class="rows" id="modalRows"></div>
        <button class="close" id="modalClose">关闭</button>
      </div>
    </div>

    <div class="section-title" style="margin-top:16px">
      <span>全局设置</span>
      <span id="settingsDirty" class="dirty-dot hidden" title="有未保存的修改"></span>
      <span id="settingsArea">
        <button class="manage" id="settingsEdit">修改设置</button>
        <button class="manage hidden" id="settingsSave">保存修改</button>
        <button class="manage hidden" id="settingsCancel">取消</button>
      </span>
    </div>
    <div class="settings" id="settings">
      <div class="field">
        <label>Gist 名称</label>
        <input type="text" id="setGistName" placeholder="copilot-config-sync" disabled>
        <div class="sub">用于自动识别你的同步仓库（新建时也用这个名称）</div>
      </div>
      <div class="field">
        <label>Gist ID</label>
        <input type="text" id="setGistId" placeholder="留空则按名称自动查找/创建" disabled>
        <div class="sub">显式指定后所有机器强制连到这一个 gist</div>
      </div>
      <div class="field">
        <label>本机设备名</label>
        <input type="text" id="setDeviceName" placeholder="默认为主机名" disabled>
        <div class="sub">记录在同步清单里，用于区分哪台机器推送的</div>
      </div>
      <div class="field">
        <label>同步口令</label>
        <input type="password" id="setPassphrase" placeholder="已设置 — 输入新值可更换" disabled>
        <div class="sub">加密敏感字段。更换口令后，其他机器需用新口令才能解密。</div>
      </div>
      <div class="error" id="settingsError"></div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let current = null;
  let managing = false;
  let draftEnabled = {};
  let mode = 'create';

  function label(c) {
    const names = { skills: 'Skills', instructions: 'Instructions', agents: 'Agents', hooks: 'Hooks', prompts: 'Prompts', mcp: 'MCP Servers', lmProviders: 'LM Providers', sync: '同步' };
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

  function renderCats() {
    const listEl = $('cats');
    const cats = Object.keys(current.counts);
    listEl.innerHTML = cats.map((c) => {
      const on = managing ? (draftEnabled[c] !== false) : (current.enabled[c] !== false);
      const cb = managing ? '<input type="checkbox" ' + (on ? 'checked' : '') + ' tabindex="-1">' : '';
      return '<div class="cat' + (on ? '' : ' off') + '" data-cat="' + c + '">' +
        cb +
        '<span class="name">' + label(c) + '</span>' +
        '<span class="count">' + (current.counts[c] || 0) + '</span>' +
        '</div>';
    }).join('');
    if (managing) {
      listEl.querySelectorAll('.cat').forEach((el) => {
        el.addEventListener('click', () => {
          const cat = el.dataset.cat;
          draftEnabled[cat] = draftEnabled[cat] === false ? true : false;
          renderCats();
        });
      });
    }
  }

  function setManaging(on) {
    managing = on;
    $('manageBtn').classList.toggle('hidden', on);
    $('manageSave').classList.toggle('hidden', !on);
    $('manageCancel').classList.toggle('hidden', !on);
    if (on) {
      draftEnabled = Object.assign({}, current.enabled);
    }
    renderCats();
  }

  let toastTimer = null;
  let lastToastSeq = 0;
  let autoCopiedFor = null;
  function showToast(text, kind) {
    const el = $('toast');
    clearTimeout(toastTimer);
    el.textContent = text;
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    // force reflow so re-triggering restarts the entry animation
    void el.offsetWidth;
    toastTimer = setTimeout(() => {
      el.classList.add('leaving');
      toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 260);
    }, kind === 'error' ? 6000 : 3000);
  }

  function render(state) {
    current = state;
    if (state.toast && state.toast.seq !== lastToastSeq) {
      lastToastSeq = state.toast.seq;
      showToast(state.toast.text, state.toast.kind);
    }
    const connected = state.gistId && state.status !== 'not-setup';
    $('setup').classList.toggle('hidden', connected);
    $('main').classList.toggle('hidden', !connected);

    if (!connected) {
      $('statusText').textContent = '未设置 — 填写下方信息开始';
      $('dot').className = 'dot off';
      return;
    }

    const dot = $('dot'), text = $('statusText'), pulse = $('pulse');
    dot.className = 'dot';
    pulse.className = 'pulse';
    const busy = state.status === 'syncing';
    $('syncBtn').disabled = busy;
    const trackLabel = $('trackLabel');
    switch (state.status) {
      case 'syncing': dot.classList.add('syncing'); text.textContent = '同步中…'; pulse.classList.add('syncing'); trackLabel.textContent = '同步中'; break;
      case 'ok': text.textContent = '已同步' + (state.lastSyncAt ? ' · ' + relTime(state.lastSyncAt) : ''); pulse.classList.add('ok'); trackLabel.textContent = '已同步'; break;
      case 'error': dot.classList.add('warn'); text.textContent = '同步出错'; pulse.classList.add('off'); trackLabel.textContent = '已断开'; break;
      default: text.textContent = '空闲'; pulse.classList.add('off'); trackLabel.textContent = '未连接';
    }
    renderCats();
    if (managing) { /* keep edit mode visuals */ }

    // version button doubles as the check-update trigger
    const verBtn = $('verBtn');
    const checking = state.checkingUpdate === true;
    verBtn.disabled = checking;
    verBtn.textContent = checking ? '检查中…' : 'v' + (state.version || '?');

    // newer version found: copy install command automatically (once per version)
    if (state.update && state.version && state.update.latest !== state.version) {
      if (autoCopiedFor !== state.update.latest) {
        autoCopiedFor = state.update.latest;
        navigator.clipboard.writeText(state.update.command).then(() => {
          showToast('发现新版本 ' + state.update.latest + '，更新命令已复制到剪贴板', 'info');
        });
      }
    } else if (state.updateChecked) {
      showToast('已是最新版本 ' + (state.version || ''), 'info');
    }

    // settings inputs: refill only when not mid-edit (no unsaved changes)
    if (!editingSettings) {
      fillSettings();
    }

    // history: lazy render in batches, load more on scroll
    const hist = $('history');
    histItems = state.history || [];
    histShown = 0;
    if (histItems.length) {
      hist.innerHTML = '';
      renderMoreHistory();
    } else {
      hist.innerHTML = '<div class="empty">还没有同步记录</div>';
    }
  }

  const HIST_BATCH = 10;
  let histItems = [];
  let histShown = 0;

  function renderMoreHistory() {
    const hist = $('history');
    const batch = histItems.slice(histShown, histShown + HIST_BATCH);
    batch.forEach((h, i) => {
      const div = document.createElement('div');
      div.className = 'h-item';
      div.tabIndex = 0;
      div.setAttribute('role', 'button');
      div.innerHTML =
        '<span class="arrow">' + (h.direction === 'up' ? '↑' : '↓') + '</span>' +
        '<span class="cat-name">' + label(h.category) + '</span>' +
        '<span>' + h.files + ' 项</span>' +
        '<span class="time">' + relTime(h.at) + '</span>';
      const idx = histShown + i;
      div.addEventListener('click', () => openDetail(idx));
      div.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDetail(idx); });
      hist.appendChild(div);
    });
    histShown += batch.length;
  }

  function openDetail(idx) {
    const h = histItems[idx];
    if (!h) return;
    $('modalTitle').textContent = (h.direction === 'up' ? '推送' : '拉取') + '详情';
    $('modalSub').textContent = relTime(h.at) + ' · 共 ' + h.files + ' 项';
    const rows = $('modalRows');
    const detail = h.detail && Object.keys(h.detail).length
      ? h.detail
      : (h.files > 0 ? { [h.category]: h.files } : {});
    const entries = Object.entries(detail);
    rows.innerHTML = entries.length
      ? entries.map(([cat, n]) =>
          '<div class="row"><span class="name">' + label(cat) + '</span><span class="n">' + n + ' 项</span></div>'
        ).join('')
      : '<div class="empty">无变更</div>';
    $('modalMask').classList.remove('hidden');
    $('modalClose').focus();
  }

  // setup UI
  $('modeCreate').addEventListener('click', () => {
    mode = 'create';
    $('modeCreate').classList.add('active');
    $('modeConnect').classList.remove('active');
    $('fieldName').classList.remove('hidden');
    $('fieldGistId').classList.add('hidden');
    $('fieldPassphrase2').classList.remove('hidden');
    $('setupBtn').textContent = '初始化';
  });
  $('modeConnect').addEventListener('click', () => {
    mode = 'connect';
    $('modeConnect').classList.add('active');
    $('modeCreate').classList.remove('active');
    $('fieldName').classList.add('hidden');
    $('fieldGistId').classList.remove('hidden');
    $('fieldPassphrase2').classList.remove('hidden');
    $('setupBtn').textContent = '连接';
  });
  $('setupBtn').addEventListener('click', () => {
    const pass = $('passphrase').value;
    const confirmVal = $('passphrase2').value;
    if (!pass || pass.length < 4) { $('setupError').textContent = '口令至少 4 个字符'; return; }
    if (confirmVal && pass !== confirmVal) { $('setupError').textContent = '两次输入的口令不一致'; return; }
    const gistName = $('gistName').value.trim() || 'copilot-config-sync';
    const gistId = $('gistIdInput').value.trim();
    if (mode === 'connect' && !gistId) { $('setupError').textContent = '请填写 Gist ID'; return; }
    $('setupError').textContent = '';
    vscode.postMessage({ type: 'setup', mode, gistName, gistId, passphrase: pass });
  });
  // global settings: read-only until 修改设置, dirty dot on change
  let editingSettings = false;
  let savedSnapshot = {};
  function snapshotSettings() {
    return {
      gistName: $('setGistName').value,
      gistId: $('setGistId').value,
      deviceName: $('setDeviceName').value,
      passphrase: $('setPassphrase').value,
    };
  }
  function isDirty() {
    return editingSettings && JSON.stringify(snapshotSettings()) !== JSON.stringify(savedSnapshot);
  }
  function refreshDirty() {
    $('settingsDirty').classList.toggle('hidden', !isDirty());
  }
  function setEditingSettings(on) {
    editingSettings = on;
    $('settingsEdit').classList.toggle('hidden', on);
    $('settingsSave').classList.toggle('hidden', !on);
    $('settingsCancel').classList.toggle('hidden', !on);
    ['setGistName', 'setGistId', 'setDeviceName', 'setPassphrase'].forEach((id) => {
      $(id).disabled = !on;
    });
    if (on) {
      $('setGistName').focus();
    } else {
      $('settingsError').textContent = '';
      fillSettings();
    }
    refreshDirty();
  }
  function fillSettings() {
    $('setGistName').value = current.gistName || 'copilot-config-sync';
    $('setGistId').value = current.gistId || '';
    $('setDeviceName').value = current.deviceName || '';
    $('setPassphrase').value = '';
    $('setPassphrase').placeholder = current.hasPassphrase ? '已设置 — 输入新值可更换' : '设置一个口令';
    savedSnapshot = snapshotSettings();
    refreshDirty();
  }
  ['setGistName', 'setGistId', 'setDeviceName', 'setPassphrase'].forEach((id) => {
    $(id).addEventListener('input', refreshDirty);
  });
  $('settingsEdit').addEventListener('click', () => setEditingSettings(true));
  $('settingsCancel').addEventListener('click', () => setEditingSettings(false));
  $('modalClose').addEventListener('click', () => $('modalMask').classList.add('hidden'));
  $('modalX').addEventListener('click', () => $('modalMask').classList.add('hidden'));
  $('modalMask').addEventListener('click', (e) => {
    if (e.target === $('modalMask')) $('modalMask').classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('modalMask').classList.add('hidden');
  });

  // lazy load on scroll
  $('history').addEventListener('scroll', () => {
    const el = $('history');
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20 && histShown < histItems.length) {
      renderMoreHistory();
    }
  });

  $('settingsSave').addEventListener('click', () => {
    const pass = $('setPassphrase').value;
    if (pass && pass.length < 4) { $('settingsError').textContent = '口令至少 4 个字符'; return; }
    $('settingsError').textContent = '';
    savedSnapshot = snapshotSettings();
    refreshDirty();
    setEditingSettings(false);
    vscode.postMessage({
      type: 'saveSettings',
      settings: {
        gistName: $('setGistName').value.trim() || 'copilot-config-sync',
        gistId: $('setGistId').value.trim(),
        deviceName: $('setDeviceName').value.trim(),
        passphrase: pass || undefined,
      },
    });
  });

  $('manageBtn').addEventListener('click', () => setManaging(true));
  $('manageSave').addEventListener('click', () => {
    Object.keys(draftEnabled).forEach((c) => {
      if ((current.enabled[c] !== false) !== (draftEnabled[c] !== false)) {
        vscode.postMessage({ type: 'toggle', category: c, enabled: draftEnabled[c] !== false });
      }
    });
    setManaging(false);
  });
  $('manageCancel').addEventListener('click', () => setManaging(false));
  $('syncBtn').addEventListener('click', () => vscode.postMessage({ type: 'syncNow' }));
  $('verBtn').addEventListener('click', () => {
    if (current && current.checkingUpdate) return;
    vscode.postMessage({ type: 'checkUpdate' });
  });

  window.addEventListener('message', (e) => {
    if (e.data.type === 'state') render(e.data.state);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}