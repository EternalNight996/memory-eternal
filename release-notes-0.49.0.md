## 🔗 v0.49.0 — 多实例协作：MEM Pair 配对 + Agent MCP 挂载标准

### 这一版解决什么

本机常常同时跑着多个 memory-eternal：运营库（7999）、隔离运营的 mem-purge（7989）、云端实例。
以前它们只能各过各的，而 Agent 的 MCP 又是"谁装上谁就自动挂"——一个仓库里被多个 agent 读到不同库，
沉淀和召回就会串味。这一版给两件事定了规矩：

1. **库之间怎么互通**：MEM Pair —— 显式配对、按匹配码重连、数据只进待审；
2. **Agent 挂哪个库**：一处声明 → 六种宿主渲染；**DSH 插件默认挂 DSH**，其它宿主必须手动。

### 一、MEM Pair：两个库互配对、互传卡

| 阶段 | 怎么做 | 判定信号 |
|---|---|---|
| 发现 | 局域网 UDP 广播（默认 7990），或直填 `host:port` | 面板列出名字 + **匹配码** + 指纹 |
| 首次配对 | 一端发起 → 另一端**弹窗**确认（6 位握手码，两边肉眼核对） | 双方配对表里出现对方 |
| 之后再连 | **只需匹配码**：对方认得且指纹没变 → 直接建立，不再弹窗 | 面板「已配对 → 对方」 |
| 指纹变了 | 重装 / 可能被冒充 → 回到人工确认，弹窗标红 | 必须重新确认 |
| 传数据 | 上传（本库→对方）/ 下载（对方→本库），**只进对方待审队列** | sent / written / failed |

安全：共享密钥由两端从一次性 ephemeral 各自派生（长期密钥永不上网）；每个请求 HMAC-SHA256 + ±5 分钟时间窗 + nonce 去重；`/peer/push` 走待审不进已审。

```bash
dsh-memory peer code                                   # 我的匹配码
dsh-memory peer pair 192.168.1.20:7989                 # 首次配对
dsh-memory peer connect 7K2M-Q9FA --host 192.168.1.20 --port 7989
dsh-memory peer upload   --to 7K2M-Q9FA
dsh-memory peer download --from 7K2M-Q9FA
```

端到端实测（两个实例 8011/8012）：配对（需确认）→ 上传 1 张 → 对方待审收到 → 下载 1 张 → 吊销后**只凭匹配码重连自动成功**。

### 二、Agent MCP 挂载标准

- **DSH 插件：默认就挂到 DSH**（`~/.dsh/mcp-servers.json`），装好即用；关掉：`mcpAutoMount: false` 或 `MEMORY_MCP_AUTOMOUNT=0`。
- **其它宿主必须手动**：Claude Code / Claude 项目级 / Cursor / Windsurf / Codex（TOML）。
- 标准：server 名固定 `memory-eternal`；stdio + 绝对路径 + env 传参；幂等且**只增删自己那一条**；写前备份 `*.bak-mem`、写后回读校验；**漂移检测**（指向旧包路径会报警）；同一时刻只挂一个目标。

```bash
dsh-memory mcp status                                    # 状态 + 宿主矩阵
dsh-memory mcp mount --vault ~/.dsh/memory-vault         # 默认只写 DSH
dsh-memory mcp mount --url http://127.0.0.1:7989 --host dsh,claude
dsh-memory mcp mount --vault <库> --host all             # 所有已安装宿主
dsh-memory mcp unmount                                   # 幂等
```

面板：**设置 → 🧪 实验性 → 🔌 Agent MCP 挂载状态**（逐宿主矩阵 / 目标下拉 / 挂载·卸载 / 一键挂所有已装宿主 / 漂移告警）。
挂到已配对节点时，MCP 进程走 `MEMORY_API` 远端模式，本地库不参与。

### 三、测试

- `tests/peer.test.mjs`（7）：身份持久化、共享密钥对称、签名（改包/改路径/超时窗/重放全拒）、配对全流程、握手码不一致拒绝、status 不泄密、revoke；
- `tests/mcp-mount.test.mjs`（8）：DSH 默认挂载且只挂 dsh、幂等、`MEMORY_MCP_AUTOMOUNT=0` 可关、local/peer 目标、重复挂载只留一条、unmount 幂等、不踩别人的 MCP 条目、面板独立区块守卫；
- `tests/mcp-hosts.test.mjs`（6）：多宿主 adapter（JSON×4 + Codex TOML）、`--host all`、矩阵、漂移检测；
- 全仓 `npm test` 全绿（含既有 155 个测试文件）。

### 升级

```bash
npm i -g memory-eternal@0.49.0
cd ~/.dsh/profiles/desktop && pnpm add -w memory-eternal@0.49.0
cd ~/.dsh/profiles/web     && pnpm add -w memory-eternal@0.49.0
# 重启 DSH 一次：宿主会自己把 MCP 挂到 DSH（首次），面板随之出现「🔌 Agent MCP 挂载状态」
```
