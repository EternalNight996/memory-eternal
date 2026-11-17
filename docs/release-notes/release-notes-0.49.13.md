## 🔌 v0.49.13 — 一键挂载扩到 15 个宿主：Google 桌面端 / 阿里 / 月之暗面 / GrokBot 全进来

> 上一版（0.49.12）修的是「沉淀不丢卡」，这一版修的是「接得上」：MCP 客户端不再只有 Claude / Codex / Cursor 这一圈。

### 一、新增 6 个可一键挂载的宿主

| 宿主 | 配置位置 | 类型 |
|---|---|---|
| **Gemini CLI** | `~/.gemini/settings.json` → `mcpServers` | CLI（Google） |
| **Antigravity** | `~/.gemini/config/mcp_config.json` → `mcpServers` | **桌面 IDE（Google）** |
| **Cline** | `~/.cline/data/settings/cline_mcp_settings.json` | VS Code 扩展 |
| **Qwen Code** | `~/.qwen/settings.json` → `mcpServers` | CLI（阿里，Gemini CLI 同源） |
| **Kimi CLI** | `~/.kimi/mcp.json` | CLI（月之暗面） |
| **GrokBot** | `~/.grokbot/mcp.json` ／ `%APPDATA%\\GrokBot\\mcp.json` | 桌面客户端 |

统一口径：只增删 `memory-eternal` 这一条，别人的 server 与其它顶层键原样保留；写后回读校验；幂等。
别名也认：`gemini-cli`/`google`→`gemini`、`qwen-code`→`qwen`、`kimi-cli`→`kimi`、`roo`→`cline`。

### 二、README 支持表重做

拆成 **国际主流 / 国内主流 / 不用装进程** 三段，图例 `✅` 一键 · `⚠️` 有条件 · `➖` 手填 · `❌` 无 MCP 配置，中英严格对齐（readme-i18n 守卫）。

两个容易搞错的点已写进表里：

- **Antigravity 就是 Google 的桌面端**，配置在共用的 `.gemini/config/mcp_config.json`，不是 `.antigravity` 目录；
- **Gemini 桌面应用 / 网页版不提供 MCP 配置**，接不了 —— Google 侧能挂 MCP 的只有 Antigravity（桌面）与 Gemini CLI（终端）。

### 三、面板不再出现重复项

自动探测名单里原本还留着 openclaw / hermes / kimi / grokbot / mengbot / project —— 这些早已升级成可挂载宿主，
同一次面板刷新会出现两行同名项。现在探测名单只保留真正没有可写配置的 **VS Code / 智谱清言 / WorkBuddy**。

### 四、其它

- CLI 用法里的宿主清单改成从 `Object.keys(HOSTS)` 现算（以前写死，加宿主必过期）；
- `docs/INTEGRATIONS.md` 新增 Qwen Code / Kimi CLI / GrokBot 三节，速查表扩到 9 行，另加「只能在应用内加、没有外部配置文件」的客户端表（Cherry Studio / 智谱 / WorkBuddy / VS Code Copilot）；
- 修掉两处过期表述（“云端 HTTP 端点未提供”“MCP 侧只做 stdio”）；
- `llms-install.md` 字段名同步。

### 五、验证

| 套件 | 结果 |
|---|---|
| `tests/mcp-hosts.test.mjs` | **16/16**（+5：三家 JSON 宿主写入/回读/幂等/只删自己，GrokBot 的 APPDATA 回落） |
| `mcp-mount` / `mcp-manifests` / `readme-i18n` | 15 / 6 / 6 |
| `api` / `two-store` / `manifests` / `setup-node-path` / `body-limit` | 14 / 15 / 3 / 5 / 11 |
| 全仓 `npm test` | 163 个测试文件，fail 0 |

### 升级

```bash
npm i -g memory-eternal@0.49.13
cd ~/.dsh/profiles/desktop && pnpm add -w memory-eternal@0.49.13
cd ~/.dsh/profiles/web     && pnpm add -w memory-eternal@0.49.13
# 重启 DSH → 设置 → 🧪 实验性 → 🔌 Agent MCP 挂载：列表里会多出 6 行
```
