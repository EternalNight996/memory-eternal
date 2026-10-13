// issue #33 的落地守卫（按批准的裁剪范围：② journal_mode 读回 + 写探针、④ /overview 降级返回、
// ⑤ 损坏时引导从备份重建）。**刻意不做**：busy_timeout（DatabaseSync 同步 → 会阻塞事件循环）、
// WAL→DELETE 自动降级（会永久改库模式，等确诊再说）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkDbHealth, rebuildGuidance } from '../lib/db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

test('② 打开即体检：正常库 writable=true + 真实 journal_mode；文件只读时必须被发现', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-health-'))
  const file = path.join(dir, 'memory-eternal.db')
  try {
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE t(x)')
    const ok = checkDbHealth(db)
    assert.equal(ok.writable, true, '正常库的写探针应当通过')
    assert.equal(ok.journalMode, 'wal', 'journal_mode 要**读回真实值**（不是执行完 PRAGMA 就当成功）')
    assert.equal(ok.corrupt, false)
    db.close()

    // 现场形态：文件不可写（实测报错就是 `attempt to write a readonly database`）
    if (process.platform === 'win32') execFileSync('attrib', ['+R', file])
    else fs.chmodSync(file, 0o444)
    const ro = new DatabaseSync(file)
    const bad = checkDbHealth(ro)
    assert.equal(bad.writable, false, '写不进去必须被体检发现（旧实现会以只读状态一路静默运行）')
    assert.match(bad.error, /readonly|read-only|只读/i)
    try { ro.close() } catch {}
  } finally {
    try { if (process.platform === 'win32') execFileSync('attrib', ['-R', file]) } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('⑤ 引导：不可写 / 损坏时给出可执行步骤，且绝不自动改数据', () => {
  const g1 = rebuildGuidance('C:/vault', { writable: false, error: 'attempt to write a readonly database', corrupt: false })
  assert.ok(g1.some((l) => /不可写/.test(l)))
  assert.ok(g1.some((l) => /配置仍可保存/.test(l)), '要说清「配置仍可保存」，否则用户会以为整个插件坏了')
  const g2 = rebuildGuidance('C:/vault', { writable: false, error: 'database disk image is malformed', corrupt: true })
  assert.ok(g2.some((l) => /疑似损坏/.test(l)))
  assert.ok(g2.some((l) => /先停下会写它的进程/.test(l)), '恢复前必须先停写者')
  assert.ok(g2.some((l) => /留证/.test(l)), '必须先留证，不能直接覆盖现场')
  assert.ok(g2.some((l) => /dsh-memory doctor/.test(l)), '要给出可执行的下一步命令')
})

test('④ /overview 库不可用时降级（200 + dbError + 身份字段），不再 500', () => {
  const api = read('lib/api.js')
  assert.match(api, /const degraded = \(error\) => \{/, '要有降级分支')
  assert.match(api, /degraded: true, vaultDir: vaultRoot, version: servingVersion/, '降级也要保住身份字段 —— 探针/面板靠它认「这是我们」')
  assert.match(api, /dbError: status\.error/, '要把真实原因带出去')
  assert.match(api, /try \{ await ensureVault\(vaultRoot\) \} catch \(e\) \{ return degraded/, 'ensureVault 失败走降级')
  assert.match(api, /try \{ data = await overview\(vaultRoot\) \} catch \(e\) \{ return degraded/, 'overview 失败走降级')
  const seg = api.slice(api.indexOf("case '/overview'"), api.indexOf("case '/cards'"))
  assert.doesNotMatch(seg, /json\(res, 500/, '/overview 分支里不许再出现 500')
  assert.match(api, /db: dbStatus\(vaultRoot\)/, '正常路径也要带上库健康结论')
  assert.match(read('bin/dsh-memory.mjs'), /case 'doctor': \{/, '要有 doctor 自检入口（库健康 + 备份清单 + 引导）')
})

test('刻意不做的那两件：不许偷偷加 busy_timeout / WAL 自动降级（评审结论已记录）', () => {
  const db = read('lib/db.js')
  assert.doesNotMatch(db, /busy_timeout/i, 'DatabaseSync 是同步 API，busy_timeout 会阻塞事件循环 → 未经实测不得加')
  assert.doesNotMatch(db, /journal_mode=DELETE|journal_mode = DELETE/, '不得自动把库降级成 rollback journal（会永久改库模式且并发更差）')
})
