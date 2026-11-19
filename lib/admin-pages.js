// 管理端三个主页面：概览 / 订单 / 用户（共用 admin-shell 的骨架）。
import { adminShell, statCards, section, esc } from './admin-shell.js'

const yuan = (fen) => ((Number(fen) || 0) / 100).toFixed(2).replace(/\.00$/, '')
const fmtT = (v) => v ? String(v).slice(0, 16).replace('T', ' ') : '—'

const statusPill = (s) => {
  const v = String(s || '')
  if (v === 'paid') return '<span class="pill ok">已付款</span>'
  if (v === 'refunded') return '<span class="pill mute">已退款</span>'
  if (v === 'created') return '<span class="pill warn">待确认</span>'
  return '<span class="pill mute">' + esc(v || '—') + '</span>'
}
const planPill = (p) => {
  const v = String(p || 'free')
  if (v === 'free') return '<span class="pill mute">免费</span>'
  return '<span class="pill blue">' + esc(v) + '</span>'
}

export function navItems({ pendingOrders = 0, users = 0 } = {}) {
  return [
    { key: 'dash', href: '/api/admin', label: '概览' },
    { key: 'orders', href: '/api/admin/orders', label: '订单', badge: pendingOrders ? String(pendingOrders) : '', badgeKind: 'warn' },
    { key: 'users', href: '/api/admin/users', label: '用户', badge: users ? String(users) : '', badgeKind: 'mute' },
  ]
}

/** 概览：关键数字 + 待确认订单 + 最近用户 */
export function dashboardPage(opts = {}) {
  const sys = opts.system || {}
  const orders = opts.recentOrders || []
  const pending = Number(opts.pendingOrders) || 0
  const users = opts.recentUsers || []
  const stats = statCards([
    { k: '待确认订单', v: pending || 0, warn: pending > 0 },
    { k: '用户', v: sys.tenants == null ? '—' : sys.tenants },
    { k: '卡片总数', v: sys.cards == null ? '—' : sys.cards },
    { k: '云端库', v: sys.vaults == null ? sys.tenants : sys.vaults },
    { k: '密钥', v: Array.isArray(opts.keys) ? opts.keys.length : 0 },
    { k: '库大小', v: sys.dbMB == null ? '—' : sys.dbMB, unit: 'MB' },
    { k: '运行', v: sys.uptime || '—' },
  ])
  const orderRows = orders.length
    ? orders.map((o) => '<tr><td><code>' + esc(String(o.id).slice(0, 14)) + '…</code></td><td>' + esc(o.owner) + '</td><td>' + esc(o.sku) + '</td><td>¥' + esc(yuan(o.price_fen)) + '</td><td>' + statusPill(o.status) + '</td><td class="muted">' + esc(fmtT(o.created_at)) + '</td></tr>').join('')
    : '<tr><td colspan="6" class="empty">还没有订单</td></tr>'
  const userRows = users.length
    ? users.map((u) => '<tr><td>' + esc(u.email) + '</td><td>' + planPill(u.plan) + '</td><td class="muted">' + esc(fmtT(u.created_at)) + '</td></tr>').join('')
    : '<tr><td colspan="3" class="empty">还没有用户</td></tr>'
  const body = stats
    + section({
      title: '待确认订单' + (pending ? ' <span class="pill warn">' + pending + '</span>' : ''),
      right: '<a href="/api/admin/orders">全部订单 →</a>',
      tight: true,
      body: '<table class="tbl"><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>状态</th><th>创建</th></tr>' + orderRows + '</table>',
    })
    + section({
      title: '最近用户',
      right: '<a href="/api/admin/users">全部用户 →</a>',
      tight: true,
      body: '<table class="tbl"><tr><th>邮箱</th><th>套餐</th><th>注册</th></tr>' + userRows + '</table>',
    })
    + section({
      title: '签发访问密钥',
      body: '<div class="toolbar"><input id="owner" type="text" placeholder="owner（用户邮箱或标识）" style="min-width:260px">'
        + '<input id="note" type="text" placeholder="备注（可选）" style="min-width:200px">'
        + '<button class="btn" id="issue" type="button">签发</button></div>'
        + '<div id="issued" class="note ok" style="display:none"></div>'
        + '<div class="sub muted" style="font-size:12px">明文只显示这一次；库里只存 sha256。</div>',
    })
  const script = '<script>'
    + 'document.getElementById("issue").addEventListener("click",async function(){'
    + 'var box=document.getElementById("issued");var owner=document.getElementById("owner").value.trim();var note=document.getElementById("note").value.trim();'
    + 'if(!owner){box.className="note err";box.style.display="block";box.textContent="owner 必填";return}'
    + 'var r=await fetch("/api/admin/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:owner,note:note})});'
    + 'var d=await r.json().catch(function(){return{}});box.style.display="block";'
    + 'if(r.ok&&d.ok){box.className="note ok";box.innerHTML="已签发：<code>"+d.token+"</code>（只显示这一次）"}else{box.className="note err";box.textContent=d.error||("HTTP "+r.status)}'
    + '});</script>'
  return adminShell({
    title: '概览', subtitle: '服务端 ' + (sys.version || '') + ' · 订单与用户总览',
    active: 'dash', nav: navItems({ pendingOrders: pending, users: sys.tenants }),
    body: body + script, version: sys.version,
    flash: opts.flash, error: opts.error,
  })
}

