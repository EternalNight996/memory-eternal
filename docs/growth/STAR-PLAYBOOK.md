# memory-eternal Star 增长作战手册

> 基线：2026-10-21，GitHub **23 stars / 2 forks**，仓库 7 周，最新 v0.10.54
> 目标：30 天 100 stars，90 天 300 到 500 stars（按实际流量调整）
> 原则：不买 star、不刷榜、不 repeated spam。Star 是“看完之后愿意收藏”的结果，不是运营数字。

---

## 0. 先把问题说清楚

23 stars 不是产品问题，是**分发问题**。项目已经具备罕见的三件事：

1. **真实工作流**：自动沉淀、审核、回收、备份、知识图谱，不是 demo 壳子。
2. **跨 Agent**：DSH / Claude Code / Codex / Cursor 共用一个本地 vault。
3. **可审计**：Markdown + SQLite + 先审后入，和“向量黑盒”形成清晰差异。

缺的是“让没装过的人 30 秒内看懂 + 10 秒内想试”：

- 没有**在线 Demo**（本轮已补）。
- README 首屏是旧界面截图，第一眼不够“想点开”。
- 全球渠道需要英文入口；本轮已补 `site/en.html`，但 Demo 数据仍是中文。
- 没有 launch 内容，只在 DSH 小圈子里自然增长。
- 没有“安装后点 Star”的轻量入口。

---

## 1. 漏斗：star 从哪来

```text
看到（渠道）
  → 点进仓库 / landing（第一眼）
  → 打开 Demo（10 秒内可试）
  → 安装（60 秒内可跑）
  → 觉得有用（第一次召回 / 第一次审核）
  → Star（收藏 + 传播）
```

四类动作，按优先级：

| 优先级 | 动作 | 影响 |
| --- | --- | --- |
| P0 | 上线 landing + 在线 Demo | 把“看不懂”变成“能试” |
| P0 | README 首屏换成新版预览 + Demo 链接 | 仓库访客的第一眼 |
| P1 | 中文社区首发 + 英文 Show HN / Reddit | 一次性流量峰 |
| P1 | 安装后 Star 入口 + Release 说明 | 已装用户的转化 |
| P2 | 技术博客 / 视频 / Awesome 列表 | 长尾搜索 |

---

## 2. 已经准备好的资产

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| Landing | `site/index.html` / `site/en.html` | GitHub Pages 首页（中 / 英） |
| 在线 Demo | `site/demo/index.html` | 示例数据，免安装 |
| Demo 截图 | `site/assets/` | landing / README / 社交 |
| OG 图 | `site/assets/og.png` | GitHub social preview / X |
| 增长手册 | 本文 | 发布节奏与文案 |
| 设计稿 | `docs/design/` | 证明产品在持续进化 |

Demo 使用完全虚构的 `northstar` 项目：24 张示例卡 + 6 张旧卡 + 5 张待审，不包含真实记忆内容。

---

## 3. 上线步骤（必须按顺序）

### 3.1 启用 GitHub Pages

1. 推送 `site/` 到 `main`。
2. GitHub → Settings → Pages → Source: **Deploy from a branch** → Branch: `main`，Folder: **`/site`**。
3. 等待 1 到 2 分钟，访问：
   - `https://eternalnight996.github.io/memory-eternal/`
   - `https://eternalnight996.github.io/memory-eternal/demo/`
4. 确认无 404、图片可加载、移动端无横向滚动。

> README 里的 Demo 链接已经指向这两个 URL；**先启用 Pages 再推 README**，避免首屏出现死链。

### 3.2 设置仓库社交预览

GitHub → Settings → General → Social preview → 上传 `site/assets/og.png`。
这样在 X / Reddit / Slack 分享时，卡片是“让 AI 记住你们一起做过的决定”，而不是默认仓库头像。

### 3.3 仓库元数据

当前 topics 已有 `deepseek-harness`、`dsh-plugin`、`claude-plugin`、`codex-plugin`、`mcp`、`knowledge-graph` 等。
建议补 3 到 4 个（GitHub 上限 20）：

- `local-first`
- `cursor`
- `ai-memory`
- `second-brain`

Description 建议保留“本地、可审核、零依赖”三个关键词；不要写“最强”。

### 3.4 发一个“Demo 上线”Release

版本号不必大改，`v0.10.55` 或 `v0.11.0` 都行。Release notes 固定四段：

1. 一句话：新增在线 Demo 与新版界面预览。
2. 用户可感知：不用安装就能试记忆库 / 审核 / 星图。
3. 升级注意：插件功能不变，Demo 使用示例数据。
4. 回滚方式：照旧。

---

## 4. 首屏与文案

### 4.1 中文定位

- 主标题：**让 AI 记住你们一起做过的决定。**
- 副标题：对话结束自动沉淀成可审核、可 git 管理的知识卡；召回只取相关小块，省 token，也少噪音。
- 差异化一句话：**不是又一个向量库，是你能打开、能审、能回滚的记忆。**
- 行动：先 Demo，再 Star，再安装。

### 4.2 英文定位

- Headline: **Your AI forgets. Give it a second brain you can audit.**
- Sub: Every conversation becomes a Markdown card you can review, diff, and recall. Local-first, zero dependencies, shared by DSH / Claude Code / Codex / Cursor.
- One-liner: **Markdown, not embeddings. Review, not autopilot.**

### 4.3 README 首屏检查

- [ ] 第一张图是新版界面（本轮已换，标注“界面预览 + 在线 Demo”）。
- [ ] 第一屏能看到 Demo 链接和 Star CTA。
- [ ] 安装命令是当前版本，不是 0.9.6。
- [ ] 三张真实运行截图仍然保留，并标注“当前安装版”。
- [ ] 不出现“最强 / 颠覆 / 替代所有”这类词。

