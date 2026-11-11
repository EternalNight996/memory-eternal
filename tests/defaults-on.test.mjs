// 开箱即用默认值守卫：
// 1) 自动沉淀/召回缺键时必须按「开」处理，而不是被 falsy 判断静默关掉；
// 2) 体验优先的默认值（日配额 1000 / 60s 冷却 / 120 字 / 60s 超时 / 跟随会话）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8')

test('默认值：自动沉淀/召回/蒸馏/去重/Web 都默认开', () => {
  const idx = read('index.js')
  for (const key of ['enabled', 'autoCapture', 'autoRecall', 'coreMemoryEnabled', 'workingMemoryEnabled', 'skillCardsAutoSync', 'distillEnabled', 'dedupByLLM', 'autoWeb']) {
    assert.match(idx, new RegExp(key + ': z\\.boolean\\(\\)\\.default\\(true\\)'), key + ' 应默认开')
  }
  assert.match(idx, /maxCardsPerDay: z\.number\(\)\.default\(1000\)/)
  assert.match(idx, /captureCooldownMs: z\.number\(\)\.default\(60 \* 1000\)/)
  assert.match(idx, /captureMinChars: z\.number\(\)\.default\(120\)/)
  assert.match(idx, /captureTimeoutMs: z\.number\(\)\.min\(5000\)\.max\(600000\)\.default\(60000\)/)
  assert.match(idx, /captureFollowSession: z\.boolean\(\)\.default\(true\)/)
})

test('缺键安全：不能用 falsy 判断把默认开启的自动沉淀/召回关掉', () => {
  const idx = read('index.js')
  assert.match(idx, /cfg\.enabled === false \|\| cfg\.autoCapture === false/, '自动沉淀缺键时应视为开')
  assert.match(idx, /cfg\.enabled === false \|\| cfg\.autoRecall === false/, '自动召回缺键时应视为开')
  assert.doesNotMatch(idx, /if \(!cfg\.enabled \|\| !cfg\.autoCapture\) return/, '不能保留 falsy 关断')
})

test('配置面板：缺键时必要开关显示为默认开', () => {
  const client = read('src/client/index.tsx')
  const m = /const BOOL_DEFAULT_ON = new Set\(\[([^\]]+)\]\)/.exec(client)
  assert.ok(m, '必须有 BOOL_DEFAULT_ON')
  for (const key of ['enabled', 'autoCapture', 'autoRecall', 'distillEnabled', 'dedupByLLM', 'autoWeb']) {
    assert.match(m[1], new RegExp("'" + key + "'"), key + ' 应在默认开清单')
  }
})
