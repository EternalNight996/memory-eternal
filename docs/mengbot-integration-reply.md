# 回复：memory-eternal-cloud ↔ MengBot 账号 / 支付 / 验证对接

**来自**：YG（memory-eternal-cloud，私有组件 `0.45.0`）
**日期**：2026-11-13
**事项**：对你们提出的三项开通项（OIDC 客户端注册 / API Token 签发 / Webhook 开通）的答复

---

## 结论

三项我方**对应实现已全部完成并实测通过**，现在只等你们三个交付物：`client_secret`、`mbt_` token、`webhook secret`。

拿到这三样，我方填进环境变量即可联调，**不需要你们再改任何代码**（除 §1.1 那一处 clients 白名单追加）。

---

## 1. OIDC 客户端注册

### 1.0 你们那个注册表单怎么填（三字段）

| 字段 | 填什么 |
|---|---|
| **厂商名** | `memory-eternal-cloud` |
| **redirect_uri** | `https://<我方生产域名>/memory-eternal/api/cloud/auth/callback http://127.0.0.1:7999/memory-eternal/api/cloud/auth/callback`<br>（多个用**空格**分隔；第一条等我方域名定下来后确认，第二条是本地调试，不放行就删掉） |
| **scope** | 勾 `openid` `profile` `email` **+ `offline_access`** |

**关于 scope 为什么必须带 `offline_access`**：我方用 `refresh_token` 做静默续期（
`$DSH_HOME/cloud-oidc-refresh.json`，自动轮换）。不勾它就拿不到 refresh_token，
token 一过期用户就得重新跳一次登录。

**关于 redirect_uri 的硬要求**（我方代码已按此实现）：

- 路径固定 `/memory-eternal/api/cloud/auth/callback`（注意 `memory-eternal` 这个前缀）；
- 生产必须 `https`（我们不做 TLS 终结，由 Caddy/Nginx 反代）；
- 本地调试只有 `http://127.0.0.1:7999/...` 这一种 http 形态；
- 多个值用空格分隔（不要逗号）。

填完后请把**生成的 `client_secret`** 通过安全渠道给我方，我方配到 `MEMORY_OIDC_CLIENT_SECRET`。

### 1.1 请在 `server/pay/oidc.ts` 的 `clients` 数组追加

```ts
{
  client_id: "memory-eternal-cloud",
  client_secret: process.env.MEMORY_ETERNAL_CLIENT_SECRET,   // ← 你们生成，安全渠道给我们
  redirect_uris: [
    "https://<我方域名>/memory-eternal/api/cloud/auth/callback",
    "http://127.0.0.1:7999/memory-eternal/api/cloud/auth/callback", // 本地调试；不放行的话我删掉
  ],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_basic",
  scope: "openid profile email offline_access",
},
```

我方 `lib/oidc.js` 的 `oidcClientRegistration({ baseUrl, clientSecret })` 就是生成这个形状，可以直接 `node -e` 打印后贴过去，避免手抄出错。

### 1.2 我方会发的授权请求（标准 authorization_code + PKCE）

```
GET {issuer}/oidc/auth
  ?response_type=code
  &client_id=memory-eternal-cloud
  &redirect_uri=https://<我方域名>/memory-eternal/api/cloud/auth/callback
  &scope=openid profile email offline_access
  &state=<32B base64url>.<回跳地址 base64url>
  &nonce=<base64url>
  &code_challenge=<S256(code_verifier)>
  &code_challenge_method=S256
```

**实测**（我方本机 8023 起实例，未跟随跳转）：

```
GET /memory-eternal/api/cloud/auth/start?redirect_uri=https://app.example/done
→ 302  https://cloud.mengbot.com.cn/oidc/auth
        ?response_type=code
        &client_id=memory-eternal-cloud
        &redirect_uri=https%3A%2F%2Fmem.example.com%2Fmemory-eternal%2Fapi%2Fcloud%2Fauth%2Fcallback
        &scope=openid+profile+email+offline_access
        &state=…&nonce=…&code_challenge=…&code_challenge_method=S256
```

### 1.3 我方会发的换 token 请求

```
POST {issuer}/oidc/token
Authorization: Basic base64("memory-eternal-cloud:<client_secret>")
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code>
&redirect_uri=<同上>
&code_verifier=<PKCE verifier>
```

拿到 `access_token` 后：

```
GET {issuer}/oidc/me   Authorization: Bearer <access_token>
```

**我方用 `email`（优先）或 `sub` 作为租户标识**（一人一个独立数据库，目录名由它决定）。如果你们规划里 email 可变，请告知，我改用 `sub`。

### 1.4 请你们确认三件事

- [ ] **issuer 用哪个域**：`https://cloud.mengbot.com.cn` 还是 `https://accounts.mengbot.com.cn`？
      我方按 `<issuer>/oidc/auth`、`/oidc/token`、`/oidc/me` 拼；若不在 `/oidc` 前缀下，请给实际路径。
