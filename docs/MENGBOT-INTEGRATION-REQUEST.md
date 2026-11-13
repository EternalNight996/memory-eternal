# 接入需求：memory-eternal-cloud ← MengBot 账号授权

> 这份文档可以直接整段转给 MengBot 团队。里面只有三件事：**我们要什么、为什么、怎么验**。

## 0. 结论先行

我方产品 `memory-eternal-cloud`（多租户记忆库服务端，每个用户一个独立 SQLite）需要**用 MengBot 账号登录**，
从而让用户不用再管一套独立密码。请你方提供**以下三选一**（按实现成本从低到高）：

| 方案 | 你需要做的 | 我方成本 | 推荐度 |
|---|---|---|---|
| **A. 控制面邮箱 OTP 上线** | 把 `accounts.mengbot.com.cn` 部署起来（代码已有，`wrangler.jsonc` 里配了） | 0（我按现有 better-auth 契约对接） | ★★★ 最正规 |
| **B. 服务端互信令牌** | 给我一个 `POST /v1/partner/exchange`：用共享密钥换用户标识 | 1 行配置 | ★★ 最快，但只适合小范围 |
| **C. 设备配对道印灵钥** | 告诉我怎么拿到 `mb_install_*`（客户端导出/本地接口） | 中等（要走设备通道） | ★ 仅当 A 暂时不上线 |

**如果只能做一件事：做方案 A** —— 你代码里已经有了，只差部署。

## 1. 背景（我方是什么）

- `memory-eternal`：本地记忆库插件（开源），用户的知识卡/项目记忆存在本机 SQLite；
- `memory-eternal-cloud`：它的**云端服务端**（商用私有），支持多用户；
- 我们希望用户在云端版里**直接用 MengBot 账号登录**，登录后自动分配一个独立库。

我方已有能力（不需要你方改造）：
- 密钥鉴权（`POST /cloud/keys`，已可用）；
- 多租户隔离（`cloud-vaults/<owner>/memory-eternal.db`）；
- 连接协商（`POST /cloud/connect` 返回 apiBase / 配额 / 能力开关）。

**唯一缺的就是「MengBot 账号 → 我方租户」这一步。**

## 2. 我方探测到的现状（2026-11-13，实测）

| 探测 | 结果 |
|---|---|
| `GET https://accounts.mengbot.com.cn/v1/me` | **404** `{"error":"not found"}` |
| `GET https://accounts.mengbot.com.cn/` | 200 HTML（只有 SPA，`/api/auth/*` 与 `/v1/*` 全 404） |
| `POST https://cloud.mengbot.com.cn/api/auth/email-otp/send-verification-otp` | **403** `forbidden: this request came through a proxy (pair this device to use the server remotely)` |
| 本机客户端 `%APPDATA%\MengBot\cloud-entitlement.json` | `{"plan":"free","status":"inactive"}`（未登录） |
| `credentials.bin` / `cloud-account.bin` | `v10`（Electron safeStorage=DPAPI 带应用熵，脱离客户端解不开） |

判断：
1. **控制面 `accounts.mengbot.com.cn` 未部署** —— 你在 `cloudflare/control-plane/wrangler.jsonc` 里配了
   `BETTER_AUTH_URL=https://accounts.mengbot.com.cn`、`routes: accounts.mengbot.com.cn`，但线上是 404；
2. `cloud.mengbot.com.cn/api/*` 是**设备配对后的 companion 通道**（`pair this device`），不是通用账号入口。

## 3. 方案 A：控制面邮箱 OTP（推荐，你代码里已有）

你方 `cloudflare/control-plane/src/auth.ts` 已经是 standard better-auth：

```ts
betterAuth({
  appName: "MengBot",
  basePath: "/api/auth",
  plugins: [
    emailOTP({ otpLength: 8, expiresIn: 10*60, allowedAttempts: 5, storeOTP: "hashed" }),
    bearer({ requireSignature: true }),
  ],
})
```

我方需要的就是这 4 个端点（**与你现在代码一致，不用新增**）：

### 3.1 发送验证码

```http
POST /api/auth/email-otp/send-verification-otp
Content-Type: application/json

{ "email": "user@example.com" }
```

- 成功：`200 {}`（或你现有响应体，我方只判 `ok`）
- 失败：`4xx` + `{ "message": "..." }`（我方把 message 原样回显给用户）
- 限流：你现在是 60s / 5 次，**保持即可**（我方不会重试）

### 3.2 登录换会话令牌

```http
POST /api/auth/sign-in/email-otp
Content-Type: application/json

{ "email": "user@example.com", "otp": "12345678" }
```

我方需要的**最小响应**：

```json
{ "token": "<bearer token>" }
```

> 如果你方的 token 在响应头 `set-auth-token` 而不是 body，也可以 —— 我方已经同时读这两个地方
> （`body.token` 优先，其次 `set-auth-token` 头）。

