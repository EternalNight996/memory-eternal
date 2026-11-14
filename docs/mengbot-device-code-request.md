# 商户接入：我们找到了最优解，只差你们一行配置

> 承接前几轮的联调。这轮不是提需求要你们开发 —— 是**发现你们已经有这个能力，
> 只是没给我们的 client 开**。开完商户就能 3 分钟开通。

---

## 一句话

**你们已经支持 Device Code Flow（RFC 8628），但 `memory-eternal-cloud` 这个 client 没被允许
`urn:ietf:params:oauth:grant-type:device_code`。加这一个 grant type 即可。**

我们的客户端**已经全部实现并在生产跑起来了**，你们开完立刻生效，不需要我们发版。

---

## 为什么这个是最优解（不是我们偷懒）

### 商户的真实场景决定了不能只用授权码流程

| 商户的部署形态 | 能走授权码流程吗 |
|---|---|
| 浏览器里的 web 版 | ✅ 能 |
| **桌面客户端（Electron，页面 origin 是 `dsh-app://app`）** | ❌ 不能 |
| **部署在服务器上的实例（没有浏览器）** | ❌ 不能 |
| **商户老板在手机上操作** | ❌ 不能（要跨设备） |

桌面端走不通的原因是 OIDC 的 **interaction cookie** 种在 `accounts.mengbot.com.cn` 域上，
而桌面应用的页面是自定义协议 —— cookie 跨不过去。你们的授权页会明确报：

```
HTTP 400
title: 登录链接已失效
正文: 这次授权过程已经过期，或不在同一个浏览器里。请回到应用重新发起登录。
```

**这不是 bug，是浏览器的同源策略**。RFC 8252（OAuth 2.0 for Native Apps）为此专门规定了
两种替代方案，Device Code Flow 是其中最适合我们的：

```
商户点「一键开通」
  → 界面显示：请在手机或任意浏览器打开 accounts.mengbot.com.cn/device，输入 ABCD-1234
  → 商户在手机上输入（或用扫码直达）
  → 我们的服务端轮询，拿到令牌 → 商户开通完成
```

**商户全程不需要理解"重定向""cookie""origin"这些词** —— 输一个码就完事。

---

## 我们实测到的现状

### ① 你们服务端已经支持

`GET https://accounts.mengbot.com.cn/.well-known/openid-configuration` 里：

```json
{
  "device_authorization_endpoint": "https://accounts.mengbot.com.cn/device/auth",
  "grant_types_supported": [
    "implicit",
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code"
  ]
}
```

### ② 我们的 client 认证是通的

```
POST https://accounts.mengbot.com.cn/device/auth
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded
scope=openid profile email offline_access
```

### ③ 但被 client 级 grant 拦住

```
HTTP 400
{"error":"invalid_request",
 "error_description":"urn:ietf:params:oauth:grant-type:device_code is not allowed for this client"}
```

**不是认证失败，是这个 client 没开这个 grant。**

---

## 请你们做什么（一行配置）

在 `memory-eternal-cloud` 这个 client 的配置里，把 grant_types 加上：

```ts
grant_types: [
  'authorization_code',
  'refresh_token',
  'urn:ietf:params:oauth:grant-type:device_code',   // ← 加这一行
]
```

`node-oidc-provider` 会自动提供：
- `POST /device/auth`（已在 discovery 里）
- `GET /device` 用户输入码的页面（你们可能已经有）
- `POST /token` 的 `device_code` grant（已支持）

**顺手确认一件事**：`/device` 那个用户输入码的页面已经上线了吗？
我们从 discovery 只看到 `device_authorization_endpoint`，接入方还需要一个**给人输码的页面**。
如果还没有，需要补一个（oidc-provider 有默认实现，只需挂路由）。

---

## 我们这边已经做完的部分

| 能力 | 状态 |
|---|---|
| 发现 `device_authorization_endpoint` | ✅ 走 discovery，不硬编码 |
| 发起设备码授权 | ✅ `POST /cloud/auth/device/start` |
| 显示短码 + 授权网址 + 二维码（待加） | ✅ 前端面板已做 |
| 轮询取令牌 | ✅ `POST /cloud/auth/device/poll`，遵守 `interval` 与 `slow_down` |
| 拿到令牌后签发本地会话 | ✅ 与授权码流程共用同一套下游（含 profile 头像） |
| 失败识别 | ✅ 专门识别 `not allowed for this client`，给用户准确提示 |
| 回落 | ✅ 不可用时提示用访问密钥，不阻塞商户 |

**当前生产状态**：端点已上线，调用返回 `409 grant_not_allowed`（就是上面那条）；
前端会显示「总部已支持设备码登录，但还没为我们的应用开启这项权限，请先用访问密钥」。
**你们加完配置，这条提示自动消失，功能即刻可用。**

---

## 商户体验对比（这是生意层面的差别）

### 现在（只能用访问密钥）

```
商户：我要接入
我们：请把这一长串 me_xxx 复制到配置里
商户：这是什么？会不会泄漏？怎么轮换？
我们：（一串解释）
```

### 加完 device code 之后

```
商户：我要接入
界面：请在手机上打开 accounts.mengbot.com.cn/device，输入  ABCD-1234
商户：（输码，3 秒完成）
界面：✓ 已开通，套餐 pro，30 天有效
```

**从「要理解一套密钥体系」变成「输一个码」** —— 这是商户愿不愿意开通的分水岭。

---

## 还有两件小事（不急，但影响计费闭环）

### 1. 商户套餐的 sku

你们公布的 `personal` / `pro` / `max` 全是个人套餐，没有商户档。

我们现在用 `MEMORY_MERCHANT_PLAN_SKU=sub-merchant` 占位，商户点「订阅商户套餐」会跳到
`pay.mengbot.com.cn/subscribe?sku=sub-merchant&source=memory-eternal&merchant=mch_xxx`。

**请给正式 sku 与价格**（可以只有一个档，先跑通）。

### 2. 商户权益下发的 `account` 填什么

商户订阅成功后，webhook 的 `entitlement.updated` 里 `account` 填哪个？

- 填注册人邮箱 → 商户套餐会和个人套餐混在同一个人的权益里（商户管理员会白拿商户配额）
- 填我们签发的 `mch_xxx` → 你们要先承认我们的商户编号体系

**建议**：webhook 里加一个独立字段 `merchant_id`（和 `account` 并列），我们据此分流。
这样个人权益与商户权益永远不会混。

---

## 总结：三件事，工作量从小到大

| 优先级 | 事项 | 你们的成本 |
|---|---|---|
| **P0** | `memory-eternal-cloud` 加 `device_code` grant | **一行配置** |
| P1 | 确认 `/device` 用户输码页面在线 | 若未上线，挂个路由 |
| P2 | 商户套餐 sku + 商户权益的 `merchant_id` 字段 | 需要一次产品决定 |

**P0 做完，商户接入的主干就通了** —— 剩下的都是计费细节，不阻塞开通。
