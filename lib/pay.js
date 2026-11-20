// 自有支付与订阅（不走 MengBot 收款）。
//
// 设计照 MengBot 的 server/pay/subscriptions.ts：
//   **订阅不是存下来的字段，而是由「已付订单」实时派生**。
//   好处：提前续费累加、退款自动折减、补单立即生效，不需要人工维护 plan 字段。
//
// 支付通道用 XorPay（聚合支付，个人可注册）：协议就是四个字段 + 一个 MD5，不需要 SDK。
// 没配 XORPAY_AID/SECRET 时降级为「手动订单」：管理端建单 → 立即生效，先能卖再谈自动到账。
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

// ── 套餐契约（本地定义，价格与 MengBot 公布的一致，可自行调整）──────────
export const PLANS = {
  'sub-personal': { id: 'sub-personal', name: '个人版', days: 30, priceFen: 1800, tier: 'personal', cards: 2000, rpm: 150, vaults: 1 },
  'sub-pro': { id: 'sub-pro', name: '团队版', days: 30, priceFen: 11800, tier: 'pro', cards: 10000, rpm: 300, vaults: 3 },
  'sub-max': { id: 'sub-max', name: '旗舰版', days: 30, priceFen: 39900, tier: 'max', cards: 100000, rpm: 1000, vaults: 10 },
  'sub-personal-half': { id: 'sub-personal-half', name: '个人版（半年）', days: 182, priceFen: 9900, tier: 'personal', cards: 2000, rpm: 150, vaults: 1, base: 'sub-personal' },
  'sub-pro-half': { id: 'sub-pro-half', name: '团队版（半年）', days: 182, priceFen: 64900, tier: 'pro', cards: 10000, rpm: 300, vaults: 3, base: 'sub-pro' },
  'sub-max-half': { id: 'sub-max-half', name: '旗舰版（半年）', days: 182, priceFen: 219400, tier: 'max', cards: 100000, rpm: 1000, vaults: 10, base: 'sub-max' },
  'sub-personal-year': { id: 'sub-personal-year', name: '个人版（年付）', days: 365, priceFen: 18000, tier: 'personal', cards: 2000, rpm: 150, vaults: 1, base: 'sub-personal' },
  'sub-pro-year': { id: 'sub-pro-year', name: '团队版（年付）', days: 365, priceFen: 118000, tier: 'pro', cards: 10000, rpm: 300, vaults: 3, base: 'sub-pro' },
  'sub-max-year': { id: 'sub-max-year', name: '旗舰版（年付）', days: 365, priceFen: 399000, tier: 'max', cards: 100000, rpm: 1000, vaults: 10, base: 'sub-max' },
}

export const DAY_MS = 24 * 60 * 60 * 1000

export function planOf(sku) {
  const p = PLANS[String(sku || '').trim()]
  return p || null
}

/**
 * 展示用：按月付档位分组，带上半年/年付。
 *
 * 目前**只开放个人版**（团队版/旗舰版还没有对公资质与备案，标为即将开放）。
 * 新增开放档位只需改 OPEN_TIERS —— 价格与配额已在 PLANS 里备好，不用动别的代码。
 */
export const OPEN_TIERS = ['personal']

/**
 * 读取订阅视图配置（lib/pay-views.json）。
 * 照 MengBot 的做法：**页面结构由配置驱动**，改文案/开放档位不用动代码。
 */
