// 通知渠道：全套照搬 MengBot 的 server/pay/notify.ts。
//
// 七个渠道：飞书 / 企业微信 / 钉钉 / PushPlus / Telegram / QQ（qmsg 或官方 bot）/ 邮件。
// 设计取舍：**每个渠道独立 catch**，一个坏不影响其它；通知失败绝不影响下单。
import crypto from 'node:crypto'

/** 飞书自定义机器人签名 */
export function feishuSign(timestamp, secret) {
  return crypto.createHmac('sha256', String(timestamp) + '\n' + secret).update('').digest('base64')
}

async function postJson(url, body, timeoutMs = 10000) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  })
  const answer = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(answer.message ?? answer.msg ?? ''))
  return answer
}

/** 渠道清单（页面下拉用） */
export const CHANNELS = [
  { key: 'feishu', name: '飞书机器人', fields: [
    { k: 'url', label: 'Webhook 地址', ph: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
    { k: 'secret', label: '签名密钥（可选）', ph: '开了「签名校验」才需要填', secret: true },
  ] },
  { key: 'wecom', name: '企业微信机器人', fields: [
    { k: 'url', label: 'Webhook 地址', ph: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' },
  ] },
  { key: 'dingtalk', name: '钉钉机器人', fields: [
    { k: 'url', label: 'Webhook 地址', ph: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
  ] },
  { key: 'pushplus', name: 'PushPlus（微信推送）', fields: [
    { k: 'token', label: 'Token', ph: 'pushplus.plus 个人 token', secret: true },
  ] },
  { key: 'telegram', name: 'Telegram', fields: [
    { k: 'botToken', label: 'Bot Token', ph: '123456:ABC-…', secret: true },
    { k: 'chatId', label: 'Chat ID', ph: '群或用户 id，如 -1001234567890' },
  ] },
  { key: 'qq', name: 'QQ（Qmsg 酱 / 官方 bot）', fields: [
    { k: 'mode', label: '模式', ph: 'qmsg 或 official', options: ['qmsg', 'official'] },
    { k: 'key', label: 'Qmsg 酱 Key（qmsg 模式）', ph: 'qmsg.zendee.cn 的 key', secret: true },
    { k: 'qq', label: '接收 QQ 号（可选）', ph: '不填则推给 Key 绑定的人' },
    { k: 'appId', label: '官方 Bot AppID（official 模式）', ph: '' },
    { k: 'secret', label: '官方 Bot Secret', ph: '', secret: true },
    { k: 'groupOpenId', label: '群 OpenID', ph: '' },
  ] },
  { key: 'email', name: '邮件（SMTP）', fields: [
    { k: 'host', label: 'SMTP 主机', ph: 'smtp.163.com' },
    { k: 'port', label: '端口', ph: '465' },
    { k: 'secure', label: 'SSL（465 一般开）', ph: 'true / false', options: ['true', 'false'] },
    { k: 'user', label: '账号', ph: 'xxx@163.com' },
    { k: 'pass', label: '授权码/密码', ph: '', secret: true },
    { k: 'from', label: '发件人（可选）', ph: '默认同账号' },
    { k: 'to', label: '收件人', ph: '收通知的邮箱' },
  ] },
]

const DEFAULT_CFG = {
  feishu: { enabled: false, url: '', secret: '' },
  wecom: { enabled: false, url: '' },
  dingtalk: { enabled: false, url: '' },
  pushplus: { enabled: false, token: '' },
  telegram: { enabled: false, botToken: '', chatId: '' },
  qq: { enabled: false, mode: 'qmsg', key: '', qq: '', appId: '', secret: '', groupOpenId: '' },
  email: { enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '' },
}

/** env 里的默认值（兼容之前只配了 FEISHU_* 的部署） */
export function notifyChannels(env = process.env) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CFG))
  const fu = String(env.FEISHU_WEBHOOK_URL || '').trim()
  if (fu) { cfg.feishu.enabled = true; cfg.feishu.url = fu; cfg.feishu.secret = String(env.FEISHU_WEBHOOK_SECRET || '').trim() }
  const wu = String(env.WECOM_WEBHOOK_URL || '').trim()
  if (wu) { cfg.wecom.enabled = true; cfg.wecom.url = wu }
  const gu = String(env.NOTIFY_WEBHOOK_URL || '').trim()
  if (gu) { cfg.generic = { enabled: true, url: gu } }
  return cfg
}

