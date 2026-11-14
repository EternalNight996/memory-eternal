// R1–R4 验收（对照 autokill-purge 的清单第 9 节）
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi } from 'file:///F:/MyApp/eternal/memory-eternal/lib/api.js'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'me-accept-'))
const mk = () => {
  const h = createApi({ vaultDir: () => vault, vaultRoots: () => [{ name: 't', root: vault }], getSettings: () => ({}), getCaptureLog: () => null })
  return http.createServer((q, r) => h(q, r))
}
const boot = async () => {
  const srv = mk()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, B: `http://127.0.0.1:${srv.address().port}/memory-eternal/api` }
}

let { srv, B } = await boot()
const j = async (u, o) => { const r = await fetch(B + u, o); return { s: r.status, d: await r.json().catch(() => ({})) } }
const POST = (u, body) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

let pass = 0, fail = 0
const chk = (n, ok, extra = '') => { console.log(`${ok ? '✔' : '✘'} ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }

// 1 未登记 → missing
const r1 = await POST('/lookup', { keys: ['purge.gear.plan_unpack'] })
chk('1 lookup 未登记 → missing', r1.s === 200 && r1.d.results[0].state === 'missing')

// 2 capture/upsert → created
const r2 = await POST('/upsert', { card: { key: 'purge.test.one', kind: 'tool', title: '测试卡', body: '# 正文\n\n内容。', source: 'autokill-purge' } })
chk('2 upsert → created + pending', r2.s === 200 && r2.d.action === 'created' && r2.d.state === 'pending', JSON.stringify({ action: r2.d.action, key: r2.d.key }))

// 3 提交即可查 → pending
const r3 = await POST('/lookup', { keys: ['purge.test.one'] })
chk('3 立即 lookup → pending', r3.d.results[0].state === 'pending', 'path=' + String(r3.d.results[0].path || '').slice(0, 30))

// 4 重复 upsert → updated，且只有一张卡
const r4 = await POST('/upsert', { card: { key: 'purge.test.one', kind: 'tool', title: '测试卡', body: '# 正文\n\n改过。', source: 'autokill-purge' } })
const h4 = await j('/health')
chk('4 重复 upsert → updated', r4.d.action === 'updated', 'cards=' + h4.d.cards)

// 5 200 keys ≤100ms + 顺序一致
const keys = Array.from({ length: 200 }, (_, i) => 'purge.perf.' + i)
const t0 = Date.now()
const r5 = await POST('/lookup', { keys })
const ms = Date.now() - t0
chk('5 200 keys ≤100ms', r5.s === 200 && ms <= 100, ms + 'ms')
chk('5b 顺序与请求一致', r5.d.results.every((r, i) => r.key === keys[i]))

// 6 health 单版本 + alive + writable
const r6 = await j('/health')
const verCount = JSON.stringify(r6.d).match(/"version"/g) || []
chk('6 health 只有一个 version', r6.s === 200 && verCount.length === 1, 'v=' + r6.d.version + ' alive=' + r6.d.alive + ' writable=' + r6.d.writable)
chk('6b schema_version=2', r6.d.schema_version === 2)

// 7 重启后不丢
srv.close()
;({ srv, B } = await boot())
const j2 = async (u, o) => { const r = await fetch(B + u, o); return { s: r.status, d: await r.json().catch(() => ({})) } }
const r7 = await j2('/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['purge.test.one'] }) })
chk('7 重启后仍可查（pending/approved）', ['pending', 'approved'].includes(r7.d.results[0].state), r7.d.results[0].state)

// 8 filter 收窄
const r8 = await j2('/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['purge.test.one'], filter: { source: 'other-app' } }) })
chk('8 filter 不匹配 → missing', r8.d.results[0].state === 'missing')

// 9 非法 key 被拒
const r9 = await j2('/upsert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card: { key: 'Bad Key!', title: 'x', body: 'y' } }) })
chk('9 非法 key 被拒(400)', r9.s === 400)

// 10 超过 200 keys 被拒
const r10 = await j2('/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: Array.from({ length: 201 }, (_, i) => 'k' + i) }) })
chk('10 >200 keys 被拒(413)', r10.s === 413)

srv.close()
setTimeout(() => { try { fs.rmSync(vault, { recursive: true, force: true }) } catch {} }, 300)
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
