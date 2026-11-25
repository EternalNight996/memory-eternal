// 设置页「保存」的兜底：DSH 只允许写 volatile 字段（dsh-settings 抛 "has no volatile fields"），
// 本插件配置字段不是 volatile。验证：保存不报错、进程内立即生效、跨重启保留、宿主写成功后摘掉兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bindSettings } from '../index.js'

function fakeCtx(service) {
  return {
    get: (name) => (name === 'settings' ? service : undefined),
    on() {},
    off() {},
    effect(fn) { try { fn() } catch { /* 忽略 */ } return () => {} },
    fiber: { entry: { options: { id: 'memory-eternal' } } },
  }
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-settings-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve(fn(home)).finally(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
}

const refusal = {
  update: async () => { throw new Error('Plugin entry "memory-eternal" has no volatile fields') },
  describe: () => [{ ns: 'memory-eternal', revision: 7 }],
  configure: () => () => {},
}

test('宿主拒绝 volatile 字段时：保存不报错、立即生效、写兜底文件、重启后保留', () => withHome(async (home) => {
  const s1 = bindSettings(fakeCtx(refusal), undefined, { autoCapture: true, auditMode: 'all' })
  const r = await s1.update({ autoCapture: false, auditMode: 'none' })
  assert.equal(r.fallback, true, '应走兜底而不是抛错')
  assert.equal(s1.get().autoCapture, false, '进程内应立即生效')
  assert.equal(s1.get().auditMode, 'none')
  const file = path.join(home, 'memory-eternal-config-overrides.json')
  assert.ok(fs.existsSync(file), '兜底文件应落盘')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.autoCapture, false)
  assert.equal(saved.auditMode, 'none')
  // 模拟 DSH 重启：宿主配置仍是旧值，兜底应叠加回来
  const s2 = bindSettings(fakeCtx(refusal), undefined, { autoCapture: true, auditMode: 'all' })
  assert.equal(s2.get().autoCapture, false, '重启后应保留')
  assert.equal(s2.get().auditMode, 'none', 'auditMode 同样要保留')
}))

test('宿主抛激活上下文守卫（unavailable from a plugin activation）时同样走兜底', () => withHome(async (home) => {
  const guard = {
    update: async () => { throw new Error('root.events.emit is unavailable from a plugin activation') },
    describe: () => [{ ns: 'memory-eternal', revision: 2 }],
    configure: () => () => {},
  }
  const s = bindSettings(fakeCtx(guard), undefined, { autoCapture: true })
  const r = await s.update({ autoCapture: false })
  assert.equal(r.fallback, true, '门禁类错误也应走兜底')
  assert.equal(s.get().autoCapture, false)
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'memory-eternal-config-overrides.json'), 'utf8'))
  assert.equal(saved.autoCapture, false)
}))

test('宿主写成功后清掉同名兜底键（不再掩盖宿主真实配置）', () => withHome(async (home) => {
  fs.writeFileSync(path.join(home, 'memory-eternal-config-overrides.json'), JSON.stringify({ autoCapture: false }))
  const okService = { update: async () => {}, describe: () => [{ ns: 'memory-eternal', revision: 1 }], configure: () => () => {} }
  const s = bindSettings(fakeCtx(okService), undefined, { autoCapture: true })
  assert.equal(s.get().autoCapture, false, '启动时应先加载兜底值')
  const r = await s.update({ autoCapture: true })
  assert.equal(r.fallback, undefined, '宿主写成功时不应走兜底')
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'memory-eternal-config-overrides.json'), 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'autoCapture'), false, '兜底键应被清除')
}))

test('源码守卫：保存兜底逻辑必须存在（防回归）', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /memory-eternal-config-overrides\.json/, '兜底文件名')
  assert.match(src, /has no volatile fields\|is not volatile/, '必须识别宿主的 volatile 拒绝')
  assert.match(src, /fallback: true/, '兜底结果要标记 fallback')
})