export async function loadNotifyConfig(env = process.env) {
  const base = notifyChannels(env)
  try {
    const { q } = await import('./server-db.js')
    const r = await q("SELECT value FROM settings WHERE key='notify'", [], env)
    const v = r.rows[0] && r.rows[0].value
    if (!v || typeof v !== 'object') return { cfg: base, source: 'env' }
    const merged = JSON.parse(JSON.stringify(base))
    for (const ch of Object.keys(DEFAULT_CFG)) {
      if (v[ch] && typeof v[ch] === 'object') merged[ch] = { ...merged[ch], ...v[ch] }
    }
    if (v.generic && typeof v.generic === 'object') merged.generic = { ...(merged.generic || {}), ...v.generic }
    return { cfg: merged, source: 'db' }
  } catch { return { cfg: base, source: 'env' } }
}

export async function saveNotifyConfig(patch, env = process.env) {
  const { q } = await import('./server-db.js')
  let cur = {}
  try {
    const r = await q("SELECT value FROM settings WHERE key='notify'", [], env)
    cur = (r.rows[0] && r.rows[0].value) || {}
  } catch { cur = {} }
  for (const ch of Object.keys(DEFAULT_CFG)) {
    if (patch && patch[ch] && typeof patch[ch] === 'object') {
      cur[ch] = { ...(cur[ch] || {}), ...patch[ch] }
    }
  }
  if (patch && patch.generic) cur.generic = { ...(cur.generic || {}), ...patch.generic }
  await q("INSERT INTO settings(key,value,updated_at) VALUES('notify',$1,now()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()", [JSON.stringify(cur)], env)
  return cur
}
// ── 各渠道发送（照搬 MengBot 的报文格式与校验）──────────────────

async function sendFeishu(c, text) {
  if (!c.url) throw new Error('缺少 Webhook 地址')
  const payload = { msg_type: 'text', content: { text } }
  if (c.secret) {
    const ts = Math.floor(Date.now() / 1000)
    payload.timestamp = String(ts)
    payload.sign = feishuSign(ts, c.secret)
  }
  const a = await postJson(c.url, payload)
  if (a && a.code !== undefined && a.code !== 0) throw new Error('Feishu ' + a.code + ': ' + String(a.msg ?? ''))
}

async function sendWecom(c, text) {
  if (!c.url) throw new Error('缺少 Webhook 地址')
  const a = await postJson(c.url, { msgtype: 'text', text: { content: text } })
  if (a && a.errcode !== undefined && a.errcode !== 0) throw new Error('WeCom ' + a.errcode + ': ' + String(a.errmsg ?? ''))
}

async function sendDingtalk(c, text) {
  if (!c.url) throw new Error('缺少 Webhook 地址')
  const a = await postJson(c.url, { msgtype: 'text', text: { content: text } })
  if (a && a.errcode !== undefined && a.errcode !== 0) throw new Error('DingTalk ' + a.errcode + ': ' + String(a.errmsg ?? ''))
}

async function sendPushplus(c, text) {
  if (!c.token) throw new Error('缺少 Token')
  const a = await postJson('https://www.pushplus.plus/send', { token: c.token, title: '记忆云 · 通知', content: text, template: 'txt' })
  if (a && a.code !== 200) throw new Error('PushPlus: ' + String(a.msg ?? a.code))
}

async function sendTelegram(c, text) {
  if (!c.botToken || !c.chatId) throw new Error('缺少 Bot Token 或 Chat ID')
  const a = await postJson('https://api.telegram.org/bot' + c.botToken + '/sendMessage', { chat_id: c.chatId, text, disable_web_page_preview: true })
  if (!a || a.ok !== true) throw new Error('Telegram: ' + String((a && a.description) || 'failed'))
}