/** 订单页：状态筛选 + 表格 + 补单/退款 */
export function ordersPageNew(opts = {}) {
  const orders = opts.orders || []
  const st = String(opts.status || '')
  const pendingAll = Number(opts.pendingOrders) || 0
  const counts = opts.counts || {}
  const chip = (v, label, n) => '<a class="chip' + (st === v ? ' on' : '') + '" href="?status=' + v + '">' + label + (n ? ' <span class="n">' + n + '</span>' : '') + '</a>'
  const rows = orders.length
    ? orders.map((o) => {
        const s = String(o.status || '')
        const act = s === 'paid'
          ? '<button class="btn danger" data-refund="' + esc(o.id) + '" type="button" style="padding:4px 10px;font-size:12px">退款</button>'
          : s === 'created' ? '<button class="btn ok" data-pay="' + esc(o.id) + '" type="button" style="padding:4px 10px;font-size:12px">标记已付</button>' : ''
        return '<tr><td><code>' + esc(o.id) + '</code></td><td>' + esc(o.owner) + '</td><td>' + esc(o.sku) + '</td>'
          + '<td>¥' + esc(yuan(o.price_fen)) + '</td><td class="muted">' + esc(o.provider) + '</td><td>' + statusPill(s) + '</td>'
          + '<td class="muted">' + esc(fmtT(o.created_at)) + '</td><td class="muted">' + esc(fmtT(o.paid_at)) + '</td><td>' + act + '</td></tr>'
      }).join('')
    : '<tr><td colspan="9" class="empty">没有符合条件的订单</td></tr>'
  const stats = statCards([
    { k: '待确认', v: pendingAll, warn: pendingAll > 0 },
    { k: '订单总数', v: counts.total || orders.length },
    { k: '已付款', v: counts.paid || 0 },
    { k: '已退款', v: counts.refunded || 0 },
  ])
  const tool = '<div class="toolbar">' + chip('', '全部', counts.total) + chip('created', '待确认', counts.created) + chip('paid', '已付款', counts.paid) + chip('refunded', '已退款', counts.refunded)
    + '<div class="grow"></div><a class="btn ghost" href="/api/admin">刷新</a></div>'
  const body = stats + tool + section({ tight: true, body: '<table class="tbl"><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>渠道</th><th>状态</th><th>创建</th><th>付款</th><th></th></tr>' + rows + '</table>' })
  const script = '<script>'
    + 'document.querySelectorAll("[data-pay]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'if(!confirm("确认这笔订单已收到款？标记后订阅立即生效，并自动为该用户建库+生成匹配码"))return;'
    + 'b.disabled=true;var r=await fetch("/api/admin/orders/"+b.getAttribute("data-pay")+"/paid",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});'
    + 'if(r.ok)location.reload();else{b.disabled=false;alert("失败 HTTP "+r.status)}})});'
    + 'document.querySelectorAll("[data-refund]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'if(!confirm("确认整单退款？订阅会按退款重新计算"))return;'
    + 'b.disabled=true;var r=await fetch("/api/admin/orders/"+b.getAttribute("data-refund")+"/refund",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});'
    + 'if(r.ok)location.reload();else{b.disabled=false;alert("失败 HTTP "+r.status)}})});'
    + '</script>'
  return adminShell({
    title: '订单', subtitle: '收款确认、补单与退款 · 标记已付后订阅立即生效',
    active: 'orders', nav: navItems({ pendingOrders: pendingAll }),
    body: body + script, flash: opts.flash, error: opts.error,
  })
}
/** 用户页：列表 + 套餐/封禁操作 */
export function usersPageNew(opts = {}) {
  const users = opts.users || []
  const pendingAll = Number(opts.pendingOrders) || 0
  const stats = statCards([
    { k: '用户总数', v: users.length },
    { k: '已订阅', v: users.filter((u) => u.plan && u.plan !== 'free').length },
    { k: '管理员', v: users.filter((u) => String(u.role) === 'admin').length },
    { k: '已封禁', v: users.filter((u) => String(u.status) === 'disabled').length, warn: users.some((u) => String(u.status) === 'disabled') },
  ])
  const rows = users.length
    ? users.map((u) => {
        const dis = String(u.status) === 'disabled'
        return '<tr><td>' + esc(u.email) + '</td>'
          + '<td>' + planPill(u.plan) + '</td>'
          + '<td class="muted">' + esc(u.expiresAt ? String(u.expiresAt).slice(0, 10) : '—') + '</td>'
          + '<td>' + (String(u.role) === 'admin' ? '<span class="pill blue">管理员</span>' : '<span class="muted">用户</span>') + '</td>'
          + '<td>' + (dis ? '<span class="pill err">已封禁</span>' : '<span class="pill ok">正常</span>') + '</td>'
          + '<td class="muted">' + esc(fmtT(u.created_at)) + '</td>'
          + '<td style="white-space:nowrap">'
          + '<select data-plan="' + esc(u.id) + '" style="padding:4px 8px;font-size:12px">'
          + ['free', 'personal', 'pro', 'max'].map((p) => '<option value="' + p + '"' + ((u.plan || 'free') === p ? ' selected' : '') + '>' + (p === 'free' ? '免费' : p) + '</option>').join('')
          + '</select>'
          + '<button class="btn ghost" data-toggle="' + esc(u.id) + '" data-to="' + (dis ? 'active' : 'disabled') + '" type="button" style="padding:4px 10px;font-size:12px;margin-left:6px">' + (dis ? '解封' : '封禁') + '</button>'
          + '</td></tr>'
      }).join('')
    : '<tr><td colspan="7" class="empty">还没有用户</td></tr>'
  const body = stats + section({ tight: true, body: '<table class="tbl"><tr><th>邮箱</th><th>套餐</th><th>到期</th><th>角色</th><th>状态</th><th>注册</th><th>操作</th></tr>' + rows + '</table>' })
  const script = '<script>'
    + 'document.querySelectorAll("[data-plan]").forEach(function(s){s.addEventListener("change",async function(){'
    + 'var id=s.getAttribute("data-plan"),plan=s.value;'
    + 'var r=await fetch("/api/admin/users/"+id+"/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan:plan,days:30})});'
    + 'if(!r.ok)alert("设置失败 HTTP "+r.status);else location.reload()})});'
    + 'document.querySelectorAll("[data-toggle]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'var id=b.getAttribute("data-toggle"),to=b.getAttribute("data-to");'
    + 'if(!confirm((to==="disabled"?"封禁":"解封")+"这个账号？"))return;'
    + 'var r=await fetch("/api/admin/users/"+id+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:to})});'
    + 'if(r.ok)location.reload();else alert("失败 HTTP "+r.status)})});'
    + '</script>'
  return adminShell({
    title: '用户', subtitle: '套餐设置与封禁 · 套餐直接改 entitlement，不影响订单记录',
    active: 'users', nav: navItems({ pendingOrders: pendingAll, users: users.length }),
    body: body + script, flash: opts.flash, error: opts.error,
  })
}