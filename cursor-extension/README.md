# Cursor / VS Code extension — Memory Atlas

在 Cursor / VS Code 左侧 Activity Bar 添加「Memory Atlas」，用 Webview 加载同一套 Memory Atlas Web UI。

## 安装

1. 安装依赖并打包扩展：

```bash
cd cursor-extension
npx @vscode/vsce package
```

2. Cursor / VS Code：

```text
Extensions → ... → Install from VSIX
```

或开发模式：

```bash
code --extensionDevelopmentPath=.
```

## 使用

- 左侧 Activity Bar 出现 Memory Atlas 图标
- 面板内 iframe 加载 `http://127.0.0.1:7999/?embed=1`
- 命令面板：`Memory Atlas: Open`

## 前提

- `memory-eternal` 的本地 Web 服务在 `127.0.0.1:7999` 运行
- 启动命令：`dsh-memory open`

## 说明

- 这是真正的 Webview 内嵌，不是外部浏览器跳转
- 与 DSH/Web 共用同一份 `web/app.js`，版本一致
- 不新增 agent 权限；审批仍在 Web UI 由人完成
