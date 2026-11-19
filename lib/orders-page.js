// 用户侧「我的订单」页：让用户看得到自己买过什么、什么时候到期。
// 之前只有 /pay/orders 这个 JSON 接口，界面上无处可看。
import { shell } from './cloud-admin-ui.js'

const CSS = [
  '.wrap2{max-width:880px;margin:0 auto;padding:34px 20px 70px}',
  '.wrap2 h1{font-size:22px;margin:0 0 6px}',
  '.card2{background:#161b22;border:1px solid #232a33;border-radius:12px;padding:0;overflow:hidden;margin-top:16px}',
  '.tbl{width:100%;border-collapse:collapse;font-size:13px}',
  '.tbl th{text-align:left;padding:11px 14px;font-weight:500;color:#8b949e;font-size:12px;border-bottom:1px solid #232a33;background:#12171e}',
  '.tbl td{padding:11px 14px;border-bottom:1px solid #1b222b}',
  '.tbl tr:last-child td{border-bottom:0}',
  '.pill2{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11.5px}',
  '.paid{background:#3fb95022;color:#3fb950}',
  '.wait{background:#d2992222;color:#d29922}',
  '.back{background:#8b949e22;color:#8b949e}',
  '.empty{padding:40px;text-align:center;color:#8b949e;font-size:13px}',
].join('')

export function ordersListPage(opts = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const orders = Array.isArray(opts.orders) ? opts.orders : []
  const plan = opts.plan || {}
  const yuan = (fen) => ((Number(fen) || 0) / 100).toFixed(2).replace(/\.00$/, '')
  const fmt = (v) => v ? String(v).slice(0, 16).replace('T', ' ') : '—'
  const st = (s) => {
    const v = String(s || '')
    if (v === 'paid') return '<span class="pill2 paid">已付款</span>'
    if (v === 'refunded') return '<span class="pill2 back">已退款</span>'
    return '<span class="pill2 wait">待确认</span>'
  }
  const rows = orders.length
    ? orders.map((o) => '<tr><td><code style="font-size:12px">' + esc(String(o.id)) + '</code></td><td>' + esc(o.sku) + '</td><td>¥' + esc(yuan(o.price_fen)) + '</td><td>' + st(o.status) + '</td><td>' + esc(fmt(o.created_at)) + '</td><td>' + esc(fmt(o.paid_at)) + '</td></tr>').join('')
    : '<tr><td colspan="6" class="empty">还没有订单</td></tr>'
  const sub = plan && plan.plan && plan.plan !== 'free'
    ? '<div style="font-size:13px;color:#3fb950">当前套餐：' + esc(plan.plan) + ' · 到期 ' + esc(String(plan.expiresAt || '—').slice(0, 10)) + '</div>'
    : '<div style="font-size:13px;color:#8b949e">当前未订阅</div>'
  const body = [
    '<style>' + CSS + '</style>',
    '<div class="wrap2">',
    '<div style="display:flex;justify-content:space-between;align-items:flex-start">',
    '<div><h1>我的订单</h1>' + sub + '</div>',
    '<div style="display:flex;gap:14px;font-size:13px"><a href="/api/console">控制台</a><a href="/api/pay">订阅</a></div>',
    '</div>',
    '<div class="card2"><table class="tbl">',
    '<tr><th>订单号</th><th>套餐</th><th>金额</th><th>状态</th><th>创建</th><th>付款</th></tr>',
    rows, '</table></div>',
    '<div style="margin-top:14px;font-size:12px;color:#8b949e">待确认的订单：付完款后由管理员确认收款，确认后订阅立即生效。提前续费会累加到现有到期日之后。</div>',
    '</div>',
  ].join('')
  return shell('记忆云 · 我的订单', body)
}