# 🧠 memory-eternal — 给 AI 装「第二大脑」

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-3B82F6" alt="DSH plugin" />
  <img src="https://img.shields.io/npm/v/memory-eternal" alt="npm version" />
  <img src="https://img.shields.io/github/stars/EternalNight996/memory-eternal?style=flat" alt="GitHub stars" />
  <img src="https://img.shields.io/github/license/EternalNight996/memory-eternal" alt="license" />
  <a href="https://dsh.market/"><img src="https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg" alt="DSH Market 收录" /></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-eternal.gif" width="880" alt="对话自动沉淀 + 图形化知识库 + 知识图谱（演示）" />
</p>

> **对话结束自动沉淀，跨会话不失忆；召回只取相关小块，省 token 少噪音。**
> 全自研、零第三方记忆框架、不改 DSH 源码、一个记忆库所有 Agent 共享，SQLite 持久存储，零外部依赖。

<p align="center"><strong>⭐ 觉得好用就点个 Star</strong>！ <br/><sub>DSH 一条命令：<code>dsh plugin --profile web add memory-eternal</code></sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-popup.png" width="32%" alt="记忆库弹窗：知识卡 / 检索 / 知识图谱" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-settings.png" width="32%" alt="DSH 设置 → 记忆：全部配置项" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-sidebar.png" width="32%" alt="侧边栏一键入口" />
</p>

---

## 🚀 五分钟上手

### 🟦 DeepSeek Harness（DSH）—— 重点

**装**（官方桌面版走插件市场，`dsh web` 用一条 CLI）：

```bash
# ① 官方 DeepSeek Harness 桌面版（推荐）：设置 → 插件 → 搜 memory-eternal 安装
#    等价 CLI（该壳的 profile 名就是 desktop）：
dsh plugin --profile desktop add memory-eternal

# ② dsh web（浏览器端）：
dsh plugin --profile web add memory-eternal

# 或在 profile（pnpm workspace）里直接更新。注意用 pnpm，npm install 会报 EUNSUPPORTEDPROTOCOL
cd ~/.dsh/profiles/web && pnpm add memory-eternal@latest

# 刚发新版时 @latest 可能被 pnpm 的最小发布年龄门槛/元数据缓存挡住（静默停在旧版）：
# 直接指定版本号最快，pnpm 会自动把它加进 workspace 的 minimumReleaseAgeExclude
cd ~/.dsh/profiles/web && pnpm add memory-eternal@0.9.6

# 验版本（应等于上面装的号），然后重启对应宿主生效
node -e "console.log(require('memory-eternal/package.json').version)"
```

#### 🖥️ 桌面版支持策略（先看这条）

- **优先、且只保证支持官方 DeepSeek Harness 桌面版**（官方 Electron 发行版，profile 名 `desktop`）。v0.9.4 → v0.9.6 三轮修复全部围绕它：0.1.7 设置服务换血、`schemastery 3.18.4` 的 volatile 活引用、以及窗口标题栏避让（`data-windows-titlebar`，避免全屏浮层压住最小化/最大化/关闭）。
- **作者自研的 `dsh-desktop`（`dsh-desktop-shell` / `dsh-ui-*` / `dsh-plugin-marketplace` 那一套）已停止维护**，不再作为支持目标 —— 官方桌面版已覆盖同样能力，继续维护两条壳只会分裂兼容性。注意它的 profile 依赖里还钉着已从 npm 撤下的 `dsh-desktop-shell@0.3.0`，会让 `pnpm install` 直接失败；**建议迁到官方桌面版，并从 profile 里删掉这套依赖**。
- 兼容矩阵（均已实测）：官方桌面版 `desktop` profile（schemastery **3.18.4**）＋ `dsh web` 的 `web` profile（schemastery **3.18.1**），两条路径共用同一份代码。

**重启宿主**后，三样东西立即生效：

| 效果 | 在哪看 |
|---|---|
| 自动沉淀知识卡 | 每轮对话结束自动发生，无需操作 |
| `memory_recall` 工具 | Agent 需要历史时自动调用 |
| 图形化界面 | 侧边栏底部「记忆」按钮 / 设置 → 记忆 |

**入口**：侧边栏底部「记忆」按钮 → 记忆库（左栏含 知识卡 / 知识图谱 / 用量 / **审核中心** / 回收中心 / **记忆配置**）；「DSH 设置 → 记忆」= 纯配置页。

**界面语言**：全套 UI 中英双语，跟随 **DSH 设置 → 语言** 实时切换（含知识卡 / 知识图谱 / 审核中心 / 新建卡模板）；浏览器直接访问 web 时跟随浏览器语言。

**改配置**：记忆库左栏「记忆配置」（或 DSH 设置 → 记忆）→ DSH 记忆配置 / 成本控制 / 自动审核配置 / 服务自管理，点「保存配置」即写入。`autoWebMode`/`watchdogAutoSpawn` 的改动需重启 DSH 生效。

### 🟨 Claude Code

```bash
npm i -g memory-eternal     # 装 CLI + MCP（写 ~/.claude.json mcpServers.memory）
dsh-memory connect claude       # 写 ~/.claude/settings.json 的 SessionEnd hook → 会话结束自动沉淀
```

