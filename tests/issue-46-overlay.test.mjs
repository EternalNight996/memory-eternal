// issue #46 的落地守卫：macOS 桌面版窗口左上角「红绿灯」遮住记忆库弹窗。
//
// 事实（已在本机官方桌面版 app.asar 里核实，不是猜的）：
//   · macOS 端是 Electron 的 titleBarStyle: hiddenInset + trafficLightPosition {x:16, y:18}，
//     「关闭 / 最小化 / 缩放」是**原生窗口控件**，由系统画在网页内容之上 —— 它不是 DOM，
//     插件用 z-index / portal / 更高层浮层都**盖不住**它（这条结论写进了源码注释，见 ③）；
//   · 宿主 @deepseek-ai/dsh-client-ui-layout 在 <html> 上发布安全区：
//       data-platform="darwin"（**只**由桌面版 preload 写入，普通浏览器文档没有）、
//       --dsh-frame-top-clearance（macOS 48px）、
//       --dsh-frame-overlay-top（对话框/菜单顶边，macOS 68px，原生全屏自动降到 20px）。
//   · 宿主的文字说明同样在 app.asar 里：「The root publishes --dsh-frame-top-clearance for the
//     reserved strip (48px on macOS, the caption height on Windows), and --dsh-frame-overlay-top
//     adds 20px for dialogs and menus.」
// 所以插件侧唯一可行的修法是「让开」，不是「改层级」。本守卫钉死：
//   ① 四条让位规则都在**注入页面的 CSS**里（不是写在源码别处的死字符串）；
//   ② 只对 [data-platform=darwin] 生效 —— 浏览器 / Windows 的行为一点没变；
//   ③ 结论与上游建议写在注释里，避免后人把它当成多余的魔法数字删掉；
//   ④ 构建产物里确实带上了它；
//   ⑤ package.json 的 test 链包含本文件（否则这条守卫会悄悄失效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

const src = read('src/client/index.tsx')
// 只认真正会被 <style>{CSS}</style> 注入的那段模板；源码其它位置出现同名 token 不算数。
// 模板里没有转义反引号，所以「起始反引号之后的第一个反引号」就是模板结尾（不要按 \n 找：
// 仓库里有文件是 CRLF）。
const CSS_HEAD = 'const CSS = `'
const head = src.indexOf(CSS_HEAD)
const bodyStart = head === -1 ? -1 : head + CSS_HEAD.length
const bodyEnd = bodyStart === -1 ? -1 : src.indexOf('`', bodyStart)
const css = bodyStart === -1 || bodyEnd === -1 ? '' : src.slice(bodyStart, bodyEnd)
/** 去掉注释后的 CSS：断言「会不会真的生效」时只看声明，不看说明文字。 */
const decls = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取出以行首选择器开头的单条规则（选择器 + { ... }）；找不到返回 null。 */
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = decls.match(new RegExp('(^|\\n)' + esc + ' \\{([\\s\\S]*?)\\}'))
  return m ? m[0] : null
}

test('① 注入的 CSS 里有 macOS 安全区：浮层顶边跟随宿主的 --dsh-frame-overlay-top（issue #46）', () => {
  assert.ok(css.length > 1000, '没找到 client 的 CSS 模板 —— 提取方式与源码结构对不上了，先修测试')

  const overlay = rule('[data-platform=darwin] .me-overlay-top')
  assert.ok(overlay, '缺 macOS 浮层让位规则：[data-platform=darwin] .me-overlay-top')
  assert.match(overlay, /padding-top:\s*var\(--dsh-frame-overlay-top,\s*68px\)/,
    '顶边必须让到宿主安全区下沿（并保留 68px 兜底：老宿主没发布变量时也得让开红绿灯）')
  assert.match(overlay, /padding-bottom:\s*16px/, '底部留 16px，别把对话框顶到窗口下沿')

  // 关键：高度正好等于「可视高 - 安全区 - 16px」，居中即等于顶对齐（顶边恒为 68px）。
  // 只加 padding-top 而不收高度的话，98vh 的高弹窗居中溢出会把顶边又顶回 ~1vh（原 bug）。
  const modal = rule('[data-platform=darwin] .me-overlay-top .me-modal:not(.me-modal-full)')
  assert.ok(modal, '缺 macOS 弹窗高度约束：只加 padding 不收高度时，居中溢出会把顶边顶回红绿灯下面')
  assert.match(modal, /height:\s*min\(calc\(100vh - var\(--dsh-frame-overlay-top,\s*68px\) - 16px\),\s*1080px\)/,
    '高度要正好填满安全区后的剩余空间（并保留 1080px 上限）')

  const dialog = rule('[data-platform=darwin] .me-overlay')
  assert.ok(dialog, '阅读器 / 新建卡 / 导出等小对话框也要让位')
  assert.match(dialog, /padding-top:\s*var\(--dsh-frame-overlay-top,\s*68px\)/,
    '导出全屏模式会顶到 24px，小对话框同样要避开顶带')

  const full = rule('[data-platform=darwin] .me-modal-full')
  assert.ok(full, '弹窗自身的全屏模式也要让位（它是 position: fixed，不吃外层的 padding）')
  assert.match(full, /top:\s*var\(--dsh-frame-overlay-top,\s*68px\)/)
  assert.match(full, /height:\s*calc\(100vh - var\(--dsh-frame-overlay-top,\s*68px\)\)/)
  assert.match(full, /max-height:\s*calc\(100vh - var\(--dsh-frame-overlay-top,\s*68px\)\)/)
})

