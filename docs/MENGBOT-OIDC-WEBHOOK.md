# MengBot ↔ memory-eternal-cloud 对接清单（可直接转给 MengBot 侧）

> 我方已实现完毕，等 MengBot 侧完成三件事：**OIDC 客户端注册**、**签 `mbt_` token**、**开通 Webhook**。
> 每一项下面都给出了「你要改哪里 / 你要给我什么 / 我怎么验」。

我方版本：`memory-eternal-cloud 0.45.0` · 对接日期：2026-11-13

---

## 一、OIDC 客户端注册

### 1.1 你要改的位置

`server/pay/oidc.ts` 的 `clients` 数组（现在是 `admin` + `desktop` 两个），**追加第三个**：

```ts
{
  client_id: "memory-eternal-cloud",
  client_secret: process.env.MEMORY_ETERNAL_CLIENT_SECRET,   // ← 你生成，同步给我们
  redirect_uris: [
    "https://<我们的域名>/memory-eternal/api/cloud/auth/callback",
    "http://127.0.0.1:7999/memory-eternal/api/cloud/auth/callback", // 本地调试用
  ],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_basic",
  scope: "openid profile email offline_access",
},
```

> 我方 `lib/oidc.js` 的 `oidcClientRegistration()` 生成的就是这个形状，可以直接 `node -e` 打印出来贴过去。

### 1.2 我方会发的授权请求（标准 authorization_code + PKCE）

```
GET {issuer}/oidc/auth
  ?response_type=code
  &client_id=memory-eternal-cloud
  &redirect_uri=https://<我们>/memory-eternal/api/cloud/auth/callback
  &scope=openid profile email offline_access
  &state=<32B base64url>.<回跳地址 base64url>
  &nonce=<base64url>
  &code_challenge=<S256(verifier)>
  &code_challenge_method=S256
```

实测（我方本机 8023 起实例）：

```
GET /memory-eternal/api/cloud/auth/start?redirect_uri=https://app.example/done
→ 302  https://cloud.mengbot.com.cn/oidc/auth?response_type=code&client_id=memory-eternal-cloud
        &redirect_uri=https%3A%2F%2Fmem.example.com%2Fmemory-eternal%2Fapi%2Fcloud%2Fauth%2Fcallback
        &scope=openid+profile+email+offline_access&state=…&code_challenge=…&code_challenge_method=S256
```

### 1.3 我方会发的换 token 请求

```
POST {issuer}/oidc/token
Authorization: Basic base64("memory-eternal-cloud:<client_secret>")
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>&redirect_uri=<同上>&code_verifier=<verifier>
```

然后：

```
GET {issuer}/oidc/me          Authorization: Bearer <access_token>
```

**我方用 `email`（优先）或 `sub` 作为租户标识**（`email` 变了你告诉我，我改 `sub`）。

### 1.4 需要你确认

- [ ] `issuer` 是 `https://cloud.mengbot.com.cn` 还是 `accounts.mengbot.com.cn`？（我按前缀 `/oidc/auth` `/oidc/token` `/oidc/me` 拼，若不在这两个前缀下请告知实际路径）
- [ ] 回调时**只给 `code`**（标准做法），还是也会直接带 `token`？（两种我都支持，标准 code 更安全）
- [ ] `redirect_uris` 是否支持 `http://127.0.0.1:7999/...`（本地调试），不支持我就去掉这一条

---

## 二、`mbt_` API Token

### 2.1 我方行为

```
Authorization: Bearer mbt_xxxxxxxx
        ↓
① 未校验过 → 401 + { code:"needs_verify" }，引导走 /cloud/login/mengbot 或 OIDC 登录
② 校验通过后缓存在 cloud-keys.json（hash 存储，默认 24h TTL，最近 200 个）
③ 之后同一 token 直接放行，不再每请求打 MengBot
```

### 2.2 需要你给我什么

1. **一个 `mbt_` 前缀的 client token**（或为我方单独建一把，便于按 token 限流与撤销）；
2. **校验端点**：`GET /v1/me`（Bearer `mbt_`）返回什么？如果 `mbt_` 不能调 `/v1/me`，给一个等价端点（`/v1/token/introspect` 之类）；
3. **限流阈值**：每秒/每分钟多少请求，我按这个设缓存 TTL。

### 2.3 为什么不直接用 OIDC access_token

OIDC 的 token 是**用户级**（一次登录一个用户）；`mbt_` 是**服务级**（我们的服务代表用户长期调用）。
两者用途不同：OIDC 管「谁登录了」，`mbt_` 管「服务端调你的 API」。