装完即用：会话里说「recall 一下数据库选型」→ 自动检索记忆；会话结束 → 自动沉淀进统一 `~/.dsh/memory-vault`（新卡 `pending` 待审核）。

### 🟧 Codex CLI / Cursor

```bash
npm i -g memory-eternal     # 装完自动写 Codex config.toml / Cursor mcp.json 的 mcpServers.memory
dsh-memory connect codex        # 写用户级 ~/.codex/hooks.json 的 Stop hook → 会话结束自动沉淀（含 Codex Desktop）
dsh-memory connect cursor       # 写 ~/.cursor/hooks.json 的 stop/sessionEnd hook → 自动沉淀
```

重启工具 → MCP 已在列表，会话里直接：`用 memory_recall 查一下项目历史决策`；会话结束自动沉淀进统一 `~/.dsh/memory-vault`（新卡 `pending` 待审核）。

> **三种 agent 同一套库**：全部写入 `~/.dsh/memory-vault`，每卡 `submittedBy` 区分作者（DeepSeek Harness / claude-code / codex / cursor），主库只显已审核、审核中心管新卡。

> **原生插件（可选，平台 Marketplace）**：仓库含 `.claude-plugin` / `.codex-plugin` / `.cursor-plugin` 清单，可 `claude /plugin marketplace add EternalNight996/memory-eternal` + `/plugin install`、`codex plugin marketplace add EternalNight996/memory-eternal` + `codex plugin add`、Cursor Settings→Plugins。`connect` 走用户级 hooks.json（更稳，不依赖 Marketplace 审核；Codex Desktop 也走这条）。

> **只保留本插件（卸载其它记忆插件，如 agentmemory）**：`dsh-memory` 只写自己的键（`mcpServers.memory` / 含 `capture.mjs` 的 hooks），不依赖、也不冲突任何其它记忆插件。卸载其它插件需在其自身配置层删除对应条目（如 Codex 的 `[marketplaces.*]` 与 `hooks.state.*`、其 `hooks.json` 事件、`~/.agentmemory` 数据目录）。



### 🟩 浏览器（不依赖任何 Agent）

```bash
dsh-memory open    # 起 web + 开浏览器（默认 http://127.0.0.1:7999）
```

统计 / 搜索 / 知识卡（增删改合并导入导出）/ 知识图谱，全在此。与 DSH 内嵌页同一份 UI，数据同步。

> **zcode（智谱）**：暂无原生 MCP，经社区 [zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) 转 MCP 或用 CLI。

---

## 📖 命令速查

```bash
dsh-memory recall "数据库选型"       # 检索
dsh-memory capture "重要结论..."     # 手动沉淀（- 读 stdin）
dsh-memory sweep ~/.claude/projects  # 挖掘已有会话记录
dsh-memory setup [--dry-run]         # 重跑/预览自动挂载（幂等）
dsh-memory connect <claude|codex|cursor>  # 写会话结束自动沉淀 hook（用户级 hooks.json，含 Codex Desktop）
dsh-memory mcp                       # MCP stdio（挂任意 MCP 客户端）
dsh-memory serve [--port 7999]       # 前台跑 web
dsh-memory open                      # ensure web 存活 + 开浏览器
dsh-memory watchdog [--port 7799]    # 看门狗保活 web（独立进程）
```

单独装（不发 DSH）时 `dsh-memory` 命令来自 `npm i -g`。

---

## ⚙️ 服务自管理（白话）

**三个概念**，别搞混：

- **web server 怎么保活**（`autoWebMode`）→ `init`=DSH 启动时拉一次（默认）；`interval`=DSH 进程内定时探活自动拉起（0 额外内存）；`manual`=全手动只从 `dsh-memory open` 起。
- **看门狗进程**（`watchdogAutoSpawn`，默认开）→ 一个**独立** node 进程，DSH 退出了它也能拉起 web（约 +47 MB 内存）。只在要 7×24 保活时开。
- **自动挂载 MCP**（`autoMcpSetup`，默认关）→ 是否自动把 MCP 写进 Claude Code/Codex/Cursor 配置。关 = 不碰你本机配置文件，需要时手动 `dsh-memory setup`。

**改这些**：记忆库左栏「记忆配置」（或 DSH 设置 → 记忆）→ 表格里改，点「保存配置」；`autoWebMode`/`watchdogAutoSpawn` 需重启 DSH 生效。

**MCP 是协议不是常驻服务**：agent 开会话才 spawn，用完即退，没有「开机自启」一说。

### 三种部署强度

| 场景 | 配置 | 内存 |
|---|---|---|
| 个人开发（默认） | `autoWebMode=init` + `watchdogAutoSpawn=off` | web 47 MB |
| 常驻 7×24 | `watchdogAutoSpawn=on` | web + watchdog 47+47 MB |
| 真正开机自启（无 DSH） | Windows 计划任务跑 `dsh-memory watchdog --port 7799 --interval 5000 --max-restart 10` | 同上 |

---

## ⚙️ 记忆配置（大白话）

