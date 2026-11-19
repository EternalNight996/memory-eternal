// 管理端 UI（私有模块，不随开源包发布）
//
// 与用户端登录**完全隔离**：
//   用户端 /api/login  → MengBot 账号 / 邮箱 OTP / me_ 密钥 → cookie me_user
//   管理端 /api/admin  → 管理令牌 → cookie me_admin
// 两套 cookie 名字不同、Path 不同、互不认：管理端不接受用户密钥，用户端不接受管理令牌。
//
// 不引前端框架：页面就几个，内联 HTML+CSS+少量 fetch 足够；服务端产物只有 491 KB。
import crypto from 'node:crypto'

const COOKIE_ADMIN = 'me_admin'
const COOKIE_USER = 'me_user'
const TTL_MS = 30 * 60 * 1000

/** 用管理令牌派生会话签名密钥：令牌一换，旧会话全部失效。 */
function signer(secret) {
  return (payload) => crypto.createHmac('sha256', String(secret || '')).update(payload).digest('hex')
}

export function issueSession(secret) {
  const ts = Date.now()
  return ts + '.' + signer(secret)(String(ts))
}

export function verifySession(secret, cookieValue) {
  if (!cookieValue) return { ok: false, reason: 'no-cookie' }
  const i = String(cookieValue).lastIndexOf('.')
  if (i <= 0) return { ok: false, reason: 'malformed' }
  const ts = String(cookieValue).slice(0, i)
  const sig = String(cookieValue).slice(i + 1)
  const want = signer(secret)(ts)
  if (sig.length !== want.length) return { ok: false, reason: 'bad-signature' }
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { ok: false, reason: 'bad-signature' } }
  catch { return { ok: false, reason: 'bad-signature' } }
  const at = Number(ts)
  if (!Number.isFinite(at) || Date.now() - at > TTL_MS) return { ok: false, reason: 'expired' }
  return { ok: true, ts: at }
}

export function readCookie(req, name) {
  const raw = String((req.headers && req.headers.cookie) || '')
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

export function setCookie(res, name, value, opts = {}) {
  const path = opts.path || '/'
  const maxAge = opts.maxAge == null ? Math.floor(TTL_MS / 1000) : opts.maxAge
  const bits = [name + '=' + encodeURIComponent(value), 'Path=' + path, 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + maxAge]
  // Secure 只在真的是 HTTPS 时加：本地 http:// 调试若强制 Secure，浏览器会直接丢弃 cookie，
  // 表现为「登录返回 200 但一直是未登录」—— 排查起来极费时间。
  const force = String(process.env.MEMORY_COOKIE_SECURE || '')
  const secure = force === '1' ? true : (force === '0' ? false : !!opts.secure)
  if (secure) bits.push('Secure')
  const prev = res.getHeader && res.getHeader('Set-Cookie')
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [String(prev)]) : []
  list.push(bits.join('; '))
  if (res.setHeader) res.setHeader('Set-Cookie', list)
}

const CSS = 'body{margin:0;background:#0f1216;color:#e6e9ef;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}'
  + 'a{color:#6ea8fe}.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px}'
  + 'h1{font-size:20px;margin:0 0 4px}.sub{opacity:.55;font-size:12px}'
  + '.card{background:#161b22;border:1px solid #232a33;border-radius:10px;padding:16px 18px;margin-bottom:16px}'
  + '.card h2{font-size:13px;margin:0 0 12px;opacity:.7}'
  + 'table{width:100%;border-collapse:collapse;font-size:12.5px}'
  + 'th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #1e242c;white-space:nowrap}'
  + 'th{opacity:.5;font-weight:500}tr:last-child td{border-bottom:none}'
  + 'code{background:#0b0f14;padding:1px 5px;border-radius:4px;font-size:12px}'
  + 'input,button{font:inherit}input[type=text],input[type=password]{width:100%;padding:9px 11px;border-radius:8px;border:1px solid #2a323d;background:#0b0f14;color:#e6e9ef}'
  + 'button{padding:9px 16px;border-radius:8px;border:1px solid #2f6feb;background:#2f6feb;color:#fff;cursor:pointer}'
  + 'button.ghost{background:transparent;border-color:#2a323d;color:#c9d1d9}button.danger{background:transparent;border-color:#7a2c2c;color:#ff7b72}'
  + '.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.err{color:#ff7b72;font-size:12.5px}.ok{color:#3fb950;font-size:12.5px}'
  + '.muted{opacity:.5}.login{max-width:400px;margin:12vh auto}'

