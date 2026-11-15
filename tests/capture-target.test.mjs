// 自动沉淀写哪里：云端模式下**只写云端**（用户实测问题：切了云端后本机库还在长卡）。
//
// 真实现场（v0.48.2 之前）：云端 9656 张、本地 46 张碎片；capture 一律「本地永远写 + 云端是副本」，
// 于是用户切到云端后 `~/.dsh/memory-vault` 继续增长 —— 在他看来就是"还在往本地插"。
//
// 现在：云端可用 → 只写云端（失败进补推队列，不碰本地库）；云端不可用 → 写本地；
// `cloudWriteMode='both'` 保留老行为（本地账本）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveCaptureTarget, cloudReady, CLOUD_WRITE_MODES } from '../lib/capture-target.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

const cloudConn = { mode: 'cloud', active: true, url: 'https://mem.example.com', token: 'me_test_token' }

test('云端可用 + 默认配置 → 只写云端', () => {
  assert.equal(resolveCaptureTarget({ conn: cloudConn, cfg: {} }), 'cloud')
  assert.equal(resolveCaptureTarget({ conn: cloudConn, cfg: { cloudWriteMode: 'cloud' } }), 'cloud')
})

test('cloudWriteMode=both → 保留老行为（本地也写）', () => {
  assert.equal(resolveCaptureTarget({ conn: cloudConn, cfg: { cloudWriteMode: 'both' } }), 'local')
})

test('云端不可用（未登录 / 无令牌 / 坏地址 / active=false）→ 写本地', () => {
  const cases = [
    { mode: 'local', active: true, url: 'https://x', token: 'me_a' },
    { mode: 'cloud', active: false, url: 'https://x', token: 'me_a' },
    { mode: 'cloud', active: true, url: 'https://x', token: '' },
    { mode: 'cloud', active: true, url: 'not-a-url', token: 'me_a' },
    null,
    undefined,
  ]
  for (const conn of cases) {
    assert.equal(resolveCaptureTarget({ conn, cfg: {} }), 'local', JSON.stringify(conn))
    assert.equal(cloudReady(conn), false)
  }
})

test('cloudReady 只看"能不能真发请求"，不看 mode 以外的字段', () => {
  assert.equal(cloudReady(cloudConn), true)
  assert.equal(cloudReady({ ...cloudConn, token: '  ' }), false)
})

test('配置取值只有两种（配置面板与 schema 共用）', () => {
  assert.deepEqual([...CLOUD_WRITE_MODES], ['cloud', 'both'])
})

test('源码守卫：云端分支里不写本地库、不写本地操作日志', () => {
  const src = read('index.js')
  const at = src.indexOf('const _target = resolveCaptureTarget(')
  assert.ok(at > 0, 'index.js 里找不到写入目标判定')
  const block = src.slice(at, src.indexOf("if (_target === 'cloud')", at) + 1600)
  const cloudBranch = block.slice(block.indexOf("if (_target === 'cloud')"), block.indexOf('const written = await captureCard'))
  assert.ok(cloudBranch.includes('pushCardToCloud'), '云端分支应直接推云端')
  assert.ok(!/captureCard\(/.test(cloudBranch), '云端分支**不许**再调 captureCard（那就是写本地）')
  assert.ok(!/logActivity\(/.test(cloudBranch), '云端分支不该往本地 activity_log 记一条')
  assert.ok(cloudBranch.includes('enqueueFailedPush'), '云端写失败要进补推队列（数据不丢）')
  assert.ok(/未写本地/.test(cloudBranch), '失败日志要明确说"未写本地"，避免用户误判')
})

test('配置面板：有 cloudWriteMode 下拉，中英文案成对', () => {
  const ui = read('src/client/index.tsx')
  assert.ok(ui.includes("set('cloudWriteMode'"), '面板要有 cloudWriteMode 的写入点')
  assert.ok(/cloudWriteModeLabel:|'自动沉淀写哪里'/.test(ui))
  for (const k of ['cloudWriteModeLabel', 'cloudWriteModeHint', 'cloudWriteModeCloud', 'cloudWriteModeBoth']) {
    const hits = ui.split(k).length - 1
    assert.ok(hits >= 2, `${k} 应在中英两份 i18n 里各出现一次（实际 ${hits}）`)
  }
})

test('两处 /config 快照都暴露 cloudWriteMode（否则面板读回来永远是默认值）', () => {
  for (const f of ['index.js', 'lib/api.js']) {
    const src = read(f)
    assert.match(src, /cloudWriteMode: cfg\.cloudWriteMode === 'both' \? 'both' : 'cloud'/, f + ' 的 /config 白名单漏了 cloudWriteMode')
  }
})
