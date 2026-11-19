// 用户云端控制台（/console）：登录后的唯一入口。
// 流程：看状态 → 未订阅去订阅 → 建库 → 生成匹配码 → 客户端粘贴连接。
import { shell } from './cloud-admin-ui.js'

const CSS = [
  '.ct{max-width:820px;margin:0 auto;padding:30px 20px 64px}',
  '.ct h1{font-size:20px;margin:0 0 3px}',
  '.ct .sub{margin:0 0 20px}',
  '.ct .card{margin-bottom:14px}',
  '.ct .card h2{font-size:13px;opacity:.7;margin:0 0 12px;font-weight:600}',
  'table{width:100%;border-collapse:collapse;font-size:12.5px}',
  'th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #1e242c}',
  'th{opacity:.5;font-weight:500}tr:last-child td{border-bottom:none}',
  '.kv{display:flex;gap:26px;flex-wrap:wrap}',
  '.kv>div{min-width:96px}',
  '.kv .k{font-size:11px;opacity:.5}',
  '.kv .v{font-size:15px}',
  '.badge{font-size:11px;padding:1px 8px;border-radius:999px;background:#1f6feb22;color:#6ea8fe}',
  '.badge.warn{background:#bb800922;color:#d29922}',
  '.badge.ok{background:#3fb95022;color:#3fb950}',
].join('')

export function consolePage(st = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const user = st.user || {}
  const plan = st.plan || {}
  const vaults = Array.isArray(st.vaults) ? st.vaults : []
  const pairs = Array.isArray(st.pairs) ? st.pairs : []
  const role = st.role || 'user'
  const planName = String(plan.plan || 'free')
  const active = planName !== 'free' && String(plan.status || '') === 'active'
  const caps = plan.caps || {}
  const badge = active ? '<span class="badge ok">已订阅 ' + esc(planName) + '</span>' : '<span class="badge warn">未订阅</span>'
  const roleBadge = role === 'admin' ? '<span class="badge">管理员</span>' : ''
  const exp = plan.expiresAt ? ' <span style="font-size:11px;opacity:.55">至 ' + esc(String(plan.expiresAt).slice(0, 10)) + '</span>' : ''
  function vaultRow(v) {
    return '<tr><td><code>' + esc(v.name) + '</code></td><td>' + esc(v.cards == null ? '—' : v.cards) + '</td><td>' + esc(v.sizeMB == null ? '—' : v.sizeMB + ' MB') + '</td><td><button class="ghost" data-pair="' + esc(v.name) + '">生成匹配码</button></td></tr>'
  }
  function pairRow(p) {
    var revoked = p.revoked_at ? '<span style="opacity:.5">已吊销</span>' : '<button class="danger" data-revoke="' + esc(p.id) + '">吊销</button>'
    return '<tr><td><code>' + esc(p.vault) + '</code></td><td>' + esc(p.label || '—') + '</td><td>' + esc(p.ip_allow || '不限') + '</td><td>' + esc(p.last_used_at ? String(p.last_used_at).slice(0, 16).replace('T', ' ') : '未使用') + '</td><td>' + revoked + '</td></tr>'
  }
  const vaultRows = vaults.length ? vaults.map(vaultRow).join('') : '<tr><td colspan="4" style="opacity:.5">还没有库</td></tr>'
  const pairRows = pairs.length ? pairs.map(pairRow).join('') : '<tr><td colspan="5" style="opacity:.5">还没有匹配码</td></tr>'
  const adminLink = role === 'admin' ? '<a href="/api/admin">管理端 →</a> · ' : ''
  const subCard = active
    ? '<div class="kv"><div><div class="k">套餐</div><div class="v">' + esc(planName) + exp + '</div></div><div><div class="k">卡片上限</div><div class="v">' + esc(caps.cards == null ? '不限' : caps.cards) + '</div></div><div><div class="k">记忆库</div><div class="v">' + esc(vaults.length) + '</div></div></div>'
    : '<div style="font-size:13px;opacity:.7;margin-bottom:12px">云端库需要订阅后才能创建。订阅走 MengBot 支付，付款完回到这里刷新即可建库。</div>'
      + (st.subscribeUrl
        ? '<a href="' + esc(st.subscribeUrl) + '"><button class="btn" type="button">去 MengBot 订阅 →</button></a>'
        : '<div class="err">订阅链接生成失败（检查 MengBot 支付域配置）</div>')
      + '<div style="margin-top:10px"><button class="btn ghost" id="refresh" type="button" style="width:auto;padding:8px 14px">刷新订阅状态</button></div>'
  const mk = active ? '<div class="row" style="margin-top:12px"><input id="vname" type="text" placeholder="新库名（小写字母/数字）" style="max-width:240px"><button id="mkvault" type="button">创建库</button></div><div class="err" id="everr" style="display:none"></div>' : ''
  const body = [
    '<style>' + CSS + '</style>',
    '<div class="ct">',
    '<div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:18px">',
    '<div><h1>' + esc(user.displayName || (user.email || '').split('@')[0] || '我的云端') + '</h1>',
    '<div class="sub">' + esc(user.email || '') + ' ' + badge + ' ' + roleBadge + '</div></div>',
    '<div class="row"><button class="btn ghost" id="logout" style="width:auto;padding:8px 14px" type="button">退出</button></div>',
    '</div>',
    '<div class="card"><h2>云端状态</h2>' + subCard + '</div>',
    '<div class="card"><h2>我的记忆库</h2><table><tr><th>库名</th><th>卡片</th><th>大小</th><th></th></tr>' + vaultRows + '</table>' + mk + '</div>',
    '<div class="card"><h2>数据库匹配码</h2><div class="sub" style="margin-bottom:10px">客户端粘贴匹配码即可连接对应库。可限本人、限 IP，随时吊销。</div><table><tr><th>库</th><th>备注</th><th>IP 限制</th><th>最后使用</th><th></th></tr>' + pairRows + '</table><div class="ok" id="pairout" style="display:none"></div></div>',
    '<div class="foot">' + adminLink + '<a href="/api/login">返回登录</a></div>',
    '</div>',
    '<script src="/api/console.js"></script>',
  ].join('')
  return shell('记忆云 · 云端控制台', body)
}