test('② 浏览器 / Windows 行为不变：让位只发生在 darwin 桌面版作用域内', () => {
  // 遮罩仍铺满全屏 —— 弹窗打开时背景点击依旧被挡住（宿主自己的 modal 层也是这个前提）。
  const overlay = rule('.me-overlay-top')
  assert.ok(overlay, '缺 .me-overlay-top 基础规则')
  assert.match(overlay, /position:\s*fixed;\s*inset:\s*0/, '遮罩必须继续铺满全屏（只让内容避让，不让遮罩缩水）')
  assert.match(overlay, /z-index:\s*2147483000/)
  assert.match(src, /createPortal\(overlay, document\.body\)/, '记忆窗口必须 portal 到 body，脱离第三方插件的 stacking context')

  // 弹窗默认高度还是 98vh：浏览器与 Windows 上的观感不受 issue #46 的改动影响。
  const modal = rule('.me-modal')
  assert.ok(modal, '缺 .me-modal 基础规则')
  assert.match(modal, /height:\s*min\(98vh,\s*1080px\)/, '浏览器 / Windows 的弹窗高度不能被改掉')

  // Windows 那条既有的让位规则原样保留（两个平台各用各的标记）。
  assert.match(css, /\[data-windows-titlebar\] \.me-overlay-top,\s*\[data-windows-titlebar\] \.me-overlay \{\s*top: var\(--dsh-windows-titlebar-height/,
    'Windows 的让位规则被弄丢了 —— 两个平台互不影响，别互相覆盖')
  assert.match(css, /\[data-windows-titlebar\] \.me-modal-full \{\s*top: var\(--dsh-windows-titlebar-height/,
    'Windows 的全屏让位规则被弄丢了')

  // 硬约束：安全区变量只能出现在 darwin 作用域里，否则浏览器里会凭空多出 68px 空白。
  assert.match(decls, /--dsh-frame-overlay-top/, '声明里根本没用到宿主安全区变量')
  const withoutDarwin = decls.replace(/\[data-platform=darwin\][^{]*\{[^}]*\}/g, '')
  assert.doesNotMatch(withoutDarwin, /--dsh-frame-overlay-top/,
    'macOS 安全区变量跑到无条件规则里了：普通浏览器会跟着让出 68px')
  assert.doesNotMatch(withoutDarwin, /--dsh-frame-top-clearance/,
    '同上：--dsh-frame-top-clearance 也必须在 darwin 作用域内使用')
  assert.doesNotMatch(withoutDarwin, /data-platform=darwin/,
    'darwin 选择器必须带在规则上，不能残留裸用法')

  // 反向断言：插件不可能靠「更高层」盖住红绿灯 —— 不许有人加这种自欺欺人的写法。
  assert.doesNotMatch(decls, /-webkit-app-region:\s*drag/, '插件的浮层不参与窗口拖拽区（那是宿主 chrome 的职责）')
})

test('③ 宿主层结论 + 上游建议写在注释里（给后来者与 issue #46 的答复）', () => {
  const at = src.indexOf('macOS 桌面版：让开窗口左上角的红绿灯')
  assert.ok(at > 0, '缺 issue #46 的结论注释块')
  const end = src.indexOf('*/', at)
  assert.ok(end > at, '结论注释块没闭合')
  const note = src.slice(at, end)

  const must = [
    [/issue #46/, '要能按 issue 号追溯'],
    [/原生/, '要写明窗口按钮是原生控件（不是宿主画上去的 DOM）'],
    [/z-index/, '要写明 z-index / 层叠顺序救不了它 —— 否则后人会去调 z-index 白忙一场'],
    [/宿主/, '要说清这是宿主层的问题'],
    [/data-platform/, '要写明生效条件（桌面版 preload 才写这个属性）'],
    [/--dsh-frame-overlay-top/, '要写清跟随的是宿主的哪个安全区变量'],
    [/全屏/, '要写清原生全屏时宿主自己会把安全区降到 20px'],
  ]
  for (const [re, why] of must) assert.match(note, re, `结论注释缺少要点：${why}`)

  // 上游建议：宿主应把「插件浮层避让」写进公开契约（我们已经在用它的变量，但它没对插件作者公开）。
  assert.match(note, /让开/, '要写清插件侧只能「让开」这块矩形')
  assert.match(src, /--dsh-frame-top-clearance|--dsh-frame-overlay-top/, '要引用宿主发布的真实变量名')
})

test('④ 构建产物里确实带上了这条规则（先 node build.mjs，再跑本测试）', () => {
  const artifacts = ['lib/client.js', 'web/app.js']
  let checked = 0
  for (const f of artifacts) {
    const p = path.join(root, f)
    if (!fs.existsSync(p)) continue // 源码树 / 精简安装（web-assets 兜底场景）下允许缺产物
    const built = fs.readFileSync(p, 'utf8')
    assert.ok(built.includes('data-platform=darwin'),
      `${f} 里没有 macOS 安全区规则 —— 忘了 node build.mjs，或 CSS 没被打进 bundle`)
    assert.ok(built.includes('--dsh-frame-overlay-top'),
      `${f} 缺少宿主安全区变量名，运行时避让不会生效`)
    checked++
  }
  assert.ok(checked > 0, 'lib/client.js 与 web/app.js 都不存在：先跑 node build.mjs')
})

test('⑤ package.json 的 test 链包含本守卫', () => {
  const pkg = JSON.parse(read('package.json'))
  const chain = String(pkg.scripts && pkg.scripts.test)
  assert.ok(chain.includes('node tests/issue-46-overlay.test.mjs'),
    '本守卫没接进 npm test —— 等于没写')
})
