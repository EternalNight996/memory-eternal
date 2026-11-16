// 库文件名可配（MEMORY_DB_FILE）+ 端口可配（既有能力）的守卫
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_DB_FILE, dbFileName, dbFileIn, renameDbFile, getDb, closeDb, readDbNameMark } from '../lib/db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dirs = []
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'me-dbname-')); dirs.push(d); return d }
test.after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ } } })

test('默认库文件名不变（不设 MEMORY_DB_FILE）', () => {
  assert.equal(dbFileName({}), 'memory-eternal.db')
  assert.equal(dbFileName({ MEMORY_DB_FILE: '' }), 'memory-eternal.db')
  assert.equal(dbFileName({ MEMORY_DB_FILE: '   ' }), 'memory-eternal.db')
  assert.equal(DEFAULT_DB_FILE, 'memory-eternal.db')
})

test('可以改成自定义名（mem-purge.db）', () => {
  assert.equal(dbFileName({ MEMORY_DB_FILE: 'mem-purge.db' }), 'mem-purge.db')
  assert.equal(dbFileName({ MEMORY_DB_FILE: 'ops_v2.db' }), 'ops_v2.db')
})

test('非法值一律退回默认名（防路径穿越 / 误写到别处）', () => {
  for (const bad of ['../evil.db', 'a/b.db', 'a\\b.db', 'mem.db.bak', 'mem', '.db', 'x'.repeat(200) + '.db', 'nullbyte\0.db']) {
    assert.equal(dbFileName({ MEMORY_DB_FILE: bad }), 'memory-eternal.db', '应拒绝：' + JSON.stringify(bad))
  }
})

test('兼容保护：设了自定义名但目录里已有标准库 → 继续用标准库（不打开空库）', () => {
  const dir = tmp()
  writeFileSync(path.join(dir, 'memory-eternal.db'), 'x')
  assert.equal(dbFileIn(dir, { MEMORY_DB_FILE: 'mem-purge.db' }), 'memory-eternal.db', '不能因为设了环境变量就换库')

  // 目录里两个都有 → 尊重自定义名
  writeFileSync(path.join(dir, 'mem-purge.db'), 'x')
  assert.equal(dbFileIn(dir, { MEMORY_DB_FILE: 'mem-purge.db' }), 'mem-purge.db')

  // 空目录 + 自定义名 → 用自定义名（新实例）
  const empty = tmp()
  assert.equal(dbFileIn(empty, { MEMORY_DB_FILE: 'mem-purge.db' }), 'mem-purge.db')
})

test('端口可配：--port / MEMORY_WEB_PORT / 配置 webPort 三条路都在（源码守卫）', () => {
  const web = readFileSyncSafe(path.join(root, 'lib/web.js'))
  assert.match(web, /process\.env\.MEMORY_WEB_PORT/, '环境变量 MEMORY_WEB_PORT')
  assert.match(web, /argOf\('--port'\)/, 'CLI --port')

  const bin = readFileSyncSafe(path.join(root, 'bin/dsh-memory.mjs'))
  assert.match(bin, /argOf\('--port'\)/, 'CLI 也认 --port')

  const idx = readFileSyncSafe(path.join(root, 'index.js'))
  assert.match(idx, /webPort: z\.number\(\)\.min\(1\)\.max\(65535\)/, '配置项 webPort（1–65535）')
})

const readFileSyncSafe = (p) => readFileSync(p, 'utf8')

test('动态改库名：真改名 + 数据保留 + 记录到 .dbname', () => {
  const dir = tmp()
  const env = { MEMORY_DB_FILE: '' }
  const db = getDb(dir)
  db.exec('CREATE TABLE IF NOT EXISTS t(x)')
  db.exec('INSERT INTO t VALUES (1)')
  const r = renameDbFile(dir, 'mem-purge.db', { move: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.from, DEFAULT_DB_FILE)
  assert.equal(r.to, 'mem-purge.db')
  assert.equal(r.moved, true)
  assert.equal(readDbNameMark(dir), 'mem-purge.db', '要在 vault 里记下当前库名（重启也生效）')

  closeDb(dir)
  const db2 = getDb(dir)   // 不设 env 也应打开 mem-purge.db（走 .dbname 记录）
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM t').get().c, 1, '数据要还在')
  closeDb(dir)
})

test('动态改库名：非法名 / 目标已存在 都拒绝', () => {
  const dir = tmp()
  getDb(dir); closeDb(dir)
  assert.equal(renameDbFile(dir, '../evil.db').ok, false)
  assert.equal(renameDbFile(dir, 'noext').ok, false)
  writeFileSync(path.join(dir, 'other.db'), 'x')
  const r = renameDbFile(dir, 'other.db')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /已存在/)
})

test('动态改端口 / 改库名：接口与面板入口都在（源码守卫）', () => {
  const api = readFileSync(path.join(root, 'lib/api.js'), 'utf8')
  assert.match(api, /case '\/db\/rename'/, '要有 /db/rename')
  assert.match(api, /case '\/web\/port'/, '要有 /web/port')
  assert.match(api, /deps\.scheduleRelisten\(want\)/, '改端口必须先回包再切换（不能直接 close）')

  const web = readFileSync(path.join(root, 'lib/web.js'), 'utf8')
  assert.match(web, /scheduleRelisten = \(wantPort\) =>/, 'web.js 要有延迟调度器')
  assert.match(web, /server\.close\(\(\) => res\(\)\)/, '要先关旧 listener')

  const ui = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')
  assert.match(ui, /function DynamicDbPortCard/, '面板要有卡片')
  assert.match(ui, /'\/db\/rename'/, '卡片要能改库名')
  assert.match(ui, /'\/web\/port'/, '卡片要能改端口')
  assert.match(ui, /id="sec-dyn"/, '要有独立区块')

  const bin = readFileSync(path.join(root, 'bin/dsh-memory.mjs'), 'utf8')
  assert.match(bin, /case 'port':/, 'CLI 要有 port 命令')
  assert.match(bin, /case 'db':/, 'CLI 要有 db 命令')
})
