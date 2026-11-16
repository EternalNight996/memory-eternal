## 🐛 v0.48.5 — 付费套餐的额度终于真的生效了（云端实测挖出来的）

### 现场

把云端实例从 0.45.0 升到 0.48.4 之后，journal 里出现这么一行：

```
[memory-eternal-cloud] 配额兜底：enterprise 未下发 caps.cards
  —— 取 max(套餐默认 200000, seats(10) × 1000 = 10000) = 200000 张。
```

而同一时刻 `GET /cloud/billing/plan` 明确返回：`plan=pro, caps={cards:10000, rpm:300}`。
**两个来源打架**，说明 per-owner 的套餐根本没被采纳。

### 根因

`lib/entitlement.js` 判"是否过期"用的是：

```js
const notExpired = (e, now) => !e.expiresAt || Date.parse(e.expiresAt) > now
```

而 MengBot 下发的是 **epoch 毫秒数字**（`1797227639837`）。`Date.parse(数字)` 会先把它转成字符串
`"1797227639837"` 再按日期解析 → **NaN** → `NaN > now` 恒为 `false` → **每个付费租户都被判成"已过期"**，
`resolveAccess()` 于是掉到「本地 license 兜底」分支（license 是 enterprise），caps 只剩 seats、
没有 cards → 走 20 万兜底。

结果：**pro 档承诺的 10,000 张 / 300 rpm 从来没生效过**，所有人都按 license 的 200,000 兜底在跑。

### 修法

```js
const toMs = (v) => {
  if (v == null || v === '') return 0
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000   // 毫秒 / 秒
  const n = Number(String(v).trim())
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000
  const p = Date.parse(String(v))
  return Number.isFinite(p) ? p : 0
}
const notExpired = (e, now) => !e.expiresAt || toMs(e.expiresAt) === 0 || toMs(e.expiresAt) > now
```

- 毫秒数字 / 秒级数字 / 数字字符串 / ISO 字符串**都认**；
- 解析不出来 → 按"未过期"（与 `isPaid()` 的「宁放行不误拒」同口径）；
- `daysLeft` 同步用 `toMs()`（原来也是 `Date.parse`，一直算成 NaN）。

### 验证

`tests/entitlement-expiry.test.mjs`（6 例）：毫秒/秒/ISO/无到期/坏值/percent-encoded owner 文件名，
全部通过；`entitlement / manifests / readme-i18n` 共 27 项无回归。

### ⚠️ 上线后果（必须先知道）

修好后配额会立刻**按真实套餐收紧**：pro = **10,000 张**。而你的云端现在已经是 **9,736 张** ——
也就是说修复生效后**只剩 264 张**，再写就 429 `quota_exceeded`。

三条路（任选，可组合）：

1. **先跑去重**：`runs/cloud-quota-plan/dedupe.mjs --apply`（软删 2,121 张重复 → 约 7,615/10,000）；
2. **升级套餐**：max = 200,000 张 / 50 库 / 1200 rpm；
3. 先按现状不动：保持在 enterprise license 兜底下跑（但那就等于付费档永远不生效）。