export function shell(title, body) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title><style>' + CSS + '</style></head><body>' + body + '</body></html>'
}

export function loginPage(opts = {}) {
  const err = String(opts.error || '')
  const next = String(opts.next || '')
  return shell('记忆云 · 管理端登录',
    '<div class="wrap login"><h1>管理端登录</h1>'
    + '<div class="sub" style="margin:6px 0 18px">这是<b>服务端管理员</b>入口，不是用户登录。用户请走 <a href="/memory-eternal/api/login">用户登录</a>。</div>'
    + '<div class="card"><form id="f">'
    + '<label style="font-size:12px;opacity:.6">管理令牌</label>'
    + '<input id="t" type="password" autocomplete="off" placeholder="MEMORY_CLOUD_ADMIN_TOKEN / 启动日志里那串">'
    + '<div class="row" style="margin-top:12px"><button type="submit">登录</button></div>'
    + '<div class="err" id="e" style="display:' + (err ? 'block' : 'none') + '">' + err + '</div>'
    + '</form></div>'
    + '<div class="sub">令牌在服务端 <code>$DSH_HOME/cloud-admin-token</code>，或由 <code>MEMORY_CLOUD_ADMIN_TOKEN</code> 指定。</div></div>'
    + '<script>document.getElementById("f").addEventListener("submit",async function(ev){ev.preventDefault();'
    + 'var e=document.getElementById("e");e.style.display="none";try{'
    + 'var r=await fetch("/memory-eternal/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},'
    + 'body:JSON.stringify({token:document.getElementById("t").value,next:' + JSON.stringify(next) + '})});'
    + 'var d=await r.json().catch(function(){return{}});'
    + 'if(r.ok&&d.ok){location.href=d.next||"/memory-eternal/api/admin";return}'
    + 'e.textContent=d.error||("登录失败 HTTP "+r.status);e.style.display="block"}catch(err){e.textContent="网络错误："+err.message;e.style.display="block"}})</script>')
}

