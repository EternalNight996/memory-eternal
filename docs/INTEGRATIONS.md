# 第三方 Agent 接入：MengBot / OpenClaw / Hermes

memory-eternal 对外就是一个**标准 MCP stdio server**（零依赖 JSON-RPC 2.0，入口 `node bin/dsh-memory.mjs mcp`），
所以「支持某个 agent」= 在它的 MCP 配置里加一条 server 定义。同一份 SQLite 库可以被多个 agent 共用，也可以按库隔离。

> 本页的宿主字段名/配置文件位置按各家 2026-11 官方文档核对过（Gemini CLI `~/.gemini/settings.json`、
> Antigravity `~/.gemini/config/mcp_config.json`、Cline `cline_mcp_settings.json`、
> OpenClaw `~/.openclaw/openclaw.json`、Hermes `~/.hermes/config.yaml`、MengBot 应用内「MCP 服务器」+ 项目 `.mcp.json`）。
> 各家偶尔会改版，接不上时先看本节末尾的「验证清单」。

## 通用启动命令

```bash
# 不安装、按需拉取（推荐写进各客户端配置；-p 指定包名、再给 bin 名，两者都写最稳）
npx -y -p @mengbot/mem dsh-memory mcp

# 已全局安装
npm i -g @mengbot/mem
dsh-memory mcp
```

MCP 能力（5 个工具）：`memory_recall` / `memory_capture` / `memory_stats` / `memory_audit_list` / `memory_revise`。

> 写入语义：MCP 侧**不能批准**任何卡（`memory_audit_list` 只读，无 approve/reject 工具）。
> 但卡进不进审核队列由本机配置决定：`auditMode` 与 `auditExemptKinds`（见「已知边界」一节的第 2 条）。
> 想让所有 agent 的写入都必经人审，就把 `content` 从 `auditExemptKinds` 里去掉。

## 云端 / 远程：MCP over HTTP（Streamable HTTP）

本机 agent 用 stdio 就够；**云端托管的 bot 摸不到本机进程**，走同一条记忆库的 HTTP 端点：

```bash
# 端点与其它业务接口同一个 API 前缀；云端实例必须带令牌 Authorization: Bearer me_xxx
curl -s http://127.0.0.1:7999/memory-eternal/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- 形态：**单次 JSON 响应（stateless）**。`initialize` 会下发 `mcp-session-id`，后续请求可带上；`notification`（无 id）回 202；批量 JSON-RPC 支持。
- `GET` 不开 SSE 服务端流（统一回 405，告知用 POST）；`DELETE` 结束会话。
- 客户端支持 `streamable-http` 时直接填这个 URL：OpenClaw 用 `transport: "streamable-http"`、Hermes 用 `url`，
  云端实例在 `headers` 里带 `Authorization: Bearer me_…`。
- 想保留 stdio 让宿主照常拉起、但读写落到远端实例：
  ```bash
  dsh-memory mcp --cloud https://mem.mengbot.vip --token me_xxx
  ```
  令牌会变成 `Authorization`（实测：不带令牌云端业务接口一律 401，带令牌召回/统计正常）。
  **注意**：`memory_audit_list` 与 `memory_revise` 依赖本地审核库，远端模式下仍读本机库。

## Hermes Agent（NousResearch）

配置文件：`~/.hermes/config.yaml`（`hermes config edit` 打开；YAML）

```yaml
mcp_servers:
  memory-eternal:
    command: npx
    args: ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"]
    # env:                      # 可选：换库 / 关掉自动审核
    #   MEMORY_VAULT_DIR: ~/.dsh/memory-vault-hermes
