// 用户云端控制台（/console）：登录后的唯一入口。
// 企业级后台：订阅概览（带配额进度）→ 记忆库 → 访问凭证 → 账号。
import { shell } from './cloud-admin-ui.js'

const CSS = [
  '.ct{max-width:960px;margin:0 auto;padding:24px 20px 64px}',
  '.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:22px}',
  '.hero .who{display:flex;align-items:center;gap:12px}',
  '.avatar{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#2f6feb,#6ea8fe);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;flex:none}',
  '.hero h1{font-size:19px;margin:0 0 3px}',
  '.hero .meta{font-size:12.5px;color:#8b949e;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.badge{font-size:11.5px;padding:2px 9px;border-radius:999px;background:#1f6feb22;color:#6ea8fe}',
  '.badge.ok{background:#3fb95022;color:#3fb950}',
  '.badge.warn{background:#d2992222;color:#d29922}',
  '.card3{background:#12171e;border:1px solid #1b2432;border-radius:14px;margin-bottom:16px;overflow:hidden}',
  '.card3 .hd{display:flex;justify-content:space-between;align-items:center;padding:15px 18px;border-bottom:1px solid #1b2432;gap:12px;flex-wrap:wrap}',
  '.card3 .hd h2{font-size:14px;margin:0;font-weight:600;display:flex;align-items:center;gap:9px}',
  '.card3 .hd .cnt{font-size:11.5px;color:#8b949e;font-weight:400}',
  '.card3 .bd{padding:18px}',
  '.card3 .bd.tight{padding:0}',
  '.planrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}',
  '.planrow .nm{font-size:21px;font-weight:600}',
  '.quota{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:18px}',
  '.q{background:#0b0f14;border:1px solid #1b2432;border-radius:11px;padding:13px 15px}',
  '.q .top{display:flex;justify-content:space-between;font-size:11.5px;color:#8b949e;margin-bottom:7px}',
  '.q .top b{color:#e6e9ef;font-weight:600;font-size:12.5px}',
  '.bar{height:6px;border-radius:99px;background:#1b2432;overflow:hidden}',
  '.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2f6feb,#6ea8fe)}',
  '.bar i.warn{background:linear-gradient(90deg,#d29922,#e5b454)}',
  '.bar i.full{background:linear-gradient(90deg,#c94040,#e5534b)}',
  '.acts{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
  'table{width:100%;border-collapse:collapse;font-size:13px}',
  'th{text-align:left;padding:10px 18px;font-weight:500;color:#8b949e;font-size:11.5px;background:#0f141a;border-bottom:1px solid #1b2432;white-space:nowrap}',
  'td{padding:11px 18px;border-bottom:1px solid #161d26}',
  'tr:last-child td{border-bottom:none}',
  'tbody tr:hover td{background:#141a22}',
  '.empty{padding:34px 18px;text-align:center;color:#8b949e;font-size:12.5px;line-height:1.9}',
  '.codebox{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;background:#0b0f14;border:1px solid #1b2432;border-radius:7px;padding:4px 9px;display:inline-block}',
  '.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}',
  '.kv2 .k{font-size:11px;color:#8b949e;margin-bottom:3px}',
  '.kv2 .v{font-size:14px}',
].join('')

