// 请求体大小上限（审计 H2）。
//
// 旧实现有三套 body 读取：`readBody` **完全没有上限**、cloud-server 自己写的 8MB、
// `/import` 的 16MB 循环。`readBody` 被 30+ 个路由使用，云端模式下它们跑在**同一个进程**里 ——
// 一个租户 POST 一个几 GB 的 body 就能把内存打满，影响所有租户。
//
// 现在只有一份实现：默认 2MB；`/backup/import`、`/vaults/import-into` 显式放宽到 256MB；
// `/import`、`/import/chunk` 保持既有的 16MB 承诺。Content-Length 声明超限就地 413，
// 流式读取超限也 413 并销毁请求。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, API_PREFIX, readBody, readBodyText, MAX_BODY_BYTES, LARGE_BODY_BYTES, bodyLimitFor } from '../lib/api.js'
import { ensureVault } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'
import { MAX_CHUNK_BYTES } from '../lib/import-batch.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-body-'))
after(() => {
  closeAllDb()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

/** 造一个假 res：只收集状态码与 body。 */
function fakeRes() {
  const out = { status: 0, body: '', headers: {} }
  out.writeHead = (s, h) => { out.status = s; if (h) out.headers = { ...out.headers, ...h } }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.end = (b) => {
    out.body = b === undefined || b === null ? '' : String(b)
    if (Buffer.isBuffer(b)) out.body = b.toString('utf8')
  }
  out.on = () => {}
  out.once = () => {}
  out.emit = () => {}
  return out
}

/**
 * 造一个可由调用方控制「声明长度」与「实际字节数」的假 req。
 * @param {{declared?:number, chunks?:Buffer[], headers?:object}} o
 */
function fakeReq({ declared = null, chunks = [], headers = {} } = {}) {
  const state = { destroyed: false }
  const h = { 'content-type': 'application/json', ...headers }
  if (declared !== null) h['content-length'] = String(declared)
  const req = {
    url: '',
    method: 'POST',
    headers: h,
    destroy() { state.destroyed = true },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  }
  return { req, state }
}

// ── 常量与路由口径 ───────────────────────────────────────────────────────────
test('H2：上限口径（默认 2MB；大体积路由显式放宽；导入保持 16MB 承诺）', () => {
  assert.equal(MAX_BODY_BYTES, 2 * 1024 * 1024)
  assert.equal(LARGE_BODY_BYTES, 256 * 1024 * 1024)
  assert.equal(bodyLimitFor('/config'), MAX_BODY_BYTES)
  assert.equal(bodyLimitFor('/write'), MAX_BODY_BYTES)
  assert.equal(bodyLimitFor('/cards/bulk'), MAX_BODY_BYTES)
  assert.equal(bodyLimitFor('/backup/import'), LARGE_BODY_BYTES)
  assert.equal(bodyLimitFor('/vaults/import-into'), LARGE_BODY_BYTES)
  assert.equal(bodyLimitFor('/import'), MAX_CHUNK_BYTES)
  assert.equal(bodyLimitFor('/import/chunk'), MAX_CHUNK_BYTES)
  assert.equal(MAX_CHUNK_BYTES, 16 * 1024 * 1024, '16MB 是分片导入对外的既有承诺')
})

// ── readBody 本身 ───────────────────────────────────────────────────────────
test('H2：Content-Length 超限 → 抛 PAYLOAD_TOO_LARGE 并销毁请求（不读进内存）', async () => {
  const { req, state } = fakeReq({ declared: MAX_BODY_BYTES + 1, chunks: [] })
  await assert.rejects(() => readBody(req), (e) => {
    assert.equal(e.code, 'PAYLOAD_TOO_LARGE')
    assert.equal(e.status, 413)
    assert.equal(e.maxBytes, MAX_BODY_BYTES)
    return true
  })
  assert.equal(state.destroyed, true, '超限必须销毁请求，别让对方继续灌数据')
})

test('H2：不声明长度但流式超限 → 同样 413 并销毁（不信 Content-Length）', async () => {
  const big = Buffer.alloc(MAX_BODY_BYTES + 1024, 0x20)
  const { req, state } = fakeReq({ chunks: [Buffer.from('{"a":"'), big, Buffer.from('"}')] })
  await assert.rejects(() => readBody(req), (e) => e.code === 'PAYLOAD_TOO_LARGE')
  assert.equal(state.destroyed, true)
})

test('H2：上限内正常解析；坏 JSON 仍旧退回空对象（既有契约）', async () => {
  const okBody = Buffer.from(JSON.stringify({ hello: 'world' }))
  const { req } = fakeReq({ declared: okBody.length, chunks: [okBody] })
  assert.deepEqual(await readBody(req), { hello: 'world' })

  const { req: broken } = fakeReq({ chunks: [Buffer.from('{不是 JSON')] })
  assert.deepEqual(await readBody(broken), {}, '坏 JSON 不许抛错（30+ 调用点依赖这个契约）')

  const { req: empty } = fakeReq({ chunks: [] })
  assert.deepEqual(await readBody(empty), {})
})

test('H2：readBodyText 保原始串（/import 要自己回答「JSON 解析失败」）', async () => {
  const raw = '{不是 JSON'
  const { req } = fakeReq({ chunks: [Buffer.from(raw)] })
  assert.equal(await readBodyText(req), raw)
  const { req: leak } = fakeReq({ declared: MAX_BODY_BYTES + 1, chunks: [] })
  await assert.rejects(() => readBodyText(leak), (e) => e.code === 'PAYLOAD_TOO_LARGE')
})

// ── 走真实路由：413 ─────────────────────────────────────────────────────────
test('H2：超大 Content-Length 打 /config → 413 payload_too_large', async () => {
  const vault = path.join(tmp, 'vault-413')
  await ensureVault(vault)
  const api = createApi({ vaultDir: () => vault, getSettings: () => ({}) })
  const res = fakeRes()
  const { req } = fakeReq({ declared: 512 * 1024 * 1024, chunks: [] })
  await api(Object.assign(req, { url: API_PREFIX + '/config' }), res)
  assert.equal(res.status, 413)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'payload_too_large')
  assert.equal(body.maxBytes, MAX_BODY_BYTES)
  assert.equal(body.declared, 512 * 1024 * 1024)
})

test('H2：不声明长度、流式超限打 /write → 也是 413（不是 500、不是 400）', async () => {
  const vault = path.join(tmp, 'vault-stream')
  await ensureVault(vault)
  const api = createApi({ vaultDir: () => vault, getSettings: () => ({}) })
  const res = fakeRes()
  const chunks = []
  for (let i = 0; i < 5; i++) chunks.push(Buffer.alloc(512 * 1024, 0x20))
  const { req, state } = fakeReq({ chunks })
  await api(Object.assign(req, { url: API_PREFIX + '/write' }), res)
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'payload_too_large')
  assert.equal(state.destroyed, true, '流式超限要销毁请求')
})

