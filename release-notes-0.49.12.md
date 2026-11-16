## 🩹 v0.49.12 — 沉淀可靠性修复：云端不通回退本地 · 错误不再"未知" · 切换必落盘

> 起因（2026-11-17 现场）：面板已切「本地模式」，自动沉淀仍然每回合报「写卡失败：未知原因」，
> 云端连接记录却还停在 cloud。三条独立缺陷叠在一起，这版逐个补上。

### 一、云端写入失败 → 回退写本地（不再丢卡）

旧逻辑：`cloudWriteMode = cloud` 时只推云端，失败就**只入补推队列、本地一张不写**
（`lib/capture-target.js` 的口径）。云端一挂，卡就悬空、健康度翻红、每回合往会话里插一条异常提示。

现在：推送失败先入队（保留补推），紧接着**回退写本地**（进审核队列），只有本地也失败才记 `fail`。
卡丢了比同步晚到严重得多。

### 二、错误原因不再被写成"未知原因"

undici 的 `fetch failed` 把真实原因藏在 `error.cause` 里（`SELF_SIGNED_CERT_IN_CHAIN` / `ENOTFOUND` / `ECONNREFUSED`），
旧代码只读 `out.reason`，而云端分支返回的字段叫 `error` → 日志永远「未知原因」。

现在：
- 云端分支把 `e.cause.code` 提取成可读文本（`SELF_SIGNED_CERT_IN_CHAIN fetch failed`）；
- 失败返回值同时带 `reason` 与 `error`，三个调用点统一 `out.reason || out.error || '未知原因'`。

### 三、切「本地/云端」必须落盘并回读校验

前端 `switchDataSource` 里写本机服务端的那次 `fetch('/cloud/conn')` 原来是 fire-and-forget，`catch {}` 直接吞掉 ——
界面显示已切本地、Node 侧记录仍是 cloud，插件继续往云端推。现在等响应并校验 `ok`，失败直接提示「本机服务端未同步」。

### 四、现场修复（不用等这版也能用）

- `memory-eternal-cloud-conn.json`：`mode=cloud → local`（url/token 保留，备案下来一条命令切回）；
- 补推队列里 **36 张卡**逐张按待审写回本机库：`ok=36 fail=0`，队列归档留证；
- 判定函数实测：`resolveCaptureTargetFromEnv({cloudWriteMode:'cloud'})` → `local`。

### 五、验证

| 套件 | 结果 |
|---|---|
| `tests/capture-target.test.mjs`（新增） | 3/3：conn=local 必写本地 · 缺令牌/非法地址/active=false 写本地 · cloud+both 才写本地 |
| `capture-route` / `two-store` / `cloud-contract` / `cloud-queue` / `api` / `mcp-http` | 10 / 15 / 5 / 9 / 14 / 8 全绿 |
| 全仓 `npm test` | 164 个测试文件，fail 0 |

### 升级

```bash
npm i -g memory-eternal@0.49.12
cd ~/.dsh/profiles/desktop && pnpm add -w memory-eternal@0.49.12
cd ~/.dsh/profiles/web     && pnpm add -w memory-eternal@0.49.12
# 重启 DSH 后，插件侧才会用上「回退写本地 + 真实错误文本」
```