> 所有配置都在 **记忆库左栏「记忆配置」**（或 DSH 设置 → 记忆）里改，点「保存配置」生效。下图就是配置页全貌（含插件信息 / Agent MCP 挂载状态 / 自动审核配置）：

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-config.png" width="880" alt="记忆配置页" />
</p>

### 一、最常用

| 配置项 | 默认 | 大白话说明 |
|---|---|---|
| 自动沉淀 | 开 | 每轮聊完自动把有用的内容存成知识卡 |
| 自动召回 | 开 | AI 需要历史时自动帮你查记忆 |
| 记忆库目录 | `~/.dsh/memory-vault` | 记忆存哪，纯 Markdown 可 git 管理 |

#### 多库（按项目隔离记忆）

配置里还有两个字段（写在 `memory-eternal-config.json`，或设置面板同步过来的共享配置）：

```json
{
  "vaultProfiles": [{ "name": "work", "path": "D:/vaults/work" }],
  "activeVault": "work"
}
```

解析顺序：`MEMORY_VAULT_DIR` 环境变量 → `activeVault` 命中 `vaultProfiles[].name` 的 `path` → `vaultDir` → 默认 `~/.dsh/memory-vault`。

**v0.9.8 起，CLI / MCP / hooks / 独立 web / sweep 与 DSH 宿主共用同一套顺序**：以前只有宿主认 `activeVault`，切库后终端与 hooks 仍往默认库写，记忆会被劈成两份。

> 说明：配置页目前还没有 `vaultProfiles` / `activeVault` 的可视化表单（要手工写配置文件），按 workspace 自动选库也还没做。

### 二、省钱包（重要）

| 配置项 | 默认 | 大白话说明 |
|---|---|---|
| **蒸馏知识卡** | 开 | 把对话**压缩**成精炼知识卡（要调 AI，花钱）。**关掉 = 存原文**，一分钱不花 |
| **语义去重喂 AI** | 开 | 判断新内容是不是重复（要调 AI）。**关掉 = 用简单去重**，省一次 AI 调用 |
| 蒸馏输出上限 | 900 | 压缩一次最多写多少字，越大越准越费钱 |
| 召回相关性阈值 | 2 | 检索要「多像」才返回，越大越准但漏得越多（越省） |
| 捕获最小长度 | 200 | 对话太短不存，避免闲聊浪费 |
| 日配额 | 60 | 一天最多存几张，防 AI 烧钱 |

### 三、服务怎么跑

| 配置项 | 默认 | 大白话说明 |
|---|---|---|
| 保活模式 `autoWebMode` | init | `init`=DSH 启动时开一次 web；`interval`=定时检查挂了自动重启；`manual`=全靠手动 |
| 看门狗 `watchdogAutoSpawn` | 开 | 后台一个**独立进程**保证 web 不死（+47 MB 内存）。个人用可关 |
| 自动挂载 MCP `autoMcpSetup` | 关 | **让 Claude Code / Codex / Cursor 也能用你的记忆库**。开=自动配好它们；关=不碰你电脑配置，手动跑 `dsh-memory setup` |

> 💰 **想省钱**：把「蒸馏知识卡」关掉、调低「蒸馏输出上限」、调高「召回相关性阈值」。

### 🎯 一键推荐配置（按场景点一下）

配置页顶部有 **🟢 A 轻量省心 / 💰 B 极致省钱 / ⭐ C 高质量** 三个按钮，点一下自动填好对应值，再点保存即可：

| 方案 | 场景 | 保活 | 看门狗 | 蒸馏 | 蒸馏上限 | 召回阈值 | 内存 | LLM 成本 |
|---|---|---|---|---|---|---|---|---|
| 🟢 **A 轻量省心** | 个人开发（默认）| init | 关 | 开 | 900 | 2 | ~47 MB | 正常 |
| 💰 **B 极致省钱** | 预算敏感/多 Agent | init | 关 | **关** | 500 | 3 | ~47 MB | **近 0** |
| ⭐ **C 高质量** | 长项目/团队 | interval | **开** | 开 | 1200 | 1 | ~94 MB | 高 |

---

## 🔔 自动沉淀日志 & 异常提示

自动沉淀是后台静默管线：一旦坏了，以前只能表现为「卡不再增加」，看不出原因。v0.9.0 起它会自己说话。

- **自动沉淀日志**：设置 → 记忆 → 用量/今日，最近 100 条运行轨迹：`🚀 启动` / `👂 会话接入（用的事件接口 + 事件数）` / `✅ 新建卡` / `➕ 追加更新` / `⏭ 跳过（原因）` / `❌ 失败（原因）`。
- **异常主动提示**：出现失败即亮红——记忆库页面顶部红条，同时把「自动沉淀异常 + 原因」注入 Agent 上下文，Agent 会在回复第一句提醒你，不需要你自己去翻日志。
- **停滞兜底**：有轮次开始、15 分钟收不到收尾事件（例如 DSH 改了事件名），10 分钟巡检直接报出来。
- **接口自适应**：自动识别 DSH 会话事件接口（`ownEvents()` → `snapshotEvents()` → `events`），DSH 升级换 API 不会再静默断掉。

---

## 🛡️ 审核中心 & 回收中心

