# 天机阁典籍库接入记忆核心（TIANJI-KB）

把 `dsh-purge` 的知识库（`~/.dsh/redteam/knowledge.db`：`poc` 14,225 条 + `kb_note` 22 条）**导出**成记忆卡，
让 agent 通过 `memory_recall` 按 tag 直接调到「能打的武器」，而不是反向读问道库。

- 导出脚本：`F:\MyApp\dsh-purge-v1.1.71\scripts\export-kb-to-memory.mjs`
- 目标库：`~/.dsh/memory-vault/memory-eternal.db`（`POST /memory-eternal/api/write`）
- 幂等键：`source = poc:redteam:<code>` / `kb:redteam:<id>`（重复跑自动跳过）

## 1. 为什么是「导出」而不是「反向读」

反向读要在记忆侧嵌一个跨库查询层：两套 schema、两套状态机（cards.status 审核态 vs poc.verified/hit_count）、
两套权限与生命周期，任何一侧升级都要同时改两边，而且 agent 的 `memory_recall` 一次调用跨不到两个库。
导出成卡片后：**召回、图谱、审核、回收站、向量检索全部复用记忆核现有的那条链路**，问道库继续当"原始仓库"。

## 2. 类型识别（tag 约定）

每张导入卡至少带这几组 tag，agent 用 tag 就能定向取武器：

| tag | 含义 | 例 |
|---|---|---|
| `redteam-kb` | 来源标记（天机阁典籍库） | — |
| `poc` / `kb-note` | 条目种类 | — |
| `type:<漏洞类型>` | **主类型**（识别后的类型，不是原始归类） | `type:sqli`、`type:deserialization` |
| `kind:<种类>` | POC / EXP / 模板 / 载荷 / 脚本 | `kind:template` |
| `cve:CVE-XXXX-YYYY` | 有 CVE 才带 | `cve:CVE-2025-22214` |
| `组件:<产品>` | 有组件才带 | `组件:Weblogic` |
| `severity:<等级>` | critical / high / medium / low / info | `severity:critical` |

检索示例（agent 侧）：

```bash
dsh-memory recall "type:sqli severity:critical"        # 高危 SQL 注入武器
dsh-memory recall "type:deserialization Weblogic"      # 反序列化 + 指定组件
dsh-memory recall "type:tunnel socks"                  # 隧道类工具与配置
```

它同时写在卡片正文开头的元数据行里（`原始归类 → 识别类型`），需要复核映射是否合理时看正文。

## 3. 识别规则

两级判定，避免把「Detect 模板」误当武器：

1. **原生 `category` 优先**（与面板计数口径一一对应，14 类）；
2. `category='other'` 的 9745 条再做反推：先跑**元数据**（code / title / 组件 / tags / description）的 29 条规则，
   再退到**正文强特征**（`AC ED 00 05`、`union select`、`/etc/passwd`、`169.254.169.254`、`<!ENTITY`、`AKIA…` 等 9 条无歧义指纹）。
   **不拿 nuclei yaml 正文跑宽关键词**——否则 `*-detect` 模板会被大面积误判成 rce。

实测（`--dry-run`）：`other` 从 **9745 → 556（-94.3%）**；原生非 other 的计数与面板完全一致。

派生类型（面板暂无对应归类，只在卡 tag 里）：
`xss 1276 / fingerprint 3777 / secret-scan 691 / misconfig 615 / cloud 550 / phishing 352 / malware 279 / compliance 236 / open-redirect 126 / takeover 86 / mobile-config 26 / injection 20 / dos 19 / memory-corruption 16 / csrf 6`。

## 4. 导入命令

```bash
cd F:\MyApp\dsh-purge-v1.1.71

# 先看计划（不动库）
node scripts/export-kb-to-memory.mjs --dry-run

# 分批定向导入（推荐：武器类优先，侦察/合规类先不导，避免稀释召回）
node scripts/export-kb-to-memory.mjs --types rce,sqli --limit 500 --yes

# 全量（谨慎：14,225 张会让召回池 ×5.6）
node scripts/export-kb-to-memory.mjs --limit 500 --yes
```

参数：`--limit N` / `--types a,b` / `--only-verified` / `--include-notes` / `--fix-native` / `--base-url` / `--token` / `--json`。

## 5. 现状（2026-11-13 实导）

