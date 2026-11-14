# 两项请求：`mbt_` 令牌 + `omc_` 澄清

> 回应你们第 3 封（`memory-eternal-round2-followup.md`）的两个遗留点。
> 这两条是唯一还卡住「套餐对账」与「支付可用」的东西。

---

## 请求一：请发一个 `mbt_` 令牌（scope=client）给 memory-eternal-cloud 服务端

### 要什么

一个 `scope=client` 的 `mbt_` 令牌，我们会写进 `/etc/memory-eternal-cloud.env` 的
`MEMORY_MENGBOT_API_TOKEN`。

### 为什么

你们在 §1 给了接口清单，其中这条对我们价值最大：

> `GET /api/v1/accounts/{email}/subscription` —— **代码注释明确「任意 API token 可读」**，只暴露运行中的 plan

**我们现在的套餐状态 100% 依赖 webhook 推送，这是个真实的可靠性缺口。**

你们的重试策略是 **1s / 5s / 30s 三次，总共 36 秒**。如果这 36 秒内我们的服务正好在重启
（这轮联调我们重启过十几次，正式运营后每次发版也会重启），事件就**永久丢失** ——
用户的套餐状态会一直错到下一次事件，而这可能是下个月续费。

有了 subscription 接口就能做**主动对账**：

```
用户请求 /cloud/billing/plan
  → 发现本地 entitlement 超过 N 分钟没更新
  → 用 mbt_ 查 GET /api/v1/accounts/{owner}/subscription
  → 对账并回写
```

`owner` **本身就是邮箱**（OIDC 的 `sub`，如 `mengbot996@163.com`），参数天然对得上。

### 需要什么 scope

`scope=client` 即可 —— 我们只调 `GET /api/v1/me`（校验令牌有效性）和
`GET /api/v1/accounts/{email}/subscription`（对账）这两个读接口，不碰订单、不碰管理端点。

### 拿到后我们会怎么做

1. `MEMORY_MENGBOT_API_TOKEN` 写进 env
2. 新增 `lib/subscription-sync.js`：
   - `fetchSubscription(owner, env)` → 打你们的接口
   - **不覆盖更新的数据**：你们 webhook 带 `version`，先用 `fetchedAt` + `version` 双条件判断，
     避免对账结果把刚收到的新 entitlement 盖回旧状态
3. 触发时机（可配置，默认最保守）：
   - `/cloud/billing/plan` 被调用且 entitlement 超过 10 分钟未更新 → 顺手对一次
   - 额外提供 `POST /cloud/billing/refresh` 让用户手动刷新
4. 对账失败**不影响主流程**（读不到就当没对，不报错给用户）

### 顺带确认一个限流细节

你们说限流键是 `tokenId:scope:IP`。我们服务端出口 IP 固定（单机部署），
所以**这一个 `mbt_` 的 300 次/分钟是我们所有租户共享的**。

按我们的对账策略（10 分钟一次、每次 1 个请求），300 次/分钟远超需求。
但如果以后要对所有租户做批量对账（比如每小时全量刷一遍），可能需要你们把这个
token 的 `rateLimit` 调高，或给一个专门的批量读接口 —— 到那时再谈。

---

## 请求二：`omc_` 设备令牌 —— 我们拿不到，请确认架构

### 现状

你们 §3 写：

> 鉴权用设备令牌（`omc_`，Bearer），不是 `mbt_`/`mbo_`。

我们的架构是**服务端代用户下单**：

```
用户 OIDC 登录我们（拿到 refresh_token）
  → 用户在我们界面点「升级 Max」
  → 我们服务端调 POST /api/cloud/desktop/checkout
```

**`omc_` 是 MengBot 桌面客户端登录后产生的设备令牌，我们作为第三方服务端拿不到。**

我们实测（用 OIDC 的 access_token 打）：

```
POST /api/cloud/desktop/checkout {plan:"max"} → 取 access_token 失败：没有可用的 refresh_token
```

（这是旧流程的报错，说明鉴权方式对不上）

### Q1：`omc_` 第三方服务端有可能拿到吗？

如果你们的本意是「这个端点只有 MengBot 自己的桌面客户端能用」，请明确说一声 ——
那我们就不该走这条路。

### Q2（我们更倾向的方案）：能否跳过 checkout 端点，直接让用户跳 subscribe 页？

你们的 `url` 指向：

```
https://pay.mengbot.com.cn/subscribe?sku=sub-pro&order=MBMWFW1EF9429A99
```

**`order` 是必须先由 checkout 端点创建的吗？还是用户可以直接打开 `?sku=` 页面、在页面上自己完成？**

如果是后者，对我们是最干净的架构：

```
用户点「升级 Max」→ 我们 302 到
  https://pay.mengbot.com.cn/subscribe?sku=sub-max&source=memory-eternal
→ 用户在你们页面自己登录 + 支付
→ webhook 回传 entitlement.updated → 我们更新套餐
```

**这个方案对双方都更好**：

| 好处 | 说明 |
|---|---|
| 我们不需要 `omc_` | 少一层道印灵钥依赖 |
| **支付道印灵钥不经过第三方服务端** | 安全上更正确 —— 你们的用户不该把自己的支付会话交给我们的服务器代持 |
| 少一次跨服务调用 | 少一类失败点（网络、鉴权、限流） |
| 订单归因仍清晰 | `source=memory-eternal` 保留来源，你们后台照样能看到渠道 |

我们唯一失去的是 `priceFen` 的实时展示（可以在 UI 上写死「¥79/月起」，或你们给一个公开的
`GET /api/v1/market/plans` 让我们读 —— 这个接口在 client 令牌清单里有，不需要额外权限）。

### 在澄清之前我们不改鉴权实现

因为改错的代价是「用户点了升级直接 401」，比现在（明确报「需重新登录」）更糟。

---

## 顺带致谢与一条自我更正

**§3 里你们指出**：

> 这个端点**之前根本不存在**（实测 404），你们说的「支付转发已验证」验的应该是你们自己那段

这条我们认，而且是个真实的验证盲区：我们的 `billing-e2e` 测试用的是**本地假 MengBot**，
只验证了「我们的转发逻辑正确」，从没真正打到你们的端点。把"自己那段通了"当成
"整条链通了"是错的，已作为教训写进我们的联调记录。

**另外 §6 确认的 refresh 语义很有用**：

> `refresh_token` 过期后不会「静默续期」，必须重新走授权码

我们据此把「刷新失败」分成两种处理：真失效 → 清令牌 + 提示重新登录；并发被抢 →
不清 + 提示重试。你们这条说明直接帮我们堵上了一个会让登录态丢失的并发缺陷。

---

## 待办汇总

| 编号 | 内容 | 谁做 |
|---|---|---|
| **P0-1** | 发一个 `mbt_`（scope=client）令牌 | 你们 |
| **P0-2** | 澄清 `omc_` 能否给第三方 / 能否直接跳 subscribe | 你们 |
| P1 | `caps.cards` / `vaults` 数值（定价表定稿时） | 你们 |
| ~~P2~~ | ~~`plan` 枚举~~ | ✅ 我们已改为 `personal`/`pro`/`max` 并部署 |
