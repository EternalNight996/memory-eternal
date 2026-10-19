// issue #47 的衍生改进：把「模型不守 JSON」记下来并让它自我纠正。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCaptureJsonDetailed } from '../lib/capture.js'
import { recordModelStrike, recentModelStrikes, rankRoutesByStrikes, routeKey, strikesPath } from '../lib/model-strikes.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

test('纯散文回复要标记 noJson（不是「格式写坏了」，是模型不守格式）', () => {
  const prose = parseCaptureJsonDetailed('已读取并理解以下技能约束，后续操作将严格遵循：\n1. **diagnosing-bugs**：先建红绿回路…')
  assert.equal(prose.parsed, false)
  assert.equal(prose.noJson, true)
  // 有 JSON 但写坏 → 仍走原 UNPARSEABLE 路径（重试/修复可能成功）
  const broken = parseCaptureJsonDetailed('{"title": "x", "body": "y",}')
  assert.equal(broken.parsed, false)
  assert.equal(broken.noJson, false)
  // 散文 + JSON 混排 → 能解析出来就不算 noJson
  const mixed = parseCaptureJsonDetailed('好的，结果如下：\n{"save": false}\n希望有帮助')
  assert.equal(mixed.parsed, true)
})

test('rankRoutesByStrikes：命中阈值的排到最后（稳定），全命中时保持原顺序', () => {
  const routes = [
    { provider: 'stepfun', model: 'step-5-preview' },
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'stepapi', model: 'step-5-preview' },
  ]
  const ranked = rankRoutesByStrikes(routes, { 'stepfun|step-5-preview': 2 })
  assert.deepEqual(ranked.map(routeKey), ['deepseek-official|deepseek-flash', 'stepapi|step-5-preview', 'stepfun|step-5-preview'])
  const all = rankRoutesByStrikes(routes, { 'stepfun|step-5-preview': 3, 'deepseek-official|deepseek-flash': 2, 'stepapi|step-5-preview': 2 })
  assert.deepEqual(all.map(routeKey), routes.map(routeKey), '全命中 → 原顺序兜底，绝不没候选')
  // 只命中 1 次（未达阈值）→ 不动
  assert.deepEqual(rankRoutesByStrikes(routes, { 'stepfun|step-5-preview': 1 }).map(routeKey), routes.map(routeKey))
})

test('打击记录：累加 / 24h 窗口 / 只留最近 50 个', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-strikes-'))
  const env = { DSH_HOME: dir }
  try {
    assert.match(strikesPath(env), /memory-eternal-config\.llm-strikes\.json$/)
    const route = { provider: 'stepfun', model: 'step-5-preview' }
    recordModelStrike(env, route, 'MODEL_NOT_JSON', 1000)
    recordModelStrike(env, route, 'MODEL_NOT_JSON', 2000)
    assert.equal(recentModelStrikes(env, { now: 3000 })[routeKey(route)], 2, '累加')
    // 24h 后过期
    assert.equal(recentModelStrikes(env, { now: 2000 + 25 * 3600 * 1000 })[routeKey(route)], undefined)
    // 超过 50 个键时裁掉最旧的
    const env2 = { DSH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'me-strikes2-')) }
    for (let i = 0; i < 60; i++) recordModelStrike(env2, { provider: 'p' + i, model: 'm' }, 'MODEL_NOT_JSON', 1000 + i)
    assert.equal(Object.keys(recentModelStrikes(env2, { now: 2000 })).length, 50)
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('接线守卫：宿主选路前排序、失败时记录、错误码与文案到位', () => {
  const idx = read('index.js')
  assert.match(idx, /rankRoutesByStrikes\(routes, strikes\)/, '选路后要排序')
  assert.match(idx, /recordModelStrike\(process\.env, route, f\.code\)/, '不守 JSON 时记录')
  assert.match(idx, /蒸馏候选已调整/, '调整要留可查日志')
  const cap = read('lib/capture.js')
  assert.match(cap, /MODEL_NOT_JSON/, '要有独立错误码')
  assert.match(cap, /模型没有按 JSON 格式输出/, '文案要说清是模型不守格式')
})