export function payViews() {
  try {
    const p = new URL('../lib/pay-views.json', import.meta.url)
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch { return null }
}

export function planCatalog({ onlyOpen = true } = {}) {
  const base = ['sub-personal', 'sub-pro', 'sub-max'].map((id) => ({
    sku: id, name: PLANS[id].name, priceFen: PLANS[id].priceFen, price: PLANS[id].priceFen / 100, days: PLANS[id].days, tier: PLANS[id].tier,
    caps: { cards: PLANS[id].cards, rpm: PLANS[id].rpm, vaults: PLANS[id].vaults },
    tier: PLANS[id].tier,
    open: OPEN_TIERS.includes(PLANS[id].tier),
    periods: Object.values(PLANS).filter((p) => p.base === id).map((p) => ({ sku: p.id, name: p.name, priceFen: p.priceFen, price: p.priceFen / 100, days: p.days })),
  }))
  return onlyOpen ? base.filter((p) => p.open) : base
}

// ── 订阅派生（照抄 currentSubscription 的算法）────────────────────────
/**
 * 从已付订单算出当前订阅。**提前续费是累加，不是覆盖**：
 *   until = max(until, paidAt) + days
 * 这样用户今天买一个月、明天再买一个月，到期日是今天+60 天，而不是被覆盖成明天+30 天。
 * @param {Array<{sku:string, paidAt?:string|Date|null, refundedFen?:number}>} orders
 */
export function currentSubscription(orders, now = Date.now()) {
  const paid = (orders || [])
    .filter((o) => o && o.paidAt && planOf(o.sku))
    .filter((o) => (Number(o.refundedFen) || 0) < planOf(o.sku).priceFen)
    .sort((a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime())
  if (!paid.length) return null
  let until = 0
  let latest = null
  for (const o of paid) {
    const at = new Date(o.paidAt).getTime()
    if (!Number.isFinite(at)) continue
    const p = planOf(o.sku)
    until = Math.max(until, at) + p.days * DAY_MS
    latest = o
  }
  if (!latest || until <= now) return null
  const p = planOf(latest.sku)
  return {
    sku: latest.sku,
    name: p.name,
    tier: p.tier,
    activeUntil: new Date(until).toISOString(),
    daysLeft: Math.max(1, Math.ceil((until - now) / DAY_MS)),
    caps: { cards: p.cards, rpm: p.rpm, vaults: p.vaults },
  }
}

// ── XorPay（聚合支付：微信扫码 / 支付宝当面付）────────────────────────
const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex').toLowerCase()

export function xorpayConfig(env = process.env) {
  const aid = String(env.XORPAY_AID || '').trim()
  const secret = String(env.XORPAY_SECRET || '').trim()
  const base = String(env.XORPAY_BASE || 'https://xorpay.com').replace(/\/+$/, '')
  const notifyUrl = String(env.XORPAY_NOTIFY_URL || '').trim()
  return { aid, secret, base, notifyUrl, ready: !!(aid && secret && notifyUrl) }
}

export function createSign({ name, payType, price, orderId, notifyUrl, secret }) {
  return md5(name + payType + price + orderId + notifyUrl + secret)
}

export function notifySign({ aoid, orderId, payPrice, payTime, secret }) {
  return md5(aoid + orderId + payPrice + payTime + secret)
}

/** 回调验签。没配 secret 一律 false（不能让空 secret 算出「合法」签名）。 */
export function verifyNotify(fields, secret) {
  const sign = String((fields && fields.sign) || '')
  if (!sign || !secret) return false
  const expected = notifySign({
    aoid: String(fields.aoid || ''),
    orderId: String(fields.order_id || ''),
    payPrice: String(fields.pay_price || ''),
    payTime: String(fields.pay_time || ''),
    secret,
  })
  return sign.toLowerCase() === expected
}

/** 回调金额是「元」字符串（9.00），订单存的是分。 */
export function notifyAmountMatches(payPrice, expectedFen) {
  const fen = Math.round(Number(payPrice) * 100)
  return Number.isFinite(fen) && fen === Number(expectedFen)
}

export function xorpayErrorText(status) {
  const known = {
    missing_argument: '缺少必填参数（商品名/金额/订单号）',
    pay_type_error: '支付类型错误：只支持 native（微信扫码）或 alipay（支付宝）',
    app_off: 'XorPay 账号被冻结',
    aid_not_exist: 'XorPay appid 不存在，请核对后台',
    sign_error: '签名错误：检查拼接顺序与 secret 是否有多余空格',
    order_payed: '这个订单已经支付过了',
    order_expire: '订单已过期，请重新下单',
    order_exist: '订单号重复且参数不同',
    fee_error: 'XorPay 平台余额不足（手续费从余额扣），请先充值',
    alipay_api_error: '支付宝侧报错：可能未签约或授权过期',
  }
  return known[status] || ('XorPay 返回错误：' + status)
}

/** 下单：返回 { aoid, qr, expiresIn }。qr 是支付二维码内容。 */
export async function createXorpayOrder(cfg, { name, priceFen, orderId, payType = 'native', fetchImpl = fetch }) {
  if (!cfg.ready) throw new Error('XorPay 未配置（XORPAY_AID / XORPAY_SECRET / XORPAY_NOTIFY_URL）')
  const price = (Number(priceFen) / 100).toFixed(2)
  const body = new URLSearchParams({
    name, pay_type: payType, price, order_id: orderId, notify_url: cfg.notifyUrl,
    sign: createSign({ name, payType, price, orderId, notifyUrl: cfg.notifyUrl, secret: cfg.secret }),
  })
  const r = await fetchImpl(cfg.base + '/api/pay/' + encodeURIComponent(cfg.aid), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  })
  const d = await r.json().catch(() => ({}))
  if (d.status !== 'ok' || !d.aoid || !(d.info && d.info.qr)) {
    throw new Error(xorpayErrorText(String(d.status || ('http_' + r.status))))
  }
  return { aoid: String(d.aoid), qr: String(d.info.qr), expiresIn: Number(d.expires_in) || 7200 }
}
/**
 * 运行时支付配置：**管理端设置优先，env 兜底**。
 * 管理端在 /admin/payment 保存后立即生效，不用改 env、不用重启。
 */
export async function loadPaymentConfig(env = process.env) {
  const base = xorpayConfig(env)
  const out = {
    channel: base.ready ? 'xorpay' : 'manual',
    simulate: String(env.PAY_SIMULATE || '') === '1',
    qrWechat: '', qrAlipay: '',
    aid: base.aid, secret: base.secret, baseUrl: base.base, notifyUrl: base.notifyUrl,
  }
  try {
    const { q } = await import('./server-db.js')
    const r = await q("SELECT value FROM settings WHERE key='payment'", [], env)
    const v = r.rows[0] && r.rows[0].value
    if (v && typeof v === 'object') {
      if (v.channel) out.channel = String(v.channel)
      if (v.simulate !== undefined) out.simulate = !!v.simulate
      if (v.qrWechat) out.qrWechat = String(v.qrWechat)
      if (v.qrAlipay) out.qrAlipay = String(v.qrAlipay)
      if (v.xorpayAid) out.aid = String(v.xorpayAid)
      if (v.xorpaySecret) out.secret = String(v.xorpaySecret)
      if (v.xorpayBase) { out.baseUrl = String(v.xorpayBase) }
      if (v.xorpayNotify) out.notifyUrl = String(v.xorpayNotify)
    }
  } catch { /* 用 env */ }
  // 两种可用形态：
  //   xorpay 自动收款 → 需要 aid + secret + notifyUrl
  //   manual 手动确认 → **需要至少一张收款码**（用户扫你的码转账，你在订单页确认）
  // manual 且没有收款码才算「未配置」——以前这里只认 xorpay，导致上传了收款码也提示未配置。
  // ⚠ createXorpayOrder 读的是 cfg.base / cfg.notifyUrl（xorpayConfig 的原字段名），
  //   这里统一补一份同名别名，否则会拼出 "undefined/api/pay/xxx"（实测踩到）。
  out.base = out.baseUrl
  out.notifyUrl = out.notifyUrl
  const hasQr = !!(out.qrWechat || out.qrAlipay)
  out.ready = out.channel === 'xorpay'
    ? !!(out.aid && out.secret && out.notifyUrl)
    : hasQr
  out.mode = out.channel === 'xorpay' ? 'xorpay' : (hasQr ? 'manual' : 'none')
  return out
}