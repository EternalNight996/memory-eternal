'use strict'

const vscode = require('vscode')

const URL = 'http://127.0.0.1:7999/?embed=1'

function frameHtml(webview) {
  const csp = [
    "default-src 'none'",
    'frame-src http://127.0.0.1:7999',
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
  ].join('; ')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #1e2228; }
  iframe { width: 100%; height: 100%; border: 0; display: block; background: #1e2228; }
</style>
</head>
<body><iframe src="${URL}" title="Memory Atlas"></iframe></body>
</html>`
}

class MemoryAtlasViewProvider {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true }
    view.webview.html = frameHtml(view.webview)
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('memory-eternal.view', new MemoryAtlasViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('memory-eternal.open', () => {
      const panel = vscode.window.createWebviewPanel(
        'memory-eternal.panel',
        'Memory Atlas',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      )
      panel.webview.html = frameHtml(panel.webview)
    }),
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
