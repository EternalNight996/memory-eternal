// 一键诊断包：脱敏必须可靠（这是唯一会把用户现场带出机器的功能），zip 必须真能打开。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactText, buildSupportBundle } from '../lib/support.js'
import { makeZip, listZipNames } from '../lib/zip.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

test('脱敏：家目录 / sk- / ghp_ / github_pat / Bearer / 配置里的 key 字段', () => {
  const home = 'C:\\Users\\tester'
  const raw = [
    'vault ' + home + '\\.dsh\\memory-vault',
    'key sk-abcdefghijklmnopqrstuvwx',
    'gh p ghp_' + 'a'.repeat(30),
    'Authorization: Bearer abcdefghijklmnop',
    '{"secretHint":"hunter2","apiKey":"zzz","token":"q"}',
    'password=hunter2',
  ].join('\n')
  const out = redactText(raw, { home })
  assert.doesNotMatch(out, /tester/, '家目录必须被替换')
  assert.match(out, /<home>/)
  assert.doesNotMatch(out, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(out, /ghp_aaaa/)
  assert.doesNotMatch(out, /Bearer abcdefghijklmnop/)
  assert.doesNotMatch(out, /hunter2/, '配置/环境里的密钥值不能留下')
  assert.match(out, /"secretHint": "\*\*\*"/)
})

test('zip：写入后能被自检读回，中文名正常', () => {
  const buf = makeZip([{ name: 'a.txt', data: 'hello 世界' }, { name: 'logs/x.jsonl', data: 'y'.repeat(3000) }])
  assert.equal(buf.readUInt32LE(0), 0x04034b50, '本地文件头魔数')
  assert.deepEqual(listZipNames(buf), ['a.txt', 'logs/x.jsonl'])
})

test('诊断包：包含预期条目，且配置里的密钥不会进包', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-sup-'))
  const env = { DSH_HOME: dir }
  const out = path.join(dir, 'bundle.zip')
  try {
    fs.writeFileSync(path.join(dir, 'memory-eternal-config.json'), JSON.stringify({ captureProvider: 'x', secretHint: 'hunter2', token: 'zzz' }))
    fs.writeFileSync(path.join(dir, 'memory-eternal-capture.jsonl'), 'sk-abcdefghijklmnop\n' + JSON.stringify({ action: 'boot', reason: 'ok' }) + '\n')
    fs.writeFileSync(path.join(dir, 'memory-eternal-watchdog.json'), JSON.stringify({ watchdogs: [] }))
    fs.writeFileSync(path.join(dir, 'memory-eternal-config.host.json'), JSON.stringify({ pid: 1, port: 2 }))
    const r = buildSupportBundle({ env, vaultRoot: dir, out, tail: 10, spawn: false, now: 1700000000000 })
    assert.equal(r.ok, true)
    assert.ok(fs.statSync(out).size > 0)
    for (const name of ['meta.json', 'config.json', 'lock.json', 'host.json', 'capture-log.tail.jsonl', 'README.txt']) {
      assert.ok(r.entries.includes(name), '缺少条目 ' + name)
    }
    // 小文件是 store 模式 → 明文可直接在 zip 字节里检索：密钥绝不能出现
    const raw = fs.readFileSync(out).toString('latin1')
    assert.doesNotMatch(raw, /hunter2/)
    assert.doesNotMatch(raw, /sk-abcdefghijklmnop/)
    assert.doesNotMatch(raw, new RegExp(String(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '家目录不应明文出现')
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('接线守卫：CLI 有 support 子命令与用法说明', () => {
  const cli = read('bin/dsh-memory.mjs')
  assert.match(cli, /case 'support':/)
  assert.match(cli, /buildSupportBundle\(/, '要调用诊断包实现')
  assert.match(cli, /--no-spawn/, '受限环境的逃生口')
  const sup = read('lib/support.js')
  assert.match(sup, /export function redactText/)
  assert.match(sup, /export function buildSupportBundle/)
})
