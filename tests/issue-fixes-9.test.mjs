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

test('③ 锁文件可写性探测：能写 / 写不进去都要如实报（#33 第③层）', async () => {
  const { probeLockWritable } = await import('../lib/watchdog.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-lock-'))
  try {
    const ok = probeLockWritable({ DSH_HOME: dir })
    assert.equal(ok.writable, true, '正常目录应当可写')
    assert.match(ok.path, /memory-eternal-watchdog\.json$/)
    assert.deepEqual(fs.readdirSync(dir).filter((x) => x.includes('me-lock-probe')), [], '探测不能留下垃圾文件')
    // 把「父路径」做成文件 → mkdir/写必然失败，模拟受限环境
    const blocked = path.join(dir, 'afile')
    fs.writeFileSync(blocked, 'x')
    const bad = probeLockWritable({ DSH_HOME: path.join(blocked, 'sub') })
    assert.equal(bad.writable, false, '写不进去必须被发现（老实现静默吞掉 → 面板显示「未托管」）')
    assert.ok(bad.error.length > 0, '要带上真实原因，供 doctor / 面板显示')
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('③ 三态托管 + 库不可写的统一 UX（源码守卫）', () => {
  const api = read('lib/api.js')
  assert.match(api, /const lockInfo = probeLockWritable\(process\.env\)/, 'version-check 要探测锁可写性')
  assert.match(api, /const managedKnown = residentManaged \|\| lockInfo\.writable/, '导出三态：被托管 / 确实没托管 / 判不出来')
  assert.match(api, /managedKnown,/, 'resident 里要带上 managedKnown')
  assert.match(api, /pid: process\.pid,/, '要报出服务进程 pid（受限环境下不依赖 OS 枚举认领实例）')
  assert.match(api, /const DB_WRITE_ROUTES = /, '写路由要在入口短路径失败')
  assert.match(api, /code: 'DB_UNAVAILABLE'/, '要给出可识别的错误码')
  assert.match(api, /配置仍可保存/, '要说清「配置仍可保存」')
  assert.match(read('lib/watchdog.js'), /lockWarned/, '锁写失败不许再全静默（留一条可查的痕）')
  assert.match(read('bin/dsh-memory.mjs'), /看门狗锁：/, 'doctor 要报告锁可写性')
  const client = read('src/client/index.tsx')
  assert.match(client, /residentLockUnknown/, '面板要区分「判不出来」与「未托管」')
  assert.match(client, /dbReadonlyTitle/, '库不可写要有顶部明示')
  assert.equal((client.match(/dbReadonlyTitle:/g) || []).length, 2, '中英词条各一条')
})

test('撞锁用「应用层异步重试」而不是 busy_timeout（评审：同步忙等会卡住事件循环）', async () => {
  const { withDbRetry, isDbBusyError } = await import('../lib/db.js')
  assert.equal(isDbBusyError(new Error('database is locked')), true)
  assert.equal(isDbBusyError(new Error('SQLITE_BUSY: database is locked')), true)
  assert.equal(isDbBusyError(new Error('no such column: mtime')), false, '数据/语法错误不该被当成"忙"')

  // 重试到成功
  let n = 0
  const out = await withDbRetry(async () => { n += 1; if (n < 3) throw new Error('database is locked'); return 'ok' }, { tries: 5, delayMs: 1 })
  assert.equal(out, 'ok')
  assert.equal(n, 3, '应当重试到成功为止')

  // 非忙错误立刻抛（不浪费重试）
  let m = 0
  await assert.rejects(() => withDbRetry(async () => { m += 1; throw new Error('no such table: cards') }, { tries: 5, delayMs: 1 }))
  assert.equal(m, 1, '非忙错误只试一次')

  // 显式禁止重试（响应已发出）
  let k = 0
  await assert.rejects(() => withDbRetry(async () => { k += 1; const e = new Error('database is locked'); e.noRetry = true; throw e }, { tries: 5, delayMs: 1 }))
  assert.equal(k, 1)

  // 试满仍失败 → 抛最后一次
  let j = 0
  await assert.rejects(() => withDbRetry(async () => { j += 1; throw new Error('database is locked') }, { tries: 3, delayMs: 1 }))
  assert.equal(j, 3)

  const api = read('lib/api.js')
  assert.match(api, /withDbRetry\(async \(\) => \{/, '写路由要接上重试')
  assert.match(api, /e\.noRetry = true/, '响应已发出时禁止重试')
  assert.match(api, /import \{ backupDb, dbStatus, rebuildGuidance, withDbRetry \} from '\.\/db\.js'/, '要从 db.js 引入')
})

test('刻意不做的那两件：不许偷偷加 busy_timeout / WAL 自动降级（评审结论已记录）', () => {
  const db = read('lib/db.js')
  // 只禁「真的去设 PRAGMA busy_timeout」（注释里可以提它 —— 新代码正是靠注释解释为什么不用它）
  // 只禁「真的去执行/设置 busy_timeout」（注释里解释"为什么不用它"是允许且必要的）
  assert.doesNotMatch(db, /exec\([^)]*busy_timeout|PRAGMA\s+busy_timeout\s*=|busy_timeout\s*=\s*\d/i, 'DatabaseSync 是同步 API，busy_timeout 忙等会阻塞事件循环 → 未经实测不得加')
  assert.match(db, /withDbRetry/, '撞锁要走应用层异步重试')
  assert.doesNotMatch(db, /journal_mode=DELETE|journal_mode = DELETE/, '不得自动把库降级成 rollback journal（会永久改库模式且并发更差）')
})
