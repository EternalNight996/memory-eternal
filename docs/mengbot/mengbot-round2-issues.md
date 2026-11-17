# 给 MengBot 端的问题清单（第 2 轮）

> 背景：memory-eternal 云端（`mem.mengbot.com.cn`）已全量联调通过 —— OIDC 授权、webhook 推送、支付转发、
> 套餐读取、配额执行都在生产验证过了。这轮是**真实用户使用中暴露的问题**，按「必须改 / 建议改 / 待确认」
> 分类，每条附现象与证据，可以直接照做。

---

## A. 必须改（会直接卡住真实用户）

### A1. `mbo_` 令牌被终端用户当成了「第三方访问密钥」

**现象**：用户在记忆插件里报「无法识别的令牌（前缀 mbo_QG…，长度 44）」。
查我们服务端令牌表，里面只有 `mb_` 会话令牌（有效到 11-21），说明**服务端发的没问题** ——
是用户从 MengBot 后台复制了一个 `mbo_` 开头的令牌，填进了我们插件的「访问密钥」输入框。

**为什么必然发生**：后台令牌列表里 `mbo_` 和 `mbt_` 混在一起，没有任何用途说明，
用户看到一串令牌第一反应就是「这应该是访问密钥」。

**希望你们做**：

1. 令牌列表里给 `mbo_` 加明确标注，例如：
   > 仅用于调用 MengBot API 本身，**不要填入第三方服务**

2. 或者更彻底：**不向终端用户展示 `mbo_`**（它是 OAuth access_token，本来就不该给用户手动复制）

3. `mbo_` 与 `mbt_` 的区别在文档里写清：

   | 前缀 | 是什么 | 谁能用 |
   |---|---|---|
   | `mbo_` | OAuth access token（登录会话用） | 仅客户端 ↔ MengBot 之间 |
   | `mbt_` | API token（调 API 用） | 可交给可信第三方（带 scope 与限流） |

**我们的兜底**：已经识别 `mbo_` 前缀并返回明确指引（"请清空这一栏，点「用 MengBot 账号登录」"），
但**用户不该有机会犯这个错**。

---

### A2. 文档 §1.2 的 `{issuer}/oidc/auth` 路径是错的

**文档写的**：`{issuer}/oidc/auth`

**实际是**：`https://accounts.mengbot.com.cn/auth`（**根路径，没有 `/oidc` 前缀**）

discovery 文档实测：

```json
{
  "issuer": "https://accounts.mengbot.com.cn",
  "authorization_endpoint": "https://accounts.mengbot.com.cn/auth",
  "token_endpoint": "https://accounts.mengbot.com.cn/token",
  "userinfo_endpoint": "https://accounts.mengbot.com.cn/me",
  "code_challenge_methods_supported": ["S256"]
}
```

**影响**：任何按文档硬编码 `/oidc/auth` 的客户端都会 404，且很难自查（报错看起来像"地址填错了"）。

**希望你们做**：文档改成「**从 `/.well-known/openid-configuration` 读取 `authorization_endpoint`，
不要硬编码路径**」。我们这边已经这么做了，实测授权端点返回 303 到登录页。

---

### A3. `mbt_` 校验缓存 TTL 建议从 24h 改成 15 分钟

**你们文档 §2.1 写的是缓存 24h**。

**问题**：`mbt_` 可以随时撤销。缓存 24h 意味着**撤销滞后最多一天** ——
用户取消授权后，第三方还能继续用一整天。

**建议**：缓存 15 分钟。

**成本核算**：15 分钟 = 每分钟 4 次校验，你们的限流是 300 次/分钟，占 1.3%，完全不构成压力。

我们这边已经按 **15 分钟** 实现（`MBT_CACHE_TTL_HOURS = 0.25`）。

---

## B. 建议改（影响体验与后续扩展）

### B1. `caps` 建议下发明确的配额字段

**现状**：entitlement / webhook 里下发的是

