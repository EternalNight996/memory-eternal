# 🧠 memory-eternal — 给 AI 装「第二大脑」

[![HOL Guard](https://img.shields.io/endpoint?url=https%3A%2F%2Fhol.org%2Fapi%2Fregistry%2Fbadges%2Fplugin%3Fslug%3Deternalnight996%252Fmemory-eternal%26metric%3Dtrust)](https://hol.org/registry/plugins/eternalnight996%2Fmemory-eternal)

<!-- 语言 / Language：本文件是**默认**（简体中文）README；英文镜像见 README.en.md。
     两份是**独立文件**、标题层级一一对应；改一处请同步另一处（新增一节要两边都加）。
     npm / DSH 插件市场默认展示本文件（中文）。 -->

<p align="center"><b>简体中文（默认）</b> · <a href="README.en.md">English</a></p>

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

**改配置**：记忆库左栏「记忆配置」（或 DSH 设置 → 记忆）→ DSH 记忆配置 / 成本控制 / 自动审核配置 / 服务自管理，点「保存配置」即写入。`autoWebMode`/`watchdogAutoSpawn` 的改动需重启 DSH 生效；注意**已常驻的 watchdog 不会被配置改动自动停掉**，要停止或换新版请执行 `dsh-memory stop` / `dsh-memory restart`（见「服务自管理」）。

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
dsh-memory status [--json]           # 看常驻 watchdog：pid / 端口 / 版本 / 是否存活
                                     # 以及**端口上真正在服务的版本**（锁里的版本号只是 watchdog 自述）
dsh-memory stop [--port 7799]        # 停止常驻 watchdog（配置改动不会自动停；连它拉起的 web 一起停）
                                     # 停完会再问一次端口占用者，仍被占着就明确告警
dsh-memory restart [--port 7799]     # 停止并重起 watchdog（升级后换新版）
                                     # 按端口占用者兜底收掉锁里没登记的旧 web，起完自检端口上服务的版本
dsh-memory audit list [--status pending|rejected|approved|deleted|all] [--limit N] [--json]
                                     # 列出卡片；总数不受 --limit 影响，--limit 只限制显示条数（默认全部）
                                     # all = 审核队列（pending + rejected），不含 approved / deleted
dsh-memory audit approve <卡片路径...>              # 人工批量批准
dsh-memory audit reject <卡片路径...> --reason "..." # 人工批量驳回
```

单独装（不发 DSH）时 `dsh-memory` 命令来自 `npm i -g`。

---

## ⚙️ 服务自管理（白话）

**三个概念**，别搞混：

- **web server 怎么保活**（`autoWebMode`）→ `init`=DSH 启动时拉一次（默认）；`interval`=DSH 进程内定时探活自动拉起（0 额外内存）；`manual`=全手动只从 `dsh-memory open` 起。
- **看门狗进程**（`watchdogAutoSpawn`，默认开）→ 一个**独立** node 进程，DSH 退出了它也能拉起 web（约 +47 MB 内存）。只在要 7×24 保活时开。
- **版本漂移自愈**（`autoRestartOnDrift`，默认开）→ 常驻 web **比 DSH 活得久**：升级只换磁盘文件，端口上那个进程仍跑着启动时加载的旧代码（「启动 dsh 后运行中还是旧版本」就是这么来的）。开着它，DSH 激活时会**问端口上真正服务的版本**，与磁盘不一致就用新代码重启常驻实例；关掉则只告警，需要时在「插件信息」点**重启常驻实例**。
- **自动挂载 MCP**（`autoMcpSetup`，默认关）→ 是否自动把 MCP 写进 Claude Code/Codex/Cursor 配置。关 = 不碰你本机配置文件，需要时手动 `dsh-memory setup`。

**改这些**：记忆库左栏「记忆配置」（或 DSH 设置 → 记忆）→ 表格里改，点「保存配置」；`autoWebMode`/`watchdogAutoSpawn` 需重启 DSH 生效。

> ⚠️ **同端口不会因配置改动而自动替换（#19）**：看门狗是**独立进程且故意不杀**（多会话共用一个），所以
> 关闭 `watchdogAutoSpawn` **不会**停掉已经在跑的那个，改 `webCheckIntervalMs`/`webMaxRestart` 也不会生效。
> 要停止 / 换新版请显式执行 `dsh-memory stop [--port N]` 与 `dsh-memory restart [--port N]`（`stop` 会**连它拉起的 web 一起停**，不留占端口的孤儿）；
> `dsh-memory status` 会显示常驻实例的 pid、端口、启动时间与**版本是否落后于本机安装的包**，并单独报出**端口上真正服务的版本**
> （锁文件里的版本号只是 watchdog 自述，端口上跑旧代码时它不会变）。
>
> ⚠️ **升级后请以「端口实际服务版本」为准（#23）**：`restart` 现在不只信锁里登记的 web 子进程，
> 还会按**端口占用者**兜底清理（锁里没登记的旧 web 也会被识别并收掉，非本插件的进程只告警不动手），
> 并在起完之后自检「端口上服务的版本 = 本机版本」——对不上就以非 0 退出码报失败，不再打印「已启动」就完事。
>
> ✅ **「更新了却还是旧版本」现在有两条出路（#19/#23）**：① 默认开的 `autoRestartOnDrift` 在 DSH 启动时
> **自动**替换旧常驻实例；② 面板「插件信息」里发现版本漂移时给一个**🔄 重启常驻实例**按钮（服务端即
> `dsh-memory restart --port N` 的同一实现：收旧实例 → 抢锁 → 拉起新 web → 自检端口版本）。
> 注意「运行中」那一格指的是**服务本页的进程**：独立 Web 页里就是常驻 web，DSH 设置页里是宿主 ——
> 面板会同时列出**常驻实例**的版本，两者不同时一眼能看出该重启谁。

**MCP 是协议不是常驻服务**：agent 开会话才 spawn，用完即退，没有「开机自启」一说。

### 三种部署强度

| 场景 | 配置 | 内存 |
|---|---|---|
| 个人开发（推荐） | `autoWebMode=init` + **手动**把 `watchdogAutoSpawn` 关掉（默认是**开**，见下方配置表） | web 47 MB |
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
| 看门狗 `watchdogAutoSpawn` | 开 | 后台一个**独立进程**保证 web 不死（+47 MB 内存）。个人用可关——但关闭后**既有实例不会自动停**，需 `dsh-memory stop`（#19） |
| 漂移自愈 `autoRestartOnDrift` | 开 | DSH 激活时发现**端口上服务的版本 ≠ 磁盘版本**（升级后常驻 web 还是旧代码）就用新代码重启常驻实例。关掉只告警，仍可在「插件信息」点**🔄 重启常驻实例**（#19/#23） |
| 自动挂载 MCP `autoMcpSetup` | 关 | **让 Claude Code / Codex / Cursor 也能用你的记忆库**。开=自动配好它们；关=不碰你电脑配置，手动跑 `dsh-memory setup` |
| 凭证提示 `secretHint` | 空 | 填一句自己的约定（例如「需要 API key/token 时先查记忆里的密钥目录」），会**注入每个会话的 systemPrompt**。记忆库里只存**目录**（名字/位置/取用方式），密钥的**值**不入库 —— 见下方「密钥怎么放」 |

> 🔑 **密钥怎么放（`secretHint` 的用法）**：把**值**留在本机凭据里（环境变量 / 密钥文件，权限收紧），
> 记忆库里只留一张**目录卡**（有哪些键、放在哪、干什么用、轮换状态），再用 `secretHint` 让 agent
> 每次会话都想到去查这张卡。为什么值不能入库：卡片 `summary` 就是正文开头，**召回默认就带 130 字**
> （`recallSummaryLen`），值一入库就随每次相关召回进入模型上下文；`/export`、备份、多机同步也会带上。
> `dsh-memory setup` 会在 Claude Code 里注册一个 `PreToolUse` 守卫：直接读
> `.credentials.yaml` / `.env` / `*-token` 会被拒绝并指路到目录卡。

> 💰 **想省钱**：把「蒸馏知识卡」关掉、调低「蒸馏输出上限」、调高「召回相关性阈值」。

### 🎯 一键推荐配置（按场景点一下）

配置页顶部有 **🟢 A 轻量省心 / 💰 B 极致省钱 / ⭐ C 高质量** 三个按钮，点一下自动填好对应值，再点保存即可：

| 方案 | 场景 | 保活 | 看门狗 | 蒸馏 | 蒸馏上限 | 召回阈值 | 内存 | LLM 成本 |
|---|---|---|---|---|---|---|---|---|
| 🟢 **A 轻量省心** | 个人开发（推荐）| init | 关 | 开 | 2000 | 2 | ~47 MB | 正常 |
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

> **v0.10.0 起：升级为「两套存储」——未审核内容物理隔离。**
> `cards`（**主库 / 正常区**）物理上**只存 approved**；`quarantine`（**隔离区 / 异常区**）存 `pending` / `rejected` / `deleted`。
> 意义：召回、检索、知识图谱、去重池、导出这些读路径**查主库即安全**——不再依赖「每处 SQL 都记得写 `WHERE status='approved'`」。
> （v0.9 审计实测漏过三处：去重池会把新知识追加进待审卡、`readCard` 可按 path 直读未审核正文、`/card` 接口无状态校验。）
> 审核流转 = **跨表搬家**：批准 → 搬进主库，驳回/软删 → 搬进隔离区；搬家在一个事务里完成，更新记录与审计日志跟着走。
> 升级说明：首次启动会自动把存量非 approved 卡搬进隔离区（**不删除任何内容**，都在同一个 `.db` 文件里）。
> 若回滚到旧版本，审核队列会显示为空（旧代码看不到隔离区表），升级回来即恢复。

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

> 📄 **README 是中英两份独立文件**：`README.md`（简体中文，**默认**，npm / 插件市场展示这一份）
> 与 `README.en.md`（English）。两份标题层级一一对应，**改一处要同步另一处**（新增一节两边都加）。

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

> **发布规则（2026-09-30 起）**：正式版一律**三端同步发布** —— `npm publish` + **GitHub Release** + **Gitee Release**，并保证 `vX.Y.Z` tag 在三端一致。桌面版 profile 依赖 `github:EternalNight996/memory-eternal`、`dsh web` 走 npm 版本号，少任何一端都会出现「npm 上是新版、桌面版还是旧的」。统一入口：`npm run release:dry`（预演）→ `npm run release`（正式）。详见 [PUBLISH.md](./PUBLISH.md)。
>
> **版本撤回说明**：**v0.9.16 – v0.9.22 已全部撤回**（问题期间版本：git tag 已删除、npm 已标记 deprecated，请使用 **v0.9.23**）。**v0.9.14 已 deprecated**（客户端渲染改动降低手感，已回退；其服务器侧算法优化并入 **v0.9.15**，渲染与 v0.9.13 完全一致）。**v0.9.0 – v0.9.5 均已在 npm 标记 deprecated；v0.9.1 / v0.9.2 / v0.9.3 / v0.9.4 的 release tag 已从 git 移除**（v0.9.5 只是被取代、tag 保留）—— v0.9.1/v0.9.2 带记忆页白屏缺陷，v0.9.0 沉淀告警误报刷屏，v0.9.3 不支持 DSH v0.1.7-rc.2（升级后插件整体挂不上：设置服务换血 + 客户端 `settingsScope` 消失），v0.9.4 在官方桌面版（schemastery 3.18.4 的 volatile 活引用）下抛 `cfg.vaultDir.trim is not a function`、插件整体挂不上，**v0.9.5 的全屏浮层会盖住桌面版的窗口控制面板（右上角「×」压在窗口「关闭」上，点一下会退出整个桌面壳）**。请一律使用 **v0.9.6+**（`npm i memory-eternal@latest`）。
> **DSH 兼容性**：`>=0.1.5-alpha.2 <0.3.0-0`（**v0.10.1 起放宽**：旧的上界 `<0.2.0` 在 semver 上会把 DSH `0.2.0-rc.x` 排除在外 —— DSH 的插件守卫用 `includePrerelease:true` 判定，实际仍能装上，但声明与事实不一致；现在明确覆盖整个 0.1/0.2 线，且 `<0.3.0-0` 仍然挡住 0.3.0 及其预发布。**已在官方桌面版 DSH 0.2.0-rc.2 上实测运行**：插件挂载、记忆页、自动沉淀、审核中心、导入导出均正常）。**v0.9.4 起适配 DSH v0.1.7-rc.2**（该版本把设置服务换成纯表单 API，并移除了 `@deepseek-ai/dsh-client-runtime` 与 `settingsScope`）；**v0.9.5 起兼容 schemastery ≥3.18.4 的 volatile 活引用**（官方桌面版 profile 即此形态，web profile 仍是 3.18.1，两者都支持）；**v0.9.6 起全屏浮层自动让开桌面壳的窗口标题栏**（不再压住最小化/最大化/关闭）。0.1.5 系列仍走旧的 `settings.register` 路径，两条路径都保留。

| 版本 | 日期 | 关键改动 |
|---|---|---|
| **v0.10.11** | 2026-10-09 | **蒸馏输出解析再补一层容错：字符串里的裸引号（`Expected ',' or '}' after property value`）**。现场：`fail` 日志里 `UNPARSEABLE_OUTPUT` 占大头（最近 600 条里 103 条），最近一条带全了现场 —— `JSON.parse 原始报错：Expected ',' or '}' after property value in JSON at position 1913`，摘录里能看到正文写着 `运行 "npm test" 时…`：模型把引号当正文直接写进字符串，于是它被当成字符串结束符。这与 #24 修过的「裸控制字符」是**不同**的一类（控制字符在字符串内非法，引号只是需要转义）。修法：新增 `repairUnescapedQuotes()` —— 一个 `"` 后面（跳过空白）紧跟 `:` `,` `}` `]` 或文本结尾才算字符串结束，否则当正文补 `\"`；它**只作为最后一个候选**参与解析，且必须仍通过卡片体检（标题合格 + 正文 ≥20 字）才被接受 —— 宁可不修，也不写坏卡。回归守卫 `tests/capture-json-repair.test.mjs`（4 项：合法 JSON 恒等变换、裸引号现场、控制字符与裸引号叠加、截断仍如实失败）。`npm test` 共 **293 项** |
| **v0.10.10** | 2026-10-09 | **审核中心能看正文了 + 就地批准/驳回（issue #27）**。现场（thinrflbtlm）：审核中心过去只列「标题 / 类型 / 来源 / 严重度 / 原因」，**看不到正文**；而 v0.10.0 之后待审卡物理隔离在 `quarantine`、知识卡界面只列已审核卡 —— 于是「不人工确认就没法审」，审核形同虚设。① 每行新增 ▸/▾（点标题也行）**就地展开 frontmatter + 正文**，用与卡片详情**同一套 Markdown 渲染**（`renderMd` + `splitFrontmatter`），不是裸文本；② 正文**按需拉取**（`GET /card?path=…&status=pending|rejected`，服务端只放行确实在审核队列里的 path，未知 path 仍然 403 `CARD_NOT_APPROVED`），列表接口不塞整库正文；③ 展开块里直接给 **✓ 批准 / ✕ 驳回**（回收站页签是 ✓ 恢复 / 🗑 删除），批量勾选与外层工具条保持原样；④ 批/驳后自动收起并刷新，中英双语词条齐全。新增 `tests/issue-fixes-6.test.mjs`（2 项：待审正文读得到且批准后离开队列、源码守卫含「按需拉取」与「越权拒绝码」）。`npm test` 共 **289 项** |

<details>
<summary>更早的更新日志（v0.10.9 及以前 · 共 36 版，点开查看）</summary>

| 版本 | 日期 | 关键改动 |
|---|---|---|
| **v0.10.9** | 2026-10-09 | **升级期端口漂移把记忆页打成「拒绝连接」的根治（issue #29）**。现场：旧包遗留的 detached 实例占着 7999 且不自报版本 → 宿主 `ensureWebServer()` 认不出它、向后漂到 8000 并写进 `web-info`；而插件的自愈随后把 8000 上的实例当野实例收掉 → `web-info` 永久悬空，客户端 iframe 指向死端口（首次能进、刷新即「拒绝连接 127.0.0.1」）。① **记忆库页改走 host 同源壳**：宿主新增 `/memory-eternal/ui/app`（与配置页 `/ui/config` 同一份 index.html，其中 `<script src="app.js">` 相对路径正好解析到 `/ui/app.js`），iframe 地址从此与「常驻实例监听哪个端口」**彻底解耦**（旧宿主 404 时仍回落 `web-info`）。② **`/web-info` 实时收敛**：每次读之前先探「配置端口 → 记录端口」，谁在服务就用谁，都不通就如实 `alive:false`（不再把死地址当活的）；自愈替换成功后与 interval 保活探到活时都就地回写。③ **不再盲目漂端口**：新增 `looksLikeOurWeb()`（宽松识别「自家但不自报版本」的占用者：/overview、/web-info、/budget 任一 ok:true 即认），疑似自家时先给自愈留 6s 接管窗口，等不到才漂并留日志。④ **体检退避重试**：`inspectResident()` 一次探针打空不再直接判「旧版不自报版本」（那个结论会触发误替换，每次启动都白起一次实例），退避重试后才下结论。新增 `tests/issue-fixes-5.test.mjs`（4 项：宽松识别真/假阳性、等自愈接管不漂端口、宿主与客户端源码守卫）。`npm test` 共 **287 项** |
| **v0.10.8** | 2026-10-08 | **独立 Web 端保存「点一下即生效」：把应用 pending 的上下文从插件回调搬到宿主 HTTP 请求（方案 A，实测驱动）**。现场：独立页保存 → 宿主连续重试 5 次后 `dropped`，报错恒为 `HMR transactions cannot be nested`（0.10.7 只修掉了它冒充「自动沉淀异常」与升级期未知键，同步本身没修）。**实测定位**（同一宿主、同一个 `settings.update`）：从插件**回调**（`setInterval` / `fs.watch`）里调 → 抛守卫错且**一个字节都没提交**（只含宿主认识的键、值真的变了，同样失败）；从插件 **HTTP 请求处理器**里调 → **真的提交**（`recallSummaryLen` 130→132→130，`revision` 4→6）。所以修法不是换 API 而是换**调用上下文**：① 宿主新增 `POST /memory-eternal/api/drain-pending`，在**请求处理器**里应用 pending（两道闸门：只接受本机来源 + 心跳里的一次性令牌，防本机任意页面乱写）；② 宿主把自己 web server 的**监听端口 + 令牌**写进心跳（`webServer.port` 是服务公开的 getter），独立端保存后据此**主动叫醒宿主**，拿到真实结果再回给界面（新增 `savedApplied`「已保存并生效」）；③ 叫醒失败（旧宿主没这条路由 404 / 端口对不上 / 超时）**不算错误** —— 回落到 0.10.5 的等待路径与「去 DSH 设置里改」的指路。新增 `tests/host-drain.test.mjs`（6 项：回环判定 / 守卫三件套 / 端到端叫醒 / 失败如实回报 / 404 回落 / 源码守卫）+ `tests/e2e-host-drain.mjs`（2 项：**真起进程**的端到端「独立页保存 → 叫醒宿主 → 宿主应用 → 回报已生效」，以及旧宿主心跳（无端口/令牌）时回落成「排队等待」）。`npm test` 共 **283 项** |
| **v0.10.7** | 2026-10-08 | **「启动 dsh 后运行中还是旧版本」根治：版本漂移自愈 + 一键重启常驻实例（#19 / #23 的正面解法）**。现场：升级 npm 包只换了磁盘文件，**常驻 web（默认 7999）比 DSH 宿主活得久** —— 端口上那个进程仍在跑「启动时加载进内存」的旧代码；而宿主激活时的策略是「同端口已有活着的 watchdog 就 `delegated`（不再 spawn、更不替换）」，于是**重启多少次 DSH 都不会换掉它**（实测本机：宿主 10:19 启动已是新版、设置页同源显示 0.10.6，而 7999 上的 web 是 08:15 启动的 0.10.0，`/config` 与 `/version-check` 各报一个版本）。① **启动自愈（`autoRestartOnDrift`，默认开）**：激活时先 `inspectResident()` 体检 —— 版本一律**问端口**（锁里的 `pkgVersion` 只是 watchdog 自述，旧实例写的还是空串，根本看不出版本漂移），再 `decideResidentAction()` 决策：一致 → `delegate`（保持 #19 的如实口径）、漂移 → `restart`、读不到本机版本 → 绝不乱动、刚替换过 → 防抖不重来（配置改动会让 effect 重跑）。**「更新运行中的程序」的正确形态由此定为「用新代码重启那个常驻进程」，而不是热替换内存里的模块**：ESM 模块缓存 + 闭包状态（settings / vault 路由 / SSE hub / `fs.watch` / 已监听端口）没有安全热换的余地，缓存失效重 import 只会得到第二份模块图（双实例、双监听、双写）。② **替换机制统一到一处**：新增 `restartResident()` = spawn 一个 detached 的 `watchdog.js --replace` 助手（收旧 watchdog / 旧 web → **等端口真的空出来** → 抢锁 → 拉起新 web），再自检「端口上真正服务的版本 = 本机版本」（#23 建议 2）；端口没空出来就**中止接管**、不退让到 `port+1`（退让实例正是孤儿 web 的诞生地）。`dsh-memory restart`、宿主启动自愈、面板按钮现在共用这一份实现。助手是 detached + `stdio:ignore`（stderr 没人看），所以接管结论**必须**写进「自动沉淀日志」—— 否则「重启了却没生效」又会变成一条无迹可查的静默失败。③ **面板一键修复**：新增 `POST /memory-eternal/api/restart-self`，三条硬约束 —— 本进程很可能**就是**要被替换的旧 web，所以**先回响应再调度**替换；常驻实例已经是最新就回 `alreadyCurrent`（宿主面板点这个按钮时最常见，绝不为一个健康实例白折腾一次停机）；同一时刻只允许一个替换在跑。④ **面板语义消歧**：「运行中」改为「**运行中（服务本页的进程）**」（独立 Web 页里它是常驻 web，DSH 设置页里是宿主 —— 这正是两个面板数字「打架」的根源），并新增「**常驻实例 vX**」徽标：两者不同时一眼看出该重启谁；漂移横幅给按钮 + 等价命令，若常驻实例已新而本页仍旧，则明说「需重启桌面版 / DSH」，不再给一个点了也没用的按钮。⑤ **`updateAvailable` 改按版本比较**：`latest !== onDisk` 在本地跑未发布版本时会**反过来劝你装回旧版**（磁盘 0.10.7 / npm 0.10.6），现在用 `compareVersions`（含预发布语义 `rc.2 < rc.10`）。⑥ 顺带清掉客户端词典里重复的 `saving` 键（esbuild 每次构建都在报警告）。新增 `tests/watchdog-restart.test.mjs`（17 项：决策矩阵 / 体检问端口 / 替换自检 / 接管前清场不误杀 / 路由先响应后替换 + 并发闸门 / 版本比较）。⑦ **README 改为中英两份独立文件**：`README.md` 是**默认**的简体中文（npm 与 DSH 插件市场展示这一份），`README.en.md` 是英文镜像；顶部加语言切换与「改一处要同步另一处」的说明，并补齐英文版缺失的「环境自检」小节；新增 `tests/readme-i18n.test.mjs` 锁住**结构 1:1**（标题层级序列 + 代码块数量 + 互链 + 默认语言标记），防止以后只改一份。⑧ **`secretHint` 凭证提示 + 凭据读取守卫**：填一句自己的约定就会被注入每个会话的 systemPrompt，让 agent 需要 API key / token 时**先查记忆里的「密钥目录」卡**（记忆库只存目录：名字/位置/取用方式，**值留在本机凭据库**）；`dsh-memory setup` 同时注册 Claude Code 的 `PreToolUse` 守卫（拒读 `.credentials.yaml` / `.env` / `*-token` 并指路到加载器），并会刷新仍指向旧安装副本的 hook 路径。⑨ **发布前又抓到三个实测现场并修掉**：① 面板「重启常驻实例」按钮在**服务本页的进程**是旧版时也显示 —— 点了必然 404（旧宿主没有这条路由），用户只看到一句「未知接口」；现在按钮只在「端口上那个常驻实例落后于磁盘」时出现，404/405 还会给一条「重启桌面版 / DSH 或执行 dsh-memory restart」的指路。② 独立页（新版）提交整张表单、宿主还是旧版时：宿主按白名单丢掉它不认识的键（如 `secretHint`）→ 回读校验必然对不上 → 连试 5 次 `dropped`，用户只看到「HMR transactions cannot be nested」；现在应用前按宿主 schema **过滤未知键**（宿主升级后自然生效），并把「配置同步失败」与「自动沉淀异常」彻底分开（`config-warn` / `config-fail`，不再翻红沉淀健康状态）。③ `autoRestartOnDrift` 在宿主快照里没有这个键时按**默认开**渲染（实测现场：0.10.6 宿主 + 0.10.7 面板 → 复选框空着，而宿主实际按开处理，面板与真实行为不一致）。新增 `tests/issue-fixes-4.test.mjs`。`npm test` 共 **274 项** |
| **v0.10.6** | 2026-10-07 | **孤儿 web 有了回收机制 + 共享配置同步失败不再静默**。① **孤儿 web**：web 子进程是 detached 启动的，watchdog 被硬终止时（Windows 上 `process.kill(pid,'SIGTERM')` 即无条件终止）它的退出处理器不执行；若这个 web 当初因为目标端口被占而**退让到 port+1…**，登记它的锁条目又随 watchdog 一起消失 —— 于是 8001/8002 这类端口上会常驻没人认领的 web（实测本机就躺着两个，其中一个已跑了 20 小时，而 `status` 只探配置端口，永远发现不了）。现在 `startWatchdog` 启动时、以及 `stop`/`restart`（`checkPort` 路径）都会扫**退让窗口** `[port+1, port+9]` 并收掉它们；三道门缺一不可（端口在窗口内 / 命令行**确实是本插件的 web** / pid 不在锁里任何 watchdog 的 `pid` 或 `webPid` 上），**别人的 `node web.js` 一个都不杀**。另外 `spawnWeb` 发现目标端口上已有自家 web 时**不再重复拉起**（退让实例的主要来源），只交给 tick 探活。② **`syncConfigFile()` 不再静默吞错**：它写的是独立页 / hooks / MCP 共用的读源，写不进去就表现为「配置改了但他们看不到」——旧实现是 `catch { /* 静默 */ }`（实测到过一次：共享文件 mtime 停在激活前，而宿主里的值已经变了）。现在失败会进 stderr 与「自动沉淀日志」的 warn（同一原因只报一次，不刷屏）；因为 `logCapture` 定义在 `apply()` 更靠后的位置，日志刻意**延迟一拍**再写，避开 `const` 的 TDZ。新增 `tests/watchdog-orphans.test.mjs`（7 项），`npm test` 共 **245 项** |
| **v0.10.5** | 2026-10-07 | **独立 Web 端的配置保存：不再空头承诺，也不再要求「必须装了 DSH」**。① **宿主无关的直写路径（#21）**：独立端保存后若 800ms 内没人消费 pending 文件、**且**本机没有活着的 DSH 宿主（心跳文件 `memory-eternal-config.host.json` 不新鲜、或里面的 pid 已死），就直接把改动**原子合并**写进共享配置、清掉 pending，响应回 `pendingOutcome: applied-direct` —— 于是 Codex / Claude Code / Cursor、以及只跑 `dsh-memory serve` 的用户，保存当场生效（此前那条路只会写「待应用」等一个**根本不存在**的宿主，界面上那句「下次启动生效」永远不会兑现）。宿主活着时**绝不**直写：共享配置是宿主的派生镜像，绕过它会被下一次 `syncConfigFile()` 盖回去（有专门的反向测试守着这条边界）。② **失败要指路，不只是重复报错（#21）**：识别「宿主守卫类」报错 —— `HMR transactions cannot be nested`（Cordis HMR 宿主）与 `root.events.emit is unavailable from a plugin activation`（dsh-tui 一类）是同一族缺陷的两种措辞 —— 并把「此宿主不允许插件从自己的回调上下文写配置」与「去哪改」（**DSH 设置 → 记忆**，或 profile 的配置补丁层）写进放弃时的报错、诊断信息与独立页提示；`POST /config` 同时回 `hostGuard` / `hint` 字段。③ **界面不再一律弹「已保存」（#21）**：客户端开始消费 `pendingOutcome` —— `queued` / `failed` 用**非成功样式**并说明「尚未确认生效」，`applied-direct` 明确写「本机没有 DSH 宿主，已直接写入共享配置」，只有真生效才显示「已保存」。④ 顺带修掉一个会让宿主/测试**无法退出**的清理竞态：心跳定时器与 pending 文件监听都是在异步 `import()` 之后才建立，若在它 resolve 之前就 dispose，回调就再没人清理（心跳定时器还额外 `unref()`）—— `tests/settings-compat.test.mjs` 用假 ctx 跑 `apply()` 时正是被它挂住的。新增 `tests/issue-fixes-3.test.mjs`（9 项），`npm test` 共 **238 项** |
| **v0.10.4** | 2026-10-07 | **四个「看着正常、实际静默错位」的 issue 集中修复（#21 / #22 / #23 / #24）**。① **宿主守卫误报的保存不再被当成失败（#21）**：dsh-tui 一类宿主的能力守卫会在 `settings.update` **内部**的 `describe()` 上抛 `root.events.emit is unavailable from a plugin activation`，而写入其实已经提交 —— 旧实现只认「有没有抛错」，会把**已生效**的改动重试 5 次后标成 `dropped`、日志里还报失败。新增 `applyPatchVerified`（抛错后**回读确认**，判据 `patchApplied` 浅比较，命中则记一行日志按成功处理），drain 与独立 Web 端共用这条路径；独立 Web 的 `POST /config` 也不再无条件回「一切正常」：等最多 800ms 回读 pending 文件，回 `pendingOutcome: applied / failed / queued` 并给对应措辞（`waitPendingOutcome`）。② **`/cards` 的 status 不再静默错位（#22）**：`status=deleted` 现在真的列**回收站**（与 `/recycle/list` 的数字对得上），未知取值显式回 `unknownStatus: true` 并回显 `appliedStatus` / `requestedStatus`（回落 approved 的老行为保留，但不再沉默）。③ **升级后以「端口上真正服务的版本」为准（#23）**：`/overview` 新增**当前服务进程**加载的 `version`；`dsh-memory status` 单独报「端口实际服务版本」，对不上就直说「升级尚未生效」（锁里的版本号只是 watchdog 自述；端口上是 **v0.10.4 之前**的旧 web 时探不到版本 —— 它的 `/overview` 还没有 `version` 字段 —— 这时会明说「是本插件的 web 但不会自报版本，即旧版」，而不是误报「没有服务在响应」）；`stop` 停完再问一次端口占用者、仍被占就告警；`restart` 不再只信锁里登记的 webPid —— 按**端口占用者**兜底收掉锁里没登记的旧 web（先用命令行确认**确实是本插件的 web**（包名 `memory-eternal`，或本插件自己的 `lib/web.js` 绝对路径）才动手，别人的 `node web.js` 只告警不动手 —— 收紧这条判据是刻意的：误杀别人占着该端口的进程，比不杀更糟），端口没空出来就中止重启，起完自检「端口服务版本 = 本机版本」，对不上以非 0 退出（不再打印「已启动」就完事）。④ **蒸馏解析不再把「字符串里的裸控制字符」误判成无法解析（#24）**：模型把 markdown 正文的换行写成真实 U+000A（括号闭合、`looksTruncatedJson` 为 false）时，旧实现必然 `JSON.parse` 失败 → 整卡退成原文卡；新增 `repairJsonControlChars` **只在字符串内部**把裸控制字符转成合法转义（`\n` `\r` `\t` `\b` `\f`，其余 `\u00XX`；字符串外的换行是合法 JSON 空白，一律不动），候选串顺序为「原样 → 截 `{ … }` → 各自的已修复版」；解析失败的消息不再吞掉 `JSON.parse` 原始报错，现场摘要改为**首尾各留一段**（`describeOutputExcerpt`，旧的 `slice(0,160)` 恰好把「被切在 `"body":` 半截处」显示得像输出断了）；撞输出上限的重试从「只翻倍一次」改为 `maxTokenLadder` **一路翻倍到 schema 上限**（1200 → 2400 → 4000，不再止步 2400）。新增 `tests/issue-fixes-2.test.mjs`（21 项），`npm test` 共 **229 项** |
| **v0.10.3** | 2026-10-06 | **修复 `audit list` 的计数语义（#20）**。① 总数与 `--limit` **解耦**：`共 N 张` 取**匹配总数**（`countCards`），`--limit` 只限制显示条数，截断时明确写出 `显示前 M 张 … 还有 X 张未显示`。② **默认不再静默截断**（不给 `--limit`、或 `--limit 0` = 全部显示）。③ `--json` 拆分为 `total`（匹配总数）/ `returned`（本次返回）/ `count`（= total 的兼容别名；0.10.2 里它误等于 returned）/ `limit`（null = 全部）/ `hasMore`。④ `--status all` 的语义写进用法与 README：= 审核队列（pending + rejected），**不含**已出队的 approved 与回收中心的 deleted；`approved` 可显式查询。⑤ **同源修复 MCP 的 `memory_audit_list`**：它同样存在「默认 20 静默截断 + 把截断条数报成待处理数」，现改为报匹配总数 + 未显示提示，上限 100 → 500。 |
| **v0.10.2** | 2026-10-06 | **五个存量 issue 集中修复（#15 / #16 / #17 / #18 / #19）**。① **按项目选库在宿主侧终于生效（#15-1）**：宿主过去拿进程 cwd 去匹配 `vaultProfiles[].match.workspace`，而那是「启动 dsh 的目录」——现在从 `session.header.cwd` 取**会话自己的工作区**（capture 与 memory_recall 两条路径都传），CLI/MCP/hooks 行为不变。② **蒸馏不再选错 provider（#15-2）**：声明 `supportsReasoningEffort:false` 的候选不再被传 `reasoningEffort`（能力未知一律按支持处理），并把它们排到支持者之后但**不删除**，避免兜底全无。③ **输出截断不再伪装成解析失败（#18）**：新增独立错误码 `MAX_TOKENS`（含实际上限值），撞上限自动以双倍上限重试同一候选；兜底上报改为**始终以第一候选为主因** + 其余错误按码汇总（不再被最后一个候选覆盖）；默认 `captureMaxTokens` 900 → **2000**；失败兜底的原文卡加 `distill-failed` 标签便于过滤。④ **独立 Web 端保存配置不再静默丢失（#16）**：drain 报错不再被 `catch {}` 吞掉（进 stderr + 自动沉淀日志，5 分钟去重节流），共享配置 `memory-eternal-config.json` 改为 **tmp + rename 原子写**（原先非原子写会在截断窗口内被独立 web / MCP 读到半截内容 → JSON.parse 失败 → 设置静默回落成默认值），重试耗尽后**保留 pending 文件**并标注 `dropped:true` + `lastError`（不再删除用户改动），失败状态进 `/diagnostics` 与 `/config` 响应。⑤ **审核中心有了 CLI（#17）**：`dsh-memory audit list/approve/reject`（多路径批量、`--json` 便于 jq 筛选、复用同一套 `setCardStatus` 守卫与 `audit_log`）；MCP 侧只新增**只读**的 `memory_audit_list`，不暴露 approve/reject。⑥ **看门狗有了生命周期（#19）**：新增 `dsh-memory status/stop/restart`，锁文件写入 `pkgVersion`（status 会提示「常驻实例是旧版」），宿主日志按抢锁结果如实打印 `spawned` / `delegated to existing pid`（不再每次都谎报 spawned），关闭 `watchdogAutoSpawn` 时明确提示既有实例仍在跑；并且 `dsh-memory stop` 会**连同该 watchdog 拉起的 web 一起停**（Windows 上 `process.kill(pid,'SIGTERM')` 是无条件终止，watchdog 的退出处理器根本不会执行 —— 旧写法会在 stop 后留下一个占着端口的孤儿 web；web 子进程 pid 现在记在锁里，杀之前还会用进程命令行确认确实是 `web.js`，防 pid 复用误杀）；README 修正「默认值自相矛盾」与「重启即可关闭」的错误承诺。 |
| **v0.10.1** | 2026-10-02 | **修复「导出 OK、导入 0 张」**。根因：客户端「导出JSON」写出的是**裸数组**，而 `/import` 只读 `payload.cards` —— 裸数组被静默当成空备份（`ok:true` / `imported:0` / `skipped:0`），UI 只显示「导入完成：0」，看不出是格式不匹配。① `/import` 现在同时接受**裸数组**（v0.10.0 及以前的备份）与**信封对象** `{format, formatVersion, exportedAt, count, cards}`；形状不认识 → **400 + 人话原因**，空文件 → `warning`，坏 JSON → 原有的解析失败提示；② 导出改为**带信封**（老版本只认 `payload.cards`，信封对老版本也互通）并保留每张卡的 `status` / `store`；③ 导入去重基线改为**导入前快照**（`writeCard` 新增 `dedupAgainst`）—— 否则同一份备份里互相近似的卡会在写入过程中互相判重、被自己人吞掉一批（备份是真相源）；④ 导入应答补 `total` / `skipped` / `quarantined` / `failed[]`（含每条未导入原因），提示语改为「导入完成：N 张 / 文件共 M 张 · 待审核 K · 跳过 D」，一张都没进来时按**失败样式**提示；⑤ 新增 `tests/import-roundtrip.test.mjs`（6 项：裸数组 / 信封 / 导出→导入全量往返 / 重复导入如实报重复 / 坏形状 / 审核守卫不可绕过）。⑥ **装坏了也要说人话（issue #14）**：从插件市场装出来的副本可能缺 `web/` 静态资源，那时侧边栏「记忆」只会弹一页 `{"ok":false,"error":"ENOENT …"}` —— 现在缺 `index.html` 但 `app.js` 还在就用**内置外壳**把界面拉起来（自救），缺 `app.js` 则回一段把诊断画进 `#root` 的 JS + 一页含「缺哪个文件 / 绝对路径 / 包版本 / 怎么重装」的说明；两种缺失都写进自动沉淀日志（`app.js` → `fail` 健康态亮红、只缺 `index.html` → `warn`），宿主启动时也自检一次（判据与措辞由新增的 `lib/web-assets.js` 统一，附 `tests/web-assets.test.mjs` 6 项）。⑦ 顺带修 `appendCaptureLog` 在 `DSH_HOME` 目录不存在时静默失败（诊断信息连一条都留不下）。⑧ **DSH 兼容范围放宽到 `>=0.1.5-alpha.2 <0.3.0-0`**：旧上界 `<0.2.0` 按 semver 会把 DSH `0.2.0-rc.x` 排除在外（DSH 守卫用 `includePrerelease:true`，实际装得上，但声明与事实不符）——现在覆盖整个 0.1/0.2 线，`<0.3.0-0` 仍挡住 0.3.0 及其预发布；`dsh.compatibility` 同步补 `"0.2.0-rc.2": "compatible"`（本机在官方桌面版 0.2.0-rc.2 上实测运行）。⑨ **修三个第三方插件清单长期非法 JSON**：`.claude-plugin` / `.codex-plugin` / `.cursor-plugin` 的 `description` 收尾引号被双重编码吃掉（最后改动停在 v0.9.23），DSH 不走这三个文件所以一直没暴露，但 Claude Code / Codex / Cursor 侧安装**必然解析失败**；现已重写为合法 UTF-8 JSON、`version` 跟到 0.10.1，并新增**随包体检守卫** `tests/manifests.test.mjs`（3 项：随包 JSON 全部可解析 / 三清单 `name`+`version` 与 package.json 一致 / 随包文本无编码事故乱码）。实测用户 **661 张真实备份（裸数组、3.9MB）：修复前导入 0 张 → 修复后 661 张**（654 进主库 + 7 进隔离区）。`npm test` 共 **187 项** |
| **v0.10.0** | 2026-09-30 | **两套存储：未审核内容物理隔离**。① `cards`（主库）只存 `approved`，新增 `quarantine`（隔离区，含 `quarantined_at` / `quarantine_reason`）存 `pending`/`rejected`/`deleted`；② 召回/检索/图谱/去重/导出等读路径**不再需要状态条件**（查主库即安全），根治 v0.9 审计出的三处绕过审核漏洞（去重池把新知识写进待审卡、`readCard` 直读未审核正文、`/card` 无状态校验）；③ 审核流转改为**跨表搬家**（事务内完成，id 由新增的 `card_sequence` 单一发号器分配，`card_updates` 随卡改绑）；④ 首次启动**自动迁移**存量非 approved 卡（不删内容，幂等）；⑤ 新增 `checkMainStoreInvariant()` 不变量体检与 `tests/two-store.test.mjs`（15 条）；⑥ 入料噪声闸门：剥离 DSH 运行时注入（环境快照 / team 广播 / teammate 原文 / 工具说明），挡住碎片卡与糊标题；⑦ 修 `settings-compat` 在 Windows 上的原生崩溃（`fs.watch` 父目录 → 改监听文件） |
| **v0.9.23** | 2026-09-30 | **保存不再闪烁**。保存成功后客户端会立刻重拉 `/config`，而宿主 volatile 回流是滞后的 → 输入框会「先退回原配置、再跳回修改后的值」。现在客户端把「已保存但宿主未回显」的字段做**本地叠加**（新增 `src/client/config-merge.js` 纯函数 + 4 项单测），宿主回显一致后自动摘除，之后仍跟随宿主权威值；重置表单会清空叠加层。`npm test` 共 **139 项** |
| **v0.9.22** | 2026-09-30 | **配置准即时同步（SSE 推送 + 文件监听）**。① 新增 SSE 推送中心 `lib/sse.js`：DSH 内嵌宿主与独立 Web 宿主都暴露 `/memory-eternal/api/events`，配置一变更就推给所有已打开的页面，客户端订阅后自动重载 —— **正在编辑时不覆盖你的输入**（dirty 标记）。② 独立页保存 → DSH 应用：从 5 秒轮询升级为 `fs.watch` **毫秒级**触发（5 秒轮询保留为兜底）。③ 独立页监听共享配置文件：DSH 端一保存，独立页立刻同步。新增 `tests/sse.test.mjs`（5 项），`npm test` 共 **135 项** |
| **v0.9.21** | 2026-09-30 | **保存成功不再被误读为失败 + 配置页排版修复**。① 保存成功一律用**成功样式**提示（原来「已写入；宿主尚未回流」被弹成红色失败样式，用户以为保存失败），措辞改为「已写入配置文件；宿主仍是旧版，重启 DSH 后即以新值为准」；② 配置页字段网格列宽 150/160px → **200/220px**、间距加大、长中文标签允许换行，勾选框与说明文字顶端对齐，字段不再互相挤压。 |
| **v0.9.20** | 2026-09-30 | 独立 Web 页补**取值范围校验**：`/config` 镜像 Config schema 的 min/max（如 `recycleRetentionDays` 1–3650、`webPort` 1–65535），越界直接 **400** 并说明「需要 1–3650，当前 0」。至此「数字框清空 / 越界」这条最常见的保存失败链路在**客户端 + 独立页 + 宿主**三层都被拦住并给出字段级原因。 |
| **v0.9.19** | 2026-09-30 | **「保存失败」不再无信息量（根因：数字框清空＝0 被 schema 拒绝，宿主回空 500）**。复现与实测：越界值 / 清空数字框 / 类型错误 → DSH 宿主返回 **HTTP 500 + 空响应体** → 客户端 `r.json()` 抛错 → 只能显示通用「保存失败」。修复：① **数字输入框清空不再静默变成 0**（JS 里空串转数字得 0，而 `recycleRetentionDays` 的 schema 是 `min(1)`，直接失败）；② 保存前按 schema 范围**逐字段自检**，指名报错（例如「recycleRetentionDays」需要 1–3650 之间的数字，当前 0）；③ 响应体兜底解析：非 JSON / 空响应体时显示 HTTP 状态码与原始片段，而不是「保存失败」；④ 宿主 POST 外层兜底，**绝不返回空响应体**，并对空字符串数值字段前置返回 400 + 字段名；⑤ 独立页 /config 增加类型与范围校验（拒绝空数值、类型不符），避免写入非法「待应用」值；⑥ `drainPendingConfig` 增加失败计数，连续 5 次失败后放弃并删除（不再每 5 秒无限重试）。`npm test` 共 **130 项** |
| **v0.9.18** | 2026-09-30 | **独立 Web 页终于能保存配置 + 只读状态不再「毫无反应」**。根因（issue #12 的另一半）：独立 web server 进程**没有 DSH 的 settings 服务**，它的 `/config` 过去固定返回 `writable:false`，客户端 `save()` 第一行就 `if (readonly) return`，按钮还是 `disabled` —— 所以点保存**一点反应都没有**，与插件版本无关。修复：① 新增共享文件协议 `lib/config-sync.js`：独立页保存 → 原子写 `memory-eternal-config.pending.json` → **DSH 端激活时与每 5 秒轮询应用**（`settings.update(patch, undefined)` 跳过乐观并发校验），成功后删除，失败保留重试；DSH 没运行时改动留在文件里，下次启动生效。② 独立页 `/config` 返回 `writable:true, viaPending:true`，页面顶部显示蓝色说明「保存会写入待应用文件，由 DSH 自动同步」。③ **只读时按钮不再禁用**：点击必弹出明确原因（`🔒 只读` + 指引「桌面版 → 设置 → 记忆」），彻底消灭「按了没反应」。新增 `tests/config-sync.test.mjs`（4 项：读写往返、损坏内容容错、drain 成功即删/失败保留、clear 幂等）。`npm test` 共 **125 项** |
| **v0.9.17** | 2026-09-30 | **「更新了却还是旧界面」根治**。① 构建期把插件版本注入客户端 bundle，配置页新增「**页面脚本 vX**」徽标；② 当**页面脚本版本 ≠ 磁盘版本**时醒目提示「⚠ 当前页面仍在运行旧版脚本（页面 v{page} / 磁盘 v{disk}）：**按 Ctrl+F5 刷新页面即生效**」；当「运行中（宿主加载）」落后于磁盘时，提示语也改为「先刷新页面，宿主半未更新才需重启桌面版 / DSH」。起因：issue #12「保存配置没有任何反馈」的真实原因之一，就是页面里跑的还是更新前加载的旧 JS —— 宿主已设 `Cache-Control: no-store`，但**已打开的页面不会自动重新加载脚本**，不刷新永远是旧的。另：独立 web 服务（`:7999`，9/29 启动的旧进程）已重启到新版并验证 `loaded=onDisk=latest` |
| **v0.9.16** | 2026-09-30 | **修复配置保存不生效（issue #12）+ 配置项全覆盖**。① **保存链路**：宿主 `dsh-settings.write()` 要求「面板持有的 revision 与 describe **完全一致**」，revision 一过期就抛 `SettingsConflictError` 导致保存失败 —— 现在遇到冲突会自动取最新 revision **重试一次**（提示里标 ♻）。② **宿主 volatile 回流滞后**：写成功后把改动叠加在本地视图（面板重开立刻是新值），等宿主快照追上再自动摘除；宿主 POST 新增**写入回读校验**，未回流时返回 `pending` 并提示「已写入，重启 DSH 后以配置文件为准」。③ **保存即时反馈**（你此前反馈过）：保存按钮旁直接显示 ⏳ 保存中 / ✅ 已保存 / ⚠ 错误，并标明是否重试/是否回流；按钮文案修正（原来误显示「导出中…」）。④ **配置全覆盖**：补齐 7 个以前只能手改配置文件的字段 —— **总开关 `enabled`**、单库目录 `vaultDir`、蒸馏路由 `captureProvider` / `captureModel`、沉淀冷却 `captureCooldownMs`、语义召回 `recallEmbedding`、会话预算 `sessionBudgetChars`；宿主 `/config` 补 6 项、独立 web `/config` 补 9 项。⑤ 新增**永久守卫测试**：`tests/config-coverage.test.mjs` 保证每个 Config 字段都被「宿主 API / 独立 web API / 配置页」三处覆盖（漏一个就红），`tests/settings-save.test.mjs`（5 项）钉死 revision 重试、回流兜底与「错误不吞」。`npm test` 共 **121 项** |
| **v0.9.15** | 2026-09-29 | **只带服务器侧图谱提速（渲染与 v0.9.13 完全一致）**。① **建图落盘缓存**：按指纹缓存 nodes+edges 到 `<vault>/memory-eternal-graph-cache.json`（原子写、指纹失效、超 8MB 不缓存、写失败只影响下次重建），596 卡实测冷启动 **422ms → 11ms**；② **bigram 哈希化 + 稀有 gram 计数排序**：`bigramHashSet()` 把 bigram 压成 32 位整数入 `Set<number>`（**写卡去重仍用字符串版，判定语义不变**），稀有倒排改按 df 计数排序（202 → **54ms**）；③ **MinHash + LSH 候选生成**（48 维签名 / 24 band，与稀有倒排取并集后**精确校验**）：jaccard 调用 15,148 → 6,797，相似度段 210 → 130ms。全量冷建图 **600 → 422ms**，边数与 v0.9.13 一致（tag 2777 / similar 4）。**客户端零改动**：不做精灵/静态层/骨架降级（v0.9.14 那三项因影响手感已回退并 deprecated）。新增 `lib/minhash.js` + `tests/minhash.test.mjs`（4 项），`npm test` 共 **108 项** |
| **v0.9.13** | 2026-09-28 | **按用户反馈修 7 项**。① **版本跟踪**：配置页「插件信息」同时显示**运行中（宿主加载）/ 磁盘安装 / npm 最新**三个版本；磁盘比运行中新时给橙色警告（「磁盘已安装 X，但当前进程仍加载 Y —— 重启后才生效」），并新增「🔄 检查更新」（服务端查 npm，10 分钟缓存 + 4s 超时）。② **复制失败**：记忆弹窗在 iframe 里、默认没有 clipboard-write 权限，`navigator.clipboard.writeText` 必然被拒 —— 现在先试 Clipboard API，失败退 `document.execCommand('copy')`，再失败就把内容摊进只读文本框并给「全选」；iframe 加 `allow="clipboard-write; clipboard-read"`。③ **保存没有提示**：保存结果显示在保存按钮旁（⏳ 保存中… / ✅ 已保存 / ⚠ 错误），文案从错误的「导出中…」改为「保存中…」。④ **回收中心**：恢复 / 彻底删除 / 清空都有成功与失败提示，空库给说明与禁用态。⑤ **通用按键反馈**：审核中心的批准 / 驳回 / 删除原先 `catch{}` 吞掉一切，现逐条统计成功失败并提示；未选卡片也提示。⑥ **图谱缩放卡顿**：新增 `src/client/graph-lod.js` —— **视口剔除**（屏幕外节点/边不画）+ **标签预算**（≤120 全画 / ≤300 画 160 / ≤600 画 90 / 更多画 60，优先焦点、悬停、搜索命中、高度数）+ **文本宽度缓存** + **大图关阴影**。⑦ 新增 `tests/graph-lod.test.mjs`（5 项），`npm test` 共 **108 项** |
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

</details>
| v0.2.0 | 2026-09-03 | recall 含正文修复（`search()` 返回 excerpt 字段） |
| v0.1.2 | 2026-09-03 | 审核守卫加固（`writeCard` 默认 `pending`，`mergeCards` 走审核） |
| v0.1.1 | 2026-09-03 | recall 含正文修复（excerpt 字段 + body 逻辑修正） |
| v0.1.0 | 2026-08-31 | 首发：自动沉淀 + 自动召回 + 图形化知识库 + 知识图谱 + 审核中心 + 回收中心 |

</details>

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
