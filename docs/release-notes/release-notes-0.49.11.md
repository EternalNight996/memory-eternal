## 🛰 v0.49.11 — MCP 三向打通：云端 HTTP 端点 · 令牌透传 · 三家宿主自动挂载

MengBot / OpenClaw / Hermes 三家都是"能不能接 MCP"的问题。这一版把**协议层、鉴权层、挂载层**三处缺口一次补齐，
并用可执行探针验证：本地 stdio、云端 HTTP、远端 stdio 转接，三条路都能真的读到同一份库。

### 一、🌐 MCP over HTTP：云端 bot 不用装进程

新增 `POST /memory-eternal/api/mcp`（MCP Streamable HTTP，**单次 JSON 响应**形态）：

| 方法 | 行为 |
|---|---|
| `POST` | JSON-RPC 单条 + 批量；`initialize` 下发 `mcp-session-id`；notification（无 id）回 202 |
| `GET` | 405 + 明确告知本端点不开 SSE 服务端流，请用 POST |
| `DELETE` | 结束会话 → 200 |

- 支持协议版本协商：`2025-06-18` / `2025-03-26` / `2024-11-05`，未知版本回落 `2024-11-05`；
- 工具与 stdio 侧**同一份实现**（`memory_recall` / `capture` / `stats` / `audit_list` / `revise`），不存在两套逻辑；
- 鉴权沿用现有栈：云端由 cloud-server 先验 `Authorization: Bearer me_…`，本机走 loopback + 同源闸门。

```bash
curl -s http://127.0.0.1:7999/memory-eternal/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 二、🔑 远端 stdio 带令牌（修掉必 401）

旧版 `MEMORY_API` 远端模式只带 `content-type`，连云端实例一律 401 —— 这是"MCP 连不上云"的根因；
`docs/CLOUD.md` 里写的 `--cloud` / `--token` 在 CLI 里**根本没有解析**。现在：

```bash
dsh-memory mcp --cloud https://mem.mengbot.com.cn --token me_xxx
```

- 令牌变成 `Authorization: Bearer`（也接受 `memory-eternal/api` 后缀地址，不会拼成双份）；
- 提示信息走 **stderr**，不污染 stdout 协议通道。

### 三、🔌 三家宿主可以自动挂载了（但都不强制）

`lib/mcp-hosts.js` 新增三个 adapter，与 dsh/claude/codex/cursor/windsurf 同一套标准（幂等、写前备份、写后回读、只碰自己的键）：

| 宿主 | 写哪里 | 保守设计 |
|---|---|---|
| **OpenClaw** | `.openclaw/openclaw.json` → `mcp.servers.memory-eternal` | 写标准 JSON（JSON5 超集）；**碰到注释/尾逗号就拒绝改写并提示手填**，绝不抹掉注释 |
| **Hermes** | `.hermes/config.yaml` → `mcp_servers.memory-eternal` | 无 YAML 依赖，块级编辑：只换自己那块，注释/其它键/缩进原样保留 |
| **MengBot** | 机器人项目 `.mcp.json` → `mcpServers.memory-eternal` | 必须 `MEMORY_HOST_MENGBOT_PROJECT=<项目根>` 才算已安装（不虚构路径）；应用内「设置 → MCP 服务器」仍是主路径 |

**"不强制"是硬约束，不是文案**：

- `parseHosts('')` 只返回 `['dsh']`；挂载状态文件为空时，除 DSH 外没有任何宿主会被写；
- 自动挂载的唯一自动行为是**DSH 插件挂到 DSH 自己**（`mcpAutoMount`，可关）；MengBot / OpenClaw / Hermes 一律要人手点或显式命令；
- MengBot 在本机没有可安全改写的用户级 JSON（`~/.mengbot/config.json` 只存引擎实例与内置工具白名单，不含 MCP），所以不碰它。

### 四、🔒 审核闸门默认收紧

`auditExemptKinds` 的代码默认值本来就是 `[]`，但本机活配置留了 `["project","content","business"]` ——
导致经 MCP `memory_capture` 降级写入的 `content` 卡**直接 approved 且立即可召回**，"人审才入库"形同虚设。
现已清空（备份 `memory-eternal-config.json.bak-audit-*`），MCP 写入一律进待审队列。

### 五、修的问题

- `docs/INTEGRATIONS.md` 三处硬错：OpenClaw 配置位置（`~/.openclaw/openclaw.json`，不是 `.openclaw/mcp.json`）、
  Hermes 位置同理、以及**"MengBot 引擎是 Claude Code"的误传**（官方口径 25+ 引擎，MCP 挂载面是应用内「MCP 服务器」+ 项目 `.mcp.json`）；
- `lib/setup.js` 的探测路径一并纠正，非 JSON 宿主改为给出真实位置提示（不再只甩一个"JSON 解析失败"）；
- 文档里的 `memory-eternal@0.30.0` 旧 pin 全部去掉；
- `package-lock.json` 根版本长期停在 0.45.0，已同步。

### 六、验证

| 套件 | 结果 |
|---|---|
| `tests/mcp-http.test.mjs`（新增） | 8/8：多版本协商 · 会话头 · notification 202 · 批量 · 三个错误码 · 真写真召回 · GET/DELETE |
| `tests/mcp-remote-token.test.mjs`（新增） | 2/2：服务端确实收到 `Bearer me_abc123`；带 `/memory-eternal/api` 后缀不拼重 |
| `tests/mcp-hosts.test.mjs` | 11/11（新增 OpenClaw/Hermes/MengBot 三条 adapter 用例） |
| 全仓 `npm test` | 165 步全绿、163 个测试文件 `fail 0` |

### 升级

```bash
npm i -g memory-eternal@0.49.11
cd ~/.dsh/profiles/desktop && pnpm add -w memory-eternal@0.49.11
cd ~/.dsh/profiles/web     && pnpm add -w memory-eternal@0.49.11
# 重启 DSH 后：HTTP 端点 POST /memory-eternal/api/mcp 生效；
# 设置 → 🧪 实验性 → Agent MCP 挂载 里会多出 OpenClaw / Hermes / MengBot 三行
```
