// 卡片标题 hover 颜色的守卫（用户实测反馈：鼠标划过白卡，黑标题突然变红，像"这张卡出错了"）。
//
// 规则：hover 只能**加下划线**表示可点，不许改标题文字颜色。
// 原因：标题色以前取 `--dsw-alias-brand-primary`，而在几套皮肤里它是高饱和状态色
// （spider #e62429 报错红 / pop #ff2e63 玫红 / resident #7cff3f 毒绿）—— 一 hover 就像故障态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

/** 取某条 CSS 规则（selector 精确匹配）的声明体；找不到返回 null。 */
function ruleBody(selector) {
  const i = css.indexOf(selector)
  if (i < 0) return null
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return css.slice(open + 1, close)
}

test('基础规则：hover 标题只加下划线，不设 color', () => {
  const body = ruleBody('.mc-cardrow:hover .mc-v5-card-title {')
  assert.ok(body, '找不到 .mc-cardrow:hover .mc-v5-card-title 规则')
  assert.match(body, /text-decoration:\s*underline/, 'hover 应该有下划线提示可点')
  assert.match(body, /text-decoration-color:/, '下划线颜色应取品牌色（保留皮肤观感）')
  assert.doesNotMatch(body, /(^|[;\s])color:/, 'hover 不许改标题文字颜色（会变成状态色，看着像报错）')
})

test('各皮肤覆盖：也不许把 hover 标题改成高饱和色', () => {
  // pop 皮肤历史上有一条 `color: var(--pop-red)`，现在应为 pop-ink
  const pop = ruleBody('[data-skin="pop"] .mc-cardrow:hover .mc-v5-card-title {')
  if (pop) {
    assert.doesNotMatch(pop, /(^|[;\s])color:\s*var\(--pop-red\)/, 'pop 皮肤 hover 标题不该用 pop-red 当文字色')
    assert.match(pop, /text-decoration-color:/, 'pop 的下划线颜色可以继续用 pop-red')
  }
  for (const m of css.matchAll(/\[data-skin="[a-z]+"\] \.mc-cardrow:hover \.mc-v5-card-title \{[^}]*\}/g)) {
    const decl = m[0]
    const colorDecl = /(?:^|[\s{;])color:\s*([^;]+);/.exec(decl)
    if (!colorDecl) continue
    const value = colorDecl[1].trim()
    assert.ok(
      /var\(--(sp-ink|pop-ink|dsw-alias-label-primary)|#(0b0b0f|17130b|1c1c1e)/i.test(value),
      '皮肤里 hover 标题只能是"墨色类"变量，实际是：' + value,
    )
  }
})

test('构建产物里同样生效（先 node build.mjs 再跑本测试）', () => {
  const built = readFileSync(path.join(root, 'web/app.js'), 'utf8')
  const at = built.indexOf('.mc-cardrow:hover .mc-v5-card-title')
  assert.ok(at > 0, 'web/app.js 里找不到 hover 标题规则（是不是没跑 build？）')
  const body = built.slice(at, built.indexOf('}', at))
  assert.match(body, /text-decoration:\s*underline/, '产物里的 hover 规则应有下划线')
  assert.doesNotMatch(body, /(^|[;\s])color:/, '产物里的 hover 规则不该再设 color')
})