---

## 三、Webhook 开通

### 3.1 我方端点（已实现，等你的推送）

```
POST https://<我方域名>/memory-eternal/api/cloud/webhook/mengbot
X-MengBot-Signature: sha256=<hex>          ← 或 t=<ts>,v1=<hex>（你选一种）
X-MengBot-Event: entitlement.updated
X-MengBot-Event-Id: <事件唯一 id>           ← 我方按它做幂等
Content-Type: application/json
```

### 3.2 签名算法（两种都支持）

**形态 A（简单）**
```
signature = "sha256=" + hex(HMAC_SHA256(secret, rawBody))
```

**形态 B（带时间戳，防重放，推荐）**
```
signature = "t=<unix_ms>,v1=" + hex(HMAC_SHA256(secret, "<t>." + rawBody))
```
我方校验时间戳容差 **±5 分钟**，超出直接 401。

> **对原始 body 算摘要**（不是重排后的 JSON）—— 我方读的是原始字节。

### 3.3 事件与报文体

| 报文体关键字段 |
|---|---|---|
| `entitlement.updated` | 支付成功 / 续费 / 升级 / 套餐变更 | `{account, plan, status, expiresAt, version, caps}` |
| `subscription.canceled` | 用户取消订阅 | `{account}`（我方置 `plan=free, status=inactive`） |
| `subscription.expired` | 到期 | 同上 |

```jsonc
{
  "id": "evt_01HX...",            // 幂等键（也可放 X-MengBot-Event-Id 头）
  "event": "entitlement.updated", // 也可放 X-MengBot-Event 头
  "account": "yg@example.com",    // 与 OIDC 的 email 一致，用来定位租户
  "plan": "pro",
  "status": "active",
  "expiresAt": "2026-12-13T00:00:00.000Z",
  "version": 12,                  // ← 单调递增；我方拒绝回退的 version
  "caps": { "seats": 5 }
}
```

### 3.4 幂等与重试

- 我方按 `id` 做幂等（`$DSH_HOME/cloud-webhook-seen.json`，保留最近 200 个）；
- **重复投递返回 200 + `applied:false`**，请按 200 处理，不要重试；
- 我方**不做**主动重试拉取；丢了就丢了 —— 下次登录/`/cloud/connect` 时我方会主动拉 `session` 兜底。

### 3.5 需要你给我什么

1. **`MEMORY_WEBHOOK_SECRET`** 的值（双方各存一份，走安全渠道给）；
2. **签名形态**（A 还是 B）；
3. **`caps` 的键语义**（`planCaps()` 实际有哪些键）—— 我要用它设配额；
4. 推送地址确认（我方生产地址 `https://<域名>/memory-eternal/api/cloud/webhook/mengbot`）。

---

## 四、我方已完成的部分（供你核对）

| 能力 | 文件 | 测试 |
|---|---|---|
| 标准 OIDC 客户端（authorization_code + PKCE S256） | `lib/oidc.js` | `tests/oidc-webhook.test.mjs` 9 条 |
| 跳转授权端点（start / callback，令牌走 fragment） | `lib/cloud-server.js` | 本机 8023 实测 302 + 全套参数 |
| `mbt_` token 识别 + 校验缓存 | `lib/cloud-auth.js` | 同上 |
| Webhook 接收（HMAC + 幂等 + 事件应用） | `lib/webhook.js` | 本机 8022 实测：200/200(dup)/401 |
| 三层权限：MengBot → license → 降级 | `lib/entitlement.js` | `tests/entitlement.test.mjs` 7 条 |

实测记录（我方本机）：

```
POST /cloud/webhook/mengbot（正确签名）→ 200 {"ok":true,"applied":true,"reason":"entitlement.updated → plan=pro status=active"}
POST 同一 eventId                      → 200 {"ok":true,"applied":false,"reason":"重复投递（已应用过）"}
POST 错签名                            → 401 {"ok":false,"error":"签名不匹配"}
GET  /cloud/config                     → access: {"source":"mengbot","plan":"pro","daysLeft":29,"canWrite":true}
```

---

## 五、可选（你要就做）

- **OpenAPI 3.1** 文件：可直接导入 Postman / 生成 SDK；
- **`examples/` 目录**：Node + Python 两个可跑通的示例（登录 → 建租户 → 写卡片 → 查 recalled）。

这两项我方做（我们自己的 API 文档），不需要 MengBot 侧投入 —— 你说要我就补。
