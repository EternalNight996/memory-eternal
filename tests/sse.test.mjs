// SSE 推送中心回归：接入/广播/断开清理/心跳。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHub } from '../lib/sse.js'

const fakeRes = () => {
  const chunks = []
  const handlers = new Map()
  return {
    chunks,
    headers: null,
    ended: false,
    writeHead(status, headers) { this.headers = headers },
    write(chunk) { chunks.push(String(chunk)); return true },
    end() { this.ended = true },
    on(ev, fn) { handlers.set(ev, fn) },
    emit(ev) { const fn = handlers.get(ev); if (fn) fn() },
  }
}

test('接入时写 SSE 头与 retry，广播能到达', () => {
  const hub = createHub({ heartbeatMs: 0 })
  const a = fakeRes()
  assert.equal(hub.add(a), true)
  assert.match(a.headers['Content-Type'], /text\/event-stream/)
  assert.equal(a.headers['Cache-Control'], 'no-store')
  assert.equal(a.chunks[0], 'retry: 3000\n\n')
  const n = hub.broadcast('config', { at: 123 })
  assert.equal(n, 1)
  assert.equal(a.chunks[1], 'event: config\ndata: {"at":123}\n\n')
})

test('多个连接都收到；断开后自动清理且不再发送', () => {
  const hub = createHub({ heartbeatMs: 0 })
  const a = fakeRes(), b = fakeRes()
  hub.add(a); hub.add(b)
  assert.equal(hub.size, 2)
  assert.equal(hub.broadcast('change', { ok: true }), 2)
  a.emit('close')
  assert.equal(hub.size, 1, 'close 后必须移除')
  hub.broadcast('change', {})
  assert.equal(b.chunks.length, 3, 'B 应收到 retry + 两次广播')
})

test('写入失败（客户端已死）不会抛错，并顺手清理', () => {
  const hub = createHub({ heartbeatMs: 0 })
  const dead = fakeRes()
  hub.add(dead)
  dead.write = () => { throw new Error('EPIPE') }
  assert.doesNotThrow(() => hub.broadcast('config', {}))
  assert.equal(hub.size, 0, '写失败应被清理')
})

test('close() 结束所有连接', () => {
  const hub = createHub({ heartbeatMs: 0 })
  const a = fakeRes()
  hub.add(a)
  hub.close()
  assert.equal(hub.size, 0)
  assert.equal(a.ended, true)
})

test('未传 data 时广播为空对象（保持 JSON 合法）', () => {
  const hub = createHub({ heartbeatMs: 0 })
  const a = fakeRes()
  hub.add(a)
  hub.broadcast('tick')
  assert.equal(a.chunks[1], 'event: tick\ndata: {}\n\n')
})