- [ ] **回跳带什么**：只给 `code`（标准做法，推荐），还是也会直接带会话 `token`？
      两种我方都支持（`completeMengbotAuth` 同时认 `code` 与 `token`），但标准 `code` 更安全。
- [ ] **`http://127.0.0.1:7999/...` 这条 redirect 是否放行**？不放行我删掉，只保留生产地址。

---

## 2. `mbt_` API Token

### 2.1 我方处理逻辑（已实现）

```
Authorization: Bearer mbt_xxxxxxxx
        ↓
① 首次见到 → 401 + { code: "needs_verify" }，引导走 OIDC 登录或 /cloud/login/mengbot
② 校验通过后写入 cloud-keys.json（**只存 sha256**，24h TTL，最近 200 个）
③ 之后同一 token 直接放行，不再每请求打 MengBot
```

**实测**：

```
mbt_ 未校验 : needsVerify=true
cacheMbtToken(...) 后 : owner=yg@example.com via=mengbot-token
```

### 2.2 请你们给三样

1. **一个 `mbt_` 前缀的 client token**（建议为我方单独建一把，便于按 token 限流与撤销，不影响 desktop 那把）；
2. **校验端点**：`mbt_` 能否直接调 `GET /v1/me`？如果它是另一套道印灵钥，请给等价端点（如 `/v1/token/introspect`），并说明返回字段；
3. **限流阈值**（每秒/每分钟多少次）—— 我按这个设缓存 TTL，避免触发你们的限流。

### 2.3 为什么 `mbt_` 和 OIDC access_token 要分开

- OIDC token 是**用户级**：一次登录对应一个用户，短时有效；
- `mbt_` 是**服务级**：我方服务代表用户长期调用你们的 API（拉套餐、报用量等）。

两者职责不同，混用会让「用户登出后服务端就断供」。

---

## 3. Webhook 开通

### 3.1 我方端点（已实现，等你们推送）

```
POST https://<我方域名>/memory-eternal/api/cloud/webhook/mengbot
X-MengBot-Signature: sha256=<hex>          或  t=<unix_ms>,v1=<hex>
X-MengBot-Event: entitlement.updated
X-MengBot-Event-Id: <事件唯一 id>
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

> 注意：**对原始 body 字节算摘要**，不是重排后的 JSON —— 我方读的是原始字节。

### 3.3 事件与报文体

| 事件 | 触发时机 | 报文体关键字段 |
|---|---|---|
| `entitlement.updated` | 支付成功 / 续费 / 升级 / 套餐变更 | `account, plan, status, expiresAt, version, caps` |
| `subscription.canceled` | 用户取消订阅 | `account`（我方置 `plan=free, status=inactive`） |
| `subscription.expired` | 到期 | 同上 |

```jsonc
{
  "id": "evt_01HX...",             // 幂等键（也可放 X-MengBot-Event-Id 头）
  "event": "entitlement.updated",  // 也可放 X-MengBot-Event 头
  "account": "yg@example.com",     // 与 OIDC 的 email 一致，用来定位租户
  "plan": "pro",
  "status": "active",
  "expiresAt": "2026-12-13T00:00:00.000Z",
  "version": 12,                   // 单调递增；我方拒绝回退的 version
  "caps": { "seats": 5 }
}
```

### 3.4 幂等与重试约定

- 我方按 `id` 做幂等（`$DSH_HOME/cloud-webhook-seen.json`，保留最近 200 个）；
- **重复投递返回 `200` + `applied:false`** —— 请当成功处理，不要重试；
- 我方**不主动回拉**；万一丢了，下次登录 / `POST /cloud/connect` 时我方会拉 `session` 兜底。

### 3.5 实测三种情况

```
POST /cloud/webhook/mengbot（正确签名）→ 200 {"ok":true,"applied":true,"reason":"entitlement.updated → plan=pro status=active"}
POST 同一 eventId                      → 200 {"ok":true,"applied":false,"reason":"重复投递（已应用过）"}
POST 错签名                            → 401 {"ok":false,"error":"签名不匹配"}
GET  /cloud/config                     → access: {"source":"mengbot","plan":"pro","daysLeft":29,"canWrite":true}
```

### 3.6 请你们给四样

1. **`MEMORY_WEBHOOK_SECRET` 的值**（双方各存一份，走安全渠道）；
2. **用哪种签名形态**（A 还是 B）；
3. **`caps` 的键语义**（`planCaps()` 实际有哪些键：席位？卡片数？并发？）—— 我要用它设配额；
4. **推送地址确认**：`https://<我方域名>/memory-eternal/api/cloud/webhook/mengbot`。

---

## 4. 我方已完成的部分（供你们核对）

