// 弹窗右上角窗口控制条（左栏「记忆」/「配置」打开的全屏弹窗）的落地守卫。
//
// 背景（用户反馈）：
//   ① 「右上角的缩小 / 关闭用不了」——根因不是按钮没绑事件，而是弹窗高度 98vh + 遮罩 56px
//      内边距在多数窗口高度下溢出，flex 居中把弹窗顶边顶出可视区；Windows 桌面版更狠：
//      遮罩只下移了 caption 高度，弹窗又被顶回 caption 区，控制条正好压在原生「最小化/关闭」
//      上，点击被系统按钮接管。修法：把弹窗高度夹进可视区（Windows 再减 caption），
//      居中恒等于顶对齐，控制条永远落在 caption 下方。
//   ② 「丑」——原来是「半透明灰胶囊 + 两颗带边框方块（⤢ / × 字符）」。改成桌面客户端
//      标题栏风格：扁平、细线内联 SVG、悬停才出底、关闭悬停变红。
// 本守卫钉死：高度约束、两颗按钮的尺寸/悬停态、iframe 安全区宽度、以及「不许退回字符图标」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

const src = read('src/client/index.tsx')
// 只认真正会被 <style>{CSS}</style> 注入的那段模板（与 issue-46 守卫同款提取方式）。
const CSS_HEAD = 'const CSS = `'
const head = src.indexOf(CSS_HEAD)
const bodyStart = head === -1 ? -1 : head + CSS_HEAD.length
const bodyEnd = bodyStart === -1 ? -1 : src.indexOf('`', bodyStart)
const css = bodyStart === -1 || bodyEnd === -1 ? '' : src.slice(bodyStart, bodyEnd)
const decls = css.replace(/\/\*[\s\S]*?\*\//g, '')

function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = decls.match(new RegExp('(^|\\n)' + esc + ' \\{([\\s\\S]*?)\\}'))
  return m ? m[0] : null
}

