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
    { key: 'keys', href: '/api/admin/keys', label: '访问密钥' },
    { key: 'audit', href: '/api/admin/audit', label: '审计日志' },
    { key: 'payment', href: '/api/admin/payment', label: '支付' },
    { key: 'notify', href: '/api/admin/notify', label: '通知配置' },
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
/** 用户页（合并了租户与管理员）：一个列表搞定角色、套餐、封禁与数据规模 */
export function usersPageNew(opts = {}) {
  const users = opts.users || []
  const pendingAll = Number(opts.pendingOrders) || 0
  const stats = statCards([
    { k: '用户', v: users.length },
    { k: '管理员', v: users.filter((u) => String(u.role) === 'admin').length },
    { k: '已订阅', v: users.filter((u) => u.plan && u.plan !== 'free').length },
    { k: '已封禁', v: users.filter((u) => String(u.status) === 'disabled').length, warn: users.some((u) => String(u.status) === 'disabled') },
  ])
  const roleSel = (u) => '<select data-role="' + esc(u.id) + '" style="padding:4px 8px;font-size:12px">'
    + ['user', 'admin'].map((r) => '<option value="' + r + '"' + (String(u.role) === r ? ' selected' : '') + '>' + (r === 'admin' ? '管理员' : '用户') + '</option>')
    + '</select>'
  const planSel = (u) => '<select data-plan="' + esc(u.id) + '" style="padding:4px 8px;font-size:12px">'
    + ['free', 'personal', 'pro', 'max'].map((p) => '<option value="' + p + '"' + ((u.plan || 'free') === p ? ' selected' : '') + '>' + (p === 'free' ? '免费' : p === 'personal' ? '个人版' : p === 'pro' ? '团队版' : '旗舰版') + '</option>')
    + '</select>'
  const statusSel = (u) => {
    const dis = String(u.status) === 'disabled'
    return '<select data-status="' + esc(u.id) + '" style="padding:4px 8px;font-size:12px">'
      + '<option value="active"' + (dis ? '' : ' selected') + '>正常</option>'
      + '<option value="disabled"' + (dis ? ' selected' : '') + '>已封禁</option>'
      + '</select>'
  }
  const rows = users.length
    ? users.map((u) => {
        const dis = String(u.status) === 'disabled'
        return '<tr data-row="' + esc(u.id) + '"><td>' + esc(u.email) + '</td>'
          + '<td>' + roleSel(u) + '</td>'
          + '<td>' + planSel(u) + '</td>'
          + '<td>' + statusSel(u) + '</td>'
          + '<td class="muted">' + esc(u.expiresAt ? String(u.expiresAt).slice(0, 10) : '—') + '</td>'
          + '<td class="muted">' + esc(u.cards == null ? '—' : u.cards) + '</td>'
          + '<td class="muted">' + esc(u.vaults == null ? '—' : u.vaults) + '</td>'
          + '<td class="muted">' + esc(fmtT(u.created_at)) + '</td>'
          + '<td class="muted" data-dirty="' + esc(u.id) + '"></td></tr>'
      }).join('')
    : '<tr><td colspan="9" class="empty">还没有用户</td></tr>'
  const savebar = '<div class="savebar" id="savebar">'
    + '<div class="sb-info"><b id="sbcount">0</b> 处未保存修改</div>'
    + '<div class="sb-acts">'
    + '<button class="btn ghost" type="button" id="sbreset">撤销</button>'
    + '<button class="btn" type="button" id="sbsave" disabled>保存全部更改</button>'
    + '</div></div>'
  const body = stats + section({
    title: '全部用户 <span class="pill mute">角色 · 套餐 · 状态</span>',
    right: '<span style="font-size:12px;color:#8b949e">改完点底部「保存全部更改」统一提交</span>',
    tight: true,
    body: '<table class="tbl"><tr><th>邮箱</th><th>角色</th><th>套餐</th><th>状态</th><th>到期</th><th>卡片</th><th>库</th><th>注册</th><th></th></tr>' + rows + '</table>',
  })
  const style = '<style>'
    + '.savebar{position:sticky;bottom:0;display:flex;justify-content:space-between;align-items:center;gap:16px;'
    + 'background:#0f141a;border:1px solid #1b2432;border-radius:10px;padding:12px 16px;margin-top:14px;'
    + 'box-shadow:0 -6px 20px rgba(0,0,0,.35);z-index:20}'
    + '.sb-info{font-size:13px;color:#8b949e}.sb-info b{color:#e6e9ef;font-size:15px;margin-right:4px}'
    + '.sb-acts{display:flex;gap:10px}'
    + 'tr.dirty td{background:rgba(210,153,34,.06)}'
    + 'td[data-dirty]::after{content:attr(data-mark);color:#d29922;font-size:11px}'
    + '</style>'
  const script = '<script>'
    + '(function(){'
    + 'var dirty={};'
    + 'function refresh(){'
    + 'var n=Object.keys(dirty).length;'
    + 'var c=document.getElementById("sbcount"),b=document.getElementById("sbsave");'
    + 'if(c)c.textContent=n;if(b)b.disabled=n===0;'
    + '}'
    + 'document.querySelectorAll("[data-row]").forEach(function(tr){'
    + 'var id=tr.getAttribute("data-row");'
    + 'tr.querySelectorAll("select").forEach(function(s){'
    + 's.dataset.orig=s.value;'
    + 's.addEventListener("change",function(){'
    + 'var changed=false;'
    + 'tr.querySelectorAll("select").forEach(function(x){if(x.value!==x.dataset.orig)changed=true;});'
    + 'if(changed){dirty[id]=true;tr.classList.add("dirty");}else{delete dirty[id];tr.classList.remove("dirty");}'
    + 'refresh();'
    + '});'
    + '});'
    + '});'
    + 'var rb=document.getElementById("sbreset");'
    + 'if(rb)rb.addEventListener("click",function(){'
    + 'document.querySelectorAll("[data-row]").forEach(function(tr){'
    + 'tr.querySelectorAll("select").forEach(function(s){if(s.dataset.orig!==undefined)s.value=s.dataset.orig;});'
    + 'tr.classList.remove("dirty");'
    + '});'
    + 'dirty={};refresh();'
    + '});'
    + 'var sb=document.getElementById("sbsave");'
    + 'if(sb)sb.addEventListener("click",async function(){'
    + 'var ids=Object.keys(dirty);if(!ids.length)return;'
    + 'sb.disabled=true;sb.textContent="保存中…";'
    + 'var fails=[];'
    + 'for(var i=0;i<ids.length;i++){'
    + 'var id=ids[i];var tr=document.querySelector("[data-row=\\"" + id + "\\"]");if(!tr)continue;'
    + 'var r=tr.querySelector("[data-role]"),p=tr.querySelector("[data-plan]"),st=tr.querySelector("[data-status]");'
    + 'async function post(u,b){var x=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return x.ok;}'
    + 'try{'
    + 'if(r&&r.value!==r.dataset.orig){if(!await post("/api/admin/users/"+id+"/role",{role:r.value}))fails.push(tr.children[0].textContent+": 角色");}'
    + 'if(p&&p.value!==p.dataset.orig){if(!await post("/api/admin/users/"+id+"/plan",{plan:p.value,days:p.value==="free"?0:30}))fails.push(tr.children[0].textContent+": 套餐");}'
    + 'if(st&&st.value!==st.dataset.orig){if(!await post("/api/admin/users/"+id+"/status",{status:st.value}))fails.push(tr.children[0].textContent+": 状态");}'
    + '}catch(e){fails.push(tr.children[0].textContent+": "+e.message);}'
    + '}'
    + 'if(fails.length){alert("有 "+fails.length+" 项失败：\n"+fails.join("\n"));sb.disabled=false;sb.textContent="保存全部更改";}'
    + 'else{location.reload();}'
    + '});'
    + '})();'
    + '</script>'
  return adminShell({
    title: '用户', subtitle: '角色 · 套餐 · 状态 —— 改完统一保存',
    active: 'users', nav: navItems({ pendingOrders: pendingAll, users: users.length }),
    body: body + style + savebar + script, flash: opts.flash, error: opts.error,
  })
}
/** 访问密钥页 */
export function keysPageNew(opts = {}) {
  const keys = opts.keys || []
  const pendingAll = Number(opts.pendingOrders) || 0
  const stats = statCards([
    { k: '密钥总数', v: keys.length },
    { k: '已吊销', v: keys.filter((k) => k.revokedAt || k.revoked_at).length },
    { k: '最近 7 天使用', v: keys.filter((k) => k.lastUsedAt && Date.now() - new Date(k.lastUsedAt).getTime() < 7 * 864e5).length },
  ])
  const rows = keys.length
    ? keys.map((k) => {
        const rev = k.revokedAt || k.revoked_at
        return '<tr><td><code>' + esc(String(k.id).slice(0, 16)) + '…</code></td><td>' + esc(k.owner || '—') + '</td>'
          + '<td class="muted">' + esc(k.note || '—') + '</td>'
          + '<td class="muted">' + esc(fmtT(k.createdAt || k.created_at)) + '</td>'
          + '<td>' + (rev ? '<span class="pill err">已吊销</span>' : '<span class="pill ok">有效</span>') + '</td>'
          + '<td>' + (rev ? '' : '<button class="btn danger" data-revoke="' + esc(k.id) + '" type="button" style="padding:4px 10px;font-size:12px">吊销</button>') + '</td></tr>'
      }).join('')
    : '<tr><td colspan="6" class="empty">还没有访问密钥</td></tr>'
  const body = stats
    + section({ title: '签发新密钥', body: '<div class="toolbar"><input id="kowner" type="text" placeholder="owner（用户邮箱或标识）" style="min-width:260px"><input id="knote" type="text" placeholder="备注（可选）" style="min-width:200px"><button class="btn" id="kissue" type="button">签发</button></div><div id="kissued" class="note ok" style="display:none"></div><div style="font-size:12px;color:#8b949e">明文只显示这一次；库里只存 sha256。</div>' })
    + section({ title: '全部密钥', tight: true, body: '<table class="tbl"><tr><th>id</th><th>owner</th><th>备注</th><th>创建</th><th>状态</th><th></th></tr>' + rows + '</table>' })
  const script = '<script>'
    + 'document.getElementById("kissue").addEventListener("click",async function(){'
    + 'var box=document.getElementById("kissued");var owner=document.getElementById("kowner").value.trim();var note=document.getElementById("knote").value.trim();'
    + 'if(!owner){box.className="note err";box.style.display="block";box.textContent="owner 必填";return}'
    + 'var r=await fetch("/api/admin/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:owner,note:note})});'
    + 'var d=await r.json().catch(function(){return{}});box.style.display="block";'
    + 'if(r.ok&&d.ok){box.className="note ok";box.innerHTML="已签发：<code>"+d.token+"</code>（只显示这一次）"}else{box.className="note err";box.textContent=d.error||("HTTP "+r.status)}'
    + '});'
    + 'document.querySelectorAll("[data-revoke]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'if(!confirm("吊销这把密钥？调用方会立刻 401"))return;'
    + 'var r=await fetch("/api/admin/keys/"+b.getAttribute("data-revoke")+"/revoke",{method:"POST"});'
    + 'if(r.ok)location.reload();else alert("失败 HTTP "+r.status)})});'
    + '</script>'
  return adminShell({ title: '访问密钥', subtitle: '给第三方/脚本用的 me_ 令牌 · 库里只存 sha256', active: 'keys', nav: navItems({ pendingOrders: pendingAll }), body: body + script })
}