---

## 5. 渠道与首发节奏

### 第 1 周：中文首发

| 渠道 | 形式 | 标题 / 角度 |
| --- | --- | --- |
| V2EX | 分享创造 | “给 AI 做了一个可审核的第二大脑，拒绝向量黑盒” |
| 掘金 | 技术文章 | “为什么我把 AI 记忆做成 Markdown + SQLite，而不是向量库” |
| 少数派 | 产品介绍 | “AI 聊完就忘？我给它装了一个能回滚的记忆库” |
| 知乎 | 回答 / 文章 | “AI 长期记忆有哪些坑？我做了 7 周后的复盘” |
| 即刻 | 短帖 + GIF | “23 star 的小项目，今天上线了在线 Demo” |
| B 站 | 3 分钟演示 | “从对话到知识卡：自动沉淀 + 审核 + 星图” |

**首发只发一次**，不要同一天刷 6 个群；每个渠道根据反馈改标题，48 小时后再发下一个。

### 第 2 周：英文渠道

| 渠道 | 形式 | 标题 |
| --- | --- | --- |
| Hacker News | Show HN | “Show HN: Local-first AI memory that writes Markdown you can review” |
| Reddit r/LocalLLaMA | Post + GIF | “I built a local-first memory plugin that writes Markdown cards, not embeddings” |
| Reddit r/ClaudeAI | Post | “One memory vault shared by Claude Code, Codex and Cursor” |
| Reddit r/codex | Post | “Codex hooks + MCP memory that you can audit” |
| X / Twitter | Thread | 5 条：问题 → 做法 → Demo → 差异 → Star |
| Product Hunt | Launch | “Memory Eternal: a second brain you can audit” |

HN 标题不要营销词；正文给“为什么做、怎么做、限制”，链接 Demo 和 GitHub。

### 第 3 到 4 周：长尾

- **Awesome 列表 PR**：
  - `awesome-mcp-servers`
  - `awesome-ai-memory`
  - `awesome-deepseek`
  - `awesome-claude-code`
  - `awesome-codex`
- **技术文章**：
  - “Why Markdown is a better memory format than embeddings (for now)”
  - “How to review AI-written memory before it poisons your context”
  - “One vault, four agents: sharing memory across DSH, Claude Code, Codex, Cursor”
- **视频**：3 分钟从安装到第一次召回；B 站 + YouTube。
- **Issue / PR 模板**：在模板底部加一句“如果这个仓库帮到了你，点个 Star”。

---

## 6. 安装后转化

已装用户是最容易被忽略的 star 来源。三个轻量入口：

1. **反馈弹窗**底部加一行小字：`喜欢这个插件？去 GitHub 点个 Star →`，不要弹窗打断。
2. **记忆配置页**底部加 GitHub 链接，和版本号同一行。
3. **Release notes** 结尾：`如果这个版本帮你少解释了一遍上下文，Star 是最好的支持。`

不要做“Star 解锁功能”。不要强制。

---

## 7. 内容选题（按传播力排序）

1. **反直觉**：为什么我不用向量数据库做 AI 记忆。
2. **可验证**：897 张卡、7 周、真实召回日志，哪些卡真的被用到了。
3. **跨 Agent**：一个 vault 同时服务 DSH / Claude Code / Codex / Cursor。
4. **审核**：AI 写的记忆，凭什么直接进上下文？先审后入。
5. **可回滚**：删除进回收站、每日备份、一键恢复。
6. **省 token**：只召回相关小块，而不是把历史全塞进 prompt。
7. **失败复盘**：早期审核流的三个坑，以及怎么修的。

每篇结尾同一个 CTA：**“在线 Demo / GitHub”**。

---

## 8. 指标与复盘

每周记录：

| 指标 | 来源 | 目标 |
| --- | --- | --- |
| GitHub views / unique visitors | Insights → Traffic | 周环比 +30% |
| Referrers | Insights → Traffic | 找出前 3 个渠道 |
| Clones | Insights → Traffic | 安装意向 |
| npm weekly downloads | npm 页面 | 周环比 +20% |
| Demo 访问 | Pages 访问（无分析时用渠道 UTM 人工看） | 首发周 500+ |
| Star | GitHub | 30 天 100 |
| Issue / 讨论 | GitHub | 每周至少 2 条真实反馈 |

不要只看 star。**star / view 转化率**低，说明首屏或 Demo 有问题；**view 低**，说明渠道不对。

---

## 9. 风险与边界

- **不要买 star / 互 star 群**：短期数字，长期毁掉推荐权重。
- **不要在多个社区同一天发同一段文案**：会被当 spam。
- **不要承诺“永久记忆 / 100% 准确”**：审核和召回都有边界，诚实反而更容易被推荐。
- **不要用旧截图配新文案**：本轮已换成“界面预览 + 真实截图”双轨，保持标注。
- **Demo 不接真实数据**：示例数据是 `site/demo/data.js`，不要把自己的 vault 提交到公开仓库。

---

## 10. 30 天检查清单

- [ ] Pages 上线，Landing / Demo / OG 都能打开
- [ ] README 首屏是新版预览 + Demo + Star CTA
- [ ] 仓库 social preview 换成 OG
- [ ] 发 Demo Release
- [ ] V2EX / 掘金 / 少数派 三选二首发
- [ ] Show HN / Reddit 两个渠道
- [ ] 5 个 Awesome 列表 PR
- [ ] 安装后 Star 入口
- [ ] 每周记录 views / clones / stars
- [ ] 根据 referrers 调整下一周渠道