```

- 外层键是 **`mcp_servers`**（不是 `mcpServers`），stdio 字段是 `command` / `args` / `env`。
- 工具过滤：`tools.include` / `tools.exclude`（fnmatch glob，两者同设时 include 优先）；`enabled: false` 整条停用。
- HTTP 传输也支持（`url`，默认 Streamable HTTP；`transport: sse` 切 SSE）——本服务的 MCP 侧只有 stdio，用不到。
- 验证：`hermes mcp test memory-eternal`（exit 0 通）；会话内改配置后 `/reload-mcp`。

## OpenClaw

配置文件：`~/.openclaw/openclaw.json`（**JSON5**，允许注释与尾逗号；`OPENCLAW_CONFIG_PATH` 可指向别处）。
同一份东西也可以从 Control UI 的 **Settings → MCP → Add server → Stdio** 写（`/settings/mcp`）。

```json5
{
  mcp: {
    servers: {
      "memory-eternal": {
        command: "npx",
        args: ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"],
      },
    },
  },
}
```

- 外层键是 **`mcp.servers`**（注意不是顶层的 `mcpServers`）；stdio 字段 `command` / `args` / `env` / `cwd`。
- 工具过滤：`mcp.servers.<name>.toolFilter.include` / `.exclude`（精确名或 `*` glob）；`.enabled: false` 停用。
- HTTP 传输支持 `url` + `transport: "streamable-http" | "sse"`（旧写法 `type: "http"` 会被规范化）——本服务不需要。
- 验证：`openclaw mcp probe memory-eternal`（也有 `openclaw mcp add|set|list|show|tools`）。

## MengBot

**先纠正一个常见误传**：MengBot 的引擎不是单一 Claude Code，官方口径是 25+ 引擎并列
（Claude Code / Codex / Cursor / Grok / Gemini CLI / Kimi / Droid / OpenCode / Qwen / Hermes / 自定义 ACP 等）。
所以这里讲的不是「Claude 的配置」，而是 MengBot 自己的 MCP 挂载面。

挂载位置（按优先级）：

1. **应用内 → 设置 → MCP 服务器**：给当前 bot/实例挂 MCP server（这是主路径）；
2. **机器人项目内的 `.mcp.json`**：跟在项目里跑的 Claude/Codex 引擎一起生效，格式沿用 Claude Code 约定：

```json
{
  "mcpServers": {
    "memory-eternal": {
      "command": "npx",
      "args": ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"],
      "env": {}
    }
  }
}
```

> 这条 stdio 条目是**按 `.mcp.json` 约定推定**的写法（MengBot 官方文档没有给 MCP server 的 JSON 示例），
> 落库前用下面的验证清单确认一遍。

- 本机唯一的文档化 JSON 是 `~/.mengbot/config.json` → `instances.<id>.{ driver, config.tools, config.disallowedTools }`，
  它只管**引擎内置工具**的白名单/黑名单，**不授予也不预批 MCP**——别把 MCP 条目写进去。
- **每 bot 独立记忆**：给不同实例设不同的 `MEMORY_VAULT_DIR`；**共用一份**：不设或设成同一个目录，
  审核仍由你在 DSH / Web 面板完成。
- **隔离**：Claude 引擎只认「应用内 MCP 服务器 + 集成 + 项目 `.mcp.json`」，不继承本机 `~/.claude`；
  除非显式设 `OMB_CLAUDE_INHERIT_USER_CONFIG=1`。
- **云托管的 bot 连不到本地 stdio**：走 HTTP 端点 `POST /memory-eternal/api/mcp`（见「云端 / 远程」一节）。
- MengBot 自己的 `MEMORY.md` 仍是它的工作区记忆，两者不冲突：MEMORY.md 是"这个 bot 现在在做的事"，
  memory-eternal 是"审核过的长期结论"。

## Gemini CLI（Google）

配置文件：`~/.gemini/settings.json`（用户级）；项目级是同形状的 `<repo>/.gemini/settings.json`。

```json
{
  "mcpServers": {
    "memory-eternal": {
      "command": "npx",
      "args": ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"],
      "env": { "MEMORY_VAULT_DIR": "C:\\Users\\<you>\\.dsh\\memory-vault-ok" },
      "trust": true,
      "includeTools": ["memory_recall", "memory_capture", "memory_stats"]
    }
  }
}
```

- 外层键 **`mcpServers`**，与其它配置（`theme`、`mcp` 全局段…）平级；自动挂载只增删自己那一条。
- **环境变量会被清洗**：启动 MCP 子进程时默认剥离 `*KEY*` / `*TOKEN*` / `*SECRET*` / `*AUTH*` 类宿主变量，
  只有你在 `env` 里显式写出的才会传进去 —— `MEMORY_VAULT_DIR` 必须写死。
- `trust` 默认 `false`（每次工具调用都要确认）；`includeTools` / `excludeTools` 收窄暴露面，`excludeTools` 优先。
- 远端形态：`url`（SSE）或 `httpUrl`（Streamable HTTP）。验证：会话里敲 `/mcp`。

## Antigravity（Google）

配置文件：`~/.gemini/config/mcp_config.json`（全局）；插件可自带 `plugins/<name>/mcp_config.json`。

```json
{
  "mcpServers": {
    "memory-eternal": {
      "command": "npx",
      "args": ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"],
      "env": { "MEMORY_VAULT_DIR": "C:\\Users\\<you>\\.dsh\\memory-vault-ok" }
    }
  }
}
```

- stdio 字段：`command` / `args` / `env`；远端只认 `url`（Streamable HTTP，旧键 `serverUrl` 也吃）。
- **不认 2024-11-05 的 legacy HTTP+SSE** —— 别把 `url` 指向 `/sse`；指向 `POST /memory-eternal/api/mcp` 即可。
- 配好后 agent 自动 discovery，工具直接出现在工具集里，没有额外启用开关。

> **Antigravity 就是 Google 的“桌面端”** —— 它是桌面 IDE（agentic IDE），配置文件在用户目录的 `.gemini/config/mcp_config.json`，
> 不是 `.antigravity` 之类的新目录，别找错地方。
>
> 另有一个同名易混的东西：**Gemini 桌面应用 / 网页版**（macOS / Windows 聊天客户端 + gemini.google.com）。
> 它只是聊天界面，**不提供 MCP 客户端配置**，因此接不进 memory-eternal —— Google 侧能挂 MCP 的桌面形态就是 Antigravity。

## Cline

配置文件（CLI）：`~/.cline/data/settings/cline_mcp_settings.json`（可用 `CLINE_MCP_SETTINGS_PATH` 覆盖）；
VS Code 扩展版把同一份放在 `%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings`。

```json
{
  "mcpServers": {
    "memory-eternal": {
      "command": "npx",
      "args": ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"]
    }
  }
}
```

- 面板 **MCP Servers → Configure → Configure MCP Servers** 打开的就是这份文件；远端支持 Streamable HTTP（推荐）与 SSE（legacy）。
- 自动挂载优先写「用户实际在用的那份」：`MEMORY_HOST_CLINE_PATH` → 已有 CLI 文件 → IDE 的 globalStorage。

## Qwen Code（阿里）

配置文件：`~/.qwen/settings.json`（用户级）；项目级是 `<repo>/.qwen/settings.json`，两者同形。

```json
{
  "mcpServers": {
    "memory-eternal": {
      "command": "npx",
      "args": ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"],
      "env": { "MEMORY_VAULT_DIR": "C:\\Users\\<you>\\.dsh\\memory-vault-ok" }
    }
  }
}
```

- 与 Gemini CLI 同源，所以键名（`mcpServers`）与`trust`/`includeTools`/`excludeTools`这套过滤都一样；
- 也可以用它自己的命令加：`qwen mcp add --scope user memory-eternal npx -y -p @mengbot/mem dsh-memory mcp`（写的就是上面那个文件）；
- 会话里 `/mcp` 查看与管理已连接的 server。

## Kimi CLI（月之暗面）

配置文件：用户级 `~/.kimi/mcp.json`（**只有一个作用域**，没有按项目覆盖，也没有 `--mcp-config` 参数）。

```json
{
  "mcpServers": {
    "memory-eternal": {
      "command": "npx",
      "args": ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"]
    }
  }
}
```

- 超时一类参数走 `KIMI_MCP_*` 环境变量；
- 想按项目隔离库，就靠 `env` 里的 `MEMORY_VAULT_DIR` 区分。

## GrokBot

**官方没有公开 MCP 配置文件文档**，本机按两个最常见约定探测，实际生效位置以你装的版本为准：

- 用户目录：`~/.grokbot/mcp.json`；
- Windows 漫游目录：`%APPDATA%\\GrokBot\\mcp.json`。

```json
{
  "mcpServers": {
    "memory-eternal": {
      "command": "npx",
      "args": ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"]
    }
  }
}
```

- 自动挂载会写「已存在的那份」，两份都不存在时写到用户目录那份；想指定就用 `MEMORY_HOST_GROKBOT_PATH`；
- 如果它其实是应用内配置（没有外部 JSON），就照应用内面板填同一段 stdio。

## 各家速查

| | 配置文件 | 顶层键 | 工具过滤 | 自动挂载 |
|---|---|---|---|---|
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` | `includeTools`/`excludeTools` / `trust` | ✅ |
| Antigravity | `~/.gemini/config/mcp_config.json` | `mcpServers` | 无（agent 侧确认） | ✅ |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | `mcpServers` | 无 MCP 级过滤 | ✅ |
| Hermes Agent | `~/.hermes/config.yaml` | `mcp_servers` | `tools.include`/`exclude` | ✅ |
| OpenClaw | `~/.openclaw/openclaw.json`（JSON5） | `mcp.servers` | `toolFilter.include`/`exclude` | ✅（含注释拒绝改写） |
| Qwen Code | `~/.qwen/settings.json` | `mcpServers` | `includeTools`/`excludeTools` / `trust` | ✅ |
| Kimi CLI | `~/.kimi/mcp.json` | `mcpServers` | 无 | ✅ |
| GrokBot | `~/.grokbot/mcp.json` 或 `%APPDATA%\\GrokBot\\mcp.json` | `mcpServers` | 无（官方未公开） | ✅（按约定） |
| MengBot | 应用内「MCP 服务器」+ 项目 `.mcp.json` | `mcpServers`（.mcp.json） | 无 MCP 级过滤文档 | ⚠️ 需项目根 |

