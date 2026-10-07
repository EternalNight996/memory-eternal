// issue #21 的宿主无关写路径（v0.10.5）：
//   · 宿主心跳：独立 Web 端怎么知道「本机有没有活着的 DSH 宿主」
//   · 无宿主 → 直接原子写共享配置（Codex / Claude Code / 只跑 dsh-memory serve 的场景）
//   · 有宿主 → 仍然只写 pending，绝不绕过宿主直写（否则被下一次 syncConfigFile 盖掉）
//   · 宿主守卫类报错（HMR transactions cannot be nested / …unavailable from a plugin activation）
//     要翻译成「去哪改」的指路，而不是重复报错
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, API_PREFIX } from '../lib/api.js'
import { configFilePath } from '../lib/capture-run.js'
import {
  applySharedConfigDirect, describeApplyFailure, isHostGuardError, drainPendingConfig,
  readPendingConfig, clearPendingConfig, writePendingConfig, pendingConfigPath,
} from '../lib/config-sync.js'
import { hostMarkerPath, writeHostMarker, readHostMarker, clearHostMarker, hostAlive, isProcessAlive } from '../lib/host-heartbeat.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'me-issues3-'))
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

let seq = 0
const newHome = async () => {
  const dir = path.join(tmpRoot, 'home-' + (++seq))
  await fs.mkdir(dir, { recursive: true })
  return dir
}
/** 在临时 DSH_HOME 里跑一段代码（所有路径都从 env.DSH_HOME 派生）。 */
async function withHome(fn) {
  const home = await newHome()
  const env = { ...process.env, DSH_HOME: home }
  return fn(env, home)
}

// ============================ 宿主心跳 ============================
test('#21 心跳路径与共享配置同源派生（xxx.json → xxx.host.json）', async () => {
  await withHome(async (env) => {
    assert.equal(path.basename(configFilePath(env)), 'memory-eternal-config.json')
    assert.equal(path.basename(hostMarkerPath(env)), 'memory-eternal-config.host.json')
    assert.equal(path.dirname(hostMarkerPath(env)), path.dirname(configFilePath(env)))
  })
})

test('#21 hostAlive：新鲜 + pid 存活才算有宿主', async () => {
  await withHome(async (env) => {
    assert.equal(hostAlive(env), false, '没有心跳文件 → 没有宿主')

    const at = 1_000_000
    writeHostMarker(env, { version: '9.9.9' }, at)
    const marker = readHostMarker(env)
    assert.equal(marker.pid, process.pid)
    assert.equal(marker.version, '9.9.9')

    assert.equal(hostAlive(env, { now: at + 1000 }), true, '新鲜且 pid 活着 → 有宿主')
    assert.equal(hostAlive(env, { now: at + 46_000 }), false, '超过 45s 没刷新 → 视为没有宿主')
    assert.equal(hostAlive(env, { now: at + 1000, isAlive: () => false }), false, 'pid 已死 → 视为没有宿主（心跳文件残留不算）')

    clearHostMarker(env)
    assert.equal(hostAlive(env, { now: at + 1000 }), false)
    assert.equal(readHostMarker(env), null)
  })
})

test('#21 isProcessAlive：自己的 pid 活着，不存在的 pid 不算', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive('abc'), false)
})

// ============================ 直写共享配置 ============================
test('#21 applySharedConfigDirect：合并写入并保留未知键（不是整体替换）', async () => {
  await withHome(async (env) => {
    const file = configFilePath(env)
    await fs.writeFile(file, JSON.stringify({ recycleRetentionDays: 30, someFutureKey: 'keep-me' }), 'utf8')
    const next = applySharedConfigDirect(env, { recycleRetentionDays: 28 })
    assert.equal(next.recycleRetentionDays, 28)
    assert.equal(next.someFutureKey, 'keep-me', '老版本/别的工具写下的键必须留住')
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.deepEqual(onDisk, next, '磁盘内容与返回值一致（原子写完成）')
  })
})

