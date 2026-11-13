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

test('每个组件体内最多一个 primary 按钮（近似「一屏一颗」）', () => {
  // 按组件（function / const 大写开头）切分：一个面板组件里堆 2~3 颗主按钮，
  // 就是「用户不知道该点哪个」的直接原因。跨组件拼屏由使用方自己克制，这里守组件级。
  const bounds = []
  const re = /^(?:export )?(?:function ([A-Z][\w]*)|const ([A-Z][\w]*) = )/gm
  let m
  while ((m = re.exec(src))) bounds.push({ name: m[1] || m[2], at: m.index, line: src.slice(0, m.index).split('\n').length })
  const offenders = []
  for (let i = 0; i < bounds.length; i++) {
    const from = bounds[i].at
    const to = i + 1 < bounds.length ? bounds[i + 1].at : src.length
    const block = src.slice(from, to)
    const n = (block.match(/variant="primary"/g) || []).length
    if (n > 1) offenders.push({ component: bounds[i].name, line: bounds[i].line, n })
  }
  assert.deepEqual(offenders, [], '这些组件里 primary 按钮超过 1 个：' + JSON.stringify(offenders))
})

test('旧的伪主按钮 me-on 只减不增（基线锁定）', () => {
  const n = (src.match(/\bme-on\b/g) || []).length
  // 基线：接入设计系统时是 42；只允许下降，新增会在 CI 里挡住
  assert.ok(n <= 42, `me-on 出现 ${n} 次，超过基线 42 —— 新代码请用 <Btn variant="primary">`)
})
