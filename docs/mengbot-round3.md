# MengBot 第 3 封回复：结论与我们的待办

> 对方第 3 封：`mengbot/mengbot/docs/memory-eternal-round2-followup.md`
> 我们第 2 封：`docs/mengbot-round2-ack.md`
> 记录时间：2026-11-14

---

## 一、他们给的 `mbt_`（scope=client）可用接口清单

**这部分之前我们不知道**，只用了 `/api/v1/me`。完整清单：

| 方法 | 路径 | 我们能用来做什么 |
|---|---|---|
| GET | `/api/v1/me` | 令牌自省（scope/tokenId/rateLimit/cloudContractVersion）← 现在在用 |
| GET | `/api/v1/accounts/{email}/subscription` | **某账号的套餐** ← **见下方「主动对账」** |
| GET | `/api/v1/accounts/{email}/entitlement` | 同上（别名，返回体一致） |
| GET | `/api/v1/version` / `/api/v1/health` | 服务版本 / 健康检查（`mode` 支付渠道、`database`） |
| GET | `/api/v1/market/*` | 市场概览 / 资源 / 套餐定义 / 看板 / 团队模板 / 条目 |
| POST | `/api/v1/orders` | 创建订单 |
| GET | `/api/v1/orders/{id}` | 单笔查询 |
| POST | `/api/v1/orders/{id}/claim` / `/confirm` | 认领 / 确认到账 |

**仅 `mba_`（admin）可用**（client 令牌拿到 **403**，不是空数据）：

```
GET  /api/v1/stats
GET  /api/v1/orders
POST /api/v1/orders/{id}/refund
```

**限流**：键是 `tokenId:scope:IP`（同一 token 多出口 IP 各自独立额度）；
`client` 默认 300 次/分钟，以 `/api/v1/me` 返回的 `rateLimit` 为准；超限 429 + `Retry-After`。

---

## 二、三条约定（已达成，需遵守）

### 1. `caps` 数值（B1）

> 1. 上线时**先按不低于对端兜底值的水平下发**（pro 至少 `cards ≥ seats×1000`、`rpm ≥ 300`、`vaults ≥ 1`）
> 2. 如果定价必须下调，**提前至少一轮通知**，由我们决定是否放宽硬拦
> 3. 字段下发前，我们继续用 `seats × 1000` 兜底，不需要改代码

**我们的对策**（已实现）：

- `lib/quota.js` 的 `quotaFor()` 返回 `source` 字段：
  - `source: 'caps'` → 用的是 MengBot 下发的显式 `caps.cards`
  - `source: 'plan+seats-fallback'` → **还在用兜底换算**
- 首次触发兜底时打一行日志（只打一次，不刷屏）：
  ```
  [memory-eternal-cloud] 配额兜底：entitlement 未下发 caps.cards，
    按 seats(10) × 1000 = 10000 张估算。（MengBot 承诺后续下发显式 caps.cards，届时本提示自动消失）
  ```

**这段兜底逻辑什么时候可以删** —— 不需要专门删：

> 当 MengBot 开始下发 `caps.cards` 后，`quotaFor` 里第 ① 步已经写入 `base.cards`，
> 第 ② 步的 `!posInt(caps.cards)` 为 false，分支自然不再触发，日志也不再出现。
>
> **可观测信号**：`/cloud/billing/plan` 的配额 `source` 从 `plan+seats-fallback` 变成 `caps`。

### 2. `client_secret` 轮换流程（A4 后遗症）

> 1. 轮换前先在我们那边确认「可以轮换」，并给时间窗（避免我们正在排查时他们改配置）
> 2. 轮换后发一条明确通知：「已轮换 + 新 secret 已写入你们 env + 已重启」，**不附带 secret 值**（我们从 env 读）
> 3. 如果要改成「我们拉取 / 他们提供管理接口」的模式也可以谈，目前是人工同步

### 3. `refresh_token` 语义（C1）

> `refresh_token` 过期后**不会静默续期**，必须重新走授权码。
> 所以遇到 `invalid_grant` 时提示用户重新登录是正确做法（不是配置问题）。

**对应的实现边界**（`lib/oidc.js`）：

