// 库文件名可配（MEMORY_DB_FILE）+ 端口可配（既有能力）的守卫
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_DB_FILE, dbFileName, dbFileIn } from '../lib/db.js'

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