export function adminPage(opts = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const version = esc(opts.version || '')
  const sys = opts.system || {}
  const tenants = Array.isArray(opts.tenants) ? opts.tenants : []
  const keys = Array.isArray(opts.keys) ? opts.keys : []
  const stat = (k, v) => '<div style="min-width:92px"><div class="muted" style="font-size:11px">' + esc(k) + '</div><div style="font-size:17px">' + esc(v) + '</div></div>'
  const tenantRows = tenants.length
    ? tenants.map((t) => '<tr><td><code>' + esc(t.owner) + '</code></td><td>' + esc(t.plan || 'free') + '</td><td>' + esc(t.expiresAt || '—') + '</td><td>' + esc(t.cards == null ? '—' : t.cards) + '</td><td>' + esc(t.vaults == null ? '—' : t.vaults) + '</td></tr>').join('')
    : '<tr><td colspan="5" class="muted">还没有租户（用户首次登录或导入库后出现）</td></tr>'
  const keyRows = keys.length
    ? keys.map((k) => '<tr><td><code>' + esc(k.id) + '</code></td><td>' + esc(k.owner || '—') + '</td><td>' + esc(k.note || '—') + '</td><td>' + esc(k.createdAt || '—') + '</td><td>' + esc(k.lastUsedAt || '未使用') + '</td><td><button class="danger" data-revoke="' + esc(k.id) + '">吊销</button></td></tr>').join('')
    : '<tr><td colspan="6" class="muted">还没有访问密钥</td></tr>'
  const flash = opts.flash ? '<div class="ok" style="margin-bottom:12px">' + esc(opts.flash) + '</div>' : ''
  const error = opts.error ? '<div class="err" style="margin-bottom:12px">' + esc(opts.error) + '</div>' : ''
  return shell('记忆云 · 管理端',
    '<div class="wrap"><div class="row" style="justify-content:space-between;margin-bottom:14px">'
    + '<div><h1>记忆云管理端</h1><div class="sub">服务端 v' + version + ' · 会话 30 分钟</div></div>'
    + '<div class="row"><a href="/memory-eternal/api/admin/users">用户</a><a href="/memory-eternal/api/admin">刷新</a><button class="ghost" id="out">退出</button></div></div>'
    + flash + error
    + '<div class="card"><h2>系统</h2><div class="row" style="gap:30px">'
    + stat('版本', sys.version || version) + stat('租户', sys.tenants == null ? '—' : sys.tenants)
    + stat('卡片总数', sys.cards == null ? '—' : sys.cards) + stat('密钥', keys.length)
    + stat('库大小', sys.dbMB == null ? '—' : sys.dbMB + ' MB') + stat('运行', sys.uptime || '—') + '</div></div>'
    + '<div class="card"><h2>签发访问密钥</h2><div class="row">'
    + '<input id="owner" type="text" placeholder="owner（用户邮箱或标识）" style="max-width:280px">'
    + '<input id="note" type="text" placeholder="备注（可选）" style="max-width:220px">'
    + '<button id="issue">签发</button></div>'
    + '<div id="issued" class="ok" style="display:none;margin-top:8px"></div>'
    + '<div class="sub" style="margin-top:8px">明文只显示这一次；库里只存 sha256。</div></div>'
    + '<div class="card"><h2>租户</h2><table><tr><th>owner</th><th>套餐</th><th>到期</th><th>卡片</th><th>库</th></tr>' + tenantRows + '</table></div>'
    + '<div class="card"><h2>访问密钥</h2><table><tr><th>id</th><th>owner</th><th>备注</th><th>创建</th><th>最后使用</th><th></th></tr>' + keyRows + '</table></div>'
    + '</div>'
    + '<script>document.getElementById("out").addEventListener("click",async function(){await fetch("/memory-eternal/api/admin/logout",{method:"POST"}).catch(function(){});location.href="/memory-eternal/api/admin"});'
    + 'document.getElementById("issue").addEventListener("click",async function(){var box=document.getElementById("issued");'
    + 'var owner=document.getElementById("owner").value.trim();var note=document.getElementById("note").value.trim();'
    + 'if(!owner){box.className="err";box.style.display="block";box.textContent="owner 必填";return}'
    + 'var r=await fetch("/memory-eternal/api/admin/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:owner,note:note})});'
    + 'var d=await r.json().catch(function(){return{}});box.style.display="block";'
    + 'if(r.ok&&d.ok){box.className="ok";box.textContent="已签发："+d.token+"（只显示这一次）"}else{box.className="err";box.textContent=d.error||("HTTP "+r.status)}});'
    + 'document.querySelectorAll("[data-revoke]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'var id=b.getAttribute("data-revoke");if(!confirm("吊销密钥 "+id+"？"))return;'
    + 'var r=await fetch("/memory-eternal/api/admin/keys/"+encodeURIComponent(id),{method:"DELETE"});'
    + 'if(r.ok)location.reload();else alert("吊销失败 HTTP "+r.status)})})</script>')
}


