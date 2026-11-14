# 对《memory-eternal 商铺接入 —— 端到端验证报告》的确认与修正

> 你们六段链路全通的结论我们这边对得上。报告里指出的那条日志问题是真的，
> 而且顺着它挖出了**一个更严重的配额 bug**。都在 `d7c5f99` 修完了。

---

## 一、你们指出的日志问题 —— 确认，并挖出更严重的

你们的原话：

> 这条出现在 **free 账号** 的事件上（free 没有 caps，属正常）。
> 建议他们把兜底提示限定在「有订阅但缺字段」时才打，否则 free 用户事件会持续刷这条日志。

我们复现后发现是**两个 bug**，第二个比日志噪声严重得多：

### ① free 用户被给了 20 倍配额（真 bug）

```
改前：quotaFor({ plan: 'free', caps: { seats: 10 } })
     → { cards: 10000, source: 'plan+seats-fallback' }   ← 本该 500 张
```

**free 事件的 `caps` 里也可能带 `seats`** —— 它表示"能开几个名额"，
我们却把它当成了卡片容量，`Math.max(500, 10 × 1000)` = 10000。

也就是说：**任何带 `seats` 的 free 账号都白拿了 10000 张卡**。

**修法**：`plan === 'free'` 时**完全不参与** seats 兜底。

```
改后：quotaFor({ plan: 'free', caps: { seats: 10 } })
     → { cards: 500, source: 'plan' }   ✓
```

### ② 日志算式与数值对不上

```
你们看到的：「seats(10) × 1000 = 200000」
实际：10 × 1000 = 10000，200000 是 enterprise 的套餐默认值
```

实际取值是 `max(套餐默认, 席位换算)`，但日志只打了后一项，所以算式看起来是错的。

**新文案**把两个数都写出来：

```
配额兜底：enterprise 未下发 caps.cards ——
  取 max(套餐默认 200000, seats(10) × 1000 = 10000) = 200000 张
  （MengBot 承诺后续下发显式 caps.cards，届时本提示自动消失）
```

而且触发条件收窄为「**付费套餐** 且 未下发 `caps.cards` 且 有 `seats`」——
free 事件不会再刷这条。

### ③ 顺带：`source` 改成三态，便于你们和我们都判断兜底何时可收口

| 值 | 含义 |
|---|---|
| `caps` | 你们下发的显式 `caps.cards` |
| `plan+seats-fallback` | 用 `seats × 1000` 兜底（**free 不会走到这里**） |
| `plan` | 既没显式 cards 也没可用 seats，用套餐默认值 |

你们报告 §4 里看到的 pro 事件已带 `cards: 10000`，我们这边会走 `caps` 分支，
兜底逻辑就此不再参与 —— 你们 B1 的承诺已经兑现了。

---

## 二、你们 §5 里那个 `cors=DENY` —— 说明一下

你们的观察很准：

> `cors=DENY` 是他们的 CORS 记录字段，webhook 是服务端调用，不影响投递（HTTP 已 200）。

确实不影响。那行日志的原意是「**这个请求带来的 Origin 是否在我们的 CORS 白名单里**」，
服务端调用不带 Origin（`origin=-`），自然判为 DENY。

我们给它换了个更准确的措辞，避免以后再看日志的人误判：

```
[cloud-access] POST /cloud/webhook/mengbot origin=<无> cors=n/a（无 Origin，服务间调用）
```

---

## 三、你们报告里没提、但我们这轮顺手修的两件事

### 1. 会话令牌只存 hash

`cloud-keys.json` 是全局单文件（所有租户共用），原来存着 `mb_` 会话令牌的**明文**。
明文会话令牌等同于"能冒充该用户的密码"——文件泄漏就是全员沦陷。

现在只存 `sha256(token)`，校验时算 hash 比对。生产已迁移 3 个会话，**迁移后仍有效**
（存 hash 不影响校验），`health=200`。

### 2. 多租户 entitlement 隔离（上一轮）

`cloud-entitlement.json` 原来是全局单文件，所有租户共享同一份套餐状态。
现在按 owner 分文件：`cloud-entitlement-<encoded-owner>.json`。

顺带修了两个会导致**付费用户拿不到配额**的 bug：
- `isPro` 写死 `plan === 'pro'`，把 `personal` 和 `max` 都当成未付费（你们的 B2 定稿后暴露的）
- webhook 写 entitlement 时不带 owner → 多租户下 A 的支付会写到全局，影响所有租户

---

## 四、我们这边现在的状态

| 项 | 状态 |
|---|---|
| OIDC 登录 | ✅ 302 → `accounts.mengbot.com.cn/auth` |
| 支付直跳 | ✅ `https://pay.mengbot.com.cn/subscribe?sku=sub-{plan}&source=memory-eternal-cloud` |
| 下单归因 | ✅ 走你们的 `source` 解析（我们传 `memory-eternal-cloud`） |
| 权益下发 | ✅ 收到 `caps: {cards:10000, rpm:300, vaults:1}`，按显式字段执行 |
| webhook | ✅ 双格式验签 / eventId 永久幂等 / 三事件名对齐 |
| 主动对账 | ✅ 用 `mbt_` 调 `/subscription`，10 分钟一次，只升级不降级 |
| 套餐枚举 | ✅ `personal` / `pro` / `max`（已按 B2 定稿改） |

---

## 五、还剩一个确认 + 一个我们自己的修正

### 1. `source` —— 我们写错了，已改（不用你们回答）

你们的验证报告 §3 写了白名单行为：

```
source:memory-eternal  → 存储 source:memory-eternal
source:evil-vendor     → 存储 source:unverified
```

我们代码里的默认值写的是 `memory-eternal-cloud`（多一个 `-cloud` 后缀）——
按你们这个规则会被判成 `source:unverified`，**渠道归因静默丢失**（支付能成功，但后台看不到来源）。

已改成 `memory-eternal`，并加了断言守住：

```
默认 source 必须是 memory-eternal（他们白名单里的值）
```

### 2. `caps.bots` 与 `caps.seats` 的关系（需要你们答复）

你们 §4 的示例里两个字段同时出现且都是 10：

```json
"caps": { "bots": 10, "apps": 5, "seats": 10, "cards": 10000, "rpm": 300, "vaults": 1 }
```

我们目前只认 `seats`（`bots` 忽略）。如果以后 `bots` 会**独立于** `seats` 变化，
请说一声 —— 我们的配额模型里没有"机器人"这个概念，需要知道映射关系才能正确取数。

---

感谢这份验证报告的严谨程度 —— 特别是「用 free 账号的事件」那条观察，
直接让我们发现了一个白送 20 倍配额的 bug。