async function sendQq(c, text) {
  const mode = String(c.mode || 'qmsg')
  if (mode === 'qmsg') {
    if (!c.key) throw new Error('缺少 Qmsg 酱 Key')
    const r = await fetch('https://qmsg.zendee.cn/send/' + encodeURIComponent(c.key), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ msg: text, ...(c.qq ? { qq: c.qq } : {}) }).toString(),
      signal: AbortSignal.timeout(10000),
    })
    const a = await r.json().catch(() => ({}))
    if (!r.ok || a.success === false) throw new Error('Qmsg: ' + String(a.reason ?? 'HTTP ' + r.status))
    return
  }
  if (!c.appId || !c.secret) throw new Error('缺少官方 Bot AppID / Secret')
  const tr = await postJson('https://bots.qq.com/app/getAppAccessToken', { appId: c.appId, clientSecret: c.secret })
  if (!tr || !tr.access_token) throw new Error('获取 access_token 失败：' + String((tr && tr.message) || 'HTTP'))
  if (!c.groupOpenId) throw new Error('缺少群 OpenID')
  const sr = await fetch('https://api.sgroup.qq.com/v2/groups/' + encodeURIComponent(c.groupOpenId) + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'QQBot ' + tr.access_token },
    body: JSON.stringify({ content: text.slice(0, 1800), msg_type: 0 }),
    signal: AbortSignal.timeout(10000),
  })
  if (!sr.ok) throw new Error('QQ 官方发送失败 HTTP ' + sr.status)
}

async function sendEmail(c, text, subject) {
  if (!c.host || !c.to) throw new Error('缺少 SMTP 主机或收件人')
  let nodemailer
  try { nodemailer = (await import('nodemailer')).default }
  catch { throw new Error('邮件渠道需要 nodemailer（npm i nodemailer）') }
  const transport = nodemailer.createTransport({
    host: c.host, port: Number(c.port) || 465,
    secure: String(c.secure) === 'true' || c.secure === true,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  })
  await transport.sendMail({ from: c.from || c.user, to: c.to, subject: subject || '记忆云 · 通知', text })
}

/**
 * 推送到所有**已启用且有配置**的渠道。永不抛错。
 * @returns {{sent:string[], failed:{channel:string,error:string}[], skipped?:boolean}}
 */
export async function sendNotify(env, text, extra = {}) {
  const { cfg } = await loadNotifyConfig(env)
  const sent = []
  const failed = []
  const jobs = []
  const only = String((extra && extra.only) || '').trim()  // 测试单渠道用
  const tryOne = (key, name, fn) => {
    const c = cfg[key]
    if (!c || !c.enabled) return
    if (only && only !== key) return
    jobs.push(Promise.resolve().then(() => fn(c, text)).then(() => sent.push(key)).catch((e) => failed.push({ channel: key, error: String((e && e.message) || e).slice(0, 160) })))
  }
  tryOne('feishu', '飞书', sendFeishu)
  tryOne('wecom', '企业微信', sendWecom)
  tryOne('dingtalk', '钉钉', sendDingtalk)
  tryOne('pushplus', 'PushPlus', sendPushplus)
  tryOne('telegram', 'Telegram', sendTelegram)
  tryOne('qq', 'QQ', sendQq)
  tryOne('email', '邮件', (c, t) => sendEmail(c, t, extra.title))
  await Promise.allSettled(jobs)
  return { sent, failed, skipped: jobs.length === 0 }
}
// ── 一键审核链接（发给管理员的，点开即确认收款）──────────────────
/** 用 ADMIN_TOKEN 对 orderId 做 HMAC，链接本身就是凭证；换订单号无效。 */
export function reviewToken(orderId, secret) {
  return crypto.createHmac('sha256', String(secret || 'no-secret')).update('paid:' + String(orderId)).digest('base64url').slice(0, 32)
}

export function reviewUrl(orderId, { secret, baseUrl } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return base + '/api/admin/orders/' + encodeURIComponent(orderId) + '/paid?t=' + reviewToken(orderId, secret)
}