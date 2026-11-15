// `dsh-memory cloud`（云端访问密钥 CLI）。
//
// 为什么要有这组测试：CLI 的授权口径是「**能在这台机上跑命令 = 管理员**」——
// 它直接读写 `$DSH_HOME/cloud-keys.json`，不依赖 `MEMORY_CLOUD_ADMIN_TOKEN`。
// 这条口径成立的前提有两个必须钉住的行为：
//   ① 台账里永远只有 sha256（CLI 任何输出都不得回显明文/hash，除 issue 那一刻）；
//   ② `resolveTenant` 每请求重新读盘 → **CLI 签发后立刻可用、吊销立刻失效**（不用重启服务）。
// 任何一条退化，"CLI 当管理员"就变成"CLI 骗人"。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createCloudServer } from '../lib/cloud-server.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const homes = []
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ccli-'))
  homes.push(home)
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  return home
}
after(() => {
  for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }) } catch { /* 忽略 */ } }
})

/** 跑一次 CLI，返回 { code, out, err }（不抛：非零退出也是被测行为）。
 *  用 spawnSync 而不是 execFileSync —— 后者只回 stdout，拿不到 stderr 上的「只显示这一次」提示。 */
function cli(args, { home } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'dsh-memory.mjs'), 'cloud', ...args, ...(home ? ['--home', home] : [])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home || process.env.DSH_HOME || '' },
  })
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

/** 造一个最小 req/res，跑一遍云端 handler（与 cloud-admin-scope 同一套桩）。 */
function invoke(handler, { method = 'GET', sub = '/overview', headers = {}, remoteAddress = '203.0.113.9', body = '' } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const req = {
      method,
      url: '/memory-eternal/api' + sub,
      headers,
      socket: { remoteAddress },
      on(evt, cb) {
        if (evt === 'data' && body) cb(Buffer.from(body))
        if (evt === 'end') cb()
        return this
      },
      destroy() {},
    }
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}) },
      setHeader() {},
      write() {},
      on() {},
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 原文 */ }
        resolve({ status: this.statusCode, body: parsed, headers: this.headers })
      },
    }
    Promise.resolve(handler(req, res)).catch(() => resolve({ status: 500, body: null }))
  })
}

const serverFor = (home) => createCloudServer({
  env: { ...process.env, DSH_HOME: home, MEMORY_CLOUD_ADMIN_TOKEN: 'admin-token-for-test' },
  version: '0.48.0',
})

test('cloud info：打印台账路径与密钥数（空台账）', () => {
  const home = makeHome()
  const r = cli(['info'], { home })
  assert.equal(r.code, 0)
  assert.match(r.out, /cloud-keys\.json/)
  assert.match(r.out, /密钥\s+：0 把/)
})

test('keys ls：空台账给可执行提示，不报错', () => {
  const home = makeHome()
  const r = cli(['keys', 'ls'], { home })
  assert.equal(r.code, 0)
  assert.match(r.out, /还没有任何访问密钥/)
  assert.match(r.out, /keys issue --owner/)
})

test('keys issue：stdout 有 me_ 明文，且不含 hash', () => {
  const home = makeHome()
  const r = cli(['keys', 'issue', '--owner', 'alice', '--note', '笔记本'], { home })
  assert.equal(r.code, 0)
  const token = /(me_[A-Za-z0-9_-]{10,})/.exec(r.out)?.[1] || ''
  assert.ok(token.startsWith('me_'), 'stdout 里应有 me_ 开头的明文：' + r.out)
  // 台账里存的是 hash，输出里不该出现"64 位 hex"这种哈希形状
  assert.doesNotMatch(r.out, /\b[0-9a-f]{64}\b/)
  // 一次性提示必须在 stderr（不与明文抢同一行，方便脚本 capture stdout）
  assert.match(r.err, /明文只显示这一次/)
  assert.match(r.err, /立即生效/)
  const store = JSON.parse(fs.readFileSync(path.join(home, 'cloud-keys.json'), 'utf8'))
  assert.equal(store.keys.length, 1)
  assert.equal(store.keys[0].owner, 'alice')
  assert.equal(store.keys[0].token, undefined, '台账不能存明文')
  assert.ok(store.keys[0].hash && store.keys[0].hash.length >= 32, '台账应存 hash')
})

test('keys ls：列表不含明文与 hash（只是运维视图）', () => {
  const home = makeHome()
  const issued = cli(['keys', 'issue', '--owner', 'bob', '--note', 'b'], { home })
  const token = /(me_[A-Za-z0-9_-]{10,})/.exec(issued.out)?.[1] || ''
  const ls = cli(['keys', 'ls'], { home })
  assert.equal(ls.code, 0)
  assert.match(ls.out, /bob/)
  assert.ok(!ls.out.includes(token), 'ls 不得回显明文密钥')
  assert.doesNotMatch(ls.out, /\b[0-9a-f]{64}\b/, 'ls 不得回显 hash')
  const store = JSON.parse(fs.readFileSync(path.join(home, 'cloud-keys.json'), 'utf8'))
  assert.ok(!ls.out.includes(store.keys[0].hash), 'ls 不得回显 hash 原值')
})

