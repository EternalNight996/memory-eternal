# 对《MengBot 第 2 轮答复》的确认与处理结果

> 逐条核对你们 `mengbot-round2-reply.md` 后的处理结果。所有结论都附实测，可直接复现。
> 核对时间：2026-11-14 03:30 UTC

---

## A4 `client_secret` —— **已验证修复，登录链路恢复** ✅

你们轮换后写入了我们的 `/etc/memory-eternal-cloud.env`（secret 长度 43 → 44，前缀变为 `mbo_`）并重启服务。

**我们的独立验证方法**（不依赖你们的自述）：用**假 code** 直接打 token 端点 ——
如果认证不过会返回 `invalid_client`，认证过了才会因为 code 假而返回 `invalid_grant`。

```
修复前：POST /token (client_secret_basic)  → 401 {"error":"invalid_client"}
修复后：POST /token (client_secret_basic)  → 400 {"error":"invalid_grant"}   ← 认证通过 ✓
```

生产侧同时确认：`GET /cloud/auth/start` → 302 跳 `accounts.mengbot.com.cn/auth`，`/cloud/health` 返回
`{"ok":true,"oidc":true,"license":"valid"}`。

**顺带纠正我们自己的一个错误认知**：我们一开始把 `mbo_` 当成了 "OAuth access_token"，
按你们 A1 的说明，它其实是 **OIDC 客户端密钥**。这解释了为什么用户会把它填进我们的
「访问密钥」框 —— 那个框叫"访问密钥"，而用户从你们后台复制的恰好就是一把密钥。
相关错误文案已按此改写：

```
mbo_ 是 MengBot 的 OIDC 客户端密钥（只给服务端换令牌用），不能当访问密钥填
—— 请清空这一栏，点「用 MengBot 账号登录」；或用 me_ 开头的访问密钥
```

### 一个运维诉求

你们是**直接改我们服务器的 env** 完成这次轮换的。这次没问题（我们也验证了），
但**以后轮换 `client_secret` 时能否先告知一声**？否则我们会先怀疑自己的配置，
这轮排查就是从这个方向开始的（我们核对了 env 长度、前后缀、两种认证方式，才排除掉自身原因）。

---

## C1 `refresh_token` 一次性轮换 —— **已修，这是真实风险** ✅

你们的答复让我们发现了一个会导致**用户登录态彻底丢失**的并发缺陷：

> 采用 oidc-provider 默认的 refresh token rotation：每次刷新签发新 token，旧 token 立即失效（一次性使用）

**修复前的行为**（两个请求同时刷新时）：

```
A: 读到 T1 → 用它刷新 → 成功，得到 T2，存 T2
B: 读到 T1 → 用它刷新 → T1 已失效 → 失败 → forgetRefreshToken() 把 T2 也清了
```

而 `getValidAccessToken` 会被 `/cloud/billing/plan`、`/cloud/billing/checkout` 等多处调用，
并发是常态，不是理论风险。

**修复后**：

1. **单飞（single-flight）** —— 同一 owner 的刷新合并成一个 Promise，并发调用共享结果
2. **失败时不无条件清令牌** —— 先比对库里的 token 是否已被别的请求换掉；
   变了就说明别人成功了，返回 `并发刷新：令牌已被另一个请求轮换，请重试` 而不清

**实测**（5 个并发刷新）：

```
实际打 token 端点次数: 1
成功次数: 5
库里的 refresh_token: RT_NEW（没被误清）

并发失效场景 → 返回「令牌已被另一个请求轮换，请重试」
库里的 token = RT_BY_OTHER（别人的新令牌没被清）
```

也谢谢你们明确写了「不要并发用同一个 refresh_token 刷两次」——
这条我们原先没有防护，是按你们的答复补上的。

---

## C3 `mba_` 管理员令牌 —— **已拒绝** ✅

按你们「管理员令牌前缀 `mba_`，不要发给第三方」的说明，我们收到 `mba_` 直接拒绝：

```
mba_ 是 MengBot 管理员令牌，不能用于第三方接入
—— 请到 MengBot「API」页创建 mbt_ 令牌（scope=client）
```

前端也做了本地拦截（不发请求）；即使用户把 `mba_` 填进配置，保存时会被自动丢弃。

### 关于 `scope` 的一个澄清请求

你们提到 `scope=client` 与 `scope=admin`。我们目前只验证过 `scope=client` 的 `mbt_`：

```json
{"ok":true,"scope":"client","tokenId":"tok_cb26...","rateLimit":300,"cloudContractVersion":1}
```

请确认：**`scope=client` 的 `mbt_` 能调用的 `/api/v1/*` 具体包含哪些**？
我们目前只用到 `/api/v1/me`（校验令牌有效性与取 `rateLimit`），想确认没有遗漏我们该用的接口。

---

## B2 checkout 契约 —— **已按答复收窄** ✅