| 项 | 数值 |
|---|---|
| 已导入 | **4,164 张**（17 个武器类型，`approved` 直进主库） |
| 记忆库总量 | 3,057 → **7,228** 张 |
| 库体积 | 38.3 → **61.7 MB** |
| 失败 | 0 |
| 幂等复跑 | `written=0`（全部按 `source` 跳过） |
| FTS 检索 | `sqli` 命中 506、`log4j` 命中 49 |
| `memory_recall` 实测 | 按 `type:sqli` 能召回导入卡全文 ✅ |
| **向量覆盖** | 2,980 / 7,228 ≈ 41% —— 本地嵌入服务 `127.0.0.1:7997`（bge-m3）当前不在线，新卡暂无向量；服务起来后跑 `node scripts/embed-backfill.mjs` 补齐 |

## 6. 还没做的取舍

1. **侦察/合规类未导**：`fingerprint 3777 / secret-scan 691 / misconfig 615 / cloud 550 / compliance 236 / phishing 352`——对"找武器"帮助小，先留在原库；要导就 `--types fingerprint,...`。
2. **`other` 剩 556 条**：剩余主要是 nuclei 的日志分析、语言 scanner、Android manifest 检查、无关键词的 CVE，继续加规则收益递减。
3. **原生归类有噪声**：909 条原生 `rce` 里约 232 条实际是云配置检查（`ack-cluster-network-policies-disable` 这类）。脚本提供 `--fix-native` 改判（会影响 190 条），默认关闭——因为一开就与面板 `category` 计数不一致。要不要开、要不要顺带修 `knowledge.db` 的 `category`，留待决策。
4. **派生类型在 dsh-purge 面板点不到**：面板 `category` 筛选只认 `schema.js` 里那 14 个 code，`xss/fingerprint/...` 只在卡 tag 里。要在面板按这些类型筛，得二选一：① 把反推结果写回 `knowledge.db` 的 `category`（改库 + 同步 `POC_CATEGORIES`）；② 面板改成按 `type:` 语义映射到多条原生归类。
5. **审核**：`/write` 的 `dedup:false` + 当前 `auditMode: none`，导入直接 `approved` 进主库（不经待审隔离区）。要留痕就在导入前后各跑一次 `dsh-memory audit list`。

## 7. 面板：类型可展开（`lib/redteam/client.js`）

知识库页的归类胶囊原来平铺 14 类，现在：默认只显示 **前 8 个高频类型** + `更多类型 ▾（+N）` 按钮，展开后显示全部 + `收起 ▴`；
选中项不在前 8 时自动补位显示（不会"点了却看不见当前筛选"）。点胶囊仍是「同类再点 = 取消筛选」的原有语义。

构建：改完 `lib/redteam/client.js` 后 `node scripts/build-client.mjs`（把 drill 片段重新嵌进根 `client.js`），再重启 DSH 桌面端 / 刷新面板。

## 8. 技能侧同样打类型标签（memory-eternal 面板）

问道/普通技能卡也走同一套「类型」思路，形成「资源 = 卡片 + 类型 tag」的统一口径：

- 识别：`lib/skill-cards.js` 的 `skillTypeOf()`，21 类（侦察/破绽发现/借势/洞天游历/传送阵代理/蔽息藏形对抗/参悟解禁/移动端/物联网/天机讯息/试炼秘境/越阶/道印灵钥/Web 安全/报告/自动化/记忆/写作/办公/开发/其它）。匹配顺序：**名字 → description/whenToUse → 正文前 1200 字**各跑一轮，每轮按优先级取第一个命中，命中的全集都进 tags。
- 落库：`tags` 变 `['技能类型:<中文>', 'skill-type:<code>', ...]`，正文元数据行多一行 `- 类型：<中文>`；幂等键 `source='skill:<name>'` 不变。
- 问道 47 个技能实测 **0 个 other**：参悟解禁 9 / 传送阵代理 6 / 侦察 5 / 洞天游历 4 / 蔽息藏形对抗 3 / Web 安全 3 / 试炼秘境 3 / 破绽发现 3 / 移动端 2 / 自动化 2 / 物联网 2 / 借势 2 / 道印灵钥 1 / 天机讯息 1 / 越阶 1。
- 面板：技能库的类型芯片默认显示前 8 个 + `更多类型 ▾`，卡片上的 `技能类型:x` 是可点标签（点击即按该 tag 过滤）。
- 入库现状：`/skills/sync` → `total=151 created=47 pendingUpdates=104`，随后一次性审批（151 条全部 approved）→ 技能卡 **151/367 带类型 tag**（余下 216 张的源技能已从磁盘移除，保留旧内容不重算）。

