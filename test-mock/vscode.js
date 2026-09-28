// minimal vscode mock for node-side testing
const store = new Map();
module.exports = {
  window: {
    showInputBox: async () => { throw new Error('passphrase prompt not available in mock'); },
    showQuickPick: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    withProgress: async (_o, task) => task(),
    createStatusBarItem: () => ({ show(){}, dispose(){} }),
  },
  commands: { registerCommand: () => ({ dispose(){} }) },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  authentication: { getSession: async () => { throw new Error('no auth in mock'); } },
  Uri: { joinPath: (...p) => ({ fsPath: p.map(x=>x.fsPath||x.path||x).join('/') }) },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Window: 10 },
  ExtensionMode: { Production: 1 },
  __store: store,
};
