# Orca plugin — Memory Atlas 启动器

在 Orca 右侧栏添加一个「记忆」面板，一键在终端执行 `dsh-memory open`，打开本地 Memory Atlas Web UI。

## 安装

### 推荐：Git URL

Orca → Settings → Plugins → Install plugin → **Git URL**：

```text
https://github.com/EternalNight996/memory-eternal-orca#v0.12.1
```

Orca 会固定到 `v0.12.0` tag。

### 本地目录

1. 确认本机已安装并运行 `memory-eternal`（默认 Web 服务 `http://127.0.0.1:7999/`）。
2. 确认终端能找到 CLI：

```bash
dsh-memory --help
```

3. 在 Orca 中安装本目录：

```text
Orca → Plugins → Install plugin → 选择 orca-plugin/
```

4. 打开右侧栏的「记忆」图标，选择终端，点「打开 Memory Atlas」。

## 它做什么

- 调 Orca 官方 `workspace.readContext` 读取当前工作区终端
- 调 Orca 官方 `terminal.sendText` 执行 `dsh-memory open`
- 不 iframe、不 fetch、不复制第二套 UI

## 为什么不是完整内嵌 UI

Orca panel 使用严格沙箱 CSP：

```text
default-src 'none'
connect-src 'none'
img-src data:
```

因此 panel 内不能 iframe `127.0.0.1:7999`、不能 fetch API、不能 `window.open`。
完整 Memory Atlas 仍由 Web UI 提供；Orca 只做官方能力内的启动器。

## 权限

- `workspace:read`：读取当前工作区终端列表
- `terminal:send`：向指定终端发送命令

没有任何内存卡写入、审核批准或 agent 权限。
