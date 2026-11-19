// 管理端布局系统：左侧边栏 + 右侧主区（参考 MengBot admin.html 的结构）。
//
// 为什么单独抽出来：重构前三个页面各写各的顶部导航，样式和交互都在漂移。
// 这里只提供**骨架和原子组件**（统计卡/分区/表格/状态徽章/工具栏），页面只填内容。

export const ADMIN_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#0b0f14;color:#e6e9ef;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}
a{color:#6ea8fe;text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.layout{display:flex;min-height:100vh}

/* 侧边栏 */
.sidebar{width:224px;flex:none;background:#0e131a;border-right:1px solid #1b2432;display:flex;flex-direction:column;padding:18px 12px;position:sticky;top:0;height:100vh}
.sidebar .brand{display:flex;align-items:center;gap:10px;padding:0 8px 18px}
.sidebar .brand img{width:34px;height:34px;border-radius:9px;display:block}
.sidebar .brand b{display:block;font-size:14.5px;line-height:1.2}
.sidebar .brand span{display:block;font-size:11.5px;color:#8b949e;line-height:1.4}
.sidebar nav{display:flex;flex-direction:column;gap:2px;flex:1}
.sidebar nav a{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:8px;color:#a9b4c2;font-size:13.5px;text-decoration:none;transition:.12s}
.sidebar nav a:hover{background:#161d26;color:#e6e9ef;text-decoration:none}
.sidebar nav a.on{background:#1f6feb22;color:#6ea8fe;font-weight:500}
.sidebar nav a .dot{width:6px;height:6px;border-radius:50%;background:#2f6feb;opacity:0}
.sidebar nav a.on .dot{opacity:1}
.sidebar .side-foot{padding-top:12px;border-top:1px solid #1b2432;display:flex;flex-direction:column;gap:6px}
.sidebar .side-foot button{width:100%;text-align:left;background:transparent;border:0;color:#8b949e;font:inherit;font-size:13px;padding:8px 11px;border-radius:8px;cursor:pointer}
.sidebar .side-foot button:hover{background:#161d26;color:#e6e9ef}

/* 主区 */
.main{flex:1;min-width:0;padding:24px 28px 60px}
.topbar{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px;gap:16px;flex-wrap:wrap}
.topbar h1{font-size:21px;margin:0 0 3px;letter-spacing:.01em}
.topbar .sub{font-size:12.5px;color:#8b949e}

/* 统计卡 */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat{background:#12171e;border:1px solid #1b2432;border-radius:11px;padding:14px 16px}
.stat .k{font-size:11.5px;color:#8b949e;margin-bottom:5px}
.stat .v{font-size:22px;font-weight:600;line-height:1.2}
.stat .v small{font-size:12px;font-weight:400;color:#8b949e;margin-left:3px}
.stat.warn{border-color:#7a5c1a}
.stat.warn .v{color:#d29922}

/* 分区 / 卡片 */
.section{background:#12171e;border:1px solid #1b2432;border-radius:12px;margin-bottom:16px;overflow:hidden}
.section .hd{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #1b2432}
.section .hd h2{font-size:14.5px;margin:0;font-weight:500}
.section .hd .right{display:flex;gap:12px;align-items:center;font-size:12.5px}
.section .bd{padding:16px}
.section .bd.tight{padding:0}

/* 工具栏 / 筛选 */
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.toolbar .grow{flex:1}
.chip{display:inline-flex;align-items:center;gap:6px;padding:6px 13px;border-radius:8px;border:1px solid #2a323d;background:transparent;color:#8b949e;font:inherit;font-size:12.5px;cursor:pointer;transition:.12s}
.chip:hover{color:#e6e9ef;border-color:#3b4553}
.chip.on{border-color:#2f6feb;color:#e6e9ef;background:#1f6feb22}
.chip .n{font-size:11px;opacity:.7}
input[type=text],input[type=search],select{padding:8px 11px;border-radius:8px;border:1px solid #2a323d;background:#0b0f14;color:#e6e9ef;font:inherit;font-size:13px;outline:none}
input:focus,select:focus{border-color:#2f6feb;box-shadow:0 0 0 3px rgba(47,111,235,.14)}

/* 按钮 */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 15px;border-radius:8px;border:1px solid #2f6feb;background:#2f6feb;color:#fff;font:inherit;font-size:13px;cursor:pointer;text-decoration:none}
.btn:hover{background:#3b7bf5;text-decoration:none}
.btn.ghost{background:transparent;border-color:#2a323d;color:#a9b4c2}
.btn.ghost:hover{border-color:#3b4553;color:#e6e9ef;background:#161d26}
.btn.danger{background:transparent;border-color:#7a2e2e;color:#e5534b}
.btn.danger:hover{background:#7a2e2e22}
.btn.ok{background:transparent;border-color:#2ea043;color:#3fb950}
.btn.ok:hover{background:#2ea04322}
.btn:disabled{opacity:.45;cursor:not-allowed}

/* 表格 */
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;padding:11px 16px;font-weight:500;color:#8b949e;font-size:11.5px;border-bottom:1px solid #1b2432;background:#0f141a;white-space:nowrap}
.tbl td{padding:11px 16px;border-bottom:1px solid #161d26;vertical-align:middle}
.tbl tr:last-child td{border-bottom:0}
.tbl tr:hover td{background:#141a22}
.tbl .muted{color:#8b949e}
.tbl .empty{text-align:center;padding:36px;color:#8b949e}

/* 徽章 */
.pill{display:inline-block;padding:1.5px 9px;border-radius:20px;font-size:11.5px;line-height:1.6}
.pill.ok{background:#3fb95022;color:#3fb950}
.pill.warn{background:#d2992222;color:#d29922}
.pill.err{background:#e5534b22;color:#e5534b}
.pill.mute{background:#8b949e22;color:#8b949e}
.pill.blue{background:#2f6feb22;color:#6ea8fe}

/* 提示 */
.note{border-radius:9px;padding:11px 14px;font-size:12.5px;margin-bottom:14px}
.note.ok{background:#3fb95018;border:1px solid #2ea04355;color:#3fb950}
.note.err{background:#e5534b18;border:1px solid #7a2e2e;color:#f08c86}
.note.warn{background:#d2992218;border:1px solid #7a5c1a;color:#d29922}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
@media(max-width:820px){.layout{flex-direction:column}.sidebar{width:auto;height:auto;position:static;flex-direction:row;align-items:center;overflow-x:auto}.sidebar .brand{padding:0 12px 0 0}.sidebar nav{flex-direction:row}.sidebar .side-foot{border:0;padding:0}}
`

const esc = (v) => String(v == null ? '' : v).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
export { esc }

/** 侧边栏导航项：{ href, label, key, badge } */
export function sideNav(items, active) {
  return items.map((it) => '<a href="' + esc(it.href) + '"' + (it.key === active ? ' class="on"' : '') + '>'
    + '<span class="dot"></span>' + esc(it.label)
    + (it.badge ? ' <span class="pill ' + (it.badgeKind || 'warn') + '">' + esc(it.badge) + '</span>' : '')
    + '</a>').join('')
}

/** 整页骨架 */
export function adminShell({ title, subtitle, active, nav, body, version, flash, error }) {
  const notes = (flash ? '<div class="note ok">' + esc(flash) + '</div>' : '')
    + (error ? '<div class="note err">' + esc(error) + '</div>' : '')
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<link rel="icon" type="image/png" href="/api/icon.png">'
    + '<title>' + esc(title) + ' · 记忆云管理端</title>'
    + '<style>' + ADMIN_CSS + '</style></head><body>'
    + '<div class="layout">'
    + '<aside class="sidebar">'
    + '<div class="brand"><img src="/api/icon.png" alt=""><div><b>记忆云</b><span>管理端' + (version ? ' · v' + esc(version) : '') + '</span></div></div>'
    + '<nav>' + sideNav(nav, active) + '</nav>'
    + '<div class="side-foot"><a href="/api/console" style="font-size:12.5px;padding:0 11px">返回用户控制台</a><button id="out">退出登录</button></div>'
    + '</aside>'
    + '<main class="main"><div class="topbar"><div><h1>' + esc(title) + '</h1><div class="sub">' + esc(subtitle || '') + '</div></div></div>'
    + notes + body + '</main></div>'
    + '<script>document.getElementById("out").addEventListener("click",async function(){await fetch("/api/admin/logout",{method:"POST"}).catch(function(){});location.href="/api/admin"});</script>'
    + '</body></html>'
}

/** 统计卡 */
export function statCards(items) {
  return '<div class="stats">' + items.map((s) => '<div class="stat' + (s.warn ? ' warn' : '') + '">'
    + '<div class="k">' + esc(s.k) + '</div><div class="v">' + esc(s.v) + (s.unit ? '<small>' + esc(s.unit) + '</small>' : '') + '</div></div>').join('') + '</div>'
}

/** 分区卡片 */
export function section({ title, right, body, tight }) {
  return '<div class="section"><div class="hd"><h2>' + title + '</h2>' + (right ? '<div class="right">' + right + '</div>' : '') + '</div>'
    + '<div class="bd' + (tight ? ' tight' : '') + '">' + body + '</div></div>'
}