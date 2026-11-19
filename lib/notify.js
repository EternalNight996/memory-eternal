// 支付/订单通知：飞书 / 企业微信 / 通用 webhook。照 MengBot 的 server/pay/notify.ts。
//
// 设计取舍：**通知失败绝不影响下单**。用户在付钱，推送挂了不该让他看到错误。
// 每个渠道独立 catch，一个坏不影响其它。
import crypto from 'node:crypto'

/** 飞书自定义机器人签名：base64(HMAC-SHA256(key = timestamp + "\n" + secret, data = "")) */
export function feishuSign(timestamp, secret) {
  return crypto.createHmac('sha256', String(timestamp) + '\n' + secret).update('').digest('base64')
}

async function postJson(url, body, timeoutMs = 8000) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const answer = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error('webhook HTTP ' + r.status + ' ' + String(answer.message ?? answer.msg ?? ''))
  return answer
}

export function notifyChannels(env = process.env) {
  const feishuUrl = String(env.FEISHU_WEBHOOK_URL || '').trim()
  const feishuSecret = String(env.FEISHU_WEBHOOK_SECRET || '').trim()
  const wecomUrl = String(env.WECOM_WEBHOOK_URL || '').trim()
  const genericUrl = String(env.NOTIFY_WEBHOOK_URL || '').trim()
  return {
    feishuUrl, feishuSecret, wecomUrl, genericUrl,
    ready: !!(feishuUrl || wecomUrl || genericUrl),
  }
}

/**
 * 推送到所有已配置渠道。返回 { sent: [...], failed: [{channel, error}] }，永不抛错。
 */
export async function sendNotify(env, text, extra = {}) {
  const cfg = await loadNotifyConfig(env)
  const sent = []
  const failed = []
  if (!cfg.ready) return { sent, failed, skipped: true }
  const jobs = []
  if (cfg.feishuUrl) {
    jobs.push((async () => {
      const payload = { msg_type: 'text', content: { text } }
      if (cfg.feishuSecret) {
        const ts = Math.floor(Date.now() / 1000)
        payload.timestamp = String(ts)
        payload.sign = feishuSign(ts, cfg.feishuSecret)
      }
      const a = await postJson(cfg.feishuUrl, payload)
      if (a && a.code !== undefined && a.code !== 0) throw new Error('Feishu ' + a.code + ': ' + String(a.msg ?? ''))
      sent.push('feishu')
    })().catch((e) => failed.push({ channel: 'feishu', error: String(e && e.message || e).slice(0, 160) })))
  }
  if (cfg.wecomUrl) {
    jobs.push((async () => {
      const a = await postJson(cfg.wecomUrl, { msgtype: 'text', text: { content: text } })
      if (a && a.errcode !== undefined && a.errcode !== 0) throw new Error('WeCom ' + a.errcode + ': ' + String(a.errmsg ?? ''))
      sent.push('wecom')
    })().catch((e) => failed.push({ channel: 'wecom', error: String(e && e.message || e).slice(0, 160) })))
  }
  if (cfg.genericUrl) {
    jobs.push((async () => {
      await postJson(cfg.genericUrl, { text, ...extra })
      sent.push('webhook')
    })().catch((e) => failed.push({ channel: 'webhook', error: String(e && e.message || e).slice(0, 160) })))
  }
  await Promise.allSettled(jobs)
  return { sent, failed }
}

/**
 * 一键审核链接：管理员在飞书里点一下就能确认收款，不用登录管理端。
 * 用 ADMIN_TOKEN 对 orderId 做 HMAC，链接本身就是凭证；换订单号无效。
 */
export function reviewToken(orderId, secret) {
  return crypto.createHmac('sha256', String(secret || 'no-secret')).update('paid:' + String(orderId)).digest('base64url').slice(0, 32)
}

export function reviewUrl(orderId, { secret, baseUrl }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return base + '/api/admin/orders/' + encodeURIComponent(orderId) + '/paid?t=' + reviewToken(orderId, secret)
}
// ── 运行时配置（管理端可改，覆盖 env）──────────────────────────────
/** 从 PG settings 表读通知配置；没有就回落 env。 */
export async function loadNotifyConfig(env = process.env) {
  const fromEnv = notifyChannels(env)
  try {
    const { q } = await import('./server-db.js')
    const r = await q("SELECT value FROM settings WHERE key='notify'", [], env)
    const v = r.rows[0] && r.rows[0].value
    if (!v || typeof v !== 'object') return { ...fromEnv, source: 'env' }
    return {
      feishuUrl: String(v.feishuUrl !== undefined ? v.feishuUrl : fromEnv.feishuUrl).trim(),
      feishuSecret: String(v.feishuSecret !== undefined ? v.feishuSecret : fromEnv.feishuSecret).trim(),
      wecomUrl: String(v.wecomUrl !== undefined ? v.wecomUrl : fromEnv.wecomUrl).trim(),
      genericUrl: String(v.genericUrl !== undefined ? v.genericUrl : fromEnv.genericUrl).trim(),
      ready: false, source: 'db',
    }
  } catch { return { ...fromEnv, source: 'env' } }
}

/** 保存通知配置到 PG（只存用户改过的字段）。 */
export async function saveNotifyConfig(patch, env = process.env) {
  const { q } = await import('./server-db.js')
  const cur = {}
  try {
    const r = await q("SELECT value FROM settings WHERE key='notify'", [], env)
    Object.assign(cur, (r.rows[0] && r.rows[0].value) || {})
  } catch { /* 新建 */ }
  for (const k of ['feishuUrl', 'feishuSecret', 'wecomUrl', 'genericUrl']) {
    if (patch && patch[k] !== undefined) cur[k] = String(patch[k] || '')
  }
  await q("INSERT INTO settings(key,value,updated_at) VALUES('notify',$1,now()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()", [JSON.stringify(cur)], env)
  return cur
}