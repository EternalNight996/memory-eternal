# dsh-TUI plugin — `/memory`

在 dsh-TUI 里增加一个用户命令：

```text
/memory
```

执行后确保 `memory-eternal` 的本地 Web 服务存活，并打开同一套 Memory Atlas Web UI。

## 安装

在 `memory-eternal` 仓库根目录：

```bash
# 本地 profile（推荐先用这个验证）
dsh plugin --profile dsh-tui add ./dsh-tui-plugin
```

或手动：

1. 把本目录复制到 dsh-TUI profile 的 node_modules；
2. 在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: memory-eternal-tui
      name: 'memory-eternal-tui'
```

3. 重启 dsh-TUI。

## 使用

```text
/memory
```

- 优先执行 `dsh-memory open`（确保 7999 存活 + 打开浏览器）
- 找不到 CLI 时直接打开 `http://127.0.0.1:7999/`
- 不会在 TUI 内嵌 WebView，也不复制第二套 UI
- 审批仍在 Web 里由人完成，不新增 agent 工具

## 要求

- `memory-eternal` 已安装在当前机器
- 终端能执行 `dsh-memory`（否则走 URL 兜底）
- dsh-TUI >= 0.9.0（commands seam）
