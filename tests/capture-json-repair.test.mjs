// 蒸馏输出解析的容错守卫（10/8 实测现场）：模型在字符串里写裸引号 → JSON.parse 报
// 「Expected ',' or '}' after property value」。这类输出以前必然落 UNPARSEABLE_OUTPUT，
// 白烧一次 LLM 调用 + 退化成原文卡。修法见 lib/capture.js 的 repairUnescapedQuotes。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCaptureJsonDetailed, repairUnescapedQuotes, repairJsonControlChars, looksTruncatedJson } from '../lib/capture.js'

const body = (s) => '# 标题\n\n' + s + '\n\n' + '细节细节细节'.repeat(6)

test('合法 JSON：原样解析，且任何修复器都判定「不用改」（不能被启发式改坏）', () => {
  const text = JSON.stringify({ save: true, title: '正常卡', kind: 'knowledge', tags: ['a'], body: body('一切正常') })
  const out = parseCaptureJsonDetailed(text)
  assert.ok(out.card, '合法 JSON 必须解析成卡')
  assert.equal(out.repaired, false, '不该走任何修复路径')
  assert.equal(repairUnescapedQuotes(text).repaired, false, '引号修复对合法 JSON 必须是恒等变换')
  assert.equal(repairJsonControlChars(text).repaired, false, '控制字符修复对合法 JSON 也必须是恒等变换')
  // 字符串里带**已转义**引号与逗号：属于合法 JSON，不能被当成「裸引号」
  const tricky = JSON.stringify({ save: true, title: '含引号', kind: 'knowledge', body: body('运行 "npm test" 时，注意 "a,b"') })
  assert.equal(repairUnescapedQuotes(tricky).repaired, false)
  assert.ok(parseCaptureJsonDetailed(tricky).card)
})

test('裸引号（10/8 现场）：补转义后能解析，且正文里的引号被保留', () => {
  // 手工构造：正文里的 " 没有转义 —— 模型真实输出就长这样
  const raw = '{"save": true, "title": "裸引号现场", "kind": "knowledge", "tags": ["npm"], "body": "' + body('运行 "npm test" 时崩了') + '"}'
  assert.equal(looksTruncatedJson(raw), false, '括号是闭合的，不是截断')
  let rawValid = true
  try { JSON.parse(raw) } catch { rawValid = false }
  assert.equal(rawValid, false, '原始输出必须确实不是合法 JSON —— 这正是那条 UNPARSEABLE_OUTPUT 的现场')
  assert.equal(repairUnescapedQuotes(raw).repaired, true, '修复器要认出它需要补转义')
  const after = parseCaptureJsonDetailed(raw)
  assert.ok(after.card, '加上引号修复候选后必须能解析成卡')
  assert.match(after.card.body, /"npm test"/, '正文里的引号要原样保留')
})

test('裸控制字符（#24 回归）与裸引号可以同时出现', () => {
  const raw = JSON.stringify({ save: true, title: '双料现场', kind: 'knowledge', body: body('占位') }).replace('占位', '第一行\n第二行 运行 "npm test" 的坑')
  const out = parseCaptureJsonDetailed(raw)
  assert.ok(out.card, '两类容错叠加后仍要能解析')
})

test('确实修不出来的（截断）仍然如实失败，不许瞎修出一张卡', () => {
  const truncated = '{"save": true, "title": "截断", "kind": "knowledge", "body": "' + body('长正文').slice(0, 120)
  assert.equal(looksTruncatedJson(truncated), true, '括号未闭合应被认成截断')
  const out = parseCaptureJsonDetailed(truncated)
  assert.equal(out.card, null, '修不出来就必须返回 null（宁可失败，也不写坏卡）')
})
