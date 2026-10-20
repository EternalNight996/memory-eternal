// issue #48：本地大模型（ollama 30B）冷启动超时 + 输出被截断 → 在 0.10.16 上必失败。
// 修法：超时可配置（captureTimeoutMs）+ 超时后同候选加时重试一次 + 截断给独立错误码走 token 阶梯。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCaptureJsonDetailed, looksTruncatedJson } from '../lib/capture.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

test('截断的 JSON 能被识别（括号/字符串未闭合）', () => {
  assert.equal(looksTruncatedJson('{"title": "x", "body": "未闭合'), true)
  assert.equal(looksTruncatedJson('{"title": "x"}'), false)
  const r = parseCaptureJsonDetailed('{"save": true, "title": "半截')
  assert.equal(r.parsed, false)
  assert.equal(r.noJson, false)
})

test('宿主：超时可配置 + 超时加时重试 + 截断走 token 阶梯（源码守卫）', () => {
  const idx = read('index.js')
  assert.match(idx, /captureTimeoutMs: z\.number\(\)\.min\(5000\)\.max\(600000\)\.default\(45000\)/, '配置项')
  assert.match(idx, /const baseTimeout = Math\.max\(5000, Number\(cfg\.captureTimeoutMs\) \|\| 45000\)/, '超时不再硬编码 45s')
  assert.match(idx, /isTimeoutFailure/, '要能识别超时失败')
  assert.match(idx, /可能是模型冷启动 → 以 .* 超时重试同一候选/, '超时要加时重试同一候选，并写清原因')
  assert.match(idx, /TRUNCATED_OUTPUT/, '截断要进同一阶梯')
  assert.match(idx, /captureTimeoutMs: cfg\.captureTimeoutMs \?\? 45000/, '/config 要暴露新字段')
  const api = read('lib/api.js')
  assert.match(api, /captureTimeoutMs: cfg\.captureTimeoutMs \?\? 45000/)
  const cap = read('lib/capture.js')
  assert.match(cap, /code: 'TRUNCATED_OUTPUT'/, '截断给独立错误码')
  assert.match(cap, /num_predict/, '文案要点出本地模型的输出上限')
})

test('面板：配置页有「蒸馏超时」输入项 + 中英词条', () => {
  const client = read('src/client/index.tsx')
  assert.match(client, /<F k="captureTimeoutMs" label=\{t\('captureTimeoutMs'\)\} type="number" \/>/)
  assert.equal((client.match(/captureTimeoutMs:/g) || []).length, 2, '中英各一条')
})
