// 回归：模型吐多个 JSON 对象时，解析要取**第一个完整对象**而不是把两个拼一起。
//
// 现场（2026-11-14 用户环境）：
//   蒸馏失败 code=UNPARSEABLE_OUTPUT
//   原因：JSON.parse 原始报错 Unexpected non-whitespace character after JSON at position 969
//
// 根因：旧实现用 lastIndexOf('}') 取"最后一个右括号"，
// 模型输出 `{"a":1}\n{"b":2}` 时 slice 出来是两个对象拼在一起 → 解析必失败。
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCaptureJsonDetailed } from '../lib/capture.js'

/** 造一张能通过卡片体检的卡（标题够长、正文够长）。 */
const card = (tag) => JSON.stringify({
  title: tag + '：一个足够长的标题用来通过卡片体检检查',
  kind: 'knowledge',
  body: '## 背景\n\n' + '这是正文内容，需要足够长才能通过卡片体检的最小长度要求。'.repeat(6),
  tags: ['test', 'json'],
})

test('单个对象（基线）能解析', () => {
  const r = parseCaptureJsonDetailed(card('基线'))
  assert.ok(r.card, '单对象必须能解析：' + r.error)
  assert.match(r.card.title, /^基线/)
})

test('两个对象连排 → 取第一个（用户报错的场景）', () => {
  const text = card('第一张') + '\n' + card('第二张')
  // 先证明旧逻辑确实会炸：整段从首 { 到末 } 是两个对象拼一起
  assert.throws(() => JSON.parse(text), /Unexpected non-whitespace character|after JSON/)
  const r = parseCaptureJsonDetailed(text)
  assert.ok(r.card, '两个对象时必须取到第一个：' + r.error)
  assert.match(r.card.title, /^第一张/)
})

test('对象后跟说明文字 → 仍能解析', () => {
  const text = card('带说明') + '\n\n以上是蒸馏结果，请审核。'
  const r = parseCaptureJsonDetailed(text)
  assert.ok(r.card, '尾随文字不该导致失败：' + r.error)
  assert.match(r.card.title, /^带说明/)
})

test('三个对象连排 → 取第一个', () => {
  const text = card('A') + card('B') + card('C')
  const r = parseCaptureJsonDetailed(text)
  assert.ok(r.card, '三对象必须取到第一个：' + r.error)
  assert.match(r.card.title, /^A/)
})

test('正文里的花括号代码块不会被误当成对象边界', () => {
  const text = JSON.stringify({
    title: '含代码块的卡片标题足够长',
    kind: 'knowledge',
    body: '```js\nif (x) { y() }\n```\n\n' + '补充正文让长度达标。'.repeat(10),
  })
  const r = parseCaptureJsonDetailed(text)
  assert.ok(r.card, '花括号在字符串内不该被当边界：' + r.error)
  assert.match(r.card.title, /含代码块/)
  assert.match(r.card.body, /if \(x\) \{ y\(\) \}/, '代码块原样保留')
})

test('纯散文（无 JSON）→ noJson=true，与"格式写坏"区分开', () => {
  const r = parseCaptureJsonDetailed('这是一段说明文字，没有任何 JSON 对象。')
  assert.equal(r.card, null)
  assert.equal(r.noJson, true, '纯散文要标记 noJson，调用方据此换模型而不是重试')
})

test('JSON 围栏（```json）能被剥掉', () => {
  const r = parseCaptureJsonDetailed('```json\n' + card('围栏') + '\n```')
  assert.ok(r.card, '围栏必须能剥：' + r.error)
  assert.match(r.card.title, /^围栏/)
})