```json
{ "plan": "pro", "caps": { "seats": 10, "apps": 5 } }
```

**问题**：`seats`（席位）和 `apps`（应用数）对"记忆服务"这种资源没有直接映射。
我们只能猜一个换算（目前是 `seats × 1000` = 卡片上限），但这是**我们猜的**，不是你们定的策略。

**建议**：直接下发可执行的配额字段，例如

```json
{
  "plan": "pro",
  "caps": {
    "cards": 5000,        // 卡片总数上限
    "rpm": 300,           // 每分钟请求数
    "vaults": 1,          // 可创建的库数量
    "seats": 10,          // 保留你们现有语义
    "apps": 5
  }
}
```

**好处**：套餐策略完全由你们控制，调整不需要我们发版。
我们这边的配额引擎已经支持 `caps.cards` / `caps.rpm` / `caps.vaults` 的**显式字段优先**，
下发即生效。

---

### B2. checkout 端点给一份明确的请求/响应 schema

**我们现在的实现**：

```
POST {API_BASE}/api/cloud/desktop/checkout
Content-Type: application/json
Authorization: Bearer <用户的 access_token>

{ "plan": "pro", "source": "memory-eternal" }
```

**响应**：我们目前**宽容解析** `url` / `checkoutUrl` / `checkout_url` 三个字段名
（因为不确定你们实际返回哪个）。建议直接告诉我们正式的字段名，我们收窄。

**另外请确认**：
- `plan` 的合法取值是不是 `pro` / `team` / `enterprise`？
- 成功时是返回一个跳转 URL，还是直接返回 `{ok:true}` 由前端自己拼？
- 支付结果是不是**一定**通过 webhook 回传（而不是同步返回）？

---

## C. 待确认（我们这边等答复）

### C1. OIDC 的 scope 必须包含 `offline_access`

我们的支付功能依赖**代用户调用 checkout** —— 需要 `refresh_token` 才能在 access_token 过期后继续调用。

目前注册的 scope 是 `openid profile email offline_access`，看起来是对的，但请**确认**：
- `refresh_token` 确实会下发
- `refresh_token` 的有效期与轮换策略（是否每次刷新都换新的？）

**证据**：如果没拿到 refresh_token，我们的 `/cloud/billing/plan` 会返回 `canCheckout: false`，
用户点了「升级」会报「没有可用的 refresh_token（需重新登录）」。

---

### C2. webhook 当前状态确认

我们这边接收方已上线并验证：

```
POST https://mem.mengbot.com.cn/memory-eternal/api/cloud/webhook/mengbot
```

| 验证项 | 结果 |
|---|---|
| 形态 A：`X-MengBot-Signature: sha256=<hex>` | ✅ 200 applied |
| 形态 B：`t=<ts>,v1=<hex>`（±5 分钟容差） | ✅ 200 |
| 同 eventId 重发（幂等） | ✅ 200 applied:false |
| 错签名 | ✅ 401 |
| 过期时间戳（重放） | ✅ 401 |
| 握手事件 `ping` / `test` / `webhook.test` | ✅ 200 `{pong:true}` |

之前你们点过一次「发送测试」，推的是真实 `entitlement.updated` → 我们这边 `plan` 变成 `pro`、
`caps: {seats:10, apps:5}`，验证成功。

**请确认**：
- 三个事件名是否是 `entitlement.updated` / `subscription.canceled` / `subscription.expired`？
- 重试策略是什么（间隔、次数）？我们据此判断去重窗口要不要加大。

---

### C3. `mbt_` 的 scope 分层语义

实测 `GET /api/v1/me` 返回：

```json
{ "ok": true, "scope": "client", "tokenId": "tok_cb26...", "rateLimit": 300, "cloudContractVersion": 1 }
```

我们按 `scope: "client"` 放行。请确认：
- 是否有 `admin` 等高权限 scope？区别是什么？
- `rateLimit: 300` 是**单 token** 维度还是**单用户**维度？多设备共用一个 token 时怎么算？

