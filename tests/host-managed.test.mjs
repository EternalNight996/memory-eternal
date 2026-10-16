// issue #30 第四点（报告者的治本建议）：锁不可写的机器上，看门狗路径被永久拒绝 ——
// 由**宿主自己**停掉旧实例、在同端口拉起新实例并保活（宿主能写、也能 kill 自己人的进程）。
// 这里守两件事：① 强制接管只对「自家 web」下手；② 宿主托管要能被面板/接口认出来（不是"未托管"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { takeoverOwnWeb } from '../lib/web.js'
import { recordHostManaged, hostManagedInfo, clearHostManaged } from '../lib/resident-state.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

test('强制接管：只收自家 web；别人的进程一个都不许动', async () => {
  const ours = await takeoverOwnWeb(7999, {
    findListener: async () => ({ pid: 4242, command: 'node F:/x/memory-eternal/lib/web.js --port 7999' }),
    looksLike: () => true,
    kill: () => true,
    sleep: async () => {},
    timeoutMs: 0,
  })
  // timeoutMs=0 → 发出终止后不再等，如实报"仍被占用"（不谎报成功）
  assert.equal(ours.pid, 4242)
  assert.match(ours.reason, /仍被占用|已收掉/)

  const killed = []
  const foreign = await takeoverOwnWeb(7999, {
    findListener: async () => ({ pid: 999, command: 'node C:/other-project/server.js' }),
    looksLike: () => false,
    kill: (pid) => { killed.push(pid); return true },
    sleep: async () => {},
  })
  assert.equal(foreign.took, false)
  assert.deepEqual(killed, [], '不是自家 web 绝不动手')
  assert.match(foreign.reason, /不是本插件的 web/)

  const empty = await takeoverOwnWeb(7999, { findListener: async () => null, sleep: async () => {} })
  assert.equal(empty.took, false)
  assert.match(empty.reason, /没有占用者/)

  // 收得掉：findListener 第二次返回 null → took=true
  let calls = 0
  const ok = await takeoverOwnWeb(7999, {
    findListener: async () => { calls += 1; return calls === 1 ? { pid: 5, command: 'node F:/x/memory-eternal/lib/web.js' } : null },
    looksLike: () => true,
    kill: () => true,
    sleep: async () => {},
    timeoutMs: 1000,
  })
  assert.equal(ok.took, true)
  assert.equal(ok.pid, 5)
})

test('宿主托管状态：记录 / 读取 / 清除（面板据此不再显示"未托管"）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-hostmgd-'))
  const env = { DSH_HOME: dir }
  try {
    assert.equal(hostManagedInfo(env), null)
    const r = recordHostManaged(env, { port: 7999, version: '0.10.34', served: '0.10.34', reason: 'lock-unwritable' })
    assert.equal(r.ok, true)
    const info = hostManagedInfo(env)
    assert.equal(info.fresh, true)
    assert.equal(info.port, 7999)
    assert.equal(info.reason, 'lock-unwritable')
    // 累计次数（便于判断是不是反复接管）
    recordHostManaged(env, { port: 7999 })
    assert.equal(hostManagedInfo(env).count, 2)
    assert.equal(clearHostManaged(env), true)
    assert.equal(hostManagedInfo(env), null)
    assert.equal(clearHostManaged(env), false)
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('align / doctor：宿主托管要能被看到（设计内降级，不是故障）', async () => {
  const { alignFindings } = await import('../lib/align.js')
  const r = alignFindings({ hostVersion: '0.10.36', onDisk: '0.10.36', residentServed: '0.10.36', hostManaged: { fresh: true, port: 7999, reason: 'lock-unwritable', version: '0.10.36' } })
  const f = r.findings.find((x) => x.id === 'resident-host-managed')
  assert.ok(f, '要有专门一条')
  assert.equal(f.level, 'warn', '要提示，但不算 fix（这是设计内的降级）')
  assert.match(f.title, /宿主托管/)
  assert.match(f.detail, /不是孤儿/, '要说清有人管')
  assert.equal(r.ok, true, 'warn 不该把整体判成失败')
  const stale = alignFindings({ hostVersion: '0.10.36', onDisk: '0.10.36', hostManaged: { fresh: false } })
  assert.equal(stale.findings.some((x) => x.id === 'resident-host-managed'), false, '过期状态不再提示')
})
test('接线守卫：宿主 tick 探版本并接管、接口报 managedBy、面板区分显示', () => {
  const index = read('index.js')
  assert.match(index, /probeServedVersion\(port\)/, 'tick 要探端口上的版本（不只探存活）')
  assert.match(index, /forceTakeover: true/, '锁不可写时宿主强制接管')
  assert.match(index, /recordHostManaged\(process\.env/, '要记下"宿主托管"')
  assert.match(index, /clearHostManaged\(process\.env\)/, '看门狗重新登记后要清掉该状态')
  assert.match(index, /宿主自己接管/, '要留可核对的日志')
  const web = read('lib/web.js')
  assert.match(web, /export async function takeoverOwnWeb/, '要有可测试的强制接管助手')
  assert.match(web, /forceTakeover/, 'ensureWebServer 要支持 forceTakeover')
  const api = read('lib/api.js')
  assert.match(api, /const managedBy = residentManaged \? 'watchdog'/, 'version-check 要报 managedBy')
  const client = read('src/client/index.tsx')
  assert.match(client, /residentHostManaged/, '面板要区分「宿主托管」')
  assert.match(read('lib/align.js'), /resident-host-managed/, 'align 也要能看到宿主托管')
  assert.match(read('bin/dsh-memory.mjs'), /常驻实例托管：/, 'doctor 要打印托管方式')
  assert.equal((client.match(/vcResidentHostManagedShort:/g) || []).length, 2, '中英词条各一条')
})