| 能力 | 文件 | 测试 |
|---|---|---|
| 标准 OIDC 客户端（code + PKCE S256） | `lib/oidc.js` | `tests/oidc-webhook.test.mjs` 9 条 |
| 跳转授权端点（start / callback，令牌走 fragment） | `lib/cloud-server.js` | 本机 302 实测，参数齐全 |
| `mbt_` token 识别 + 校验缓存 | `lib/cloud-auth.js` | 同一测试文件 |
| Webhook 接收（HMAC + 幂等 + 事件应用） | `lib/webhook.js` | 本机 200 / 200(dup) / 401 实测 |
| 三层权限：MengBot → 本地 license → 降级 | `lib/entitlement.js` | `tests/entitlement.test.mjs` 7 条 |
| 离线授权（私有部署兜底） | `lib/license.js` | `tests/license.test.mjs` 11 条 |

**为什么还留着一层本地 license**：MengBot 不可达时（控制面未上线、客户洞天内景隔离、私有部署）整个云端实例退回离线签名授权，已部署客户不受影响。你们上线后它是兜底，不是主路径。

---

## 5. 我方需要你们的三样（汇总）

| # | 交付物 | 用途 | 给到哪 |
|---|---|---|---|
| 1 | `client_secret`（配合 `client_id: memory-eternal-cloud`） | OIDC 换 token | 我方环境变量 `MEMORY_OIDC_CLIENT_SECRET` |
| 2 | `mbt_` token + 校验端点 + 限流阈值 | 服务端长期调用你们 API | 我方环境变量 + `cloud-keys.json` |
| 3 | `webhook secret` + 签名形态 + `caps` 语义 | 套餐变更推送 | 我方环境变量 `MEMORY_WEBHOOK_SECRET` |

另外几个「确认即可」的点：issuer 域名、回跳是否只给 `code`、`127.0.0.1:7999` 是否放行、`email` 可否作为稳定标识。

---

## 6. OpenAPI / examples（由 MengBot 侧提供）

按你们安排，OpenAPI 3.1 描述文件与 `examples/`（Node + Python）由**你们做**，我方不再重复造。
我方需要的只是：端点路径、鉴权头（`Authorization: Bearer <token>`）、错误码语义与我们实现一致即可。

> 我方端点全集见《docs/CLOUD.md §8 接口一览》，可直接作为你们写 OpenAPI 的底稿。

## 7. 我方进度（截至本回复）

**已完成并有实测/测试证据**：

| 项 | 证据 |
|---|---|
| 多租户分库（每人一个 SQLite） | 独立库自动创建，`/cloud/whoami` owner 正确 |
| 密钥签发 / 吊销 / 只存哈希 | `cloud-auth` 4/4 |
| 标准 OIDC 客户端（code + PKCE S256） | `oidc-webhook` 10/10，302 实测 |
| 跳转授权（start/callback，令牌走 fragment） | `redirect-auth` 5/5 |
| `mbt_` token 识别 + 24h 缓存 | `oidc-webhook` |
| Webhook（两种签名 + 幂等 + 事件应用） | 200 / 200(dup) / 401 实测 |
| refresh_token 存储 + 轮换 + 失败清除 | `oidc-webhook` |
| 离线 license + 三档降级 | `license` 11/11，readonly 写 403 实测 |
| 三层权限编排（MengBot → license → 降级） | `entitlement` 7/7 |
| 服务端不含客户端 UI（动态加载边界） | `private-boundary` 6/6，打包审计干净 |
| 前端「用 MengBot 账号登录」入口 | 实验性页按钮 + fragment 回跳消费 |
| 三端发布 `0.45.0` | npm / GitHub Release / Gitee Release 已验证 |

**还没做（不阻塞联调）**：

| 项 | 说明 |
|---|---|
| 配额与限流实际执行 | `limits` 已在 `/cloud/connect` 返回，但服务端还没真拦；等你们给 `caps` 语义后一起做 |
| 租户实例 LRU | 几十个租户没问题，几百个要淘汰（`tenants` Map 只增不减） |
| MengBot 真联调 | 等 §5 三样交付物 |

## 附：我方关键配置项一览

```bash
# OIDC
MEMORY_OIDC_ISSUER=https://<你们给的 issuer>
MEMORY_OIDC_CLIENT_ID=memory-eternal-cloud
MEMORY_OIDC_CLIENT_SECRET=<你们给的>
MEMORY_OIDC_REDIRECT_URI=https://<我方域名>/memory-eternal/api/cloud/auth/callback

# Webhook
MEMORY_WEBHOOK_SECRET=<你们给的>
MEMORY_CLOUD_PUBLIC_URL=https://<我方域名>

# 授权降级策略（生产建议 readonly）
MEMORY_LICENSE_DEGRADE=readonly
```
