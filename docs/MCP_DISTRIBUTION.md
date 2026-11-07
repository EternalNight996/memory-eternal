# MCP 分发清单

> 目标：不只出现在 DSH 插件中心，也出现在其他 agent 生态的主流 MCP 目录里。
> 每次发版后：先 `npm run test`（会校验 `server.json` 与 `package.json` 版本一致），再执行下面的发布步骤。

## 已提交

| 目录 | 规模 | 状态 | 链接 |
|---|---|---|---|
| awesome-mcp-servers | ★97k | PR open（带 🤖🤖🤖 快速合并） | https://github.com/punkpeye/awesome-mcp-servers/pull/18822 |
| Cline MCP Marketplace | ★796 | Issue open | https://github.com/cline/mcp-marketplace/issues/3603 |
| Docker MCP Registry | ★581 | PR open | https://github.com/docker/mcp-registry/pull/6738 |

## 待手动完成（需要登录）

### 1. 官方 MCP Registry

已准备好 `server.json`（仓库根目录）。你只需：

```bash
# 安装发布器（官方仓库自带）
git clone --depth 1 https://github.com/modelcontextprotocol/registry.git
cd registry && make publisher

# 浏览器授权（GitHub 登录）
./bin/mcp-publisher login github

# 回到本仓库，发布
cd <memory-eternal 目录>
<上一步的路径>/mcp-publisher publish
```

命名空间是 `io.github.EternalNight996/memory-eternal`，由 GitHub 身份自动校验，不需要 DNS。

### 2. Smithery

已准备好 `smithery.yaml`（`npx` + stdio）。发布：

```bash
npx -y @smithery/cli login
npx -y @smithery/cli publish EternalNight996/memory-eternal
```

> 若 Smithery 提示配置格式过旧，按其当前文档把 `smithery.yaml` 里的 `commandFunction` 改成 `command` 字段即可。

### 3. mcp.so / PulseMCP / Glama（网页表单）

直接粘贴下面这段：

```text
名称：memory-eternal
仓库：https://github.com/EternalNight996/memory-eternal
安装：npx -y -p memory-eternal dsh-memory mcp
类型：stdio / 本地，无需 API Key
描述：本地优先的长期记忆 MCP 服务。对话沉淀成知识卡，**人工审核通过后**才可被召回；召回走 SQLite FTS5/BM25，零模型调用（实测 2,321 张卡下 p50 2.3ms）；不可变审计日志；一个库同时供 DSH / Claude Code / Codex / Cursor 使用。
```

Glama 当前尚未收录（`glama.ai/mcp/servers/EternalNight996/memory-eternal` 返回 404），提交后其会生成评分徽章，届时可回填到 awesome-mcp-servers 条目。

## 发版后需要同步的版本号

`server.json` 里的 `version` 与 `packages[0].version` 必须等于 `package.json` 的版本；`npm test` 里有断言守着，忘了改会红。