test('H2：大体积路由不受 2MB 默认值限制（3MB 声明能过闸门，落到业务错误而非 413）', async () => {
  const vault = path.join(tmp, 'vault-large')
  await ensureVault(vault)
  const api = createApi({ vaultDir: () => vault, getSettings: () => ({}) })
  const res = fakeRes()
  // 声明 3MB（> 默认 2MB，但 < 256MB）：闸门要放过，然后因为没数据而以业务错误回答
  const { req } = fakeReq({ declared: 3 * 1024 * 1024, chunks: [] })
  await api(Object.assign(req, { url: API_PREFIX + '/vaults/import-into' }), res)
  assert.notEqual(res.status, 413, '大体积路由不能被 2MB 默认值打死：' + res.body)
  assert.equal(res.status, 400)
})

test('H2：/import 超限仍是 413 且文案指向分片导入（旧口径保留）', async () => {
  const vault = path.join(tmp, 'vault-import')
  await ensureVault(vault)
  const api = createApi({ vaultDir: () => vault, getSettings: () => ({}) })
  const res = fakeRes()
  const { req } = fakeReq({ declared: MAX_CHUNK_BYTES + 1, chunks: [] })
  await api(Object.assign(req, { url: API_PREFIX + '/import' }), res)
  assert.equal(res.status, 413)
  const body = JSON.parse(res.body)
  assert.equal(body.code, 'payload_too_large')
  assert.equal(body.maxBytes, MAX_CHUNK_BYTES)
  assert.match(String(body.error), /分片导入|16MB/)
})

// ── H3：/backup/import 的临时文件 ────────────────────────────────────────────
test('H3：/backup/import 用私有临时目录（成功/失败都不留 me-import-* 残留）', async () => {
  const vault = path.join(tmp, 'vault-h3')
  await ensureVault(vault)
  const api = createApi({ vaultDir: () => vault, getSettings: () => ({}) })
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('me-import-')))
  const call = async (payload) => {
    const res = fakeRes()
    const raw = Buffer.from(JSON.stringify(payload))
    const { req } = fakeReq({ chunks: [raw] })
    await api(Object.assign(req, { url: API_PREFIX + '/backup/import' }), res)
    return res
  }
  // ① 太小的 payload（不是 SQLite）→ 400，且不留临时目录
  const small = await call({ data: Buffer.from('not a database at all').toString('base64') })
  assert.equal(small.status, 400)
  // ② 有 SQLite 头但内容是垃圾 → 400（quick_check 不过），同样不留残留
  const junk = Buffer.alloc(8192, 0x41)
  junk.write('SQLite format 3\u0000', 0, 'latin1')
  const bad = await call({ data: junk.toString('base64') })
  assert.equal(bad.status, 400)

  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('me-import-') && !before.has(f))
  assert.deepEqual(after, [], '临时目录必须清干净（成功与失败都要清）：' + after.join(','))
})

test('H3：base64 长度先做上限判断（超限 413，不进 Buffer.from）', async () => {
  // 造一个真·超限的 base64 串太吃内存，这里用「代码形状 + 上限公式」双重守卫：
  // 口径算错（比如忘记 *4/3）时这条会先炸。
  const maxB64 = Math.ceil(LARGE_BODY_BYTES / 3) * 4
  assert.ok(maxB64 > LARGE_BODY_BYTES, 'base64 膨胀比要按 4/3 算')
  const src = fs.readFileSync(new URL('../lib/api.js', import.meta.url), 'utf8')
  assert.match(src, /b64\.length > maxB64/, 'base64 长度必须先做上限判断再 Buffer.from')
  assert.match(src, /mkdtempSync\(pathMod\.join\(osMod\.tmpdir\(\), 'me-import-'\)\)/, '必须用 mkdtemp 私有目录')
  assert.match(src, /flag: 'wx', mode: 0o600/, '临时文件必须 wx 独占 + 0600')
  assert.match(src, /rmSync\(tmpDir, \{ recursive: true, force: true \}\)/, '结束（成功/失败）都要清临时目录')
})
