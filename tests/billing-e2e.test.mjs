// 支付链路端到端：真起 HTTP，跑通
//   登录（假 IdP）→ 拿到 access_token → POST /cloud/billing/checkout → 拿到支付页
//   → 模拟 MengBot 支付成功推 webhook → GET /cloud/billing/plan 变成 pro
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { startFakeIdp } from './fixtures/fake-idp.mjs'
import { createCloudServer } from '../lib/cloud-server.js'
import { storeAccessToken } from '../lib/oidc.js'

const CLIENT_ID = 'memory-eternal-cloud'
const CLIENT_SECRET = 'fake-secret'
const USER = { sub: 'u_1', email: 'yg@example.com', name: 'YG' }

async function startOurCloud(env) {
  const handler = createCloudServer({ env })
  const srv = http.createServer(async (req, res) => {
    const handled = await handler(req, res)
    if (!handled) { res.writeHead(404); res.end('not cloud') }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }
}

test('支付闭环：登录 → 下单拿支付页 → webhook 回推 → 套餐变 pro', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-pay-e2e-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  const idp = await startFakeIdp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: USER })

  // 假 MengBot 云端 API：checkout 返回支付页
  const paid = []
  const api = http.createServer((req, res) => {
    if (req.url === '/api/cloud/desktop/checkout') {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        paid.push({ auth: req.headers.authorization, body: b })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ checkoutUrl: 'https://pay.mengbot.com.cn/c/e2e' }))
      })
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => api.listen(0, '127.0.0.1', r))
  const apiBase = `http://127.0.0.1:${api.address().port}`

  const env = {
    DSH_HOME: home,
    MEMORY_CLOUD: '1',
    MEMORY_OIDC_ISSUER: idp.base,
    MEMORY_OIDC_CLIENT_ID: CLIENT_ID,
    MEMORY_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    MEMORY_OIDC_REDIRECT_URI: 'http://127.0.0.1:9/cb',
    MEMORY_CLOUD_PUBLIC_URL: 'http://127.0.0.1:9',
    MEMORY_MENGBOT_API_BASE: apiBase,
    MEMORY_WEBHOOK_SECRET: 'whsec_e2e',
    MEMORY_CLOUD_ADMIN_TOKEN: 'adm_e2e',
  }
  const cloud = await startOurCloud(env)
  try {
    // ① 先签一把租户密钥（走管理面），拿它访问 billing
    const keyRes = await fetch(`${cloud.base}/memory-eternal/api/cloud/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer adm_e2e' },
      body: JSON.stringify({ owner: USER.email }),
    })
    assert.equal(keyRes.status, 200)
    const { token: tenantToken } = await keyRes.json()
    assert.ok(tenantToken.startsWith('me_'))

    // ② 给这个 owner 预置 access_token（等价于「他刚用 OIDC 登录过」）
    storeAccessToken(USER.email, { accessToken: 'at_live', expiresIn: 3600 }, env)

    // ③ 下单
    const co = await fetch(`${cloud.base}/memory-eternal/api/cloud/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tenantToken },
      body: JSON.stringify({ plan: 'pro', source: 'memory-eternal-cloud' }),
    })
    assert.equal(co.status, 200)
    const coBody = await co.json()
    assert.equal(coBody.url, 'https://pay.mengbot.com.cn/c/e2e')
    assert.equal(paid.length, 1, '应真的调了 MengBot checkout')
    assert.equal(paid[0].auth, 'Bearer at_live')

    // ④ 下单前：free
    const before = await (await fetch(`${cloud.base}/memory-eternal/api/cloud/billing/plan`, { headers: { Authorization: 'Bearer ' + tenantToken } })).json()
    assert.equal(before.plan.plan, 'free')

    // ⑤ MengBot 支付成功 → 推 webhook
    const payload = JSON.stringify({
      id: 'evt_pay_1', event: 'entitlement.updated', account: USER.email,
      plan: 'pro', status: 'active', version: 1,
      expiresAt: new Date(Date.now() + 86400000 * 365).toISOString(), caps: { seats: 3 },
    })
    const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec_e2e').update(payload, 'utf8').digest('hex')
    const wh = await fetch(`${cloud.base}/memory-eternal/api/cloud/webhook/mengbot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MengBot-Signature': sig, 'X-MengBot-Event': 'entitlement.updated', 'X-MengBot-Event-Id': 'evt_pay_1' },
      body: payload,
    })
    assert.equal(wh.status, 200)
    assert.equal((await wh.json()).applied, true)

    // ⑥ 下单后：pro（同一个租户令牌，服务端重启也不用动）
    const after = await (await fetch(`${cloud.base}/memory-eternal/api/cloud/billing/plan`, { headers: { Authorization: 'Bearer ' + tenantToken } })).json()
    assert.equal(after.plan.plan, 'pro', 'webhook 后套餐应立刻生效')
    assert.equal(after.plan.status, 'active')
    assert.equal(after.plan.caps.seats, 3)

    // ⑦ 业务接口的写权限也随套餐走（warn 策略下都允许，这里只验证接口可用）
    const ov = await fetch(`${cloud.base}/memory-eternal/api/overview`, { headers: { Authorization: 'Bearer ' + tenantToken } })
    assert.equal(ov.status, 200)
  } finally {
    await cloud.close()
    await new Promise((r) => api.close(r))
    await idp.close()
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})