---

## D. 我们这边已完成（供你们对照，不需要动作）

| 能力 | 状态 | 说明 |
|---|---|---|
| OIDC 授权码 + PKCE S256 | ✅ | 全部走 discovery，不硬编码端点 |
| `client_secret_basic` | ✅ | token 端点认证方式 |
| Webhook 验签 / 幂等 / 重放拦截 | ✅ | 双格式 Header 都支持 |
| 支付转发 | ✅ | `POST /cloud/billing/checkout` → 你们的 `/api/cloud/desktop/checkout` |
| 套餐读取 | ✅ | `GET /cloud/billing/plan` 返回 plan / caps / expiresAt |
| **配额执行** | ✅ | 按 `caps` 真拦：超限返回 `429 quota_exceeded` + `Retry-After` |
| 登录墙 | ✅ | 未登录访问站点 302 到 MengBot 登录 |
| 多租户隔离 | ✅ | 每人独立 SQLite，租户实例 LRU 上限 32 |
| `mbo_` / `mbt_` / `mb_` / `me_` 区分 | ✅ | 按前缀分流，错误提示写清正确做法 |

---

## 优先级建议

如果只能做三件事：

1. **A1**（`mbo_` 标注用途）—— 直接影响终端用户体验，且错误信息会让用户以为是我们服务故障
2. **A2**（文档改成用 discovery）—— 影响所有后续接入方
3. **A3**（`mbt_` 缓存 15 分钟）—— 撤销滞后一天是安全问题

其余 B / C 项不阻塞，按你们节奏即可。

---

## 附：这轮排查我们踩到的坑（不是你们的问题，仅作信息同步）

用户在 DSH 桌面端（Electron）里连不上云端，报 `Failed to fetch`。
原因是 DSH 的页面 origin 是自定义协议 `dsh-app://app`，不在我们的 CORS 白名单里。
**这跟 MengBot 无关**，我们已经修了（放行 `dsh-app://` 与 `null` origin）。

顺带说明：为了排查这类问题，我们在服务端加了访问日志

```
[cloud-access] GET /cloud/health origin=dsh-app://app cors=ok ua=...
```

如果你们后续也需要联调排查，这个日志能直接看出「请求有没有到达」。

---

## A4. OIDC 的 `client_secret` 在你们侧已不被接受（**当前阻塞登录**）

**现象**：客户端走授权码流程，回跳到 `/cloud/auth/callback` 后换令牌失败：

```
{"error":"invalid_client","error_description":"client authentication failed"}
HTTP 401
```

**我们做了对照实验**（用假 code，直接打 `https://accounts.mengbot.com.cn/token`）：

| 认证方式 | 请求 | 响应 |
|---|---|---|
| `client_secret_basic`（Authorization: Basic） | 假 code | **401 `invalid_client`** |
| `client_secret_post`（body 里带 client_id/secret） | 假 code | **401 `invalid_client`** |

两种方式都返回 `invalid_client` —— 说明**不是认证方式选错，是道印灵钥本身不被接受**。
（如果是 code 有问题，会返回 `invalid_grant`；如果是 redirect_uri 不匹配，会返回 `invalid_request`。）

**关键证据：这个 secret 之前是有效的**。我们服务端的会话表里有：

```
mb_vtHR9…  owner=mengbot996@163.com  via=oidc  到期 2026-11-21 02:14:09
mb_xYwh9…  owner=13048770337@163.com via=oidc  到期 2026-11-20 15:00:44
```

`via=oidc` 意味着这些会话是**通过 `exchangeCode` 换令牌成功后**签发的 ——
也就是说同一份代码、同一个 secret，在 11-14 02:14 还是能通过的。

**请确认**：

1. `memory-eternal-cloud` 这个 client 的 `client_secret` 是否被**重置/轮换**过？
2. client 是否被临时禁用、或配置被改动？
3. 如果重置过，请把新 secret 发我们（我们用它替换环境变量即可，代码不用动）。

