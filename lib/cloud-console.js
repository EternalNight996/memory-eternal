// 用户云端控制台（/console）—— 极简版：只留必要操作。
// 订阅状态 / 我的库（含一键生成匹配码）/ 最近生成的码。不提供吊销等次要操作。
import { shell } from './cloud-admin-ui.js'

const CSS = [
  '.ct{max-width:760px;margin:0 auto;padding:28px 20px 60px}',
  '.top{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:20px}',
  '.top h1{font-size:18px;margin:0}',
  '.top .sub{font-size:12.5px;color:#8b949e;margin-top:3px}',
  '.top .acts{display:flex;gap:12px;align-items:center;font-size:13px}',
  '.badge{font-size:11.5px;padding:2px 9px;border-radius:999px;background:#1f6feb22;color:#6ea8fe}',
  '.badge.ok{background:#3fb95022;color:#3fb950}',
  '.badge.warn{background:#d2992222;color:#d29922}',
  '.box{background:#12171e;border:1px solid #1b2432;border-radius:12px;padding:16px 18px;margin-bottom:14px}',
  '.box .hd{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}',
  '.box .hd h2{font-size:13.5px;margin:0;font-weight:600;color:#a9b4c2}',
  '.line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:#8b949e}',
  '.line b{color:#e6e9ef;font-weight:600}',
  '.row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #161d26;font-size:13px}',
  '.row:last-child{border-bottom:none}',
  '.row .nm{min-width:110px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}',
  '.row .meta{color:#8b949e;font-size:12px;flex:1}',
  '.empty{color:#8b949e;font-size:12.5px;padding:10px 0}',
  '.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#0b0f14;border:1px solid #1b2432;border-radius:7px;padding:5px 10px;display:inline-block;user-select:all}',
].join('')

export function consolePage(st = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const user = st.user || {}
  const plan = st.plan || {}
  const vaults = Array.isArray(st.vaults) ? st.vaults : []
  const role = st.role || 'user'
  const planName = String(plan.plan || 'free')
  const active = planName !== 'free' && String(plan.status || '') === 'active'
  const caps = plan.caps || {}
  const planLabel = { free: '免费版', personal: '个人版', pro: '团队版', max: '旗舰版' }[planName] || planName
  const totalCards = vaults.reduce((a, v) => a + (Number(v.cards) || 0), 0)
  const adminLink = role === 'admin' ? '<a href="/api/admin">管理端</a>' : ''
  const upTier = planName === 'personal' ? 'pro' : planName === 'pro' ? 'max' : ''
  const upLabel = upTier ? ({ pro: '团队版', max: '旗舰版' }[upTier]) : ''

  const subLine = active
    ? '<div class="line"><b>' + esc(planLabel) + '</b><span class="badge ok">生效中</span>'
      + (plan.daysLeft ? '还剩 ' + esc(plan.daysLeft) + ' 天' : '')
      + (plan.expiresAt ? '· 到期 ' + esc(String(plan.expiresAt).slice(0, 10)) : '')
      + '</div>'
      + '<div class="line" style="margin-top:8px">卡片 <b>' + totalCards.toLocaleString() + '</b>' + (caps.cards != null ? '/' + Number(caps.cards).toLocaleString() : '')
      + ' · 库 <b>' + vaults.length + '</b>' + (caps.vaults != null ? '/' + caps.vaults : '')
      + ' · 速率 <b>' + (caps.rpm == null ? '—' : caps.rpm) + '</b>/分</div>'
      + '<div class="line" style="margin-top:14px">'
      + (st.subscribeUrl ? '<a href="' + esc(st.subscribeUrl) + '?sku=' + encodeURIComponent('sub-' + planName) + '"><button class="btn" type="button" style="width:auto;padding:7px 16px">续订 30 天</button></a>' : '')
      + (upTier && st.subscribeUrl ? '<a href="' + esc(st.subscribeUrl) + '?sku=' + encodeURIComponent('sub-' + upTier) + '"><button class="btn ghost" type="button" style="width:auto;padding:7px 14px">升级到' + esc(upLabel) + '</button></a>' : '')
      + '</div>'
    : '<div class="line">未订阅 · 云端库需要订阅后才能创建</div>'
      + '<div class="line" style="margin-top:12px">'
      + (st.subscribeUrl ? '<a href="' + esc(st.subscribeUrl) + '"><button class="btn" type="button" style="width:auto;padding:7px 16px">去订阅</button></a>' : '')
      + '<button class="btn ghost" id="refresh" type="button" style="width:auto;padding:7px 14px">刷新状态</button>'
      + '</div>'

  const vaultRows = vaults.length
    ? vaults.map((v) => '<div class="row"><span class="nm">' + esc(v.name) + '</span>'
      + '<span class="meta">' + esc(v.cards == null ? '—' : v.cards) + ' 张 · ' + esc(v.sizeMB == null ? '—' : v.sizeMB) + ' MB</span>'
      + '<button class="btn ghost" data-pair="' + esc(v.name) + '" type="button" style="width:auto;padding:5px 12px;font-size:12px">生成匹配码</button></div>').join('')
    : '<div class="empty">还没有库</div>'

  const body = [
    '<style>' + CSS + '</style>',
    '<div class="ct">',
    '<div class="top">',
    '<div><h1>' + esc(user.displayName || (user.email || '').split('@')[0] || '我的云端') + '</h1>',
    '<div class="sub">' + esc(user.email || '') + '</div></div>',
    '<div class="acts">' + adminLink + '<a href="/api/orders">我的订单</a><button class="btn ghost" id="logout" style="width:auto;padding:6px 12px" type="button">退出</button></div>',
    '</div>',
    // 订阅
    '<div class="box"><div class="hd"><h2>订阅</h2></div>' + subLine + '</div>',
    // 我的库
    '<div class="box"><div class="hd"><h2>我的库</h2>'
      + (active ? '<div class="line"><input id="vname" type="text" placeholder="新库名" style="max-width:150px"><button class="btn" id="mkvault" type="button" style="width:auto;padding:6px 12px">新建</button></div>' : '')
      + '</div>' + vaultRows + '</div>',
    // 匹配码：一键生成 + 结果
    '<div class="box"><div class="hd"><h2>连接客户端</h2>'
      + (vaults.length ? '<select id="pairvault" style="min-width:120px">' + vaults.map(function (v) { return '<option value="' + esc(v.name) + '">' + esc(v.name) + '</option>' }).join('') + '</select><button class="btn" id="pairgen" type="button" style="width:auto;padding:6px 14px">生成匹配码</button>' : '')
      + '</div>',
      (vaults.length ? '<div id="pairout" style="display:none;margin-top:12px;font-size:12.5px"></div>' : '<div class="empty">先建一个库</div>'),
    '</div>',
    '</div>',
    '<input id="pairowner" type="hidden" value="1">',
    '<input id="pairip" type="hidden" value="">',
    '<script src="/api/console.js?v=' + Date.now() + '"></script>',
  ].join('')
  return shell('记忆云 · 控制台', body)
}