// XorPay mock 服务：只为验收真实支付代码路径（下单验签 → 二维码 → 回调验签 → 订阅生效）。
// 生产用真 xorpay.com，这里只证明我们的签名/参数/回调处理是对的。
import http from 'node:http'
import crypto from 'node:crypto'

const PORT = Number(process.env.MOCK_PORT || 8799)
const AID = process.env.XORPAY_AID || 'mock_aid'
const SECRET = process.env.XORPAY_SECRET || 'mock_secret'
const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex').toLowerCase()
const orders = new Map()

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  // 下单：POST /api/pay/<aid>
  if (req.method === 'POST' && url.pathname.startsWith('/api/pay/')) {
    let raw = ''
    req.on('data', (c) => raw += c)
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(raw))
      const expect = md5(f.name + f.pay_type + f.price + f.order_id + f.notify_url + SECRET)
      if (String(f.sign || '').toLowerCase() !== expect) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'sign_error' }))
        return
      }
      const aoid = 'aoid_' + Math.random().toString(36).slice(2, 10)
      orders.set(f.order_id, { aoid, price: f.price, pay_type: f.pay_type, notify_url: f.notify_url })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', aoid, info: { qr: 'weixin://wxpay/bizpayurl?pr=mock-' + aoid }, expires_in: 7200 }))
      console.log('[mock] 下单 ok', f.order_id, 'aoid=', aoid, 'price=', f.price)
    })
    return
  }
  // 触发回调：GET /mock/pay?order_id=xxx   （模拟用户付款后 XorPay 通知我们）
  if (req.method === 'GET' && url.pathname === '/mock/pay') {
    const oid = String(url.searchParams.get('order_id') || '')
    const o = orders.get(oid)
    if (!o) { res.writeHead(404); res.end('unknown order'); return }
    const payTime = String(Math.floor(Date.now() / 1000))
    const sign = md5(o.aoid + oid + o.price + payTime + SECRET)
    const body = new URLSearchParams({ aoid: o.aoid, order_id: oid, pay_price: o.price, pay_time: payTime, sign }).toString()
    fetch(o.notify_url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
      .then(async (r) => {
        const t = await r.text()
        console.log('[mock] 回调', oid, '->', r.status, t)
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('notified ' + r.status + ' ' + t)
      }).catch((e) => { res.writeHead(500); res.end(String(e)) })
    return
  }
  res.writeHead(404); res.end('mock xorpay')
})
server.listen(PORT, '127.0.0.1', () => console.log('mock xorpay on ' + PORT))