test('① 满屏弹窗必须装得进可视区：高度夹死（浏览器 + Windows 桌面版各一条）', () => {
  assert.ok(css.length > 1000, '没找到 client 的 CSS 模板 —— 提取方式与源码结构对不上了，先修测试')

  // 基础弹窗保持 98vh（issue-46 守卫也钉着这条），真正约束来自更具体的 clamp 规则。
  const modal = rule('.me-modal')
  assert.ok(modal, '缺 .me-modal 基础规则')
  assert.match(modal, /height:\s*min\(98vh,\s*1080px\)/)

  const fit = rule('.me-overlay-top .me-modal:not(.me-modal-full)')
  assert.ok(fit, '缺浏览器下的弹窗高度约束：98vh + 56px 内边距会溢出，弹窗顶边被顶出可视区')
  assert.match(fit, /height:\s*min\(calc\(100vh - 56px\),\s*1080px\)/, '高度要正好等于「可视高 − 上下 28px 内边距」')
  assert.match(fit, /max-height:\s*calc\(100vh - 56px\)/, 'max-height 同步夹住，防止别的规则把它撑回来')

  const winFit = rule('[data-windows-titlebar] .me-overlay-top .me-modal:not(.me-modal-full)')
  assert.ok(winFit, '缺 Windows 桌面版的弹窗高度约束：顶边会被顶回 caption 区，控制条压在原生关闭按钮上')
  assert.match(winFit, /height:\s*min\(calc\(100vh - var\(--dsh-windows-titlebar-height,\s*0px\) - 56px\),\s*1080px\)/,
    'Windows 要把 caption 高度一起减掉（宿主的 data-windows-titlebar 约定）')
  assert.match(winFit, /max-height:\s*calc\(100vh - var\(--dsh-windows-titlebar-height,\s*0px\) - 56px\)/)

  // Windows 既有的「遮罩下移 caption」与全屏让位规则不能被弄丢。
  assert.match(css, /\[data-windows-titlebar\] \.me-overlay-top,\s*\[data-windows-titlebar\] \.me-overlay \{\s*top: var\(--dsh-windows-titlebar-height/,
    'Windows 遮罩让位规则被弄丢了')
  assert.match(css, /\[data-windows-titlebar\] \.me-modal-full \{\s*top: var\(--dsh-windows-titlebar-height/,
    'Windows 全屏弹窗的让位规则被弄丢了')
})

test('② 控制条改成桌面客户端标题栏风格：扁平、细线、悬停才出底、关闭悬停变红', () => {
  const bar = rule('.me-wctl')
  assert.ok(bar, '缺 .me-wctl 控制条容器规则')
  assert.match(bar, /position:\s*absolute/)
  assert.match(bar, /top:\s*0/)
  assert.match(bar, /right:\s*0/)
  assert.match(bar, /z-index:\s*30/, '必须压在 iframe 之上（原来 z-index:10 已够，这里留出余量）')

  const btn = rule('.me-wctl-btn')
  assert.ok(btn, '缺 .me-wctl-btn 规则')
  assert.match(btn, /width:\s*46px/)
  assert.match(btn, /height:\s*54px/, '格子高度必须等于 iframe 顶栏行高（否则图标不在同一水平中线）')
  assert.match(btn, /background:\s*transparent/, '默认必须无底无色块（参考桌面标题栏）')
  assert.match(btn, /border:\s*0/, '不许再有灰胶囊里的方块边框')

  const hover = rule('.me-wctl-btn:hover')
  assert.ok(hover, '缺悬停态：悬停才出现浅底')
  assert.match(hover, /background:\s*rgba\(127,127,127,\.16\)/)
  const closeHover = rule('.me-wctl-close:hover')
  assert.ok(closeHover, '缺关闭键悬停态')
  assert.match(closeHover, /background:\s*#e81123/, '关闭键悬停应变红（桌面客户端惯例）')
  assert.match(closeHover, /color:\s*#fff/)

  const icon = rule('.me-wctl-btn svg')
  assert.ok(icon, '缺图标尺寸规则')
  assert.match(icon, /width:\s*13px/)

  // 窄屏跟着 iframe 顶栏的两个断点收：50px / 46px 行高，宽度 44px（2 × 44 = 88 ≤ 96 安全区）。
  assert.match(decls, /@media \(max-width: 816px\) \{ \.me-wctl-btn \{ height: 50px; \} \}/, '窗口 ≤816 时要对齐 iframe 顶栏 50px 行高')
  assert.match(decls, /@media \(max-width: 776px\) \{ \.me-wctl-btn \{ width: 44px; height: 46px; \} \}/, '窗口 ≤776 时要对齐 iframe 顶栏 46px 行高并收窄到 44px')
})

test('③ iframe 顶栏安全区要盖住控制条宽度（宽屏 108 / 窄屏 ≥ 88）', () => {
  assert.match(decls, /\.mc-v5-top\.in-host \{\s*padding-right:\s*108px/, '宽屏安全区被改小了：两颗 46px 按钮会压住「? / Star」')
  const narrow = decls.match(/\.mc-v5-top\.in-host \{\s*padding-right:\s*(\d+)px/)
  // 第一条命中是宽屏 108；窄屏那条在 media query 里，单独取。
  const narrowMatch = decls.match(/@media \(max-width: 760px\)[^{]*\{[\s\S]*?\.mc-v5-top\.in-host \{\s*padding-right:\s*(\d+)px/)
  assert.ok(narrowMatch, '缺窄屏安全区')
  const px = Number(narrowMatch[1])
  assert.ok(px >= 88, '窄屏安全区 ' + px + 'px < 88px：控制条会压住 iframe 顶栏的「?」')
})

test('④ 控制条渲染走类名 + 内联 SVG 图标，事件仍绑在按钮上（不许退回字符图标）', () => {
  const start = src.indexOf('function WebModal(')
  assert.ok(start > 0, '找不到 WebModal 组件')
  const end = src.indexOf('function DatabaseIcon(', start)
  assert.ok(end > start, '找不到 WebModal 结束边界')
  const body = src.slice(start, end)

  assert.match(body, /className="me-wctl"/, '控制条容器没用 .me-wctl 类')
  assert.match(body, /className="me-wctl-btn me-wctl-close"/, '关闭键没用 .me-wctl-close')
  assert.match(body, /data-me-wctl=\{full \? 'restore' : 'full'\}/, '全屏/还原状态要能自检（data-me-wctl）')
  assert.match(body, /aria-pressed=\{full\}/, '全屏键要有 aria-pressed')
  assert.match(body, /onClick=\{\(\) => setFull\(\(f\) => !f\)\}/, '全屏 toggle 的点击处理被弄丢了')
  assert.match(body, /onClick=\{onClose\}/, '关闭键的点击处理被弄丢了')
  assert.match(body, /<WctlMaximizeGlyph \/>/, '缺最大化图标')
  assert.match(body, /<WctlRestoreGlyph \/>/, '缺还原图标')
  assert.match(body, /<WctlCloseGlyph \/>/, '缺关闭图标')

  // 不许再用字体字符画按钮（换机器/换字体就变形），也不许保留旧灰胶囊内联样式。
  assert.doesNotMatch(body, /⤢|⤡/, '又在用 ⤢/⤡ 字符图标了')
  assert.doesNotMatch(body, /rgba\(255,255,255,0\.08\)/, '旧灰胶囊按钮的内联样式没删干净')
  assert.doesNotMatch(body, /backdropFilter/, '旧灰胶囊的毛玻璃底没删干净')

  // 三个图标组件必须在源码里真实存在。
  for (const name of ['WctlMaximizeGlyph', 'WctlRestoreGlyph', 'WctlCloseGlyph']) {
    assert.match(src, new RegExp('function ' + name + '\\(\\)'), '缺 ' + name + ' 定义')
  }
})

test('⑤ 控制条与 iframe 顶栏「同一基线」：格子行高必须跟顶栏行高一一对应', () => {
  const topbar = rule('.me-v5 .mc-v5-top')
  assert.ok(topbar, '缺 .mc-v5-top 规则')
  const h = topbar.match(/height:\s*(\d+)px/)
  const btn = rule('.me-wctl-btn')
  const bh = btn.match(/height:\s*(\d+)px/)
  assert.ok(h, '.mc-v5-top 没解析到高度')
  assert.ok(bh, '.me-wctl-btn 没解析到高度')
  assert.equal(bh[1], h[1], '按钮格子高度 ' + bh[1] + 'px ≠ 顶栏行高 ' + h[1] + 'px：图标会高/低于「本地运行 / 版本 / Star / ?」中线（用户反馈的「没对齐居中」）')

  // 窄屏两个断点也必须成对出现：iframe 50/46 ↔ 控制条 50/46。
  assert.match(decls, /@media \(max-width: 760px\)[^{]*\{[^}]*\.mc-v5-top \{ height: 50px;/, 'iframe 窄屏顶栏 50px 规则没了')
  assert.match(decls, /@media \(max-width: 720px\) \{[\s\S]*?\.me-v5 \.mc-v5-top \{ height: 46px;/, 'iframe 窄屏顶栏 46px 规则没了')
})

test('⑥ 构建产物里带上新规则与类名（先 node build.mjs，再跑本测试）', () => {
  let checked = 0
  for (const f of ['lib/client.js', 'web/app.js']) {
    const p = path.join(root, f)
    if (!fs.existsSync(p)) continue
    const built = fs.readFileSync(p, 'utf8')
    assert.ok(built.includes('.me-wctl'), f + ' 里没有控制条样式 —— 忘了 node build.mjs，或 CSS 没被打进 bundle')
    assert.ok(built.includes('--dsh-windows-titlebar-height, 0px) - 56px'), f + ' 里缺少 Windows 弹窗高度约束')
    assert.ok(built.includes('me-wctl-close'), f + ' 里没有关闭键的类名')
    checked++
  }
  assert.ok(checked > 0, 'lib/client.js 与 web/app.js 都不存在：先跑 node build.mjs')
})

test('⑦ package.json 的 test 链包含本守卫', () => {
  const pkg = JSON.parse(read('package.json'))
  const chain = String(pkg.scripts && pkg.scripts.test)
  assert.ok(chain.includes('node tests/window-controls.test.mjs'), '本守卫没接进 npm test —— 等于没写')
})
