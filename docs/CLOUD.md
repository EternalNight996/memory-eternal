# 云端多租户（memory-eternal-cloud）

> 私有包：`private/memory-eternal-cloud/`；打包 `npm run cloud:pack` → `dist/memory-eternal-cloud-<version>.tgz`。
> 本模块属于**商用私有组件**，不随开源插件发布（边界见 [PRIVATE.md](PRIVATE.md)）。

> 架构决定（按 YG 拍板）：**维持 SQLite，不换 PG**。云端 = 一个能「按密钥分库」的服务端，
> **每个用户一个独立的 `memory-eternal.db`**，物理隔离；进门方式两种：**云端密钥** 或 **MengBot 授权登录**。

## 1. 一句话原理

```
客户端 ──Authorization: Bearer <密钥/令牌>──▶ 云端实例
                                              │ resolveTenant()
                                              ▼
                          $DSH_HOME/cloud-vaults/<owner>/memory-eternal.db
```

- 不同 owner → 不同目录 → 不同 SQLite 文件：一个人的库坏了/被删了，不影响别人；
- 每个租户一个 `createApi` 实例（`embedJobs` / `probeCache` / 类型缓存都按库隔离，不会串）；
- **写者仍然唯一**：所有写都进这一个 Node 进程，所以不需要 PG 那套并发控制。

## 2. 启用

```bash
# Linux / macOS
MEMORY_CLOUD=1 node bin/dsh-memory.mjs web --port 7999
# Windows
$env:MEMORY_CLOUD='1'; node lib\web.js --port 7999
```

默认关闭；不开时行为与单机完全一致（没有任何鉴权、直接读本地 vault）。

## 3. 密钥

```bash
# 签发（明文只返回一次）
curl -X POST http://127.0.0.1:7999/memory-eternal/api/cloud/keys \
  -H 'Content-Type: application/json' \
  -d '{"owner":"alice","note":"笔记本"}'
# → {"ok":true,"token":"me_xxxxxxxx","key":{"id":"k_...","owner":"alice",...}}

# 之后所有业务请求都带上
curl http://127.0.0.1:7999/memory-eternal/api/overview \
  -H 'Authorization: Bearer me_xxxxxxxx'

# 列表（不含明文/哈希）
curl http://127.0.0.1:7999/memory-eternal/api/cloud/keys

# 吊销
curl -X DELETE http://127.0.0.1:7999/memory-eternal/api/cloud/keys/k_xxxx
```

台账文件：`$DSH_HOME/cloud-keys.json`（0600，**只存 sha256**）。

## 4. MengBot 账号授权（对齐 mengbot control-plane 的真实机制）

MengBot 云（默认 `cloud.mengbot.com.cn`）用的是 **better-auth + 邮箱 OTP + bearer 会话**，
不是 OAuth2 的 code 换 token。memory-eternal-cloud 直接代理这套流程：

```jsonc
// cloud-keys.json
{
  "mengbot": {
    "baseUrl": "https://cloud.mengbot.com.cn",   // 或 MEMORY_MENGBOT_BASE_URL
    "allowList": ["you@example.com"],            // 留空 = 不限
    "ttlHours": 168                              // 本地令牌有效期
  }
}
```

### 三条入口（`POST /cloud/login/mengbot`）

| 请求体 | 行为 |
|---|---|
| `{ email }` | 代发 8 位验证码（10 分钟、限流 60s/5），返回 `{ pending:true, step:'otp-sent' }` |
| `{ email, otp }` | 调 `/api/auth/sign-in/email-otp` 换 bearer → `/v1/me` 校验 → 签发本地 `mb_*` 令牌 |
| `{ token }` | 直接用令牌：用户会话走 `/v1/me`；`mb_install_*` 设备道印灵钥走 `/v1/installations/self` |

成功响应：

```jsonc
{
  "ok": true,
  "token": "mb_xxxxxxxx",          // 本地令牌（默认 7 天）
  "owner": "you@example.com",      // 邮箱；设备凭据时是 mb-inst-<installationId>
  "via": "mengbot",                // 或 mengbot-install
  "vaultRoot": "…/cloud-vaults/you_example.com",
  "expiresInHours": 168
}
```

