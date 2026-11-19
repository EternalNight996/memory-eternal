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
  const cfg = notifyChannels(env)
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