/** 用户管理页：列表 + 搜索 + 封禁/解封。与密钥页并列，属于同一个管理会话。 */
export function usersPage(opts = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const users = Array.isArray(opts.users) ? opts.users : []
  const q = String(opts.q || '')
  const offset = Number(opts.offset || 0)
  const limit = Number(opts.limit || 50)
  const flash = opts.flash ? '<div class="ok" style="margin-bottom:12px">' + esc(opts.flash) + '</div>' : ''
  const error = opts.error ? '<div class="err" style="margin-bottom:12px">' + esc(opts.error) + '</div>' : ''
  const rows = users.length
    ? users.map((u) => {
        const st = String(u.status || '')
        const badge = st === 'active' ? '' : ' <span class="pill warn">' + esc(st) + '</span>'
        const next = st === 'active' ? 'disabled' : 'active'
        const label = st === 'active' ? '封禁' : '解封'
        return '<tr><td><code>' + esc(u.email) + '</code>' + badge + '</td>'
          + '<td>' + esc(u.identities || 0) + '</td><td>' + esc(u.keys || 0) + '</td>'
          + '<td><span class="pill">' + esc(u.plan || 'free') + '</span>' + (u.expiresAt ? ' <span class="muted" style="font-size:11px">至 ' + esc(String(u.expiresAt).slice(0, 10)) + '</span>' : '') + '</td>'
          + '<td>' + esc(u.last_seen ? String(u.last_seen).slice(0, 16).replace('T', ' ') : '—') + '</td>'
          + '<td>' + esc(String(u.created_at || '').slice(0, 10)) + '</td>'
          + '<td><button class="ghost" data-plan="' + esc(u.id) + '" data-cur="' + esc(u.plan || 'free') + '">套餐</button> '
          + '<button class="ghost" data-uid="' + esc(u.id) + '" data-next="' + esc(next) + '">' + label + '</button></td></tr>'
      }).join('')
    : '<tr><td colspan="6" class="muted">没有匹配的用户</td></tr>'
  const prev = offset > 0 ? '<a href="?q=' + encodeURIComponent(q) + '&offset=' + Math.max(0, offset - limit) + '">上一页</a>' : ''
  const nextLink = users.length >= limit ? '<a href="?q=' + encodeURIComponent(q) + '&offset=' + (offset + limit) + '">下一页</a>' : ''
  return shell('记忆云 · 用户',
    '<div class="wrap"><div class="row" style="justify-content:space-between;margin-bottom:14px">'
    + '<div><h1>用户</h1><div class="sub">共 ' + users.length + ' 条（当前页）</div></div>'
    + '<div class="row"><a href="/memory-eternal/api/admin">← 返回面板</a><button class="ghost" id="out">退出</button></div></div>'
    + flash + error
    + '<div class="card"><form method="get" class="row">'
    + '<input type="text" name="q" value="' + esc(q) + '" placeholder="搜索邮箱" style="max-width:280px">'
    + '<button type="submit">搜索</button></form></div>'
    + '<div class="card"><table><tr><th>邮箱</th><th>身份源</th><th>密钥</th><th>套餐</th><th>最近登录</th><th>注册</th><th></th></tr>' + rows + '</table>'
    + '<div class="row" style="margin-top:12px;gap:16px">' + prev + nextLink + '</div></div></div>'
    + '<script>'
    + 'document.getElementById("out").addEventListener("click",async function(){await fetch("/memory-eternal/api/admin/logout",{method:"POST"}).catch(function(){});location.href="/memory-eternal/api/admin"});'
    + 'document.querySelectorAll("[data-plan]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'var id=b.getAttribute("data-uid"),nx=b.getAttribute("data-next");'
    + 'if(!confirm("确认把该账号设为 "+nx+" ？"))return;'
    + 'var r=await fetch("/memory-eternal/api/admin/users/"+id+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:nx})});'
    + 'if(r.ok)location.reload();else alert("操作失败 HTTP "+r.status)})});'
    + 'document.querySelectorAll("[data-plan]").forEach(function(b){b.addEventListener("click",async function(){'
    + 'var id=b.getAttribute("data-plan"),cur=b.getAttribute("data-cur")||"free";'
    + 'var v=prompt("套餐与天数，例如：pro 30（可选 free / personal / pro / max）",cur+" 30");if(!v)return;'
    + 'var parts=v.trim().split(/\\s+/);var plan=parts[0]||"free";var days=parseInt(parts[1]||"30",10)||30;'
    + 'var r=await fetch("/memory-eternal/api/admin/users/"+id+"/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan:plan,days:days})});'
    + 'if(r.ok)location.reload();else{var d=await r.json().catch(function(){return{}});alert("设置失败："+(d.error||r.status))}})})'
    + '</script>')
}
export { COOKIE_ADMIN, COOKIE_USER, TTL_MS }
/** 用户端登录页：与管理端**完全分离**（不同页面、不同 cookie、不同凭据类型）。
 *  它能收的：MengBot 账号（OIDC 跳转）、邮箱 OTP、me_ 访问密钥。
 *  它**不收**管理令牌 —— 那是服务端管理员的。 */