test('whoami：有效密钥解析出 owner；伪造密钥失败（非零退出）', () => {
  const home = makeHome()
  const issued = cli(['keys', 'issue', '--owner', 'carol'], { home })
  const token = /(me_[A-Za-z0-9_-]{10,})/.exec(issued.out)?.[1] || ''
  const ok = cli(['whoami', '--token', token], { home })
  assert.equal(ok.code, 0)
  assert.match(ok.out, /owner\s+：carol/)
  assert.match(ok.out, /来源\s+：key/)
  const bad = cli(['whoami', '--token', 'me_bogus_bogus'], { home })
  assert.notEqual(bad.code, 0)
})

test('keys revoke：吊销后同一把密钥立即失效', () => {
  const home = makeHome()
  const issued = cli(['keys', 'issue', '--owner', 'dave'], { home })
  const token = /(me_[A-Za-z0-9_-]{10,})/.exec(issued.out)?.[1] || ''
  const id = JSON.parse(fs.readFileSync(path.join(home, 'cloud-keys.json'), 'utf8')).keys[0].id
  const rev = cli(['keys', 'revoke', '--id', id], { home })
  assert.equal(rev.code, 0)
  assert.match(rev.out, /已吊销/)
  assert.notEqual(cli(['whoami', '--token', token], { home }).code, 0)
  assert.match(cli(['keys', 'ls'], { home }).out, /已吊销/)
})

test('keys revoke --owner 命中多把时要求 --all 或 --id（不默默全删）', () => {
  const home = makeHome()
  cli(['keys', 'issue', '--owner', 'erin'], { home })
  cli(['keys', 'issue', '--owner', 'erin'], { home })
  const r = cli(['keys', 'revoke', '--owner', 'erin'], { home })
  assert.equal(r.code, 2)
  assert.match(r.err, /有 2 把可用密钥/)
  const all = cli(['keys', 'revoke', '--owner', 'erin', '--all'], { home })
  assert.equal(all.code, 0)
  const store = JSON.parse(fs.readFileSync(path.join(home, 'cloud-keys.json'), 'utf8'))
  assert.ok(store.keys.every((k) => k.revoked), '--all 之后两把都应吊销')
})

test('签发即生效：CLI 写台账 → 云端实例下一次请求就能用（不用重启）', async () => {
  const home = makeHome()
  const handler = serverFor(home)              // 先起（读的是同一份台账目录）
  const before = await invoke(handler, { sub: '/overview' })
  assert.equal(before.status, 401, '没有令牌时业务面应 401')

  // 服务"运行中"用 CLI 签发 —— 这是运维最常用的顺序
  const issued = cli(['keys', 'issue', '--owner', 'frank'], { home })
  const token = /(me_[A-Za-z0-9_-]{10,})/.exec(issued.out)?.[1] || ''
  assert.ok(token.startsWith('me_'))

  const okRes = await invoke(handler, { sub: '/overview', headers: { authorization: 'Bearer ' + token } })
  assert.equal(okRes.status, 200, 'CLI 签发的密钥应立刻可用（每请求读台账）：' + JSON.stringify(okRes.body))

  // 吊销同样即时
  const id = JSON.parse(fs.readFileSync(path.join(home, 'cloud-keys.json'), 'utf8')).keys[0].id
  cli(['keys', 'revoke', '--id', id], { home })
  const afterRes = await invoke(handler, { sub: '/overview', headers: { authorization: 'Bearer ' + token } })
  assert.ok([401, 403].includes(afterRes.status), '吊销后应立即失效，实际 ' + afterRes.status)
})

test('cloud token：默认打掩码；--show 才输出全值', () => {
  const home = makeHome()
  fs.writeFileSync(path.join(home, 'cloud-admin-token'), 'A'.repeat(64) + '\n', { mode: 0o600 })
  const masked = cli(['token'], { home })
  assert.equal(masked.code, 0)
  assert.match(masked.out, /^AAAAAA…AAAA$/m)
  assert.ok(!masked.out.includes('A'.repeat(64)))
  const shown = cli(['token', '--show'], { home })
  assert.match(shown.out, /A{64}/)
})

test('cloud --help：列出全部子命令与两种模式', () => {
  const r = cli(['--help'])
  assert.equal(r.code, 0)
  for (const s of ['cloud info', 'cloud token', 'cloud keys ls', 'cloud keys issue', 'cloud keys revoke', 'cloud whoami', '--url', '--home']) {
    assert.ok(r.out.includes(s), 'help 里缺少：' + s)
  }
})

test('开源包里没有 cloud-auth.js 时：本地命令优雅降级到远程模式提示（退出码 3，不抛栈）', async () => {
  // 模拟「npm 包装出来但没有私有组件」：只拷 cloud-cli.js 到临时目录，import 它
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ccli-oss-'))
  homes.push(dir)
  fs.copyFileSync(path.join(ROOT, 'lib', 'cloud-cli.js'), path.join(dir, 'cloud-cli.js'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  const errs = []
  const origErr = console.error
  console.error = (...a) => errs.push(a.join(' '))
  let code = null
  try {
    const mod = await import('file:///' + path.join(dir, 'cloud-cli.js').replace(/\\/g, '/'))
    code = await mod.runCloudCli(['info', '--home', dir])
  } finally { console.error = origErr }
  assert.equal(code, 3, '缺私有组件时应返回 3，而不是崩')
  const text = errs.join('\n')
  assert.match(text, /没有云端私有组件/)
  assert.match(text, /--url/)
  assert.match(text, /--admin-token/)
})

