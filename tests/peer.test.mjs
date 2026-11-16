// MEM Pair：两个 memory-eternal 实例「发现 → 匹配码 → 人工确认 → 互推」的单元测试。
//
// 重点守三件事：
//   ① 共享密钥两端各自算出、**永不上网**；
//   ② 签名能挡住改包、重放、时间窗外的请求；
//   ③ 匹配码不一致必须拒绝（配错对象是这套机制唯一的真实风险）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readIdentity, fingerprint, deriveShared, sign, canonical, verifyPeerCall, signedHeaders,
  startPairing, pushIncoming, acceptPairing, finishPairing, peerStatus, peerPath, revokePeer,
} from '../lib/peer.js'

const homes = []
const newEnv = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'me-peer-'))
  homes.push(home)
  return { DSH_HOME: home }
}
test.after(() => { for (const h of homes) { try { rmSync(h, { recursive: true, force: true }) } catch { /* 忽略 */ } } })

test('身份：只建一次、持久化、密钥 32B、指纹 16 位', () => {
  const env = newEnv()
  const a = readIdentity(env)
  const b = readIdentity(env)
  assert.equal(a.instanceId, b.instanceId, '同一 DSH_HOME 必须复用同一个身份')
  assert.equal(Buffer.from(a.secret, 'base64url').length, 32)
  assert.match(fingerprint(a), /^[0-9a-f]{16}$/)
  if (process.platform !== 'win32') {
    assert.equal(statSync(peerPath(env)).mode & 0o777, 0o600, '身份文件应当 0600')
  }
})

test('共享密钥：两端各自算出的值相同，且不依赖顺序', () => {
  const e1 = 'A'.repeat(43)
  const e2 = 'B'.repeat(43)
  assert.equal(deriveShared(e1, e2), deriveShared(e2, e1))
  assert.notEqual(deriveShared(e1, e2), deriveShared(e1, e1))
})

test('签名：正常通过；改包 / 改路径 / 超时间窗 / 重放 全部拒绝', () => {
  const env = newEnv()
  let id = readIdentity(env)
  // 语义：peers 里存的是**对方**；签名头带的是**发送方自己**的 instanceId
  const remoteId = 'peer-1'
  id = { ...id, peers: [{ id: remoteId, name: 'purge', url: 'http://127.0.0.1:7989', shared: deriveShared('x'.repeat(43), 'y'.repeat(43)), enabled: true }] }
  const peer = id.peers[0]
  const body = JSON.stringify({ items: [{ title: 't', body: 'b' }] })
  const p = '/memory-eternal/api/peer/push'
  const h = signedHeaders(peer, 'POST', p, body, remoteId)
  const mk = (headers) => ({ headers })

  assert.equal(verifyPeerCall(id, mk(h), { method: 'POST', path: p, bodyText: body }).ok, true)

  const tampered = verifyPeerCall(id, mk(h), { method: 'POST', path: p, bodyText: body + ' ' })
  assert.equal(tampered.ok, false)
  assert.equal(tampered.code, 'peer_bad_sig', '改包必须签名不匹配')

  const wrongPath = verifyPeerCall(id, mk(h), { method: 'POST', path: p + '/x', bodyText: body })
  assert.equal(wrongPath.code, 'peer_bad_sig')

  const oldHeaders = { ...h, 'x-me-peer-ts': String(Date.now() - 10 * 60 * 1000) }
  assert.equal(verifyPeerCall(id, mk(oldHeaders), { method: 'POST', path: p, bodyText: body }).code, 'peer_skew')

  // 同一组头重放：nonce 已用过
  assert.equal(verifyPeerCall(id, mk(h), { method: 'POST', path: p, bodyText: body }).code, 'peer_replay')

  const unsigned = verifyPeerCall(id, mk({}), { method: 'POST', path: p, bodyText: body })
  assert.equal(unsigned.code, 'peer_not_signed')
})

test('配对全流程：两端拿到同一把共享密钥，且 pending 清空', () => {
  const envA = newEnv()
  const envB = newEnv()
  let A = readIdentity(envA)
  let B = readIdentity(envB)

  const target = { id: B.instanceId, name: 'mem-purge', host: '127.0.0.1', port: 7989, fp: fingerprint(B) }
  const started = startPairing(A, target, envA)
  assert.match(started.code, /^\d{6}$/, '匹配码必须是 6 位数字')
  A = readIdentity(envA)
  assert.equal(A.peers.length, 0, '发起方在对方确认前不能算已配对')

  const incoming = pushIncoming(B, { from: { ...started.request.from, url: 'http://127.0.0.1:7999' }, code: started.code, eph: started.request.eph, ts: started.request.ts }, envB)
  assert.equal(incoming.ok, true)
  B = readIdentity(envB)
  assert.equal(peerStatus(B).pending.length, 1)
  assert.equal(peerStatus(B).pending[0].direction, 'incoming', '面板据此弹窗')

  const acc = acceptPairing(B, started.request.from.id, envB)
  assert.equal(acc.ok, true)
  const fin = finishPairing(A, { from: acc.confirm.from, eph: acc.confirm.eph, code: acc.confirm.code }, envA)
  assert.equal(fin.ok, true)

  A = readIdentity(envA)
  B = readIdentity(envB)
  assert.equal(A.peers.length, 1)
  assert.equal(B.peers.length, 1)
  assert.equal(A.peers[0].shared, B.peers[0].shared, '两端共享密钥必须一致（否则后续签名全挂）')
  assert.equal(A.pending.length, 0)
  assert.equal(B.pending.length, 0)
})

test('匹配码不一致：拒绝配对（防配错对象）', () => {
  const envA = newEnv()
  const envB = newEnv()
  let A = readIdentity(envA)
  let B = readIdentity(envB)
  const started = startPairing(A, { id: B.instanceId, name: 'x', host: '127.0.0.1', port: 1 }, envA)
  A = readIdentity(envA)          // startPairing 写的是文件，内存对象要重读
  pushIncoming(B, { from: { ...started.request.from, url: 'http://127.0.0.1:7999' }, code: started.code, eph: started.request.eph }, envB)
  B = readIdentity(envB)
  const acc = acceptPairing(B, started.request.from.id, envB)
  const wrongCode = started.code === '000000' ? '111111' : '000000'
  const fin = finishPairing(A, { from: acc.confirm.from, eph: acc.confirm.eph, code: wrongCode }, envA)
  assert.equal(fin.ok, false)
  assert.match(fin.error, /匹配码不一致/)
})

test('status 不泄露任何密钥；revoke 能把对方踢掉', () => {
  const env = newEnv()
  let id = readIdentity(env)
  id = { ...id, peers: [{ id: 'p1', name: 'purge', url: 'http://x', shared: 'SECRET', enabled: true, pairedAt: 1 }] }
  const st = peerStatus(id)
  assert.equal(JSON.stringify(st).includes('SECRET'), false, 'status 里不许出现共享密钥')
  assert.equal(revokePeer(id, 'p1', env).ok, true)
  assert.equal(readIdentity(env).peers.length, 0)
})

test('canonical 把方法/路径/时间戳/nonce/正文摘要都绑进签名', () => {
  const c1 = canonical('POST', '/a', 1, 'n', 'body')
  const c2 = canonical('GET', '/a', 1, 'n', 'body')
  const c3 = canonical('POST', '/a', 2, 'n', 'body')
  assert.notEqual(c1, c2)
  assert.notEqual(c1, c3)
  assert.equal(sign('AAAA', 'POST', '/a', 1, 'n', 'body'), sign('AAAA', 'POST', '/a', 1, 'n', 'body'))
})