这些客户端都支持 Streamable HTTP / SSE；memory-eternal 侧同时提供 **stdio**（本地进程）与 **HTTP**（`POST /memory-eternal/api/mcp`，单次 JSON 响应形态），本地宿主按 stdio 接最省事。

**没有可写配置文件、只能在应用内添加的**：

| 客户端 | 怎么加 |
|---|---|
| Cherry Studio | 设置 → MCP 服务器（配置存在 Redux/localStorage，没有外部 JSON） |
| 智谱清言 / ZhipuAI | 应用内 MCP 面板，填同一段 stdio |
| WorkBuddy | 应用内 MCP 设置 |
| VS Code Copilot | 新版用 portable `mcpServers`、旧版用 `mcp.json` 的 `servers`，键与位置不唯一，按版本手填 |

## 自动挂载器覆盖到哪

能**自动写配置**的宿主：DSH、Claude Code、Codex CLI、Cursor、Windsurf、**Gemini CLI**、**Antigravity**、**Cline**、**Qwen Code**、**Kimi CLI**、**GrokBot**、项目根 `.mcp.json`，
以及本次新增的 **OpenClaw**（`.openclaw/openclaw.json` 的 `mcp.servers`）、
**Hermes**（`.hermes/config.yaml` 的 `mcp_servers`，YAML 块级编辑、注释与其它键原样保留）、
**MengBot**（机器人项目 `.mcp.json`，需用 `MEMORY_HOST_MENGBOT_PROJECT` 指向项目根）。