### 3.3 校验令牌 / 取用户

```http
GET /v1/me
Authorization: Bearer <token>
```

```json
{ "user": { "id": "u_xxx", "email": "user@example.com", "name": "YG", "emailVerified": true } }
```

- 我方用 `user.email`（优先）或 `user.id` 作为**租户标识**；
- 未授权：`401 { "error": "unauthorized" }`；
- **请确保这个端点对 `mb_install_*` 道印灵钥返回 401**（你现在的 `accountSession()` 已经这么做了，
  我方据此区分「用户会话」与「设备道印灵钥」）。

### 3.4 设备道印灵钥（可选，但强烈建议）

```http
POST /v1/installations            Authorization: Bearer <用户会话>
→ { "credential": "mb_install_xxxxxxxxxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "installation": { "id": "...", ... } }

GET  /v1/installations/self        Authorization: Bearer mb_install_...
→ { "installation": { "id": "...", "name": "..." }, "credentialExpiresAt": "..." }
```

我方用它实现「一次登录、长期免登」的桌面客户端（道印灵钥 90 天，与你现在一致）。

## 4. 字段与错误语义（我方如何消费）

| 你的响应 | 我方行为 |
|---|---|
| `{ token }` | 存本地，之后所有业务请求带 `Authorization: Bearer <token>` |
| `{ user: { email } }` | 用邮箱做租户目录名（`cloud-vaults/<email>/`） |
| `401` | 回给用户「MengBot 令牌无效」，不建租户 |
| `4xx + message` | 原样回显（例如「验证码错误」「邮箱不在列表」） |
| `5xx` / 超时 | 回「MengBot 服务暂不可用，请稍后重试」，**不重试**（避免触发你的限流） |

## 5. 安全要求（我方承诺 + 请你方确认）

我方：
- 只存**你方签发的令牌**，不存用户密码；令牌存在 `cloud-keys.json`（0600，仅存哈希 + 会话表）；
- 每个用户的数据在独立 SQLite 文件里，**不跨租户读**；
- 支持 `allowList`（只允许指定邮箱/用户登录）；
- 从不把 `clientSecret` 之类的东西返回给前端。

请你方确认/需要你提供的：
1. **是否允许多个第三方接入同一控制面**？如果有 partner/tenant 概念，请给出区分方式（例如 `client_id`）；
2. **令牌有效期与续期**：refresh 机制有吗？还是短期 token + 重新 OTP？
3. **`/v1/me` 返回的 `user.id` 是否稳定**（我方倾向于用 email，但如果 email 可变，请告知用 id）；
4. **限流阈值**：OTP 发码的每小时上限，我方需要在前端提示用户。

## 6. 验收清单（你给我确认后我立刻联调）

- [ ] `POST https://accounts.mengbot.com.cn/api/auth/email-otp/send-verification-otp {"email":"..."}` → 200
- [ ] 用户收到 8 位码
- [ ] `POST .../api/auth/sign-in/email-otp {email, otp}` → 返回 `token`
- [ ] `GET .../v1/me` + Bearer → 返回 `user.email`
- [ ] （可选）`POST .../v1/installations` → 返回 `mb_install_*`；`GET .../v1/installations/self` 可自校验
- [ ] 我方 `POST /cloud/login/mengbot {email, otp}` → 返回本地 `mb_*` 令牌 + 独立 vault

## 7. 我方对接位置（供你方参考，无需你改）

```js
// memory-eternal-cloud（我方）
POST /cloud/login/mengbot
  { email }        → 转发到你 /api/auth/email-otp/send-verification-otp
  { email, otp }   → 你 /api/auth/sign-in/email-otp 拿 token → GET /v1/me 校验 → 签发本地令牌
  { token }        → 直接 GET /v1/me（或 /v1/installations/self）校验
```

我方代码已按上述契约实现完毕（`lib/cloud-auth.js` 的 `verifyMengbotLogin`），
**你方控制面一上线，我方无需改代码即可联调。**

## 8. 如果要走方案 B（服务端互信，最快）

如果你方短期内不方便上线控制面，给我这样一个端点即可：

```http
POST /v1/partner/exchange
Content-Type: application/json
X-Partner-Key: <我们约定的共享密钥>

{ "email": "user@example.com" }        # 或 { "mengbot_user_id": "..." }
```

```json
{ "ok": true, "user": { "id": "u_xxx", "email": "user@example.com" } }
```

注意：**这个端点必须校验 `X-Partner-Key`**，且只允许查单个用户、不接受批量拉取（避免变成可枚举的用户目录）。
我方只在你方授权的前提下用，且会把它放在 allowList 之后。

---

**联系人**：YG · **我方版本**：`memory-eternal-cloud 0.40.1` · **探测日期**：2026-11-13