之后与密钥完全一样：客户端带 `Authorization: Bearer mb_xxxxxxxx` 访问业务接口，
服务端解析成该用户独立的 SQLite。

> **为什么不是 OAuth2**：mengbot 控制面用的是 better-auth 的 `emailOTP` + `bearer({requireSignature:true})`
> 插件，没有 authorization_code 流程（见 `cloudflare/control-plane/src/auth.ts`：`basePath:'/api/auth'`、
> `otpLength:8`、`expiresIn:10min`、限流 `/email-otp/send-verification-otp` 60s/5）。
> 设备道印灵钥 `mb_install_<22>.<43>`（90 天）由 `POST /v1/installations` 用**用户会话**创建，
> 适合「一次登录、长期免登」的桌面客户端；`/v1/installations/self` 可自校验、不需要用户会话。

### 4.1 联调现状（2026-11-13 实测，如实记录）

| 探测 | 结果 | 含义 |
|---|---|---|
| `GET https://accounts.mengbot.com.cn/v1/me` | **404** `{"error":"not found"}` | 该控制面（`wrangler.jsonc` 里的 `BETTER_AUTH_URL`）**当前未部署/未上线** |
| `GET https://accounts.mengbot.com.cn/` | 200 HTML | 只有 SPA 前端，`/api/auth/*` 与 `/v1/*` 全 404 |
| `POST https://cloud.mengbot.com.cn/api/auth/email-otp/send-verification-otp` | **403** `forbidden: this request came through a proxy (pair this device to use the server remotely)` | 这是**设备配对后的 companion 通道**，不是通用账号登录入口 |
| 本机 `%APPDATA%\MengBot\cloud-entitlement.json` | `{"plan":"free","status":"inactive"}` | 本机 MengBot 客户端**未登录云端** |
| `credentials.bin` / `cloud-account.bin` | `v10`（Electron safeStorage=DPAPI，**带应用熵**） | 脱离 MengBot 进程解不开（`CryptUnprotectData` 无熵失败） |

**结论**：`{ email }` 发码这条链路**现在跑不通**，卡在 mengbot 侧（控制面未上线 + companion 通道要求配对）。
memory-eternal-cloud 这一侧已经按真实机制实现完毕，等对方控制面上线后可直接联调，无需改代码。

**可用的替代方案**：先走**云端密钥**（`POST /cloud/keys`）—— 不依赖 mengbot，多人分库已经可用：
```bash
curl -X POST http://127.0.0.1:7999/memory-eternal/api/cloud/keys \
  -H 'Content-Type: application/json' -d '{"owner":"alice"}'
```

**等 mengbot 具备条件后再联调**（二选一）：
1. 控制面 `accounts.mengbot.com.cn` 部署上线 → 直接 `{ email }` / `{ email, otp }` 走通；
2. 或本机 MengBot 客户端先用账号登录 → 从客户端拿到 `mb_install_*` 设备道印灵钥 → `{ token: 'mb_install_…' }`
   走 `/v1/installations/self` 校验（这条不需要用户会话）。

### 4.2 跳转授权（推荐：redirect + 回跳）

面板里输邮箱 + 验证码要来回切窗口，体验差。改成**跳转授权**：

```
① 浏览器打开  GET /memory-eternal/api/cloud/auth/start?redirect_uri=<登录后回哪>
                → 302 到 MengBot 登录页（带 state + 我们的 callback）
② 用户在 MengBot 页面完成邮箱 OTP 登录
③ MengBot 回跳  GET /memory-eternal/api/cloud/auth/callback?code=…&state=…
                → 校验 state（一次性、5 分钟）→ 换令牌 → /v1/me 校验 → 解析租户
④ 302 回客户端    <redirect_uri>#me_cloud_token=mb_xxx&me_cloud_owner=…&me_cloud_api=…
```

**为什么令牌放 fragment（`#`）而不是 query**：fragment 不会进服务器访问日志，也不带进 Referer。
客户端读到后应立刻从地址栏清掉（`history.replaceState`）。

配置项：