三条保守设计，别当成 bug：

- OpenClaw 配置是 JSON5，**含注释时拒绝改写**并提示手填（宁可不做，也不抹掉你的注释）；
- Hermes 只改 `mcp_servers` 段里自己那一块，不重排整个文件；
- MengBot 的应用内「设置 → MCP 服务器」没有文档化的可写 JSON，所以自动挂载只写项目 `.mcp.json`。

## 验证清单

```bash
# 1) 协议握手（应返回 serverInfo + tools 列表）
npx -y -p @mengbot/mem dsh-memory mcp

# 2) 库路径是否正确
dsh-memory stats

# 3) 宿主侧探针
hermes mcp test memory-eternal      # Hermes
openclaw mcp probe memory-eternal   # OpenClaw
```

| 现象 | 原因 |
|---|---|
| 首次调用卡 10–20s | `npx` 在下载包；写进配置后只发生一次 |
| 工具列表为空 | 客户端没读到 `mcp` 子命令参数（必须是 `… dsh-memory mcp`） |
| 握手崩、客户端报协议错 | 宿主的 stdout 被别人的 console.log 污染；本服务日志只走 stderr |
| Windows 上找不到 node | 用绝对路径 `command: "C:\\Program Files\\nodejs\\node.exe"`（面板里的「挂载」会写绝对路径） |
| 召回为空 | 库是空的，先去 DSH 面板审核几张卡 |
| 多 agent 看到不同内容 | 各自设了不同的 `MEMORY_VAULT_DIR` |

## 已知边界

1. **HTTP 端点只有 POST 单次响应形态，没有 SSE 服务端流。** 只接受流式 SSE 的客户端要退回 POST；
   `GET` 会拿到 405。远端 stdio 模式下 `memory_audit_list` / `memory_revise` 仍读本机审核库（审核必须在人那一侧完成，这是有意为之）。
2. **审核闸门是按 kind / agent 豁免的。** `auditMode: "all"` 只对**未豁免**的 kind 生效；
   默认配置里 `auditExemptKinds: ["project","content","business"]`，意味着经 MCP `memory_capture`
   降级写入的 `content` 卡会**直接 approved 并立即可召回**。要守住"人审才入库"，把这三项删掉。
3. **多宿主共用一个库时，星标/技能卡等 DSH 专属能力只在 DSH 面板里可见**，其它宿主拿到的是卡片文本。

## 相关

- [MCP 安装页（llms-install.md）](../llms-install.md)
- [分发清单（各 MCP 目录）](MCP_DISTRIBUTION.md)
