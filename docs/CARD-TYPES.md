# 卡片类型（CARD-TYPES）：知识类型与技能类型

记忆卡的 `kind` 回答的是「这条记录以什么形态存进来」（project / knowledge / mistake / tool / content / prompt / skill），
但 agent 真正要找的往往是「这是什么性质的知识」。所以面板与检索侧另有一个**类型维度**，落在 `tags` 上：

| 维度 | tag 形式 | 适用范围 | 例 |
|---|---|---|---|
| 知识类型 | `知识类型:<中文>` + `knowledge-type:<code>` | 除 `kind=skill` 外的所有卡 | `知识类型:根因分析` / `knowledge-type:root-cause` |
| 技能类型 | `技能类型:<中文>` + `skill-type:<code>` | `kind=skill` | `技能类型:隧道代理` / `skill-type:tunnel` |
| 破绽类型 | `type:<code>` | 天机阁典籍库导入卡（另有 `kind:<template|poc|exp>`） | `type:sqli` / `kind:template` |

三个维度互不冲突：技能卡只走技能类型；问道导入卡的知识类型统一是 `漏洞模板`，细分靠 `type:*`。

## 1. 知识类型（21 类）

根因分析 / 经验教训 / 决策结论 / 踩坑记录 / 架构设计 / 部署运维 / 配置项 / 接口对接 / 安全风险 / 性能优化 /
测试验证 / 流程步骤 / 需求定义 / 概念解释 / 数据分析 / 会议记录 / 周期回顾 / 复盘总结 / **阵图残卷** / 工具用法 / 其它。

识别实现：[lib/card-types.js](lib/card-types.js) 的 `knowledgeTypeOf(card)` —— **纯关键词纯函数**，不调模型：

1. `source` 命中 `poc:redteam:` / `kb:redteam:` → 一律 `漏洞模板`（避免 yaml 正文里的词把类型带偏）；
2. `kind==='skill'` → 直接返回空（技能卡走技能类型，两套维度不打架）；
3. 否则按 **标题 → tags → 正文前 800 字** 三轮匹配，命中即取（顺序即优先级）；
4. 都没命中时按 `kind` 兜底：`mistake→经验教训`、`prompt→概念解释`、默认 `其它`。

落库用 `mergeTypeTags(tags, typeTags, { max: 20 })`：先剔除旧类型标签（含技能侧），把类型标签排到最前，再按上限合并 —— 幂等。

## 2. 检索侧怎么用

```bash
dsh-memory recall "知识类型:根因分析"          # 所有根因分析
dsh-memory recall "knowledge-type:decision"   # 决策结论（机器键，等价）
dsh-memory recall "技能类型:隧道代理"          # 技能卡按类型
dsh-memory recall "type:sqli severity:critical"  # 红队武器
```

agent 侧同理：`memory_recall` 一次调用就能按类型收窄，不用自己读 body 里猜。

## 3. 回填脚本

识别逻辑变了、或某天想重算，直接重跑（幂等）：

```bash
node scripts/backfill-card-types.mjs                            # 只统计（dry-run，默认）
node scripts/backfill-card-types.mjs --yes                      # 真写 cards
node scripts/backfill-card-types.mjs --yes --include-quarantine  # 连待审/回收站一起
```

实测分布（2026-11-13，7,283 张）：

| 类型 | 张数 | 类型 | 张数 |
|---|---|---|---|
| 阵图残卷 | 4,164 | 架构设计 | 104 |
| 部署运维 | 477 | 安全风险 | 65 |
| 决策结论 | 393 | 流程步骤 | 64 |
| 根因分析 | 380 | 工具用法 | 60 |
| 其它 | 319 | 性能优化 | 59 |
| 测试验证 | 256 | 需求定义 | 45 |
| 配置项 | 252 | 概念解释 | 36 |
| 踩坑记录 | 184 | 数据分析 | 30 |
| 经验教训 | 148 | 复盘总结 | 16 |
| 接口对接 | 126 | 会议记录 | 1 |

## 4. 面板

- **类型芯片行**（卡片库视图）：服务端 `GET /memory-eternal/api/type-cloud[?kind=knowledge|skill]` 返回按卡片数倒序的类型计数；
  面板默认只铺 **前 8 个**，其余折叠进 `更多类型 ▾（+N）`，展开后 `收起 ▴`。点芯片 = 按该 tag 过滤（对所有 kind 生效），再点取消。
- **卡片上的类型标签**：`知识类型:x` / `技能类型:x` 单独渲染成可点标签（品牌色），`knowledge-type:` / `skill-type:` 机器键不显示。
- **卡片阅读器**：标签区先过滤机器键再显示，避免"一屏都是英文 code"。

## 5. 踩过的坑（已修，留档）

- **回填把技能卡的类型标签删了**：早期 `knowledgeTypeOf` 对 `kind==='skill'` 只把 `code` 置空、没提前 return，
  兜底逻辑又把它判成 `其它`，于是回填给技能卡写了 `知识类型:其它` 并按「剔除旧类型标签」删掉了 `技能类型:*`。
  现在的实现直接 `return { code: '' }` 并让回填 `skipped`；已用回填前的备份（`memory-eternal-2026-11-13_1057.db`）
  按 `path` 精确恢复了 367 张技能卡的 tags，复核：`技能类型:` 151 张、技能卡残留 `知识类型:` **0** 张。
- **测试守卫别绑字面写法**：`tags-normalize` 里有两条源码守卫断言 `tagsOf(card).slice(0, 2)`、`(Array.isArray(tags) ? tags : []).slice(0, 8)`，
  类型标签重构（先 `const tags = tagsOf(card)` 再 find/filter）后写法变了但语义没变 —— 守卫已放宽成「走兜底 + 不直接 `card.tags.slice(`」。

## 6. 测试

```bash
node tests/card-types.test.mjs     # 7 项：标题/tags/正文优先级、红队卡、技能卡、kind 兜底、类型表自洽、mergeTypeTags 幂等
node tests/tags-normalize.test.mjs # 4 项：坏 tags 不许把 React 树带走
node tests/skill-cards.test.mjs    # 18 项：技能侧类型识别与卡片生成
```