| 变量 | 说明 |
|---|---|
| `MEMORY_CLOUD_PUBLIC_URL` | 本实例对外地址（拼 callback：`<它>/memory-eternal/api/cloud/auth/callback`） |
| `MEMORY_MENGBOT_LOGIN_URL` | 登录页模板，支持 `{redirect_uri}` `{state}` `{client}`；不配则用 `<baseUrl>/login` 自动补参 |
| `MEMORY_MENGBOT_EXCHANGE_URL` | `code → token` 换取端点；不配则用 `<baseUrl>/api/cloud/desktop/token` |

实测（本机 8021 起实例）：

```
GET /cloud/auth/start?redirect_uri=https://app.example/done
→ 302  Location: https://cloud.mengbot.com.cn/login
       ?redirect_uri=https%3A%2F%2Fmem.example.com%2Fmemory-eternal%2Fapi%2Fcloud%2Fauth%2Fcallback
       &state=kRyobslmNsjSF_w5bsPvODWR
```

三种入口并存，客户端择优：

| 方式 | 端点 | 适用 |
|---|---|---|
| **跳转授权**（推荐） | `GET /cloud/auth/start` → `GET /cloud/auth/callback` | 桌面/浏览器，一次点击完成 |
| 面板内登录 | `POST /cloud/login/mengbot {email}` / `{email,otp}` | 无跳转条件（CLI、内嵌小窗） |
| 已有令牌 | `POST /cloud/login/mengbot {token}` | 客户端已登录过，复用会话 |

> 需要 MengBot 侧确认：登录页是否接受 `redirect_uri` + `state`，回跳带 `code` 还是直接带会话 `token`。
> 两种都支持（`completeMengbotAuth` 同时认 `code` 与 `token`），对方选一种就能通。

## 6. 授权与续期（License）

云端服务端的商用授权走**离线签名 license**，与本文件的部署流程解耦：部署不需要联网校验，
续期只需换一个环境变量。完整说明见 [LICENSE.md](LICENSE.md)，这里只讲运维要做的三件事。

### 6.1 首次部署

```bash
# 服务端只认公钥（已内嵌在 lib/license.js）；私钥在签发方手里，不进仓库
MEMORY_SERVER_LICENSE=eyJhbGciOiJFUzI1NiIs...
MEMORY_LICENSE_DEGRADE=readonly      # warn（默认）| readonly | stop
```

启动即打印状态：

```
[memory-eternal-cloud] license 有效 · plan=pro · 剩 365 天
[memory-eternal-cloud] license expired（到期 2026-12-13T11:20:39.000Z，剩 -3 天）· 降级策略=readonly
```

### 6.2 续期（不用停服改代码）

```bash
# 签发方（你）跑：
node scripts/license-issue.mjs --key private/license-private.pem \
  --sub acme --plan pro --seats 5 --days 365 --features cloud,backup

# 客户侧：改环境变量 + 重启进程
sed -i "s|^MEMORY_SERVER_LICENSE=.*|MEMORY_SERVER_LICENSE=<新 token>|" /etc/memory-eternal.env
systemctl restart memory-eternal
```

> license 是**进程启动时读一次**（`createCloudServer` 构造期），所以续期后必须重启进程。
> 想做到「不重启就生效」的话，把 `licenseState(env)` 改成每次请求读取（代价是每请求一次 ECDSA 验签，
> 量级 ~0.1ms，可接受）；目前没这么做是因为 license 变动频率极低。

### 6.3 过期后客户还能做什么

| 策略 | 到期后的行为 |
|---|---|
| `warn`（默认） | 照常服务，只在 `/cloud/config` 与日志里标记 `expired` |
| `readonly` | 读、检索、**导出备份**（`/backup/export`）全部可用；写接口 403 `license_readonly` |
| `stop` | 除 `/cloud/config`、`/cloud/whoami` 等诊断外全 503 `license_stop` |

`readonly` 是推荐的生产策略：既不让人继续白用，也保证客户能把数据拿走（不人质化）。

## 7. 与 MengBot 的关系（账号 / 支付 / 验证）

**结论：账号、支付、套餐验证三套体系都接 MengBot，不自己另造一套。**

### 7.1 MengBot 已经有什么（实测路由）