// ============================ 失败分类与指路 ============================
test('#21 describeApplyFailure：两种宿主守卫措辞都归为 host-guard 并给出指路', () => {
  assert.equal(isHostGuardError('HMR transactions cannot be nested'), true)
  assert.equal(isHostGuardError('dsh-tui: root.events.emit is unavailable from a plugin activation'), true)
  assert.equal(isHostGuardError('ECONNREFUSED'), false)

  for (const raw of ['HMR transactions cannot be nested', 'root.events.emit is unavailable from a plugin activation']) {
    const d = describeApplyFailure(raw)
    assert.equal(d.kind, 'host-guard')
    assert.match(d.hint, /DSH 设置 → 记忆/, '必须说清去哪改')
    assert.match(d.hint, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '原始报错要带出来')
  }
  const other = describeApplyFailure('boom')
  assert.equal(other.kind, 'other')
  assert.match(other.hint, /boom/)
  assert.equal(describeApplyFailure('').hint, '')
})

test('#21 连续失败放弃时的报错带指路（不再只重复原报错）', async () => {
  await withHome(async (env) => {
    writePendingConfig(env, { recycleRetentionDays: 28 })
    const apply = () => { throw new Error('HMR transactions cannot be nested') }
    // maxTries=2：第一次只是记 tries，第二次才放弃 —— 与运行期 5 秒轮询的真实节奏一致
    let thrown = null
    for (let i = 0; i < 2; i++) {
      try { await drainPendingConfig(env, apply, 2) } catch (error) { thrown = error }
    }
    assert.ok(thrown, '必须抛错让调用方写日志')
    assert.equal(thrown.dropped, true, '第 2 次应标记放弃')
    assert.match(thrown.message, /HMR transactions cannot be nested/)
    assert.match(thrown.message, /DSH 设置 → 记忆/, '放弃时也要告诉用户去哪改')
    assert.equal(readPendingConfig(env).dropped, true)
    clearPendingConfig(env)
  })
})

// ============================ POST /config 的两条路 ============================
function makeRes() {
  return {
    httpStatus: 0, body: null,
    writeHead(status) { this.httpStatus = status },
    end(buf) { this.body = JSON.parse(Buffer.from(buf).toString('utf8')) },
  }
}
async function postConfig(root, payload) {
  const handle = createApi({ vaultDir: () => root })
  const res = makeRes()
  const raw = JSON.stringify(payload)
  const iter = (async function* () { yield Buffer.from(raw, 'utf8') })()
  await handle(Object.assign(iter, { url: API_PREFIX + '/config', method: 'POST', headers: {} }), res)
  return { httpStatus: res.httpStatus, ...res.body }
}

test('#21 无 DSH 宿主：保存直接写共享配置并当场生效（Codex / 纯 serve 的场景）', async () => {
  await withHome(async (env, home) => {
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const r = await postConfig(path.join(home, 'vault'), { patch: { recycleRetentionDays: 28 } })
      assert.equal(r.ok, true)
      assert.equal(r.pendingOutcome, 'applied-direct')
      assert.equal(r.appliedDirect, true)
      assert.match(r.note, /直接写入共享配置/)
      assert.deepEqual(r.pending, [], '已直写就不该再留在待应用里')
      const shared = JSON.parse(await fs.readFile(configFilePath(env), 'utf8'))
      assert.equal(shared.recycleRetentionDays, 28, '共享配置必须真的被改到（hooks/MCP/独立页都读它）')
      assert.equal(readPendingConfig(env), null, 'pending 文件应被清掉')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})

test('#21 有活宿主：只写 pending，绝不绕过宿主直写共享配置', async () => {
  await withHome(async (env, home) => {
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      // 心跳由「活着的」进程写下（用测试进程自己的 pid），等价于 DSH 宿主在跑
      writeHostMarker(env, { version: '0.10.5' })
      assert.equal(hostAlive(env), true)
      const r = await postConfig(path.join(home, 'vault'), { patch: { recycleRetentionDays: 28 } })
      assert.equal(r.ok, true)
      assert.equal(r.pendingOutcome, 'queued', '宿主还没消费 → 如实回「排队中」')
      assert.equal(r.appliedDirect, false)
      await assert.rejects(fs.readFile(configFilePath(env), 'utf8'), '共享配置不许由独立端直接改写')
      assert.equal(readPendingConfig(env).patch.recycleRetentionDays, 28, '改动留在 pending 文件里等宿主')
      clearPendingConfig(env)
      clearHostMarker(env)
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})

test('#21 pending 文件路径确实落在 DSH_HOME 下（隔离性自检）', async () => {
  await withHome(async (env, home) => {
    assert.equal(path.dirname(pendingConfigPath(env)), home)
  })
})