新卡默认进**审核中心**（`pending`），由你确认后才入主库；驳回的进「已驳回」，可恢复或删除进回收站。命中免审条件（审核模式=全部免审 / 免审智能体 / 免审类型）的新卡直接入库；回收站软删卡 30 天内可恢复，超期自动永久删除。

> **v0.3.0 起：审核守卫下沉到数据库层。** 所有写入路径（自动沉淀 / MCP / UI 新建 / 导入）强制经过 `enforceAudit()`，调用方无法绕过。`setCardStatus()` 是唯一审核操作入口，每次变更写入 `audit_log` 审计日志（who/what/when/why），不可篡改。

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/audit-center.png" width="880" alt="审核中心" />
</p>

- **待审核 / 已驳回** 双页签，按类型 / 日期 / 智能体筛选，全选后一键「批准 / 驳回 / 删除进回收站」。
- 审核规则在「记忆配置 → 自动审核配置」：`审核模式`（全部要审 / 全部免审）+ `免审智能体` + `免审类型` + `回收保留天数`。
- **Agent 不能代你审批（v0.9.1 起）**：只要审核生效，插件就往 Agent 的上下文里注入红线——新卡只能停在「待审核」，并明确禁止调用 `approve`/`reject` 接口或任何等价方式绕过；判断权始终在你手里。

### 🥇 为什么审核系统更靠谱（对比其它记忆产品）

多数记忆产品（mem0 / Zep / agentmemory…）对话一结束就**自动全量入库**，好坏不论——噪音、错误事实、敏感内容一起进库，之后又被召回，**污染上下文、放大幻觉**。

memory-eternal 走**人机协同审核**，只让可信内容进主库：

| 维度 | 其它记忆产品 | memory-eternal 审核系统 |
|---|---|---|
| 入库 | 自动全量，无把关 | 新卡先进**审核中心（pending）**，人工批准才入主库 |
| 质量 | 未过滤噪音/错误 | 只保留你确认过的卡 → 召回更准、噪声更低 |
| 可信 | 无来源/审核追溯 | 每卡带 `submittedBy` 作者 + `pending/approved/rejected` 审核状态 |
| 免打扰 | — | 免审智能体 / 免审类型命中 → 可信卡直接入库，零等待 |
| 容错 | 删了就没 | 回收站软删，30 天内可恢复 |

---

## 🧬 为什么全自研

市面上记忆方案多，但大多依赖第三方框架 / 动不动起 MCP 服务 / 记忆锁私有库。本插件把骨架自己搭，**零第三方运行时依赖**，逻辑逐行可读：

| 模块 | 自研实现 | 替代什么 |
|---|---|---|
| 去重 | 词法 Jaccard bigram（0.62）+ 语义去重 | 防重复卡 |
| 检索 | CJK 感知：中文整词 + 字符 bigram | 无需全文搜索引擎 |
| 图谱 | 力导向 + `[[wikilink]]`/共享标签连边 | 知识关联一眼看清 |
| 存储 | **SQLite**（`node:sqlite` 内置，零依赖）| 不锁库、分表存储、SQL 查询 |
| 审核 | **数据库层审核守卫** + 审计日志 | 杜绝越权，所有写入强制走审核 |

> 与热门项目同向（总结→存储→按需召回），但定位不同：**本地、自研、零依赖、可读可控**。如果你已在用 mem0/Zep 等，也能把它当「本地持久记忆底座」叠加使用。

---

## 🛠 开发 / 测试

```bash
npm i
npm test        # 单元测试：vault 去重/检索/图谱 + capture 管线 + API 形状
npm run build   # 构建 lib/client.js（DSH 内嵌）+ web/app.js（独立 web bundle）
```

---

## 🐞 反馈问题

插件左栏有 **🐞 反馈异常** 入口：填完问题描述后可以

- **在 GitHub 提交（已预填）** —— 标题 / 正文 / 诊断信息 / `bug` 标签都填好，再点一次 **Submit** 即提交；
- **复制给 AI 的提示词** —— 粘进 AI 对话框，让它用 `gh` 查重后建 issue 并回报链接。

> **为什么不能「点一下自动提交」**：GitHub 不允许匿名创建 issue；插件里内置 token 会被反编译提取；OAuth / 自建中转需要服务器。所以实现为「预填 + 一次点击」。
> 诊断信息会**自动脱敏**（home 目录 → `~`，`sk-` / `ghp_` / `github_pat_` / `api_key:` 等 → `***`），但公开提交前仍建议自己扫一眼。

如果你拿不到插件界面，也可以直接把下面这段贴给 AI（把「我的问题描述」换成你的问题即可）：