| 能力 | MengBot 路由 | 我们怎么用 |
|---|---|---|
| 邮箱 OTP 登录 | `POST /api/auth/email-otp/send-verification-otp`、`/sign-in/email-otp` | 已接（`/cloud/login/mengbot {email,otp}`） |
| 会话与身份 | `GET /v1/me`（Bearer） | 已接（拿 `user.email` 当租户标识） |
| **设备授权** | `POST /api/cloud/desktop/authorize` → `POST /api/cloud/desktop/token` | 待接（桌面客户端「一次登录长期免登」，配 `mb_install_*`） |
| **套餐与有效期** | `GET /api/cloud/desktop/session` → `entitlement{plan,status,expiresAt,version,caps}` | 待接（映射成本地权限，见 §7.3） |
| **支付下单** | `POST /api/cloud/desktop/checkout {plan,source}` | 待接（跳 MengBot 收银台，我们不做支付） |
| **升级 / 取消** | `POST /api/cloud/desktop/upgrade/preview`、`/upgrade`、`/clouds/:id/cancel` | 待接（套餐变更全交给 MengBot） |

### 7.2 为什么不自己造

- **支付**：涉及收单、对账、退款、发票、税；自建等于重新踩一遍合规坑，而 MengBot 侧已有 `checkout/upgrade/cancel` 全链路；
- **账号**：已经有 OTP + 设备码 + 会话，再建一套就是两个密码体系；
- **套餐**：MengBot 的 `entitlement{plan,status,expiresAt,version,caps}` 就是现成的权威源，直接消费即可。

我们只做一件事：**把 entitlement 翻译成本地能用的权限位**，外加**离线兜底**。

### 7.3 落地形态：三层权限来源

```
① MengBot entitlement（主）      在线时以它为准；带 version 防回退、带 expiresAt 判到期
        ↓ 缓存到 $DSH_HOME/cloud-entitlement.json
② 本地 license（离线兜底）        MengBot 不可达 / 私有内网部署时用；ES256 离线签名
        ↓
③ 降级策略（warn/readonly/stop）  两者都失效时按策略收敛
```

判定顺序（`lib/entitlement.js` 待实现）：

```
entitlement 有效（plan=pro && status=active && expiresAt>now）
  → 全功能
否则 license 有效（本地离线签名）
  → 全功能（标记 source=license）
否则
  → 按 MEMORY_LICENSE_DEGRADE 降级
```

### 7.4 需要 MengBot 侧确认/提供

1. **`/api/cloud/desktop/*` 的调用前提**：目前从服务器直连会 403
   （`forbidden: this request came through a proxy (pair this device to use the server remotely)`），
   即**必须先设备配对**。请确认：服务端对服务端（partner）有没有免配对通道？
2. **entitlement 的刷新频率与 webhook**：套餐变更（支付/取消）后，我们靠轮询还是能有推送？
   如果没有推送，建议给一个 `GET /api/cloud/desktop/session` 的最小 TTL 约定（我们按 `version` 单调递增缓存）。
3. **`caps` 字段语义**：`planCaps(input.caps)` 的具体键（席位？卡片数？并发？）—— 我们要用它设配额。
4. **`tier` 与 `plan` 的关系**：新套餐名（`TIER` 正则允许的）如何映射到我们的 `features`。

在那之前，**MengBot 不可用时的行为已确定**：整个云端实例退回「本地 license 模式」，
不影响已部署客户的正常使用（这也是为什么 `license` 和 `entitlement` 要并存，而不是二选一）。