**配置核对**（我们 env 里的值，供你们比对）：

```
MEMORY_OIDC_CLIENT_ID     = memory-eternal-cloud            （20 字符）
MEMORY_OIDC_CLIENT_SECRET = x6AV…9gn0                       （43 字符，首尾与你方交付一致）
MEMORY_OIDC_REDIRECT_URI  = https://mem.mengbot.com.cn/memory-eternal/api/cloud/auth/callback
```

**影响**：在所有用户走「用 MengBot 账号登录」时都会失败。我们已有兜底（用固定访问密钥可继续使用），
但登录体验完全依赖这条链路，请优先处理。

---

## 第 2 轮答复已落地（2026-11-14）

按对方 `mengbot-round2-reply.md` 逐条处理：

### A4 client_secret —— **已验证修复**

对方轮换后写入我们的 `/etc/memory-eternal-cloud.env`（secret 长度 43 → 44，前缀 `mbo_`）并重启。

我们的验证（假 code 直接打 token 端点）：

```
client_secret_basic → 400 invalid_grant   ← 认证通过（code 假）✓
（修复前是 401 invalid_client）
```

顺带修正一个认知：**`mbo_` 是 MengBot 的 OIDC 客户端密钥**（对方 A1 答复原文），
不是 OAuth access_token。用户从后台复制的就是 client_secret —— 这才是它出现在
「访问密钥」框里的原因。文案已按此修正。

### C1 refresh_token 一次性轮换 —— **已修（真实风险）**

对方答复：「每次刷新签发新 token，旧 token 立即失效」。

我们的旧实现有两个并发问题：
1. 两个请求同时读到同一 refresh_token → 第二个必然失败
2. 失败时 `forgetRefreshToken` 会**把第一个刚拿到的新 token 清掉** → 登录态彻底丢失

修法：
- `refreshAccessToken` **单飞**：同一 owner 的刷新合并成一个 Promise，并发调用共享结果
- 失败时**不无条件清令牌**：先比对库里的 token 是否已被别的请求换掉，
  变了就说明别人成功了，返回「并发刷新：令牌已被另一个请求轮换，请重试」而不清

实测：5 个并发刷新只打 1 次 token 端点，5 个都成功，令牌保持 `RT_NEW`。

### C3 `mba_` 管理员令牌 —— **已拒绝**

对方答复：`mba_` 是管理员令牌（scope=admin），不要发给第三方。

我们收到 `mba_` 直接拒绝：

```
mba_ 是 MengBot 管理员令牌，不能用于第三方接入 —— 请到 MengBot「API」页创建 mbt_ 令牌（scope=client）
```

前端也本地拦截（不发请求），`persistCloud` 会自动丢弃。

### B2 checkout 字段 —— **已收窄**

对方答复：`url` 是唯一契约字段，`checkoutUrl` / `checkout_url` 不是。

已从宽容解析收窄为只认 `url`（保留 `d.checkout.url` 作为嵌套形状兜底）。
测试反向验证：只给 `checkoutUrl` 时必须报「契约字段 url 缺失」。

### B1 caps 显式字段 —— 等对方下一版

对方接受建议，会在 entitlement 里下发 `cards` / `rpm` / `vaults`。
在此之前我们继续用 `seats × 1000` 兜底（已是现状）。

### C2 webhook —— 无需改动

- 事件名三个已对齐
- 重试策略：1s/5s/30s 三次，4xx 不重试（**429 例外**）→ 我们的 webhook 路径不受配额影响，不会返回 429
- 去重窗口 ≥5 分钟 → 我们按 `X-MengBot-Event-Id` **永久幂等**，更严格
- 触发点：支付成功 / 退款 / 取消

### 待对方回复的只剩两条

1. B1 的 `cards`/`vaults` 具体数值（等定价表）
2. B2 的 `plan` 取值二次确认（等 Cloud Admin 侧）