/** 租户页：每个 owner 的库与卡片 */
export function tenantsPageNew(opts = {}) {
  const tenants = opts.tenants || []
  const pendingAll = Number(opts.pendingOrders) || 0
  const totalCards = tenants.reduce((a, t) => a + (Number(t.cards) || 0), 0)
  const stats = statCards([
    { k: '租户', v: tenants.length },
    { k: '卡片总数', v: totalCards },
    { k: '已订阅', v: tenants.filter((t) => t.plan && t.plan !== 'free').length },
  ])
  const rows = tenants.length
    ? tenants.map((t) => '<tr><td>' + esc(t.owner) + '</td><td>' + planPill(t.plan) + '</td>'
      + '<td class="muted">' + esc(t.expiresAt || '—') + '</td>'
      + '<td>' + esc(t.cards == null ? '—' : t.cards) + '</td>'
      + '<td>' + esc(t.vaults == null ? '—' : t.vaults) + '</td></tr>').join('')
    : '<tr><td colspan="5" class="empty">还没有租户</td></tr>'
  const body = stats + section({ tight: true, body: '<table class="tbl"><tr><th>owner</th><th>套餐</th><th>到期</th><th>卡片</th><th>云端库</th></tr>' + rows + '</table>' })
  return adminShell({ title: '租户', subtitle: '每个用户的云端数据规模', active: 'tenants', nav: navItems({ pendingOrders: pendingAll }), body })
}