```text
我在使用 memory-eternal（DeepSeek Harness 的记忆插件）时遇到了问题，请你帮我把这个问题提交到 GitHub。

仓库：https://github.com/EternalNight996/memory-eternal

请按这个流程做：

1. 先跑 `gh issue list --repo EternalNight996/memory-eternal --state open --limit 50`，看是否已有相同问题：
   - 已有 → 用 `gh issue comment <编号> --body-file <文件>` 补充现象，不要重复开新 issue；
   - 没有 → 继续第 2 步。
2. 把正文写成文件，然后 `gh issue create --repo EternalNight996/memory-eternal --title "[Bug] <一句话概括>" --body-file <文件>`；正文用这个结构：
   现象 / 复现步骤 / 期望行为 / 实际行为 / 环境（插件版本 / DSH 版本 / 操作系统 / Node）/ 诊断信息。
3. 如果 `gh` 没登录或不可用，不要尝试提交，改为输出一条「标题与正文都已预填」的 GitHub 新建 issue 链接给我，我自己点提交。
4. 提交成功后，把 issue 链接发给我。

注意：我的问题描述请原样照录，不要替我美化或省略细节；诊断信息原样放进「诊断信息」一节。

我的问题描述：
<在这里写你的问题>

诊断信息：
<把「反馈异常」弹窗里复制的诊断信息粘到这里>
```

### 环境自检（贴问题时附上更快定位）

```bash
dsh plugin list                      # 插件版本
node -v                              # Node 版本
curl http://127.0.0.1:7999/memory-eternal/api/web-info    # 独立 web 是否活着
```

---

## 📋 更新日志

> **版本撤回说明**：**v0.9.0 – v0.9.5 均已在 npm 标记 deprecated；v0.9.1 / v0.9.2 / v0.9.3 / v0.9.4 的 release tag 已从 git 移除**（v0.9.5 只是被取代、tag 保留）—— v0.9.1/v0.9.2 带记忆页白屏缺陷，v0.9.0 沉淀告警误报刷屏，v0.9.3 不支持 DSH v0.1.7-rc.2（升级后插件整体挂不上：设置服务换血 + 客户端 `settingsScope` 消失），v0.9.4 在官方桌面版（schemastery 3.18.4 的 volatile 活引用）下抛 `cfg.vaultDir.trim is not a function`、插件整体挂不上，**v0.9.5 的全屏浮层会盖住桌面版的窗口控制面板（右上角「×」压在窗口「关闭」上，点一下会退出整个桌面壳）**。请一律使用 **v0.9.6+**（`npm i memory-eternal@latest`）。

> **DSH 兼容性**：`>=0.1.5-alpha.2 <0.2.0`。**v0.9.4 起适配 DSH v0.1.7-rc.2**（该版本把设置服务换成纯表单 API，并移除了 `@deepseek-ai/dsh-client-runtime` 与 `settingsScope`）；**v0.9.5 起兼容 schemastery ≥3.18.4 的 volatile 活引用**（官方桌面版 profile 即此形态，web profile 仍是 3.18.1，两者都支持）；**v0.9.6 起全屏浮层自动让开桌面壳的窗口标题栏**（不再压住最小化/最大化/关闭）。0.1.5 系列仍走旧的 `settings.register` 路径，两条路径都保留。

