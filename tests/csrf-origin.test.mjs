// 插件 API 的跨站写入防护（2026-10-09）。
//
// 背景：/memory-eternal/api/* 没有鉴权 —— 本机任意网页都能 POST /config、/audit/approve、/write…
// 修法：状态变更请求必须与请求自身的 Host 同源（浏览器跨站请求一定会带 Origin，而同源页面带的
// Origin 与 Host 一致）；非浏览器调用（curl / CLI / MCP）没有 Origin，照常放行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApi, crossOriginError, API_PREFIX } from '../lib/api.js'
import { ensureVault } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(here, f), 'utf8')

test('crossOriginError：同源放行、跨站拒绝、非浏览器（无 Origin）放行', () => {
  const post = (origin, host) => ({ method: 'POST', headers: { origin, host } })
  // 读请求不该被管（GET 没有副作用）
  assert.equal(crossOriginError({ method: 'GET', headers: { origin: 'https://evil.com', host: '127.0.0.1:19387' } }), '')
  // 同源：DSH 设置页 / 记忆页（宿主同源）与独立页（自己的 127.0.0.1:7999）
  assert.equal(crossOriginError(post('http://127.0.0.1:19387', '127.0.0.1:19387')), '')
  assert.equal(crossOriginError(post('http://127.0.0.1:7999', '127.0.0.1:7999')), '')
  // 局域网访问也同源，不能被误伤
  assert.equal(crossOriginError(post('http://192.168.1.5:19387', '192.168.1.5:19387')), '')
  // 跨站：拒绝
  assert.match(crossOriginError(post('https://evil.com', '127.0.0.1:19387')), /跨站写入被拒/)
  assert.match(crossOriginError(post('http://localhost:9999', '127.0.0.1:19387')), /跨站写入被拒/)
  // 非浏览器 / 拿不到 Host：放行（宁可不误伤 curl / CLI / MCP）
  assert.equal(crossOriginError({ method: 'POST', headers: {} }), '')
  assert.equal(crossOriginError(post('https://evil.com', '')), '')
  // Origin 头本身不合法：拒绝（不给绕过留缝）
  assert.match(crossOriginError(post('not-a-url', '127.0.0.1:19387')), /不合法/)
  // 桌面壳的 app:// 之类自定义 scheme：网页伪造不出来，放行（否则桌面版保存会被误伤）
  assert.equal(crossOriginError(post('app://dsh', '127.0.0.1:19387')), '')
})

test('handleApi：跨站 POST 被 403 CROSS_ORIGIN_BLOCKED 挡在业务逻辑之前', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-csrf-'))
  const vault = path.join(dir, 'vault')
  await ensureVault(vault)
  const api = createApi({ vaultDir: () => vault, getSettings: () => ({}) })
  // 放行的请求会真的走业务逻辑（这里故意指向不存在的卡 → 抛「卡片不存在」），
  // 于是「有没有过闸门」可以用「拿到的错误是不是业务错误」来断言，而不必真的建一张卡。
  const call = async (headers) => {
    const out = { status: 0, body: '', error: '' }
    const res = { writeHead(s) { out.status = s }, end(b) { out.body = String(b || '') }, setHeader() {}, on() {}, once() {}, emit() {} }
    try { await api({ url: API_PREFIX + '/audit/approve?path=x.md', method: 'POST', headers }, res) } catch (e) { out.error = String((e && e.message) || e) }
    return out
  }
  try {
    const evil = await call({ origin: 'https://evil.com', host: '127.0.0.1:19387' })
    assert.equal(evil.status, 403, '跨站写入必须 403')
    assert.match(evil.body, /CROSS_ORIGIN_BLOCKED/)
    assert.equal(evil.error, '', '被拦下的请求不该走到业务逻辑（不该抛业务错）')

    const sameOrigin = await call({ origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' })
    assert.doesNotMatch(sameOrigin.body, /CROSS_ORIGIN_BLOCKED/, '同源请求要照常走业务逻辑')
    assert.match(sameOrigin.error, /卡片不存在/, '同源请求确实进到了业务逻辑')

    const cli = await call({ host: '127.0.0.1:19387' })
    assert.doesNotMatch(cli.body, /CROSS_ORIGIN_BLOCKED/, '没有 Origin（curl / CLI / MCP）要放行')
    assert.match(cli.error, /卡片不存在/, '没有 Origin 的调用确实进到了业务逻辑')
  } finally {
    closeAllDb()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('两处入口都装了闸门（宿主拦截路由 + 共享 api），别只补一半', () => {
  const index = read('index.js')
  assert.match(index, /import \{ createApi, json, encodeBody, crossOriginError \}/, '宿主要引入同一份判定')
  assert.match(index, /const crossOrigin = crossOriginError\(req\)[\s\S]{0,200}?CROSS_ORIGIN_BLOCKED/, '宿主拦截路由之前要挡一道')
  const api = read('lib/api.js')
  assert.match(api, /const crossOrigin = crossOriginError\(req\)[\s\S]{0,200}?CROSS_ORIGIN_BLOCKED/, '共享 api 入口也要挡一道')
})

test('推荐方案（planA）的蒸馏上限必须跟默认一致 —— 不许再埋一个会先撞顶的小上限', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const planA = /A: \{[^}]*captureMaxTokens: (\d+)/.exec(src)
  assert.ok(planA, 'planA 里应当显式给出 captureMaxTokens')
  const { DEFAULT_CAPTURE_MAX_TOKENS } = await import('../lib/capture.js')
  assert.equal(Number(planA[1]), DEFAULT_CAPTURE_MAX_TOKENS, '一键推荐方案不能把默认刚省掉的重试又装回来')
})

test('蒸馏输出上限：默认即硬顶（不再先撞 2000 再重试一次，省一次 LLM 调用）', async () => {
  const { DEFAULT_CAPTURE_MAX_TOKENS, MAX_CAPTURE_MAX_TOKENS, maxTokenLadder } = await import('../lib/capture.js')
  assert.equal(DEFAULT_CAPTURE_MAX_TOKENS, MAX_CAPTURE_MAX_TOKENS, '默认值应与硬顶一致')
  assert.deepEqual(maxTokenLadder(DEFAULT_CAPTURE_MAX_TOKENS, MAX_CAPTURE_MAX_TOKENS), [], '默认配置下不该再有 ladder 重试')
})
