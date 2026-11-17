## 🎛 v0.49.1 — 两张卡重做：挂载改列表点击、配对卡重排

### 一、🔌 Agent MCP 挂载 → 列表点击式

以前是「下拉选目标 + 一个挂载按钮」，只能挂 DSH 或一键全挂。现在分两段列表，**点哪行就作用在哪行**：

```
① 选择要挂的库（点一行选中）
  ● 本机默认库                                 已选中
  ○ mem-purge  9DUW-QPVM  http://127.0.0.1:7989
  ○ 云端        5EZK-RWM5  https://mem.mengbot.com.cn

② 选择宿主（点哪行就挂/摘哪行）     已挂 2/6   [全部挂载] [全部卸载] [刷新]
  ● DeepSeek Harness (DSH)   已挂载  …\.dsh\mcp-servers.json      点击卸载
  ● Claude Code              已挂载  …\.claude.json               点击卸载
  ○ Claude 项目级 .mcp.json  未挂载  F:\…\.mcp.json               点击挂载
  ○ Cursor                   未挂载  …\.cursor\mcp.json           点击挂载
  ⊘ Windsurf                 未安装  …\windsurf\mcp_config.json  （置灰）
  ○ Codex CLI                未挂载  …\.codex\config.toml         点击挂载
```

- 未挂载 → 用「① 选中的库」挂到这个宿主；已挂载 → 卸载**这一个**宿主（不影响别的）；
- 未安装的宿主置灰不可点；每行有 `title` 说明；漂移（指向旧包路径）红字提示。

### 二、🔗 MEM Pair 卡重排

- **我的匹配码**：默认掩码 `SGT9••••`，**点一下展开全码**、再点收起；旁边 `复制` 与 **`刷新`**（同时刷新各节点的对方库摘要）；
- 指纹常显；
- 连接区收成**一行**：`对方地址 [192.168.1.20:7989]  匹配码 [XXXX-XXXX]  [连接] [局域网扫描]`
  —— **有匹配码优先按码连**（对方认得就直接连上，不弹窗），只填地址则走一次普通配对；
- **已配对节点**每行显示 `对方库：N 张`，右侧直接 `上传` / `下载` / `吊销`：

```
● mem-purge  9DUW-QPVM  http://127.0.0.1:7989   对方库：1,204 张   [上传][下载][吊销]
```

### 三、后端配套

新增两个端点（都走配对签名）：

| 端点 | 谁调 | 作用 |
|---|---|---|
| `GET /peer/summary` | 对方调我 | 返回本机库 `{total, byKind}`（不含任何卡内容） |
| `POST /peer/stats` | 我调对方 | 拿某个已配对节点的库摘要，供面板显示「对方库：N 张」 |

实测：`peer/stats → {"ok":true,"peer":{...},"total":1,"byKind":{"project":1}}`。

### 四、修的问题

- `lib/peer-routes.js` 里误从 `./peer.js` 引入 `SERVER_NAME`（这个常量在 `mcp-hosts.js`）→ 服务启动直接 `SyntaxError`、e2e 报「两个实例没起来」。改为字面量 `'memory-eternal'`。

### 五、验证

- e2e 全通：配对（需确认）→ 上传 1 张 → 对方待审收到 → 下载 1 张 → 吊销后凭码重连 `auto:true` → 对方库摘要 `total=1`；
- 测试 **55 项全绿**：peer 7 · mcp-mount 9（含新增「列表式点击挂载」守卫）· mcp-hosts 6 · ui-rules / ui-tokens / ui-overflow / config-coverage / readme-i18n；
- 全仓 `npm test` 全绿后发布。

### 升级

```bash
npm i -g memory-eternal@0.49.1
cd ~/.dsh/profiles/desktop && pnpm add -w memory-eternal@0.49.1
cd ~/.dsh/profiles/web     && pnpm add -w memory-eternal@0.49.1
# 重启 DSH → 设置 → 🧪 实验性 → 两张卡就是新排版
```
