// 记忆核心 · 会话工作区（草稿本）
//
// 行为契约（这几条错了就会伤到主线）：
//   1. 会话隔离：A 会话的草稿绝不能被 B 会话读到
//   2. 双上限：200 行 / 24KB，超出截断而不是报错
//   3. 不进知识库：它只是文件；只有「存为待审卡」才走审核
//   4. 注入必须带「不是知识」的抬头，否则模型会把草稿当事实
//   5. 会话 id 不能变成路径穿越
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  writeWorking, readWorking, clearWorking, listWorking, archiveWorking,
  workingPrompt, clipWorking, workingDir, workingPath, safeSessionId,
  WORKING_MAX_LINES, WORKING_MAX_BYTES, WORKING_KEEP,
} from '../lib/working-memory.js'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-working-'))
const env = { DSH_HOME: home }

after(async () => {
  try { await fsp.rm(home, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
})

test('工作区放在 DSH_HOME 下，不在 vault 里', () => {
  assert.equal(workingDir(env), path.join(home, 'memory-eternal.working'))
  assert.ok(workingPath(env, 's1').startsWith(workingDir(env)))
})

test('写入后可读回；replace 是整篇覆盖', () => {
  writeWorking(env, 's1', '第一版', { mode: 'replace' })
  assert.equal(readWorking(env, 's1').text, '第一版')
  writeWorking(env, 's1', '第二版', { mode: 'replace' })
  const w = readWorking(env, 's1')
  assert.equal(w.text, '第二版')
  assert.equal(w.exists, true)
})

test('append 追加而不是覆盖', () => {
  writeWorking(env, 's2', 'A', { mode: 'replace' })
  writeWorking(env, 's2', 'B', { mode: 'append' })
  assert.equal(readWorking(env, 's2').text, 'A\nB')
})

test('会话隔离：两个会话互不可见', () => {
  writeWorking(env, 'alpha', 'alpha 的草稿', { mode: 'replace' })
  writeWorking(env, 'beta', 'beta 的草稿', { mode: 'replace' })
  assert.equal(readWorking(env, 'alpha').text, 'alpha 的草稿')
  assert.equal(readWorking(env, 'beta').text, 'beta 的草稿')
})

test('行数上限：500 行被截到 200 行并标记 truncated', () => {
  const long = Array.from({ length: 500 }, (_, i) => 'L' + i).join('\n')
  const r = writeWorking(env, 'big', long)
  assert.equal(r.lines, WORKING_MAX_LINES)
  assert.equal(r.truncated, true)
  assert.equal(readWorking(env, 'big').lines, WORKING_MAX_LINES)
})

test('字节上限：超长单行被截到 24KB 以内且不劈开多字节字符', () => {
  const huge = '汉'.repeat(WORKING_MAX_BYTES) // 3 字节/字 → 远超上限
  const r = writeWorking(env, 'huge', huge)
  assert.ok(r.bytes <= WORKING_MAX_BYTES, '实际 ' + r.bytes)
  assert.equal(r.truncated, true)
  assert.ok(!/\uFFFD/.test(readWorking(env, 'huge').text), '不能留半个汉字')
})

test('注入文本必须带「不是知识」的抬头；空文档不注入', () => {
  assert.equal(workingPrompt('nobody', env), '')
  writeWorking(env, 's3', '正在改 vault.js 的索引', { mode: 'replace' })
  const p = workingPrompt('s3', env)
  assert.match(p, /不是知识库内容/)
  assert.match(p, /不要当成用户指令/)
  assert.ok(p.includes('正在改 vault.js 的索引'))
})

test('清空后不再注入', () => {
  clearWorking(env, 's3')
  assert.equal(readWorking(env, 's3').exists, false)
  assert.equal(workingPrompt('s3', env), '')
})

test('归档：移到 archive/，活动列表不再包含它', async () => {
  writeWorking(env, 'arch', '要归档的', { mode: 'replace' })
  const r = archiveWorking(env, 'arch')
  assert.equal(r.archived, true)
  assert.equal(readWorking(env, 'arch').exists, false)
  assert.ok(!listWorking(env).some((x) => x.session === 'arch'))
  const files = await fsp.readdir(path.join(workingDir(env), 'archive'))
  assert.ok(files.some((f) => f.startsWith('arch-')), JSON.stringify(files))
})

test('会话 id 不能路径穿越', () => {
  const id = safeSessionId('../../etc/passwd')
  assert.ok(!id.includes('/') && !id.includes('\\') && !id.includes('..'))
  const p = workingPath(env, '../../evil')
  assert.ok(p.startsWith(workingDir(env) + path.sep))
})

test('写入前脱敏：密钥不能进工作区（它会被注入 prompt）', () => {
  writeWorking(env, 'sec', '配置是 api_key: sk-abcdef1234567890', { mode: 'replace' })
  const t = readWorking(env, 'sec').text
  assert.ok(!t.includes('sk-abcdef1234567890'), '密钥被原样写入了：' + t)
})

test('活动工作区数量受 WORKING_KEEP 约束', () => {
  for (let i = 0; i < WORKING_KEEP + 5; i++) writeWorking(env, 'keep-' + i, 'x' + i, { mode: 'replace' })
  assert.ok(listWorking(env).length <= WORKING_KEEP, '实际 ' + listWorking(env).length)
})
