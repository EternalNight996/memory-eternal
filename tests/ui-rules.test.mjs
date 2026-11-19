// UI 硬规则守卫（源码级，防回退）
//   ① 每一处 <EmptyState …/> 都必须带 hint（「暂无数据」不算空态）；
//   ② 每一处 <ErrorBar …/> 都要能重试或给下一步（有 onRetry 或 extra）；
//   ③ 每个视图块内 <Btn variant="primary"> 最多 1 个（一屏一颗主按钮）；
//   ④ 旧的伪主按钮 me-on 只减不增（基线锁定，防止继续扩散）。
// 这些都是「体验一致性」的可执行版本：规范写在 docs/DESIGN.md，守在这里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = 'src/client/index.tsx'
const src = fs.readFileSync(SRC, 'utf8')

/** 取所有匹配开标签后的片段（到自闭合 /> 或下一个 </），用于检查属性。 */
function tagsOf(name) {
  const out = []
  const re = new RegExp('<' + name + '\\b[\\s\\S]{0,600}?/>', 'g')
  let m
  while ((m = re.exec(src))) out.push({ at: src.slice(0, m.index).split('\n').length, text: m[0] })
  return out
}

test('EmptyState 必须带 hint（禁止「暂无数据」式空态）', () => {
  const bad = tagsOf('EmptyState').filter((x) => !/\bhint=\{?/.test(x.text) && !/\bhint=/.test(x.text))
  assert.equal(bad.length, 0, '这些 EmptyState 缺少 hint：行 ' + bad.map((x) => x.at).join(', '))
})

test('ErrorBar 必须能重试或给下一步', () => {
  const bad = tagsOf('ErrorBar').filter((x) => !/onRetry=/.test(x.text) && !/extra=/.test(x.text))
  assert.equal(bad.length, 0, '这些 ErrorBar 既不能重试也没有下一步：行 ' + bad.map((x) => x.at).join(', '))
})

/**
 * 多页 / 多态组件的既有主按钮**基线**：只允许下降，不许再涨。
 *
 * 为什么需要基线，而不是把所有组件都压到 1 颗：
 *   · ConfigPanel 是 5 个分页的配置面板，且同一块里还有**互斥状态**
 *     （未登录 → 只有「登录」；已登录 → 只有「上传」；「客户端 / 商户接入」是两个页签）——
 *     同一时刻屏幕上真能看见的主按钮仍然是一颗，但「源码里数 variant="primary"」看不出条件分支。
 *   · 硬压成 1 会让守卫逼出错误的设计（把真正的主动作降级成次要按钮）。
 * 所以：**新组件一律 ≤1 颗**；已存在的多页组件锁基线，任何新增都会被挡住。
 */
// 8 → 9（2026-11-15）：换库改成了「下拉只选中 + 立即切换（弹窗确认）」后，
// 「立即切换」是该区块的主动作、「确认切换」是弹窗自己的主动作（弹窗算独立一屏），
// 原有「上传」降为次要按钮 —— 净增 1 颗，同屏可见的主按钮仍是一颗。
const PRIMARY_BASELINE = { ConfigPanel: 9 }

test('每个组件体内最多一个 primary 按钮（多页/多态组件按基线只减不增）', () => {
  // 按组件（function / const 大写开头）切分：一个面板组件里堆 2~3 颗主按钮，
  // 就是「用户不知道该点哪个」的直接原因。跨组件拼屏由使用方自己克制，这里守组件级。
  const bounds = []
  const re = /^(?:export )?(?:function ([A-Z][\w]*)|const ([A-Z][\w]*) = )/gm
  let m
  while ((m = re.exec(src))) bounds.push({ name: m[1] || m[2], at: m.index, line: src.slice(0, m.index).split('\n').length })
  const seen = new Set()
  const offenders = []
  for (let i = 0; i < bounds.length; i++) {
    const from = bounds[i].at
    const to = i + 1 < bounds.length ? bounds[i + 1].at : src.length
    const block = src.slice(from, to)
    const n = (block.match(/variant="primary"/g) || []).length
    const name = bounds[i].name
    seen.add(name)
    const limit = Number.isInteger(PRIMARY_BASELINE[name]) ? PRIMARY_BASELINE[name] : 1
    if (n > limit) offenders.push({ component: name, line: bounds[i].line, n, limit })
  }
  assert.deepEqual(offenders, [], '这些组件的 primary 按钮超过上限（新组件 1 颗 / 老组件按基线）：' + JSON.stringify(offenders))
  // 基线不许变成「写给不存在的组件」的历史垃圾：改名/删除后必须同步清理
  const stale = Object.keys(PRIMARY_BASELINE).filter((k) => !seen.has(k))
  assert.deepEqual(stale, [], '基线里这些组件已经不存在（改名或删除），请同步清理：' + JSON.stringify(stale))
})

test('旧的伪主按钮 me-on 只减不增（基线锁定）', () => {
  const n = (src.match(/\bme-on\b/g) || []).length
  // 基线：接入设计系统时是 42；只允许下降，新增会在 CI 里挡住
  assert.ok(n <= 42, `me-on 出现 ${n} 次，超过基线 42 —— 新代码请用 <Btn variant="primary">`)
})

// issue #68：关于页的「GitHub 仓库」按钮曾指向已废弃的 mengbot-ai/memory-eternal（404）。
test('关于页 GitHub 仓库链接指向本仓库（issue #68）', () => {
  assert.doesNotMatch(src, /mengbot-ai\/memory-eternal/, '不能用已废弃的 mengbot-ai 仓库地址')
  assert.match(src, /github\.com\/EternalNight996\/memory-eternal/, '必须指向本仓库')
})

// issue #67：面板「查看库」作用域（cookie 传递，服务端只认配置里的 profile 名）
test('查看库作用域入口存在（issue #67）', () => {
  assert.match(src, /me_view_vault/, 'cookie 名必须是 me_view_vault')
  assert.match(src, /viewVaultHint/, '要有作用域说明文案')
  assert.match(src, /setViewVaultCookie/, '切换时必须写 cookie')
})
