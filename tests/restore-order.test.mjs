// 还原/导入的留证顺序守卫（真实事故的固化）
//
// 事故：`restoreFromBackup` 原来按 `['', '-wal', '-shm']`（主库优先）改名留证。
// 当 DSH 宿主还持着库连接时，主库改名成功、`-wal` 改名 EBUSY 失败 → 主库凭空消失、
// 旧 WAL 留在原地 → 之后任何进程打开都是 `database disk image is malformed`（看起来像库坏了）。
//
// 正确顺序：先挪 -wal / -shm（最容易被别的进程锁），最后挪主库；任何一步失败**全量回滚**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync('lib/db.js', 'utf8')

// 只取 restoreFromBackup 函数体（注释里也提过「现场留证」，用函数边界定位更稳）
function restoreBody() {
  const start = src.indexOf('export async function restoreFromBackup')
  assert.ok(start > 0, '应当能找到 restoreFromBackup')
  const end = src.indexOf('\nexport ', start + 10)
  return src.slice(start, end > 0 ? end : src.length)
}

test('留证顺序：先 -wal/-shm，最后主库', () => {
  const body = restoreBody()
  const m = body.match(/for \(const suffix of \[([^\]]+)\]\)/)
  assert.ok(m, '留证循环应当用显式顺序数组')
  const order = m[1].split(',').map((s) => s.trim().replace(/['"]/g, ''))
  assert.deepEqual(order, ['-wal', '-shm', ''], '顺序必须是 -wal → -shm → 主库（主库最后）')
})

test('任何一步改名失败都要回滚已改的（最坏情况 = 什么都没变）', () => {
  const body = restoreBody()
  assert.match(body, /const rollback = \(\) =>/, '要有回滚函数')
  assert.match(body, /catch \(e\) \{\s*\n?\s*rollback\(\)/, '改名失败时必须调用 rollback')
  assert.match(body, /已改名的文件已还原/, '错误信息要说明已还原')
})

test('留证改名走 renameWithRetry（Windows 句柄释放有延迟）', () => {
  const body = restoreBody()
  assert.match(body, /renameWithRetry\(f, to\)/, '留证要走 renameWithRetry')
  assert.doesNotMatch(body, /^\s*renameSync\(f, to\)/m, '不要在留证里裸调 renameSync')
})

test('导入接口走统一的还原路径（不自己写替换逻辑）', () => {
  const api = fs.readFileSync('lib/api.js', 'utf8')
  const i = api.indexOf("case '/backup/import'")
  assert.ok(i > 0, '要有 /backup/import 路由')
  const block = api.slice(i, i + 5000)
  assert.match(block, /restoreFromBackup\(vaultRoot, \{ from: importFile, force: true \}\)/, '必须复用 restoreFromBackup')
  assert.match(block, /quick_check/, '导入前要做 quick_check')
  assert.match(block, /SQLite format 3/, '导入前要校验文件头')
  assert.match(block, /cards 表/, '导入前要确认有 cards 表')
})

test('导出接口先做一次快照再回传（不直接读正在写的库）', () => {
  const api = fs.readFileSync('lib/api.js', 'utf8')
  const i = api.indexOf("case '/backup/export'")
  assert.ok(i > 0, '要有 /backup/export 路由')
  const block = api.slice(i, i + 2000)
  assert.match(block, /backupDb\(vaultRoot/, '导出要先 backupDb（VACUUM INTO 自洽快照）')
  assert.match(block, /Content-Disposition/, '要带下载文件名')
})
