// 用户云端控制台（/console）：登录后的唯一入口。
// 流程：看状态 → 未订阅去订阅 → 建库 → 生成匹配码 → 客户端粘贴连接。
import { shell } from './cloud-admin-ui.js'

const CSS = [
  '.ct{max-width:860px;margin:0 auto;padding:30px 20px 64px}',
  '.ct h1{font-size:21px;margin:0 0 4px;letter-spacing:.01em}',
  '.ct .sub{font-size:12.5px;color:#8b949e;margin:0 0 20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.card2{background:#12171e;border:1px solid #1b2432;border-radius:13px;padding:18px;margin-bottom:14px}',
  '.card2 h2{font-size:13px;color:#8b949e;margin:0 0 14px;font-weight:600;display:flex;justify-content:space-between;align-items:center}',
  '.planline{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}',
  '.planline .nm{font-size:20px;font-weight:600}',
  '.caps{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:16px}',
  '.cap{background:#0b0f14;border:1px solid #1b2432;border-radius:10px;padding:11px 14px}',
  '.cap .k{font-size:11px;color:#8b949e;margin-bottom:3px}',
  '.cap .v{font-size:17px;font-weight:600}',
  '.cap .v small{font-size:11px;font-weight:400;color:#8b949e;margin-left:2px}',
  '.acts{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
  '.badge{font-size:11.5px;padding:2px 10px;border-radius:999px;background:#1f6feb22;color:#6ea8fe}',
  '.badge.warn{background:#d2992222;color:#d29922}',
  '.badge.ok{background:#3fb95022;color:#3fb950}',
  'table{width:100%;border-collapse:collapse;font-size:12.5px}',
  'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #161d26}',
  'th{color:#8b949e;font-weight:500;font-size:11.5px;background:#0f141a}',
  'tr:last-child td{border-bottom:none}',
  '.empty{padding:22px;text-align:center;color:#8b949e;font-size:12.5px}',
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
  const planLabel = { free: '免费', personal: '个人版', pro: '团队版', max: '旗舰版' }[planName] || planName
  const upTier = planName === 'personal' ? 'pro' : planName === 'pro' ? 'max' : ''
  const upLabel = upTier ? ({ pro: '团队版 ¥118/月', max: '旗舰版 ¥399/月' }[upTier]) : ''
  const capsHtml = '<div class="caps">'
    + '<div class="cap"><div class="k">卡片上限</div><div class="v">' + esc(caps.cards == null ? '—' : Number(caps.cards).toLocaleString()) + '</div></div>'
    + '<div class="cap"><div class="k">请求速率</div><div class="v">' + esc(caps.rpm == null ? '—' : caps.rpm) + '<small>次/分</small></div></div>'
    + '<div class="cap"><div class="k">记忆库</div><div class="v">' + esc(caps.vaults == null ? '—' : caps.vaults) + '<small>个</small></div></div>'
    + '</div>'
  const subCard = active
    ? '<div class="planline"><div class="nm">' + esc(planLabel) + '</div><span class="badge ok">生效中</span>'
      + (plan.daysLeft ? '<span style="font-size:12.5px;color:#8b949e">还剩 ' + esc(plan.daysLeft) + ' 天</span>' : '') + '</div>'
      + capsHtml
      + (exp ? '<div style="font-size:12.5px;color:#8b949e;margin-bottom:14px">到期时间：' + esc(String(plan.expiresAt).slice(0, 10)) + '</div>' : '')
      + '<div class="acts">'
      + (st.subscribeUrl ? '<a href="' + esc(st.subscribeUrl) + '?sku=' + encodeURIComponent('sub-' + (planName === 'max' ? 'max' : planName)) + '"><button class="btn" type="button">续订 30 天</button></a>' : '')
      + (upTier && st.subscribeUrl ? '<a href="' + esc(st.subscribeUrl) + '?sku=' + encodeURIComponent('sub-' + upTier) + '"><button class="btn ghost" type="button">升级到' + esc(upLabel) + ' →</button></a>' : '')
      + '<a href="/api/orders"><button class="btn ghost" type="button">我的订单</button></a>'
      + '</div>'
    : '<div style="font-size:13px;color:#8b949e;margin-bottom:14px">云端库需要订阅后才能创建。选一档按月订阅，提前续费会累加到现有到期日之后。</div>'
      + (st.subscribeUrl
        ? '<div class="acts"><a href="' + esc(st.subscribeUrl) + '"><button class="btn" type="button">去订阅 →</button></a>'
          + '<button class="btn ghost" id="refresh" type="button">刷新订阅状态</button></div>'
        : '<div class="note err">订阅链接生成失败（检查支付配置）</div>')
  const mk = active ? '<div class="row" style="margin-top:12px"><input id="vname" type="text" placeholder="新库名（小写字母/数字）" style="max-width:240px"><button id="mkvault" type="button">创建库</button></div><div class="err" id="everr" style="display:none"></div>' : ''
  const body = [
    '<style>' + CSS + '</style>',
    '<div class="ct">',
    '<div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:18px">',
    '<div><h1>' + esc(user.displayName || (user.email || '').split('@')[0] || '我的云端') + '</h1>',
    '<div class="sub">' + esc(user.email || '') + ' ' + badge + ' ' + roleBadge + '</div></div>',
    '<div class="row"><button class="btn ghost" id="logout" style="width:auto;padding:8px 14px" type="button">退出</button></div>',
    '</div>',
    '<div class="card2"><h2>我的订阅</h2>' + subCard + '</div>',
    '<div class="card2"><h2>我的记忆库</h2><table><tr><th>库名</th><th>卡片</th><th>大小</th><th></th></tr>' + vaultRows + '</table>' + mk + '</div>',
    '<div class="card2"><h2>数据库匹配码</h2><div class="sub" style="margin-bottom:10px">客户端粘贴匹配码即可连接对应库。可限本人、限 IP，随时吊销。</div><table><tr><th>库</th><th>备注</th><th>IP 限制</th><th>最后使用</th><th></th></tr>' + pairRows + '</table><div class="ok" id="pairout" style="display:none"></div></div>',
    '<div style="margin-top:22px;font-size:12.5px;color:#8b949e;text-align:center">' + adminLink + '<a href="/api/orders">我的订单</a> · <a href="/api/login">返回登录</a></div>',
    '</div>',
    '<script src="/api/console.js"></script>',
  ].join('')
  return shell('记忆云 · 云端控制台', body)
}