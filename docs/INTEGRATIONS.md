# 第三方 Agent 接入：MengBot / OpenClaw / Hermes

memory-eternal 对外就是一个**标准 MCP stdio server**，所以「支持某个 agent」= 在它的 MCP 配置里加一条 server 定义。同一份 SQLite 库可以被多个 agent 共用，也可以按库隔离。

## 通用启动命令

```bash
# 不安装、按需拉取（推荐写进各客户端配置）
npx -y memory-eternal@0.30.0 mcp

# 已全局安装
npm i -g memory-eternal
dsh-memory mcp
```

MCP 能力（5 个工具）：`memory_recall` / `memory_capture` / `memory_stats` / `memory_audit_list` / `memory_revise`。

> 写入语义：agent 只能**提交待审卡**，不会直接改主库——审核闸门在 memory-eternal 内部，和 agent 是谁无关。

## Hermes Agent（NousResearch）

配置文件：`~/.hermes/config.yaml`

```yaml
mcp_servers:
  memory-eternal:
    command: npx
    args: ["-y", "memory-eternal@0.30.0", "mcp"]
```

Hermes 启动时会自动发现工具。若想限制只暴露部分工具，用它的 per-server 过滤（见官方 MCP 文档）。

## OpenClaw

配置位置：`mcp.servers`（Control UI 的 **Settings → MCP → Add server → Stdio** 写的就是这里）

```json
{
  "mcp": {
    "servers": {
      "memory-eternal": {
        "command": "npx",
        "args": ["-y", "memory-eternal@0.30.0", "mcp"]
      }
    }
  }
}
```

验证连通性（OpenClaw 自带探针）：

```bash
openclaw mcp doctor memory-eternal --probe
```

## MengBot

MengBot 的 bot 引擎（Claude Code）支持**按 bot 自定义 MCP server**，stdio 规格是 `{ command, args, env }`：

```json
{
  "memory-eternal": {
    "command": "npx",
    "args": ["-y", "memory-eternal@0.30.0", "mcp"],
    "env": {}
  }
}
```

要点：

- **每 bot 独立记忆**：给不同 bot 设不同的 `MEMORY_VAULT_DIR`，就是各自独立的库；
- **共用一份记忆**：不设（或设为同一个目录），多个 bot 共享同一库，审核仍由你在 DSH / Web 面板完成；
- MengBot 自己的 `MEMORY.md` 仍是它的工作区记忆，两者不冲突：MEMORY.md 是"这个 bot 现在在做的事"，memory-eternal 是"审核过的长期结论"。

## 验证清单

```bash
# 1) 协议握手（应返回 serverInfo + tools 列表）
npx -y memory-eternal@0.30.0 mcp

# 2) 库路径是否正确
dsh-memory stats
```

| 现象 | 原因 |
|---|---|
| 首次调用卡 10–20s | `npx` 在下载包；写进配置后只发生一次 |
| 工具列表为空 | 客户端没读到 `mcp` 子命令参数（必须是 `memory-eternal ... mcp`） |
| 召回为空 | 库是空的，先去 DSH 面板审核几张卡 |
| 多 agent 看到不同内容 | 各自设了不同的 `MEMORY_VAULT_DIR` |

## 相关

- [MCP 安装页（llms-install.md）](../llms-install.md)
- [分发清单（各 MCP 目录）](MCP_DISTRIBUTION.md)
