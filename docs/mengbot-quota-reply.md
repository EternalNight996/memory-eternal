# memory-eternal 对配额文档的回复


---

# 回复：现状核对 + 联调入口（memory-eternal 侧，2026-11-15 00:40）

> 你们 22:38 那份文档我们在自己代码和生产上都核对过了。
> **三项里有一项已经做完、一项在你们查的那个版本里就已经有了、一项受架构限制暂时不适用。**
> 下面逐条给证据和联调入口，方便你们直接对着验。

## 一、逐条核对结果

| 项 | 你们判断 | 实际情况 | 证据 |
|---|---|---|---|
| `caps.cards` | ✅ 已执行 | ✅ 一致 | `lib/quota.js` + `cloud-server.js:1080` |
| `caps.rpm` | ❌ 没读到 | **✅ 已经在执行** | 见下 |
| `caps.vaults` | ❌ 没读到 | **⚠️ 架构上每租户单库，恒为 1** | 见下 |
| `/api/vaults` 带 `quota` | 缺 | **✅ 本轮已补** | 见下 |

### 1. `caps.rpm` 其实一直在拦

`lib/cloud-server.js` 第 1062-1092 行就是配额闸门：

```js
if (!SUB_WITHOUT_QUOTA.test(sub)) {
  const q = quotaFor(tenantAccess, env)
  const rate = rateLimiter.hit(t.owner, q.rpm)
  res.setHeader('X-RateLimit-Limit', String(rate.limit))
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, rate.limit - rate.used)))
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds))
    return json(res, 429, quotaExceededBody({ kind: 'rpm', ... }))
  }
  ...
}
```

**生产实测**（2026-11-15 00:35，用 yg 的 owner key）：

```
$ curl -i -H "authorization: Bearer $TOKEN" https://mem.mengbot.com.cn/memory-eternal/api/overview
  X-RateLimit-Limit: 1200          ← max 档的 rpm
  X-RateLimit-Remaining: 1198      ← 每次请求递减
```

连打 200 次全部 200（因为上限是 1200，没到阈值）。

**为什么你们 grep 不到 `caps.rpm`**：这两个值不是直接读 `access.caps.rpm`，
而是经 `quotaFor(access, env)` 解析成 `q.rpm` —— 优先级是
`caps.rpm` > 套餐默认(`PLAN_QUOTA`) > 兜底(`DEFAULT_QUOTA`)。
grep 字面量 `caps.rpm` 自然找不到（那种写法也只会在 window/plan 的响应组装里出现）。

**你们可以这样验（不用等我们改）**：

```bash
# 连打超过 rpm 的请求，第 N+1 次应当 429 + Retry-After
for i in $(seq 1 1300); do
  curl -s -o /dev/null -w '%{http_code} ' \
    -H "authorization: Bearer $TOKEN" \
    https://mem.mengbot.com.cn/memory-eternal/api/overview
done
# 期望：前 1200 个 200，之后 429
```

### 2. `caps.vaults` —— 架构上现在是恒 1，不是"忘了做"

生产服务器上：

```bash
$ ls /var/lib/memory-eternal-cloud/cloud-vaults/
13048770337_163.com   mengbot996_163.com   yg
```

**每个租户一个目录、一个 `memory-eternal.db`** —— 也就是说：

- 云端租户**只能有 1 个库**，`used` 永远是 1；
- 任何 `caps.vaults >= 1` 都不会被触发；
- **没有"建库"入口**可拦（租户库是首次访问时按 owner 懒创建，`cloud-server.js` 里没有 `POST /api/vaults`）。

**所以这条 P0 的实际情况是**：不是"少了一层判断"，而是"**当前架构没有多库这个概念**"。

两条路，需要你们定：

**A. 改订阅页文案**（成本最低）
   把「记忆库 N 个」去掉或改成「单库」——与现在的实现一致。

**B. 真的支持多库**（需要双方都改）
   · 我们：`cloud-vaults/<owner>/` 下允许多个 `.db`，加 `POST /api/vaults` 建库入口并在那里校验 `caps.vaults`；
   · 你们：在 `/api/v1/merchants/{id}/accounts` 的 caps 里下发 `vaults`（现在下发的是 `{cards, rpm, vaults}`，vaults 有值但我们没用上）。
   工作量我们估 1 天（多库路由 + 配额校验 + 前端切换器，前两项已有现成实现可复用 —— `/api/vaults` 枚举、`/api/vaults/activate` 切换、`/api/vaults/export`、`/api/vaults/import-into` 都已经在线上）。

**默认按 A 处理**，你们要 B 就说一声。

### 3. `GET /api/vaults` 的 `quota` —— 本轮已补

**生产地址**：`GET https://mem.mengbot.com.cn/memory-eternal/api/vaults`

```json
{
  "ok": true,
  "vaults": [ { "id": "...", "name": "yg", "owner": "yg", "kind": "cloud", "cards": 7583, "sizeMB": 115.5, "isCurrent": true } ],
  "count": 1,
  "current": "/var/lib/memory-eternal-cloud/cloud-vaults/yg",
  "quota": { "limit": 3, "used": 1, "field": "vaults", "limited": true }
}
```

- `limit = 0` 表示**不限**（本地单机场景没有租户配额）；
- 云端由 `cloud-server` 按**每个租户自己的 caps** 注入（不会串租户）；
- `limited: false` 是给前端判断用的冗余布尔，省得它自己算 `limit > 0`。

**本地 vs 云端实测**：

```
① 本地（不传 getCaps）        → {"limit":0,"used":2,"field":"vaults","limited":false}
② 云端注入 caps.vaults=3      → {"limit":3,"used":2,"field":"vaults","limited":true}
```

## 二、联调入口汇总（你们可以直接打）

| 用途 | 端点 | 期望 |
|---|---|---|
| 当前套餐 + caps | `GET /memory-eternal/api/cloud/billing/plan` | `{ plan, caps, plans, expiresAt }` |
| 库数量配额 | `GET /memory-eternal/api/vaults` | 带 `quota: { limit, used, field, limited }` |
| 速率配额 | 任意业务接口的响应头 | `X-RateLimit-Limit` / `X-RateLimit-Remaining`，超限 429 + `Retry-After` |
| 卡片配额 | `POST /memory-eternal/api/write`（超限时） | 429 + `{ error:'quota_exceeded', field:'cards', limit, used }` |
| 探活（不受配额限制） | `GET /memory-eternal/api/health` | 200（`/cloud/*` 与 health 都不进配额闸门） |

**配额豁免路径**：`SUB_WITHOUT_QUOTA = /^\/cloud\//` —— 管理面（登录、测连、看套餐）不限速，
否则用户超限后连"看自己还剩多少"都做不到。

## 三、还有一处需要你们配合

`GET /cloud/billing/plan` 现在返回的 `caps` 是 **null**：

```json
{ "plan":"free", "status":"inactive", "caps":null, "plans":["personal","pro","max"] }
```

我们的套餐卡因此没法显示「卡片上限 / 速率」两行（只能落一句"这一档还没有下发配额"）。
**webhook `entitlement.updated` 里带上 `caps`** 就能解决，不需要我们发版。

## 四、顺带一问：专属套餐的 SKU

我们这边注意到 `plans: ["personal","pro","max"]` 全是**跑机器人**的档
（云端桌面、并发任务、共享云加购），memory-eternal 只用得到存储与检索 API。
详细测算和三个建议档位写在 `memory-eternal-plan-pricing.md` —— 要不要开 `sub-me-*` 这组 SKU，
你们定。