## 8. 接口一览

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/cloud/config` | 云端配置（脱敏：`hasSecret` 只给布尔值） |
| GET | `/cloud/keys` | 密钥列表（不返回明文与哈希） |
| POST | `/cloud/keys` | 签发密钥（`{owner,note}`），**明文只返回一次** |
| DELETE | `/cloud/keys/:id` | 吊销 |
| POST | `/cloud/login/mengbot` | MengBot 账号授权：`{email}` 发码 / `{email,otp}` 登录 / `{token}` 直接校验 |
| GET | `/cloud/whoami` | 当前令牌解析出的 owner / 来源（`key` or `mengbot`）/ vault 路径 |
| **POST** | **`/cloud/connect`** | **连接协商**：登录后拿一份就够切客户端（`apiBase` / `vault` / `limits` / `features` / `client` 清单） |
| GET | `/cloud/client/manifest` | 客户端清单：去哪下载 + 校验值（**不下发代码**） |
| GET | `/cloud/client` | 临时自托管下载（仅当 `MEMORY_CLIENT_PKG` 指向 tgz） |

业务接口（`/cards`、`/overview`、`/backup/*` …）全部不变，只是必须带 `Authorization`。

## 5.1 三种客户端形态（服务端不含 UI）

服务端**只做 API + 连接协商**，客户端代码从标准渠道分发，不进服务端：

| 形态 | 怎么拿 | 怎么连 |
|---|---|---|
| **DSH 插件**（主力） | 开源仓库 / 插件市场 | 面板顶栏「本地运行 ▾ → 连接云端」填地址 + 令牌 |
| **Web 客户端** | 单独部署到 CDN，或本地实例**可选**托管（`MEMORY_SERVE_WEB=1`） | 浏览器打开即用，令牌存 localStorage |
| **CLI / MCP** | 同一个插件包 | `dsh-memory mcp --cloud https://… --token me_xxx` |

登录后 `POST /cloud/connect` 一次给全：

```jsonc
{
  "ok": true,
  "connect": {
    "mode": "cloud", "owner": "alice", "via": "key",
    "apiBase": "/memory-eternal/api",
    "vault": "…/cloud-vaults/alice",
    "version": "0.40.1",
    "client": { "available": true, "url": "https://…/memory-eternal-0.40.1.tgz", "sha256": "…" },
    "limits": { "maxVaults": 1, "maxCardsPerVault": null },
    "features": { "semantic": true, "backup": true, "audit": true, "cloud": true }
  }
}
```

**为什么不在服务端托管客户端包**：服务端一换版本，老客户端连不上就是事故；静态分发的带宽、
灰度、回滚交给 Release / 私有 npm / 对象存储更省事。需要洞天内景试用时用
`MEMORY_CLIENT_PKG` 临时自托管，或 `MEMORY_CLIENT_URL` 指向外部地址。

## 6. 部署清单（Linux）

```bash
# 1) 代码与依赖
git clone <repo> /opt/memory-eternal && cd /opt/memory-eternal && pnpm i --prod

# 2) 环境
cat > /etc/memory-eternal.env <<'EOF'
DSH_HOME=/var/lib/memory-eternal
MEMORY_CLOUD=1
MEMORY_VAULT_DIR=/var/lib/memory-eternal/cloud-vaults
EOF

# 3) systemd
cat > /etc/systemd/system/memory-eternal.service <<'EOF'
[Unit]
Description=Memory Eternal (cloud, multi-tenant)
After=network.target
[Service]
EnvironmentFile=/etc/memory-eternal.env
WorkingDirectory=/opt/memory-eternal
ExecStart=/usr/bin/node lib/web.js --port 7999
Restart=always
User=memory
[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now memory-eternal

# 4) HTTPS 反代（Caddy，自动证书）
# memory.example.com {
#   reverse_proxy 127.0.0.1:7999
# }
```

## 7. 备份与灾备（每个租户各自一份）

- 每个租户的库在 `cloud-vaults/<owner>/`，`/backup/*` 接口作用范围就是**该租户自己的库**；
- 服务端整体备份：`tar` 整个 `cloud-vaults/` 目录（或对每个库跑 `VACUUM INTO`）；
- 恢复单个用户：把 `<owner>/memory-eternal.db` 换回去即可（先关连接，注意删除残留 `-wal`/`-shm`，
  见 `scripts/fix-vault-lock.mjs` 的说明）。

## 8. 已知边界

| 项 | 说明 |
|---|---|
| 单写者 | 一个 Node 进程串行写 → 多人共用**同一个 owner** 时是安全的；想多人各写各的，就一人一把密钥 |
| 内存 | 每个活跃租户一个 api 实例（轻量）；几十个租户没问题，几百个建议加 LRU 淘汰 |
| 检索 | 关键词 FTS / 向量召回都**按租户库存**，不会跨用户串数据 |
| 令牌泄露 | 立刻 `DELETE /cloud/keys/:id`；MengBot 会话有过期时间，重启服务不清（在台账里） |
