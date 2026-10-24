// dsh-tui 插件启动守卫（issue #50 的根因之一）：
// 宿主 seam（tuiPluginHost / tuiScenes）是**后挂载**的，插件激活时常常还没就绪。
// 旧实现 `if (!host) return` 直接放弃 → 命令面板里永远没有 /memory、/audit（issue #50 用户实测）。
// 现在改成软探测 + 50ms 小步轮询（参照 dsh-tui-find 的做法）。本文件锁住这个行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../dsh-tui-plugin/main.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx({ hostDelayMs = 120, withHost = true, scenesDelayMs = 0 } = {}) {
  const start = Date.now()
  const commands = []
  let sceneRegistrations = 0
  const scenes = {
    active: null,
    register() { sceneRegistrations += 1; return () => { sceneRegistrations -= 0 } },
    open: () => true,
    close() {},
  }
  const disposers = []
  const ctx = {
    effect: (fn) => { disposers.push(fn()) },
    get: (name, fallback) => {
      if (name === 'tuiPluginHost') {
        if (!withHost) return false
        if (Date.now() - start < hostDelayMs) return false
        return { registerCommand: (_c, id) => { commands.push(id); return () => {} } }
      }
      if (name === 'tuiScenes') return Date.now() - start >= scenesDelayMs ? scenes : false
      return fallback
    },
  }
  return {
    ctx,
    commands,
    scenes,
    get sceneRegistrations() { return sceneRegistrations },
    disposeAll: () => disposers.reverse().forEach((d) => { try { if (typeof d === 'function') d() } catch { /* ignore */ } }),
  }
}

test('宿主 seam 晚于插件激活挂载：命令仍会被注册（不是永久放弃）', async () => {
  const m = makeCtx({ hostDelayMs: 120 })
  apply(m.ctx)
  assert.deepEqual(m.commands, [], '刚激活时宿主还没挂载，不该立刻有命令')
  await sleep(450)
  assert.deepEqual(m.commands.slice().sort(), ['memory-eternal-tui.audit', 'memory-eternal-tui.open'], '轮询到宿主后必须把 /memory 与 /audit 都注册上')
  m.disposeAll()
})

test('宿主已就绪：同步注册，不必等轮询（冷启动快路径）', () => {
  const m = makeCtx({ hostDelayMs: 0 })
  apply(m.ctx)
  assert.equal(m.commands.length, 2, '首个 tick 就应拿到宿主并注册两条命令')
  m.disposeAll()
})

test('宿主一直不挂载：安静收手，不抛错、不注册（确实没有 TUI 运行时的组合）', async () => {
  const m = makeCtx({ withHost: false })
  assert.doesNotThrow(() => apply(m.ctx))
  await sleep(120)
  assert.deepEqual(m.commands, [])
  m.disposeAll()
})

test('卸载后清掉轮询定时器：不再注册（避免残留 activation 抢注册）', async () => {
  const m = makeCtx({ hostDelayMs: 150 })
  apply(m.ctx)
  m.disposeAll()
  await sleep(450)
  assert.deepEqual(m.commands, [], 'effect 卸载后定时器必须停，命令不该迟到注册')
})

test('tuiScenes 晚挂载：场景会重试注册（不依赖单次探测）', async () => {
  const m = makeCtx({ hostDelayMs: 0, scenesDelayMs: 120 })
  apply(m.ctx)
  await sleep(450)
  assert.ok(m.sceneRegistrations >= 1, 'scenes 上线后 audit 场景必须被注册（实测 ' + m.sceneRegistrations + ' 次）')
  m.disposeAll()
})