| 版本 | 日期 | 关键改动 |
|---|---|---|
| **v0.9.12** | 2026-09-28 | **新增「反馈异常」入口（左栏 🐞）**：弹窗里填完问题描述后可 ① **一键打开 GitHub 预填 issue**（标题 / 正文 / 诊断信息 / `bug` 标签都已填好，再点一次 Submit 即提交），或 ② **复制一段给 AI 的提示词**（贴进对话框，让 AI 先用 `gh issue list` 查重、再建 issue 并回报链接）。**为什么不做「点一下直接提交」**：GitHub 不允许匿名创建 issue；插件内置 token 会被反编译提取；OAuth / 中转需要自建服务 —— 所以走「预填 + 一次点击」。诊断信息由新接口 `/memory-eternal/api/diagnostics` 生成并**自动脱敏**（home 目录 → `~`，`sk-` / `ghp_` / `github_pat_` / `api_key:` 等 → `***`，截断到 2400 字符），issue 链接用**二分截断**保证不超长（`URLSearchParams` 会把中文膨胀约 9 倍）。新增 `lib/feedback.js`（纯函数层）与 `tests/feedback.test.mjs`（4 项：脱敏 / 诊断字段与限长 / 预填链接编码与截断 / 中英双语提示词），`npm test` 共 **103 项** |
| **v0.9.11** | 2026-09-28 | **修复 `watchdog --reap` 把自己杀掉**：直接运行 `node lib/watchdog.js --reap` 时，调用者自己的命令行同样含 `watchdog.js` + 同端口、且不在锁里 —— reap 于是把**自己** SIGTERM 了，表现为「一条输出都没有 + 退出码 1」（走 `dsh-memory watchdog --reap` 时因命令行不含 `watchdog.js` 而侥幸没事，所以只在直跑时暴露）。现在保护集合固定包含 `keepPid` / 当前 pid / 父进程 pid，并跳过命令行带 `--reap` 的其它进程；输出改成 `fs.writeSync(2, …)` 同步写，不再被 `process.exit` 截断。回归测试补「自己与父进程都不得被杀」（用真实空转子进程当靶子，不再用假 pid）。`npm test` **98 项** |
| **v0.9.10** | 2026-09-28 | **多库与看门狗收尾 + 图谱帧优化**。① **多库（#10）**：`vaultProfiles` / `activeVault` 终于有了配置页表单（增删库、填目录、选激活库，并显示当前生效目录 / 来源 / workspace）；vault 解析抽成 `lib/vault-resolve.js`，宿主与 CLI / MCP / hooks / 独立 web / sweep **共用同一份**，新增 `vaultProfiles[].match.workspace` **按项目目录自动选库**（最长前缀优先、opt-in，默认仍是单库）；`memory_recall` 增加 `scope` 参数（库名 / 路径前缀 / `all` 跨库聚合），跨库结果标注来源库。② **watchdog（#11）**：锁改为**按端口分槽**（多端口 / 多 vault 并存不再互相覆盖），新增 `dsh-memory watchdog --reap` 回收升级前遗留的孤儿进程（只清同端口、且不在锁里的；锁中活跃实例与用户手动起的都不动）。③ **图谱帧时间**：边改为按「颜色 + 透明度 + 线宽」分桶后用 **Path2D 一次描边**（2.7k 条边从 2.7k 次绘制调用降到几个桶），节点径向渐变改为**按 颜色\|半径 缓存 + translate 复用**（593 次/帧 → 首帧之后基本不再创建）。④ 新增 `tests/vault-resolve.test.mjs`（7 项）、看门狗测试扩到 7 项；`npm test` 共 **98 项** |
| **v0.9.9** | 2026-09-28 | **修复侧边栏「记忆」入口被挤出可视区（issue #2）**：槽位宿主有两种形态 —— 壳自己的横向行容器 `.footerActions`，以及被其他插件（`dsh-diff-approval` / `dsh-footer-order` 等）改成 `flex-direction: column` 的 `div[data-slot="sidebar.footer.action"]`。旧 CSS 对两者都套了 `flex-wrap: wrap` + `.me-footer { flex: 1 1 100% }`：纵向容器里 wrap 的语义是「换列」、`basis: 100%` 指的是**高度 100%**，叠加后按钮被挤进右侧溢出列、裁切到只剩右边缘一条缝。现在 `flex-wrap` 只留给横向 `.footerActions`，`.me-footer` 改用方向无关的 `flex: 0 0 auto`，并新增 SSR 回归断言。另：README 双语新增「交流群 & 打赏」（群二维码 + 微信收款码 / 赞赏码），新增 `SPONSOR.md` 与 `.github/FUNDING.yml`（FUNDING 只支持文字链接，故 custom 第一项指向 SPONSOR.md 页面直接展示二维码） |
| **v0.9.8** | 2026-09-28 | **集中解决存量问题**。① **采集可信性**（issue #3 / #4）：蒸馏路由不再写死 `providers[0]` —— 新增 `captureProvider` / `captureModel` 配置，并按注册顺序**依次重试**；**流末尾 `finish` 块里的适配器错误**（缺凭证 `MISSING_CREDENTIAL`、限流等）现在成为**可见失败**（沉淀日志写明 code/message + 健康态亮红 + 兜底原文卡注明原因），不再笼统记成「蒸馏无输出」；停滞探测从「累积计数差额」改为**滑动窗口**（20 分钟内持续开始且零收尾才告警），误报与漏报一并修掉。② **独立进程 vault 一致性**（dsh-memory-eternal#5）：CLI / MCP / hooks / 独立 web / sweep 与宿主共用同一套优先级（`MEMORY_VAULT_DIR` → `activeVault` → `vaultDir` → 默认库），切库后不再数据分裂。③ **看门狗单例锁**（dsh-memory-eternal#6）：同端口已有活着的 watchdog 时新进程直接退出并清理陈旧 pid 记录，止住「每次重启多一个孤儿进程」。④ **图谱性能**：标签边改「共享标签数 Top-K」（593 卡实测 **24,193 → 2,763** 条边）、相似度改**稀有 bigram 倒排候选**（冷启动 **948 → ~520ms**，warm 2-4ms）、payload **3,531KB → 579KB**；客户端 dim 判定改**邻接 Set**（每帧 **52ms → <1ms**）。⑤ 新增 5 个测试文件（路由/finish、停滞窗口、vault 解析、看门狗锁、图谱性能基线），`npm test` **85 项** |
| **v0.9.7** | 2026-09-28 | **打开卡片默认全部展开（可收起）＋ 正文排版重做**：卡片阅读器不再默认折成 300px，而是**打开即读全文**，长卡可一键收起（折叠后底部给「展开 ⌄」提示）。frontmatter 从正文里抽出来，改成 kind / 审核状态 / 标签 / 时间 / 来源的**彩色 chips**（kind 沿用图谱配色），不再把一段 YAML 当正文露出来。正文排版换成新方案（`src/client/markdown.js`，宿主与独立 web 共用同一套）：小标题按语义自动配 **emoji + 颜色分组**（结论 ✅绿 / 风险 ⚠️琥珀 / 根因 🔍蓝 / 方案 🛠️紫 / 示例 💡粉），连续 `- ` 合成真正的 `<ul>`、`1.` 合成带圆形序号的 `<ol>`、`- [x]` 变复选框、`>` 引用升级成带 emoji 的 callout、`---` 变分隔线、行首「短键：值」渲染成对齐样式、`**加粗**` 加荧光笔下划线；围栏代码整段保护，内部 `#` / `-` 不再被误排版。**新增 7 项排版单测**（含 XSS 转义、链接协议白名单、散文冒号不得误判成 key/value）。另含 PR #8 移植：Electron 宿主下的子进程 node 解析（`lib/node-bin.js`，修「独立 web server 拉不起来 → 侧边栏弹窗白屏」）与 `webServer` 就绪后再注册 API 路由（修「设置页永远加载中」） |
| **v0.9.6** | 2026-09-28 | **修复官方桌面版全屏浮层挡住窗口控制面板（点「关闭」会退出整个桌面壳）**：桌面壳把「最小化 / 最大化 / 关闭」画在页面顶部，并按 DSH 约定在 `<html>` 上打 `data-windows-titlebar` + 给出 `--dsh-windows-titlebar-height`（已在官方桌面版 `app.asar` 里确认这两个标记确实存在）；记忆库全屏浮层原本是 `inset:0` + 内联 `100vh`，整条盖住标题栏，而我们右上角的「×」恰好压在窗口「关闭」上 —— 用户一点就直接退出整个桌面壳。现全屏态改用 `.me-modal-full` 类（不再写死内联 `100vh`：内联样式无法被 CSS 覆盖），并在 `[data-windows-titlebar]` 下把 `.me-overlay-top` / `.me-overlay` / `.me-modal-full` 一律下移 `--dsh-windows-titlebar-height`、高度改为 `calc(100vh - 该高度)`；浏览器里没有该属性时偏移 0px，行为与之前完全一致。导出图谱的全屏预览同步从 `100vh` 改为 `100%`，避免在缩短后的浮层里溢出。新增 1 项渲染回归断言（三处让位规则必须出现在打包产物中） |
| **v0.9.5** | 2026-09-28 | **修复官方桌面版（schemastery 3.18.4）下插件整体挂不上**：桌面版 profile 解析到的是 **schemastery 3.18.4**，它会把标了 `volatile` 的 Config 字段解析成 cosmokit 的**活引用**（`{ get(): snapshot }`，品牌 `Symbol.for('cosmokit.volatile.write')`），而 0.9.4 的业务代码把字段当普通值用 —— `cfg.vaultDir.trim()` 当场抛 `TypeError: cfg.vaultDir.trim is not a function`，插件在 `apply` 里就崩（桌面版实测报错原文）。现按 cosmokit 协议统一**深解引用**（引用取快照、数组/对象递归展开），`settings.get()` 对外只给普通值；每次读取都重新解，loader 原地提交的 volatile 热更新照样立刻可见，`JSON.stringify` 写共享配置也不再变成 `{}`。新增 2 项回归（3.18.4 真实引用形态 + 嵌套数组/对象），并用**桌面版真实模块解析布局**（schemastery 3.18.4 + 真 cosmokit）跑通 `apply` 验证 |
| **v0.9.4** | 2026-09-28 | **适配 DSH v0.1.7-rc.2（修复「升级后插件整体失联」）**：① **设置服务换血** —— 0.1.7 的 `ctx.settings` 只剩表单 API（`describe/update/replace/mutate/configure`），不再有 `register()`；旧代码 `ctx.settings.register(...)` 直接抛 `TypeError`，插件根本挂不上（记忆页消失、自动沉淀停摆）。现改为跨版本兼容层：旧版仍走 `register`，新版读 loader 传进来的**活配置引用**、订阅 `loader/volatile-update` 做热更新、写回走 `settings.update(条目 id, patch, revision)`（revision 冲突映射 HTTP 409），并注册 `configure({ auto:false })` 免得宿主再生成一张重复的表单页。② **字段 volatile 标记改为构造后统一打**：不再链式写 `.volatile()` —— 该方法 schemastery ≥3.18.4 才有，而插件在 profile 层实际解析到的是 **3.18.1**，链式调用会在 `import` 期抛 `volatile is not a function`，把插件整个打挂。③ **客户端去死引用**：`inject` 移除已随 `@deepseek-ai/dsh-client-runtime` 一起消失的 `settingsScope`（0.1.7 客户端服务表里已无此服务，插件会永远等待服务而永不激活 → 记忆页与侧边栏按钮全部不见）；`dsh.client.inject` 同步去掉不存在的包名。④ 新增 **`tests/settings-compat.test.mjs`**（8 项：0.1.7 形状挂载 / 活引用读值 / volatile 热更新 / 写回与 revision 冲突 / 老版本 `register` 路径 / 字段 volatile 标记），已并入 `npm test`。已在**真实 DSH v0.1.7-rc.2** 上启动验证：宿主插件正常挂载（配置落盘 `memory-eternal-config.json`）、客户端 bundle 正常进入 boot graph（`plugins/??memory-eternal/client.js`） |
| **v0.9.3** | 2026-09-12 | **修复记忆页白屏（"没画面"）**：v0.9.1 把「滚动续拉」的 `useEffect` 写在了 `loadCards` 定义**之前**——React 在渲染期求值依赖数组，触发 TDZ（`Cannot access 'loadCards' before initialization`），**整个记忆页一渲染就崩**；现已移到定义之后。**新增渲染冒烟测试**（`tests/ssr.test.mjs`：真跑打包产物、把卡片/设置/用量/图谱四个入口各渲染一遍，已并入 `npm test`）——「构建全绿、页面白屏」这类 bug 以后发不出去 |
| **v0.9.2** | 2026-09-12 | **日志可见性 + 误报修复**：自动沉淀日志**落盘持久化**（`~/.dsh/memory-eternal-capture.jsonl`，最多 500 条）——独立 Web 页不再显示「日志仅在 DSH 宿主内可用」而是直接能看到记录，宿主重启后历史也不丢（启动时读回）；修复**停滞探测误报刷屏**（轮次计数对不上其实是常态：子代理轮次、被取消的轮次都不发 `turn-stopping`；现在要求「有轮次在跑 **且** 15 分钟无任何沉淀活动」才报一次，活动恢复即自动撤销，不再每 10 分钟刷一条把面板挤满、健康状态永久亮红）；蒸馏无输出/JSON 解析失败时**改为原文卡兜底**，内容不再白丢 |
| **v0.9.1** | 2026-09-12 | **性能与体验批次**：记忆页按视图**懒加载**（打开「设置」不再顺带拉 250KB 卡片 + 890KB 图谱，首屏只需约 0.5KB）；知识图谱生成 **3232ms → 43ms**（bigram 集合只算一次 + 数学上界剪枝无损跳过 + 标签倒排），并加**指纹精确失效**的服务端缓存（写卡/审核/删卡立即重建，无脏读）；全站 **brotli q5**（图谱 877KB → **54KB**，比 gzip 再小 34%；卡片 246KB → 83KB → br 20KB），大响应体同时压 br + gzip 取更小者，保证任何响应都不比 gzip 差；`/cards` 支持**真分页**（offset/limit/total + 服务端标题排序，跨页全局有序），首屏只拉 100 条、滚到底续拉；「用量/今日」的 Agent 卡清单改为服务端署名过滤（30 条）；**审核红线**：插件在 Agent 上下文注入「禁止调用 approve/reject 代用户审批」；watchdog **回收备用端口的多余实例**（实测清掉一个常驻 76MB 的重复 web 进程） |
| **v0.9.0** | 2026-09-12 | **修复自动沉淀静默失效（一连 6 天不写卡）**：DSH 升级后会话事件接口由 `events` 改为 `ownEvents()/snapshotEvents()`，监听器读不到事件后静默返回、不留任何痕迹 —— 现改为三级自适应取法（`ownEvents()` → `snapshotEvents()` → `events`）+ 每会话接入留痕；日配额改为**只统计真实写卡**（此前「不值得保存」的判定也照样扣配额，40 次即耗尽 24h 配额）、`captureCooldownMs` 冷却真正生效、单次沉淀输入截尾 20000 字；新增**自动沉淀日志**面板与**异常主动提示**（页面红条 + 注入 Agent 上下文 + 轮次收尾停滞巡检）；移除「每日回顾」自动简报（定时器 / `/todayBrief` 接口 / UI 按钮） |
| **v0.8.0** | 2026-09-06 | **全套 UI i18n**：跟随 DSH 系统语言实时切换（中/英），覆盖知识卡 / 知识图谱 / 审核中心 / 配置面板 / 新建卡模板；Windows 测试收尾 SQLite 连接 EBUSY 修复 |
| **v0.3.1** | 2026-09-03 | 知识图谱按需加载（点击时 fetch，关闭时注销） |
| **v0.3.0** | 2026-09-03 | **SQLite 化存储层**（`node:sqlite` 零依赖）+ 数据库层审核守卫 `enforceAudit()` + `audit_log` 审计日志 + 自动从 .md 迁移 |
| v0.2.0 | 2026-09-03 | recall 含正文修复（`search()` 返回 excerpt 字段） |
| v0.1.2 | 2026-09-03 | 审核守卫加固（`writeCard` 默认 `pending`，`mergeCards` 走审核） |
| v0.1.1 | 2026-09-03 | recall 含正文修复（excerpt 字段 + body 逻辑修正） |
| v0.1.0 | 2026-08-31 | 首发：自动沉淀 + 自动召回 + 图形化知识库 + 知识图谱 + 审核中心 + 回收中心 |

---

## 💬 交流群 & 打赏

**遇到问题、想提需求、或者想聊聊 DSH 插件开发 —— 欢迎进群：**

<img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/group-qr.jpg" width="260" alt="DeepSeek Harness 交流群二维码" />

**如果这个插件帮你省了时间，可以请作者喝杯咖啡（两个码任选其一）：**

| 微信收款码 | 微信赞赏码 |
|---|---|
| <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/wechat-pay.jpg" width="230" alt="微信收款码" /> | <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/wechat-reward.jpg" width="230" alt="微信赞赏码" /> |

> 打赏完全自愿，不影响任何功能；插件本体始终开源免费（MIT）。
> 仓库页的 **Sponsor** 按钮下拉里选 custom 第一项，会落到 [SPONSOR.md](SPONSOR.md)（同样是这一页的码）。

---

## 📄 License

MIT

---

> **让 AI 真正记住你：对话自动沉淀，知识随手可查。** ⭐ 觉得有用就点个 Star，Let's make AI not forget.
>
> English README: [README.en.md](README.en.md)