export function consolePage(st = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const user = st.user || {}
  const plan = st.plan || {}
  const vaults = Array.isArray(st.vaults) ? st.vaults : []
  const pairs = Array.isArray(st.pairs) ? st.pairs : []
  const role = st.role || 'user'
  const planName = String(plan.plan || 'free')
  const active = planName !== 'free' && String(plan.status || '') === 'active'
  const caps = plan.caps || {}
  const planLabel = { free: '免费版', personal: '个人版', pro: '团队版', max: '旗舰版' }[planName] || planName

  const initial = (user.displayName || user.email || '?').trim().charAt(0).toUpperCase()
  const adminLink = role === 'admin' ? '<a href="/api/admin">管理端</a>' : ''
  const roleBadge = role === 'admin' ? '<span class="badge">管理员</span>' : ''

  // ── 配额进度条 ──
  const bar = (used, limit) => {
    if (limit == null || limit === 0) return '<div class="bar"><i style="width:0"></i></div>'
    const pct = Math.min(100, Math.round((Number(used) || 0) / limit * 100))
    const cls = pct >= 100 ? ' full' : pct >= 80 ? ' warn' : ''
    return '<div class="bar"><i class="' + cls.trim() + '" style="width:' + pct + '%"></i></div>'
  }
  const totalCards = vaults.reduce((a, v) => a + (Number(v.cards) || 0), 0)
  const quota = '<div class="quota">'
    + '<div class="q"><div class="top"><span>卡片</span><b>' + totalCards.toLocaleString() + (caps.cards != null ? ' / ' + Number(caps.cards).toLocaleString() : '') + '</b></div>' + bar(totalCards, caps.cards) + '</div>'
    + '<div class="q"><div class="top"><span>记忆库</span><b>' + vaults.length + (caps.vaults != null ? ' / ' + caps.vaults : '') + '</b></div>' + bar(vaults.length, caps.vaults) + '</div>'
    + '<div class="q"><div class="top"><span>请求速率</span><b>' + (caps.rpm == null ? '—' : caps.rpm + ' 次/分') + '</b></div>' + bar(0, 0) + '</div>'
    + '</div>'

  const upTier = planName === 'personal' ? 'pro' : planName === 'pro' ? 'max' : ''
  const upLabel = upTier ? ({ pro: '团队版', max: '旗舰版' }[upTier]) : ''
  const subBlock = active
    ? '<div class="planrow"><div class="nm">' + esc(planLabel) + '</div><span class="badge ok">生效中</span>'
      + (plan.daysLeft ? '<span style="font-size:12.5px;color:#8b949e">还剩 ' + esc(plan.daysLeft) + ' 天</span>' : '') + '</div>'
      + quota
      + (plan.expiresAt ? '<div style="font-size:12.5px;color:#8b949e;margin-bottom:16px">到期时间 ' + esc(String(plan.expiresAt).slice(0, 10)) + '</div>' : '')
      + '<div class="acts">'
      + (st.subscribeUrl ? '<a href="' + esc(st.subscribeUrl) + '?sku=' + encodeURIComponent('sub-' + planName) + '"><button class="btn" type="button">续订 30 天</button></a>' : '')
      + (upTier && st.subscribeUrl ? '<a href="' + esc(st.subscribeUrl) + '?sku=' + encodeURIComponent('sub-' + upTier) + '"><button class="btn ghost" type="button">升级到' + esc(upLabel) + ' →</button></a>' : '')
      + '<a href="/api/orders"><button class="btn ghost" type="button">我的订单</button></a>'
      + '</div>'
    : '<div style="font-size:13.5px;color:#a9b4c2;margin-bottom:16px;line-height:1.9">云端库需要订阅后才能创建。<br>选一档按月订阅，<b style="color:#e6e9ef">提前续费会累加到现有到期日之后</b>，不会浪费。</div>'
      + '<div class="acts">'
      + (st.subscribeUrl ? '<a href="' + esc(st.subscribeUrl) + '"><button class="btn" type="button">去订阅 →</button></a>' : '')
      + '<button class="btn ghost" id="refresh" type="button">刷新状态</button>'
      + '</div>'

  function vaultRow(v) {
    return '<tr><td><code>' + esc(v.name) + '</code>' + (v.name === 'default' ? ' <span class="badge" style="font-size:10px">默认</span>' : '') + '</td>'
      + '<td>' + esc(v.cards == null ? '—' : v.cards) + '</td>'
      + '<td style="color:#8b949e">' + esc(v.sizeMB == null ? '—' : v.sizeMB) + ' MB</td>'
      + '<td style="text-align:right"><button class="btn ghost" data-pair="' + esc(v.name) + '" type="button" style="padding:5px 12px;font-size:12px">生成匹配码</button></td></tr>'
  }
  function pairRow(p) {
    const revoked = p.revoked_at
    return '<tr><td><code>' + esc(p.vault) + '</code></td>'
      + '<td>' + esc(p.label || '—') + '</td>'
      + '<td style="color:#8b949e">' + esc(p.ip_allow || '不限') + '</td>'
      + '<td>' + (revoked ? '<span class="badge" style="background:#8b949e22;color:#8b949e">已吊销</span>' : '<span class="badge ok">有效</span>') + '</td>'
      + '<td style="color:#8b949e">' + esc(p.last_used_at ? String(p.last_used_at).slice(0, 16).replace('T', ' ') : '未使用') + '</td>'
      + '<td style="text-align:right">' + (revoked ? '' : '<button class="btn ghost" data-revoke="' + esc(p.id) + '" type="button" style="padding:5px 12px;font-size:12px">吊销</button>') + '</td></tr>'
  }
  const vaultRows = vaults.length ? vaults.map(vaultRow).join('')
    : '<tr><td colspan="4" class="empty">还没有记忆库<br><span style="font-size:12px">订阅后在下方创建，客户端用匹配码连接</span></td></tr>'
  const pairRows = pairs.length ? pairs.map(pairRow).join('')
    : '<tr><td colspan="6" class="empty">还没有匹配码<br><span style="font-size:12px">在「新建匹配码」里生成，客户端粘贴即可连接</span></td></tr>'

  const body = [
    '<style>' + CSS + '</style>',
    '<div class="ct">',
    // 顶栏
    '<div class="hero">',
    '<div class="who"><div class="avatar">' + esc(initial) + '</div>',
    '<div><h1>' + esc(user.displayName || (user.email || '').split('@')[0] || '我的云端') + '</h1>',
    '<div class="meta">' + esc(user.email || '') + roleBadge + (active ? '<span class="badge ok">' + esc(planLabel) + '</span>' : '<span class="badge warn">未订阅</span>') + '</div></div></div>',
    '<div class="acts" style="font-size:13px">' + adminLink + '<a href="/api/orders">我的订单</a><button class="btn ghost" id="logout" style="width:auto;padding:7px 13px" type="button">退出</button></div>',
    '</div>',
    // 订阅
    '<div class="card3"><div class="hd"><h2>订阅与配额</h2></div><div class="bd">' + subBlock + '</div></div>',
    // 记忆库
    '<div class="card3"><div class="hd"><h2>记忆库 <span class="cnt">' + vaults.length + ' 个</span></h2>' + (active ? '<div class="acts"><input id="vname" type="text" placeholder="新库名（小写字母/数字）" style="max-width:200px"><button class="btn" id="mkvault" type="button" style="width:auto;padding:7px 14px">新建库</button></div>' : '') + '</div>',
    '<div class="bd tight"><table><thead><tr><th>库名</th><th>卡片</th><th>大小</th><th></th></tr></thead><tbody>' + vaultRows + '</tbody></table></div>',
    (active ? '' : '<div class="bd" style="padding-top:0"><div style="font-size:12px;color:#8b949e">订阅后才能创建新的记忆库。</div></div>'),
    '</div>',
    // 访问凭证：新建 + 列表
    '<div class="card3"><div class="hd"><h2>新建匹配码</h2><span class="cnt">仅本账号 / IP 白名单</span></div>',
    '<div class="bd">',
    '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">',
    '<div><div class="kv2"><div class="k">库</div></div><select id="pairvault" style="min-width:140px">' + (vaults.length ? vaults.map(function (v) { return '<option value="' + esc(v.name) + '">' + esc(v.name) + '</option>' }).join('') : '<option value="">（先建库）</option>') + '</select></div>',
    '<div><div class="kv2"><div class="k">IP 白名单</div></div><input id="pairip" type="text" placeholder="留空不限，支持 10.0.0.*" style="min-width:230px"></div>',
    '<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#a9b4c2;cursor:pointer;padding-bottom:8px"><input id="pairowner" type="checkbox" checked style="width:15px;height:15px"> 仅本账号</label>',
    '<button class="btn" id="pairgen" type="button" style="width:auto;padding:8px 18px">生成</button>',
    '</div>',
    '<div id="pairout" style="margin-top:14px;display:none;font-size:12.5px;line-height:1.9"></div>',
    '</div></div>',
    // 已有凭证
    '<div class="card3"><div class="hd"><h2>访问凭证 <span class="cnt">' + pairs.length + ' 个</span></h2></div>',
    '<div class="bd tight"><table><thead><tr><th>库</th><th>备注</th><th>IP 限制</th><th>状态</th><th>最近使用</th><th></th></tr></thead><tbody>' + pairRows + '</tbody></table></div></div>',
    '</div>',
    '<script src="/api/console.js"></script>',
  ].join('')
  return shell('记忆云 · 控制台', body)
}