> 响应字段名：`url`（唯一正式字段）。`checkoutUrl` / `checkout_url` 不是契约字段

我们原先的宽容解析（三个字段名都试）已收窄为只认 `url`：

```js
// 改前：d.url || d.checkoutUrl || d.checkout_url || d.checkout.url
// 改后：d.url || d.checkout.url        ← 保留嵌套形状兜底，主字段只认 url
```

测试从「三个字段都能过」反向改为「只给 `checkoutUrl` 必须报缺字段」，防止以后回退。

**「支付结果一定走 webhook」这条也确认了**，我们的实现本来就是「同步返回只代表创建了结账单，
套餐变更一律等 webhook」，与你们一致。

---

## B1 `caps` 显式字段 —— **等你们下一版，我们继续兜底** ✅

我们已确认会用 `caps.cards` / `caps.rpm` / `caps.vaults`（显式字段优先），
下发即生效，不需要我们发版。

在字段就位前，按你们认可的 `seats × 1000` 兜底（当前 `seats:10` → 卡片上限 10000）。

**一个请求**：定价表定稿时，如果 `rpm`（每分钟请求数）和 `cards` 的数值与「pro 初值 5000/300」差很多，
麻烦提前说一声 —— 我们的配额是**硬拦**（超限返回 `429 quota_exceeded`），
数值定得比实际用量低会直接打断在用用户。

---

## C2 webhook —— **无需改动** ✅

逐条对照：

| 项 | 你们 | 我们 | 结论 |
|---|---|---|---|
| 事件名 | 三个（`entitlement.updated` / `subscription.canceled` / `subscription.expired`） | 完全一致 | ✓ |
| 重试 | 1s / 5s / 30s 三次；4xx 不重试（**429 例外**） | webhook 路径**不受配额影响**，不会返回 429 | ✓ |
| 签名 | `t=<ms>,v1=<hex>` | 双格式都支持（`sha256=<hex>` 与 `t=,v1=`） | ✓ |
| 去重窗口 | ≥5 分钟足够 | 按 `X-MengBot-Event-Id` **永久幂等** | 比要求更严格 |
| 触发点 | 支付成功 / 退款 / 取消 | 无依赖 | ✓ |

---

## A2 / A3 —— 我们接受你们的核对结论

**A2**：你们核对了仓库文档是 `GET https://accounts.mengbot.com.cn/auth`（正确）。
我们此前是基于外部收到的一份旧表述提的，既然仓库里 0 命中 `oidc/auth`，这条撤销。

**但有个实践建议**（不是纠错）：文档里除了写死正确路径，能否再加一句
「**以 `/.well-known/openid-configuration` 的 `authorization_endpoint` 为准，不要硬编码**」？
我们这轮就是因为早期硬编码 `/oidc/auth` 吃了 404，排查成本不低。

**A3**：你们 `openapi.cloud.json` 已写「建议 TTL 15 分钟」，与我们实现一致（`MBT_CACHE_TTL_HOURS = 0.25`），这条销账。

---

## 待你们回复的只剩两条

| 编号 | 内容 |
|---|---|
| **B1** | `caps.cards` / `caps.vaults` 的具体数值（等定价表） |
| **B2** | `plan` 的合法取值二次确认（等 Cloud Admin 侧） |

另外新增一条（上面 C3 里提到）：**`scope=client` 的 `mbt_` 能调用的 `/api/v1/*` 明细**。

---

## 附：这轮我们这边补齐的能力（供你们了解，不需要动作）

| 能力 | 说明 |
|---|---|
| **云端请求访问日志** | `[cloud-access] METHOD /path origin=<Origin> cors=ok\|DENY ua=...`，能直接看出请求是否到达、CORS 是否放行 |
| **令牌前缀分流** | `me_`（访问密钥）/ `mb_`（会话）/ `mbo_`（你们的 client_secret，拒绝）/ `mbt_`（API token，转你们校验）/ `mba_`（管理员，拒绝）/ 其它（报前缀+长度） |
| **前端诊断行** | 连接失败时显示「目标 URL · 页面 origin · 在线状态」，用户截图即可定位 |
| **CORS 白名单** | 本机任意端口 / 我们的公网域名 / `null`（file://）/ `dsh-app://`（DSH 桌面端 Electron） |

最后一条说明一下：这轮有用户报「连不上服务端（Failed to fetch）」，
根因是 DSH 桌面端的页面 origin 是自定义协议 `dsh-app://app`，不在我们的 CORS 白名单里 ——
**跟你们完全无关**，我们已经修了。提这个只是说明：如果你们后续也在 Electron 里做联调，
自定义协议的 origin 是 `null` 或协议名本身，需要服务端显式放行。

---

**感谢这轮答复的具体程度** —— 特别是 C1 的 rotation 说明和 C3 的 `mba_` 前缀，
两条都直接帮我们堵上了真问题。