/** 审计日志页 */
export function auditPageNew(opts = {}) {
  const logs = opts.logs || []
  const pendingAll = Number(opts.pendingOrders) || 0
  const rows = logs.length
    ? logs.map((l) => '<tr><td class="muted">' + esc(fmtT(l.created_at || l.at)) + '</td><td>' + esc(l.actor || '—') + '</td>'
      + '<td><code>' + esc(l.action || '') + '</code></td><td class="muted">' + esc(l.target || '—') + '</td>'
      + '<td class="muted">' + esc(l.ip || '—') + '</td></tr>').join('')
    : '<tr><td colspan="5" class="empty">还没有审计记录</td></tr>'
  const body = section({ tight: true, body: '<table class="tbl"><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>IP</th></tr>' + rows + '</table>' })
  return adminShell({ title: '审计日志', subtitle: '登录、下单、补单、退款、密钥签发等关键动作', active: 'audit', nav: navItems({ pendingOrders: pendingAll }), body })
}
/** 通知配置页：下拉选渠道 → 动态字段 → 保存 / 测试 */
export function notifyPage(opts = {}) {
  const cfg = opts.cfg || {}
  const channels = opts.channels || []
  const pendingAll = Number(opts.pendingOrders) || 0
  const src = opts.source === 'db' ? '管理端配置' : '环境变量'
  // 渠道下拉
  const select = '<select id="ch" style="min-width:240px;padding:9px 12px;font-size:13.5px">'
    + channels.map((c) => '<option value="' + esc(c.key) + '"' + (c.enabled ? ' data-on="1"' : '') + '>' + esc(c.name) + (c.enabled ? ' ✓' : '') + '</option>').join('')
    + '</select>'
  // 每个渠道的面板（一次全渲染，切换显示）
  const panels = channels.map((c) => {
    const v = cfg[c.key] || {}
    const fields = (c.fields || []).map((f) => {
      const val = v[f.k] == null ? '' : String(v[f.k])
      let input
      if (f.options) {
        input = '<select id="f-' + c.key + '-' + f.k + '" style="width:100%;max-width:560px">'
          + f.options.map((o) => '<option value="' + esc(o) + '"' + (String(val) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>').join('')
          + '</select>'
      } else {
        input = '<input id="f-' + c.key + '-' + f.k + '" type="' + (f.secret ? 'password' : 'text') + '" value="' + esc(val) + '" placeholder="' + esc(f.ph || '') + '" style="width:100%;max-width:560px">'
      }
      return '<div style="margin-bottom:12px"><label style="display:block;font-size:12.5px;color:#8b949e;margin-bottom:5px">' + esc(f.label) + '</label>' + input + '</div>'
    }).join('')
    return '<div class="chpanel" data-ch="' + esc(c.key) + '" style="display:none">'
      + '<div class="toolbar" style="margin-bottom:14px">'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">'
      + '<input type="checkbox" id="en-' + c.key + '"' + (v.enabled ? ' checked' : '') + ' style="width:16px;height:16px"> 启用这个渠道</label>'
      + '</div>' + fields
      + '<div class="toolbar"><button class="btn" data-save="' + esc(c.key) + '" type="button">保存</button>'
      + '<button class="btn ghost" data-test="' + esc(c.key) + '" type="button">发送测试</button>'
      + '<span class="cmsg" data-msg="' + esc(c.key) + '" style="font-size:12.5px"></span></div>'
      + '</div>'
  }).join('')
  const body = section({
    title: '通知渠道 <span class="pill ' + (opts.source === 'db' ? 'blue' : 'mute') + '">' + esc(src) + '</span>',
    right: '<span style="font-size:12px;color:#8b949e">保存后立即生效，不用重启</span>',
    body: '<div class="toolbar" style="margin-bottom:16px"><span style="font-size:12.5px;color:#8b949e">选择渠道</span>' + select + '</div>' + panels,
  })
  // 序列化渠道定义给前端
  const defs = JSON.stringify(channels.map((c) => ({ key: c.key, fields: (c.fields || []).map((f) => f.k) })))
  const script = '<script>'
    + 'var DEFS=' + defs + ';'
    + 'var sel=document.getElementById("ch");'
    + 'function showCh(k){document.querySelectorAll(".chpanel").forEach(function(p){p.style.display=(p.getAttribute("data-ch")===k)?"block":"none"})}'
    + 'sel.addEventListener("change",function(){showCh(sel.value)});'
    + 'showCh(sel.value);'
    + 'function collect(k){'
    + 'var d=DEFS.filter(function(x){return x.key===k})[0];if(!d)return {};'
    + 'var o={enabled:document.getElementById("en-"+k).checked};'
    + 'd.fields.forEach(function(f){var el=document.getElementById("f-"+k+"-"+f);if(el)o[f]=el.value.trim()});'
    + 'return o}'
    + 'document.querySelectorAll("[data-save]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'var k=b.getAttribute("data-save"),msg=document.querySelector("[data-msg=\'"+k+"\']");'
    + 'var body={};body[k]=collect(k);'
    + 'var r=await fetch("/api/admin/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});'
    + 'var d=await r.json().catch(function(){return{}});'
    + 'msg.style.color=r.ok?"#3fb950":"#e5534b";msg.textContent=r.ok?"已保存（立即生效）":(d.error||("HTTP "+r.status));'
    + 'if(r.ok)setTimeout(function(){location.reload()},500);'
    + '})});'
    + 'document.querySelectorAll("[data-test]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'var k=b.getAttribute("data-test"),msg=document.querySelector("[data-msg=\'"+k+"\']");'
    + 'msg.style.color="#8b949e";msg.textContent="发送中…";'
    + 'var r=await fetch("/api/admin/notify/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({channel:k})});'
    + 'var d=await r.json().catch(function(){return{}});'
    + 'if(r.ok&&d.sent&&d.sent.length){msg.style.color="#3fb950";msg.textContent="已发送"}'
    + 'else{msg.style.color="#e5534b";msg.textContent="失败："+JSON.stringify((d.failed&&d.failed[0]&&d.failed[0].error)||d.error||d)}'
    + '})});'
    + '</script>'
  return adminShell({ title: '通知', subtitle: '七个渠道任选：飞书 / 企微 / 钉钉 / PushPlus / Telegram / QQ / 邮件', active: 'notify', nav: navItems({ pendingOrders: pendingAll }), body: body + script })
}

const QR_BOX = 'width:220px;height:210px;border:1.5px dashed #2a323d;border-radius:12px;padding:10px;text-align:center;cursor:pointer;transition:.15s;background:#0b0f14;display:flex;flex-direction:column;flex:none'

/** 单个拖拽上传框 */
function qrBox(kind, label, url) {
  const preview = url
    ? '<img src="' + esc(url) + '" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:8px;background:#fff">'
    : '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#8b949e;font-size:12.5px;line-height:1.8">拖拽图片到这里<br>或点击选择</div>'
  return '<div data-qr="' + kind + '" style="' + QR_BOX + '">'
    + '<div class="preview" style="flex:1;min-height:0">' + preview + '</div>'
    + '<div style="font-size:12px;color:#8b949e;margin-top:8px;flex:none">' + esc(label) + '</div>'
  + '</div>'
}
/** 支付配置页：渠道选择（手动确认 / XorPay）+ 收款码 + 模拟支付 */
export function paymentPage(opts = {}) {
  const p = opts.payment || {}
  const pendingAll = Number(opts.pendingOrders) || 0
  const ch = String(p.channel || 'manual')
  const opt = (v, label) => '<option value="' + esc(v) + '"' + (ch === v ? ' selected' : '') + '>' + esc(label) + '</option>'
  const field = (id, label, val, ph, secret) => '<div style="margin-bottom:12px"><label style="display:block;font-size:12.5px;color:#8b949e;margin-bottom:5px">' + esc(label) + '</label>'
    + '<input id="' + id + '" type="' + (secret ? 'password' : 'text') + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '" style="width:100%;max-width:520px"></div>'
  const status = ch === 'xorpay' ? '<span class="pill ok">XorPay 自动收款</span>' : '<span class="pill warn">手动确认</span>'
  const body = section({
    title: '支付渠道 ' + status,
    right: '<span style="font-size:12px;color:#8b949e">保存后立即生效</span>',
    body: '<div style="margin-bottom:14px"><label style="display:block;font-size:12.5px;color:#8b949e;margin-bottom:5px">当前渠道</label>'
      + '<select id="channel" style="min-width:260px">'
      + opt('manual', '手动确认（用户提交申请，管理员确认收款）')
      + opt('xorpay', 'XorPay 自动收款（微信扫码 / 支付宝）')
      + '</select></div>'
      + '<div id="box-manual" style="display:none">'
      + '<div class="note warn">手动模式：用户点「提交开通申请」生成订单，你在「订单」页确认收款后订阅立即生效。</div>'
      + '<div style="display:flex;gap:16px;flex-wrap:wrap;margin:4px 0 18px">'
      + qrBox('wechat', '微信收款码', p.qrWechat)
      + qrBox('alipay', '支付宝收款码', p.qrAlipay)
      + '</div>'
      + '<input id="qrWechat" type="hidden" value="' + esc(p.qrWechat || '') + '">'
      + '<input id="qrAlipay" type="hidden" value="' + esc(p.qrAlipay || '') + '">'
      + '</div>'
      + '<div id="box-xorpay" style="display:none">'
      + field('xpayAid', 'XorPay AppID（aid）', p.xorpayAid, 'aid')
      + field('xpaySecret', 'XorPay Secret', p.xorpaySecret, '留空表示不修改', true)
      + field('xpayBase', '接口地址', p.xorpayBase || 'https://xorpay.com', 'https://xorpay.com')
      + field('xpayNotify', '回调地址', p.xorpayNotify || '', 'https://你的域名/api/pay/notify/xorpay')
      + '<div class="note">填好 aid 与 secret 后保存，支付页会变为自动发码；扫了真扣钱。</div>'
      + '</div>'
      + '<div class="toolbar" style="margin-top:14px"><label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">'
      + '<input type="checkbox" id="simulate"' + (p.simulate ? ' checked' : '') + ' style="width:16px;height:16px"> 开启模拟支付（测试用，会真实写库并推通知）</label></div>'
      + '<div class="toolbar" style="margin-top:12px"><button class="btn" id="save" type="button">保存</button>'
      + '<span id="msg" style="font-size:12.5px"></span></div>',
  })
  const script = '<script>'
    + 'async function uploadQr(kind,file){'
    + 'if(!file||!/^image\\//.test(file.type)){alert("请选择图片文件");return}'
    + 'if(file.size>3*1024*1024){alert("图片不能超过 3MB");return}'
    + 'var box=document.querySelector("[data-qr=\'"+kind+"\']");'
    + 'var rd=new FileReader();'
    + 'rd.onload=async function(){'
    + 'box.querySelector(".preview").innerHTML="<div class=\'ph\'>上传中…</div>";'
    + 'var r=await fetch("/api/admin/upload/qr",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind:kind,data:rd.result})});'
    + 'var d=await r.json().catch(function(){return{}});'
    + 'if(r.ok&&d.url){'
    + 'box.querySelector(".preview").innerHTML="<img src=\'"+d.url+"\' alt=\'\'>";'
    + 'document.getElementById(kind==="wechat"?"qrWechat":"qrAlipay").value=d.url;'
    + '}else{box.querySelector(".preview").innerHTML="<div class=\'ph\'>上传失败</div>";alert(d.error||("HTTP "+r.status))}'
    + '};rd.readAsDataURL(file)}'
    + 'document.querySelectorAll("[data-qr]").forEach(function(box){'
    + 'var kind=box.getAttribute("data-qr");'
    + 'box.addEventListener("click",function(){var f=document.createElement("input");f.type="file";f.accept="image/*";f.onchange=function(){uploadQr(kind,f.files[0])};f.click()});'
    + 'box.addEventListener("dragover",function(e){e.preventDefault();box.classList.add("over")});'
    + 'box.addEventListener("dragleave",function(){box.classList.remove("over")});'
    + 'box.addEventListener("drop",function(e){e.preventDefault();box.classList.remove("over");uploadQr(kind,e.dataTransfer.files[0])});'
    + '});'
    + 'var ch=document.getElementById("channel"),msg=document.getElementById("msg");'
    + 'function sync(){document.getElementById("box-manual").style.display=(ch.value==="manual")?"block":"none";document.getElementById("box-xorpay").style.display=(ch.value==="xorpay")?"block":"none"}'
    + 'ch.addEventListener("change",sync);sync();'
    + 'document.getElementById("save").addEventListener("click",async function(){'
    + 'var body={channel:ch.value,simulate:document.getElementById("simulate").checked,'
    + 'qrWechat:document.getElementById("qrWechat").value.trim(),qrAlipay:document.getElementById("qrAlipay").value.trim(),'
    + 'xorpayAid:document.getElementById("xpayAid").value.trim(),xorpaySecret:document.getElementById("xpaySecret").value.trim(),'
    + 'xorpayBase:document.getElementById("xpayBase").value.trim(),xorpayNotify:document.getElementById("xpayNotify").value.trim()};'
    + 'var r=await fetch("/api/admin/payment",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});'
    + 'var d=await r.json().catch(function(){return{}});'
    + 'msg.style.color=r.ok?"#3fb950":"#e5534b";msg.textContent=r.ok?"已保存（立即生效）":(d.error||("HTTP "+r.status));'
    + '});'
    + '</script>'
  return adminShell({ title: '支付', subtitle: '收款渠道配置 · 手动确认或 XorPay 自动收款', active: 'payment', nav: navItems({ pendingOrders: pendingAll }), body: body + script })
}

/** 管理员页：现有 admin 列表 + 提升/取消 */
export function adminsPage(opts = {}) {
  const users = opts.users || []
  const pendingAll = Number(opts.pendingOrders) || 0
  const admins = users.filter((u) => String(u.role) === 'admin')
  const others = users.filter((u) => String(u.role) !== 'admin')
  const stats = statCards([
    { k: '管理员', v: admins.length },
    { k: '普通用户', v: others.length },
    { k: '已封禁', v: users.filter((u) => String(u.status) === 'disabled').length },
  ])
  const rowA = admins.length
    ? admins.map((u) => '<tr><td>' + esc(u.email) + '</td><td><span class="pill blue">管理员</span></td><td>' + planPill(u.plan) + '</td><td class="muted">' + esc(fmtT(u.created_at)) + '</td>'
      + '<td><button class="btn danger" data-demote="' + esc(u.id) + '" type="button" style="padding:4px 10px;font-size:12px">取消管理员</button></td></tr>').join('')
    : '<tr><td colspan="5" class="empty">还没有管理员</td></tr>'
  const rowO = others.length
    ? others.map((u) => '<tr><td>' + esc(u.email) + '</td><td><span class="muted">用户</span></td><td>' + planPill(u.plan) + '</td><td class="muted">' + esc(fmtT(u.created_at)) + '</td>'
      + '<td><button class="btn ghost" data-promote="' + esc(u.id) + '" type="button" style="padding:4px 10px;font-size:12px">设为管理员</button></td></tr>').join('')
    : '<tr><td colspan="5" class="empty">没有其他用户</td></tr>'
  const body = stats
    + section({ title: '管理员', tight: true, body: '<table class="tbl"><tr><th>邮箱</th><th>角色</th><th>套餐</th><th>注册</th><th></th></tr>' + rowA + '</table>' })
    + section({ title: '其他用户（可提升为管理员）', tight: true, body: '<table class="tbl"><tr><th>邮箱</th><th>角色</th><th>套餐</th><th>注册</th><th></th></tr>' + rowO + '</table>' })
  const script = '<script>'
    + 'async function setRole(id,role){var r=await fetch("/api/admin/users/"+id+"/role",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({role:role})});if(r.ok)location.reload();else alert("失败 HTTP "+r.status)}'
    + 'document.querySelectorAll("[data-promote]").forEach(function(b){b.addEventListener("click",function(){if(confirm("把该账号提升为管理员？"))setRole(b.getAttribute("data-promote"),"admin")})});'
    + 'document.querySelectorAll("[data-demote]").forEach(function(b){b.addEventListener("click",function(){if(confirm("取消该账号的管理员权限？"))setRole(b.getAttribute("data-demote"),"user")})});'
    + '</script>'
  return adminShell({ title: '管理员', subtitle: '管理员可进入本后台；普通用户只能用自己的控制台', active: 'admins', nav: navItems({ pendingOrders: pendingAll }), body: body + script })
}