// 「配置按钮是否全覆盖」的永久守卫：Config 里的每个字段都必须
//   ① 被宿主 GET /config 暴露 ② 被独立 web /config 暴露 ③ 在配置页有编辑入口。
// 漏一个就红，避免以后新增配置项忘了接 UI（用户明确要求全面排查）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const indexSrc = read('index.js')
const clientSrc = read('src/client/index.tsx')
const apiSrc = read('lib/api.js')

const configKeys = [...indexSrc
  .slice(indexSrc.indexOf('export const Config = z.object({'), indexSrc.indexOf('markAllVolatile(Config)'))
  .matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])

const safeKeys = (src, startMark, endMark) => [...src
  .slice(src.indexOf(startMark), src.indexOf(endMark))
  .matchAll(/(\w+):\s*(?:cfg\.|Array\.isArray\(cfg\.)/g)].map((m) => m[1])

test('Config 至少 30 个字段（防止解析失效导致测试假通过）', () => {
  assert.ok(configKeys.length >= 30, '解析到的 Config 字段只有 ' + configKeys.length + ' 个')
})

test('覆盖：每个 Config 字段都能被宿主 GET /config 读出', () => {
  const keys = safeKeys(indexSrc, 'const safe = {', "const descriptor = (ctx.get('settings')")
  const missing = configKeys.filter((k) => !keys.includes(k))
  assert.deepEqual(missing, [], '宿主 /config 未暴露：' + missing.join(', '))
})

test('覆盖：每个 Config 字段都能被独立 web /config 读出', () => {
  const keys = safeKeys(apiSrc, 'const safe = {', 'json(res, 200, { ok: true, config: safe')
  const missing = configKeys.filter((k) => !keys.includes(k))
  assert.deepEqual(missing, [], '独立 web /config 未暴露：' + missing.join(', '))
})

test('覆盖：每个 Config 字段在配置页都有编辑入口', () => {
  const ui = new Set()
  for (const m of clientSrc.matchAll(/<F\s+k="(\w+)"/g)) ui.add(m[1])
  for (const m of clientSrc.matchAll(/<Bool\s+k="(\w+)"/g)) ui.add(m[1])
  for (const m of clientSrc.matchAll(/set\('(\w+)'/g)) ui.add(m[1])
  // vaultProfiles 走专门的编辑器（setForm 里整体替换数组），不是 set('vaultProfiles')
  if (clientSrc.includes('vaultProfiles: list')) ui.add('vaultProfiles')
  const missing = configKeys.filter((k) => !ui.has(k))
  assert.deepEqual(missing, [], '配置页缺少编辑入口：' + missing.join(', '))
})
