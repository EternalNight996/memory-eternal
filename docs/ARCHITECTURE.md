# 架构说明（Architecture）

记忆核心（memory-eternal）是一个独立 DSH 插件，采用「host 半边负责数据与逻辑、client 半边负责图形化界面」的双进程结构，与 [dsh-ui-three-body](https://github.com/EternalNight996/dsh-ui-three-body) 同一套插件装载机制。

```
┌───────────────────────── DSH Web (browser) ─────────────────────────┐
│  src/client/index.tsx → lib/client.js (esbuild 打包)                │
│  · 设置 → 记忆 页面（slots settings.section 挂载）                   │
│  · 统计 / 检索 / 知识卡网格 / 知识图谱（fetch /memory-eternal/api/*）    │
└───────────────┬─────────────────────────────────────▲───────────────┘
                │ fetch（同源 webServer 路由）          │ JSON
┌───────────────▼─────────────────────────────────────┴───────────────┐
│  index.js（host 半边，DSH Node 进程）                               │
│  · settings 命名空间 memory-eternal                                    │
│  · agent/turn-stopping 钩子 → 自动沉淀管线                          │
│  · systemPrompt 召回段 + memory_recall 工具                         │
│  · webServer /memory-eternal/api/* JSON 路由                           │
│  ├── lib/vault.js     Markdown Vault 存储层（纯 Node，可单测）      │
│  └── lib/capture.js   自动沉淀管线（LLM 压缩 + 语义去重）            │
└───────────────────────────┬─────────────────────────────────────────┘
                            ▼
              ~/.dsh/memory-vault/（本地 Markdown 知识库）
```

## 数据流

### 自动沉淀（写入路径）

1. `agent/turn-stopping`（serial 事件）触发：同步抓取 `agent.session.events` 增量快照（按 seq 过滤，`sliceNewEvents`），不阻塞收尾。
2. 后台队列执行 `runCapture`：
   - `extractLastTurn` 提取 user/assistant 文本（工具结果不进入）；
   - 短于 `captureMinChars` 直接跳过；日配额 `maxCardsPerDay` 防烧 token；
   - `resolveRoute` 取当前 provider 旗舰模型（与驯兽师一致）；
   - `pickNeighbors` 按关键词重叠选出最相关已有卡（≤8 张，控制 token）；
   - `summarizeTurn` 把对话 + 已有卡索引交给模型，输出严格 JSON：
     - `{"save":false}` → 丢弃；
     - `{"append_to","update"}` → 追加更新记录到已有卡（语义去重，免疫 LLM 改写）；
     - `{"save":true,title,kind,tags,body}` → 写新卡。
3. `writeCard` 写入前再做**词法去重**（Jaccard 字符 bigram，阈值 0.62，移植 boujoy）：命中则拒绝新建、改为 `appendUpdate` 追加「更新记录」段。

### 自动召回（读取路径）

- `systemPrompt.section`：注入「你拥有记忆核心 + 规则」段（可配置关闭）；
- `memory_recall` 工具：CJK 感知检索（整词 + 中文字符 bigram），返回命中卡摘要。

### 图形化知识库（client 路径）

- `settings.section` id=`memory-eternal`：统计概览、搜索框（280ms 防抖）、kind 筛选、知识卡网格、SVG 知识图谱；
- 数据源：host `webServer.register({kind:'prefix', path:'/memory-eternal/api'})`，端点：
  - `GET /overview` — 统计（总数/分 kind/近 7 天/标签数/vault 路径）
  - `GET /cards?kind=&q=&limit=` — 卡片列表
  - `GET /card?path=` — 卡片全文（阅读弹层）
  - `GET /search?q=` — 检索命中
  - `GET /graph` — 图谱节点与边（wikilink + 共享标签）

## 关键设计决策

| 决策 | 理由 |
| --- | --- |
| **两套存储**：`cards`（主库）只存 approved，`quarantine`（隔离区）存 pending/rejected/deleted | 读路径查主库即安全，不再依赖「每处 SQL 都记得写状态条件」 |
| Vault = 普通 Markdown | 用户拥有数据；可手动编辑、可 git、可被 Obsidian 等工具读取；不锁进私有数据库 |
| 模型决定「建/并/弃」 | 对齐 boujoy「模型判定价值与压缩」哲学；语义去重比纯词法更抗 LLM 改写 |
| 词法去重兜底（只在主库内） | 低成本防重复卡堆积；阈值与 boujoy 一致（0.62）；隔离区卡不作去重基准 |
| **入料噪声闸门** | 剥离 DSH 运行时注入（环境快照 / team 广播 / teammate 原文 / 工具说明），挡住「对话原文即卡」的垃圾卡 |
| 增量 seq 捕获 | 多轮会话不重复处理历史；避免把整段历史重复喂给模型 |
| 后台队列 + 日配额 | 不阻塞 turn 收尾；防止大扫荡烧光 token |
| 同源 fetch API | 不引入 typert/Remote 复杂度；client 只需 `fetch('/memory-eternal/api/…')` |

## 两套存储（v0.10）

```
              ┌──────────────── 读路径（agent / 图谱 / 检索 / 去重 / 导出）────────────────┐
              │  查 cards 即可 —— 表里物理上只有 approved，不需要写 WHERE status          │
              ▼                                                                          │
   cards（主库 / 正常区）  ◀── 审核通过（promote）──┐                                      │
        ▲                                          │                                      │
        │ 驳回 / 软删（demote，跨表搬家）           │                                      │
        └──────────────────────────────────────▶ quarantine（隔离区 / 异常区）───────────┘
                                                   pending · rejected · deleted
                                                   ↑ 新卡默认落这里（审核队列）
```

- **为什么分表而不是加个 status 列**：v0.9 是「一张表 + status」，安全性依赖每一处 SQL 都记得写状态条件。
  审计实测漏了三处（去重池把新知识追加进待审卡、`readCard` 直读未审核正文、`/card` 接口无状态校验），
  只要再漏一处就会重演。物理分表后，漏写条件也不泄漏。
- **审核流转 = 跨表搬家**：`setCardStatus` 是唯一入口；approved → 搬进 `cards`，其余 → 搬进 `quarantine`。
  搬家在一个事务里完成，并把 `card_updates.card_id` 改绑到新 id。
- **id 发号**：两表共用 `card_sequence` 单一发号器（显式 `nextCardId()`）。**不能**用两张 AUTOINCREMENT 表 ——
  它们各有一份 `sqlite_sequence` 且都从 1 开始，共享 id 空间时必然撞 `UNIQUE constraint failed`（实测）。
- **`card_updates` 不带外键**：`card_id` 指向两张表之一，SQLite 外键只认一张父表；永久删除时由 `deleteCard` 手工清理。
- **不变量**：`checkMainStoreInvariant(root)` —— 主库必须只有 approved，供测试与「用量」体检使用。
- **回滚提示**：老版本回滚后看不到隔离区（审核队列会显示为空），但数据都在同一个 `.db` 里，升级回来即恢复。

## 目录结构

```
memory-eternal/
├── index.js             # host 半边
├── lib/
│   ├── vault.js         # Vault 存储层（parseCard/safeSlug/textSimilarity/dedupCheck/queryTerms/listCards/search/graph/overview/writeCard/appendUpdate/ensureVault/readCard）
│   └── capture.js       # 沉淀管线（summarizeTurn/parseCaptureJson/extractLastTurn/sliceNewEvents/pickNeighbors/captureCard/captureUpdate/makeDedupChecker）
├── src/client/index.tsx # client 半边（设置页 + 侧边栏「记忆」按钮 + 完整记忆库弹窗）
├── build.mjs            # esbuild → lib/client.js
├── cordis.patch.yml     # bundle 补丁层
├── tests/               # node:test 单测（vault 12 + capture 12 + api 5 = 29）
├── README.md / PUBLISH.md / LICENSE
└── assets/              # README 截图（memory-settings / memory-popup / memory-sidebar）
```

## 依赖

- 运行时（host）：`@deepseek-ai/schemastery`（配置 schema）、`@deepseek-ai/dsh-tools`（工具）、`@deepseek-ai/dsh-llm`（流式模型调用）——均为 peerDependency，由 DSH 提供。
- 构建（dev）：esbuild。
- client：仅 React（DSH `__ModuleLoader__` 注入），零第三方 UI 依赖。
