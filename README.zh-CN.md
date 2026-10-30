# 🧠 memory-eternal —— 给 AI 装一个可信的第二大脑

[![GitHub stars](https://img.shields.io/github/stars/EternalNight996/memory-eternal?style=flat)](https://github.com/EternalNight996/memory-eternal/stargazers)
[![npm](https://img.shields.io/npm/v/memory-eternal)](https://www.npmjs.com/package/memory-eternal)
[![release](https://img.shields.io/badge/release-v0.19.0-FF7A45)](https://github.com/EternalNight996/memory-eternal/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English (default)](README.md) · **简体中文（镜像）**

<p align="center">
  <a href="https://eternalnight996.github.io/memory-eternal/demo/"><img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/demo.gif" width="900" alt="memory-eternal 20 秒演示：审核队列、记忆账本、知识星图" /></a>
</p>
<p align="center"><sub>▲ 20 秒演示 —— 审核队列 · 记忆账本 · 知识星图 · <a href="https://eternalnight996.github.io/memory-eternal/demo/">在线 Demo</a></sub></p>

> **你的 AI 每次会话都失忆。给它一个可信的记忆库。**
>
> 本地优先、先审后入、可度量 —— 一个 SQLite 库，DSH / Claude Code / Codex / Cursor 与任意 MCP 客户端共享。

- 🔍 **先审核，再入库** —— 新卡先进待审队列，Web 或终端里批准/驳回；每次状态变更写入不可篡改的审计日志。
- 🧾 **记忆账本** —— 召回注入了多少、蒸馏调了几次、召回到底有没有用，全部可查。
- 🏠 **本地优先，零云端** —— SQLite + Markdown 存在你自己的磁盘上。没有第三方记忆框架、不需要账号、不外发请求。
- ⭐ **核心记忆** —— 已批准的卡可提升为「每次会话强制注入」的核心记忆；自动沉淀可以建议，但最终仍由审核中心决定。
- 🧭 **阅读与布局** —— 卡片目录可点击跳转；记忆界面支持紧凑 / 标准 / 大三种布局大小。

<p align="center"><strong>⭐ 如果它帮你少解释了一遍上下文，点个 Star 就是最大的支持</strong><br/><sub>DSH 一条命令：<code>dsh plugin --profile desktop add memory-eternal</code></sub></p>

## ⚡ 快速开始

**DeepSeek Harness（桌面版 / Web）**

```bash
dsh plugin --profile desktop add memory-eternal
# 重开 DSH → 左栏「记忆」
```

**Claude Code、Codex 或 Cursor —— 通过 MCP 共享同一个库**

```bash
npm i -g memory-eternal
dsh-memory connect claude    # 或：codex / cursor
```

**任意 MCP 客户端**

```bash
npx -y -p memory-eternal dsh-memory mcp
```

**浏览器或终端**

```bash
dsh-memory open              # http://127.0.0.1:7999
npx -y -p memory-eternal dsh-memory tui   # 终端里的实时待审队列
```

## 🧾 真的省 token 吗？

大多数记忆产品都说自己省 token。我们认为你应该自己验证。插件内置**记忆账本**（运行状态 → 记忆账本），记录：

| 记录项 | 含义 |
|---|---|
| 召回：命中数 + 注入字符 | 到底有多少记忆进入了上下文 |
| 沉淀：LLM 调用次数 + 输入/输出字符 | 蒸馏花了你多少成本 |
| 有用率：有用 / 没用 反馈 | 召回的记忆是否真的帮上了忙 |

诚实的算式：

```text
净收益 ≈ 被避免的上下文开销 −（注入字符 + 蒸馏调用 × 单价）
```

| 场景 | 你要付 | 你能省 |
|---|---|---|
| 有决策与踩坑记录的多会话项目 | 每次召回约 0.6–0.9k token | 重新解释上下文（约 1.5–3k）或重读文件（3–6k） |
| 一次性问题、低命中率 | 召回注入 | 通常什么也省不到 |

> 以上是示意数字，不是 benchmark —— 用账本测你自己的。如果召回有用率长期低于约 60%，就调小（更少条数、更短摘要）或直接关掉记忆。

## 🛡️ 先审核，再入库

一个「什么都自动吞进去」的记忆系统，迟早会把错误事实当成真相召回。memory-eternal 默认**先审后入**：

- 新卡先进入**待审队列**，人工批准后才进主库；
- 在 Web、终端 TUI 或 CLI 里批准 / 驳回 / 批量处理；
- 每次状态变更追加到**不可篡改的审计日志**（谁 / 什么 / 何时 / 为什么）—— 由 SQLite 层强制，而不是靠约定；
- Agent 可以读取和提议，但**不能批准自己写的卡**；
- 删除的卡进回收站（默认保留 30 天）。

## ⭐ 核心记忆

不是所有内容都该每次注入上下文。核心记忆是一组**必须每次遵守**的偏好与硬约束：

- 任意已批准卡片都可以在阅读器或卡片列表里提升为核心记忆；
- 自动沉淀只会在用户明确要求长期偏好 / 硬约束时**建议**核心，且 core 候选**一律待审**；
- 已批准的核心卡每次会话直接注入 systemPrompt，不依赖 `memory_recall` 调用；
- 在「设置 → 记忆 → 核心记忆」里可配置条数上限和字符预算；
- 知识星图里核心节点显示为橙色菱形 + ★；
- **不要把密钥/Token 的值写进核心卡**，只保存凭证目录的引用。

## 🎛 阅读与布局

- 卡片阅读器右侧目录可点击，平滑跳转到对应章节；
- 「设置 → 记忆 → 布局大小」支持 **紧凑 / 标准 / 大**，只影响界面显示。

## 🧩 一个库，所有 Agent

| 入口 | 你能得到什么 |
|---|---|
| **DSH 桌面版 / Web** | 内嵌记忆界面：审核、图谱、配置、账本 |
| **Claude Code / Codex / Cursor** | MCP server，同一个本地库，<code>dsh-memory connect</code> |
| **任意 MCP 客户端** | <code>npx -y -p memory-eternal dsh-memory mcp</code> |
| **终端** | <code>dsh-memory tui</code> —— 实时队列、全选、批量批/驳、长文读卡 |
| **浏览器** | <code>dsh-memory open</code> → http://127.0.0.1:7999 |

## 📸 截图

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/graph.png" width="32%" alt="知识星图：按类型分簇、标签连边" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/audit.png" width="32%" alt="审核中心：类型条、队列与判词栏" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/status.png" width="32%" alt="运行状态：库、备份、自动沉淀与版本" />
</p>
<p align="center"><sub>▲ 知识星图 · 审核中心 · 运行状态</sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/tui-audit.png" width="49%" alt="终端原生审核：全选、批量批准/驳回" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/tui-reader.png" width="49%" alt="终端原生长文读卡器" />
</p>
<p align="center"><sub>▲ 终端原生审核与长文读卡 —— <code>dsh-memory tui</code></sub></p>

## 📚 文档与链接

- [英文完整手册](docs/GUIDE.md) · [完整手册（中文）](docs/GUIDE.zh-CN.md)
- [私有化部署（Docker / systemd）](docs/DEPLOY.md)
- [更新日志](docs/CHANGELOG.md) · [架构](docs/ARCHITECTURE.md)
- [终端插件（dsh-tui）](dsh-tui-plugin/README.md) · [Orca 启动器](orca-plugin/README.md) · [Cursor / VS Code 扩展](cursor-extension/README.md)
- [反馈问题](https://github.com/EternalNight996/memory-eternal/issues)

## 💬 交流群

**遇到问题、想提需求、或者想聊聊 DSH 插件开发 —— 欢迎进群：**

| QQ 交流群 | 微信交流群 |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/group-qr.jpg" width="240" alt="QQ 群二维码" /> | <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/group-wechat.jpg" width="240" alt="微信群二维码" /> |

**如果这个插件帮你省了时间，可以请作者喝杯咖啡（两个码任选其一）：**

| 微信收款码 | 微信赞赏码 |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/wechat-pay.jpg" width="200" alt="微信收款码" /> | <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/wechat-reward.jpg" width="200" alt="微信赞赏码" /> |

> 打赏完全自愿，不影响任何功能；插件本体始终开源免费（MIT）。详见 [SPONSOR.md](SPONSOR.md)。

## 📄 License

MIT —— 随便用、随便自托管、随便二次开发。