- 刷新失败且确认令牌真的失效 → `forgetRefreshToken()` + 提示重新登录
- 刷新失败但库里的 token 已被别的请求换掉（并发）→ **不清**，返回「并发刷新，请重试」
- 单飞（single-flight）保证同一 owner 同时只打一次 token 端点

---

## 三、我们的待办（按优先级）

### P0：向他们要一个 `mbt_` 令牌（scope=client）

**为什么**：有了它才能用 `/api/v1/accounts/{email}/subscription` 做**套餐主动对账**。

**现在的弱点**：套餐状态完全依赖 webhook 推送。他们的重试是 1s/5s/30s 三次，**总共 36 秒** ——
如果这 36 秒我们正好在部署重启（本轮我们重启过很多次），事件就永久丢失，用户套餐状态一直错到下次事件。

**拿到令牌后要做**：

1. env 加 `MEMORY_MENGBOT_API_TOKEN=<mbt_...>`
2. `lib/entitlement.js` 或新建 `lib/subscription-sync.js`：
   - `fetchSubscription(owner, env)` → `GET {API_BASE}/api/v1/accounts/{owner}/subscription`
   - `owner` 本身**就是邮箱**（OIDC 的 sub），参数天然对得上
3. 触发时机（任选或组合）：
   - `/cloud/billing/plan` 被调用时，如果 entitlement 的 `fetchedAt` 超过 N 分钟 → 顺手对一次
   - 提供 `POST /cloud/billing/refresh` 让用户手动刷新
   - 定时任务（已有 `lib/auto-junk.js` 的调度模式可复用）
4. **对账结果不覆盖更新的版本**：他们 webhook 带 `version`，订阅接口不一定有 ——
   用 `fetchedAt` + `version` 双条件判断，避免用旧数据盖掉新数据

### P1：等 `caps.cards` 下发

见上文「可观测信号」。收到后把 `PLAN_QUOTA` 里的默认值作为**最后兜底**保留即可。

### P2：等 `plan` 枚举确认（Cloud Admin）

他们确认后会补进 OpenAPI。我们现在的处理是对的（只认 `url`、缺就报错）。

---

## 四、我们这轮额外补的能力（已在生产）

| 能力 | 位置 | 用途 |
|---|---|---|
| 云端请求访问日志 | `cloud-server.js` | `[cloud-access] METHOD /path origin=<Origin> cors=ok\|DENY ua=...` |
| 令牌前缀分流 | `cloud-auth.js` | `me_` 密钥 / `mb_` 会话 / `mbo_` 客户端密钥（拒）/ `mbt_` API token（转校验）/ `mba_` 管理员（拒）|
| 配额 `source` 可观测 | `quota.js` | 区分「显式 caps」与「seats 兜底」，用于判断 B1 何时可收口 |
| 前端诊断行 | `client/index.tsx` | 连接失败时显示「目标 URL · 页面 origin · 在线状态」|
| CORS 白名单 | `cloud-server.js` | 本机任意端口 / 公网域名 / `null`（file://）/ `dsh-app://`（Electron）|

---

## 五、当前状态：A 类问题已全部清零

| 编号 | 内容 | 状态 |
|---|---|---|
| A1 | `mbo_` 展示用途 | ✅ 对方已改（后台加说明 + API.md 前缀表） |
| A2 | 文档 `{issuer}/oidc/auth` | ✅ 对方已采纳「以 discovery 为准」并写进 §4.2 |
| A3 | `mbt_` 缓存 15 分钟 | ✅ 双方一致 |
| A4 | `client_secret` 被拒 | ✅ 已验证修复（假 code → `invalid_grant`） |
| B2 字段 | checkout `url` | ✅ 我们已收窄，对方确认「只认 url 是对的」 |
| C1 | refresh 一次性轮换 | ✅ 已加单飞 + 不清令牌；对方确认安全 |
| C2 | webhook | ✅ 无需改动 |
| C3 | `mba_` 拒绝 | ✅ 已拒绝；接口清单已给出 |

**剩余只有 B1（数值）与 B2（plan 枚举）两个「等产品确认」的事项**，
且都不阻塞现有功能（兜底逻辑在跑，`source` 字段可观测）。
