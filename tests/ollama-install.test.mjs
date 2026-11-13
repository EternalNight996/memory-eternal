// Ollama 安装闭环：守「下载校验」与「状态机」，不真装（dry-run 只下载不执行）
//   ① 小文件/错误页必须被拒（否则会拿着 4KB 的 HTML 去"安装"）；
//   ② 正常大小文件要落盘、要算 sha256、阶段推进到 verifying；
//   ③ 状态机只允许合法迁移，失败要留 error 给前端说人话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadInstaller, runSilentInstall, installState } from '../lib/ollama-install.js'

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }))
  })
}

test('小文件（错误页/重定向残片）必须被拒绝，并清理 .part', async () => {
  const { srv, base } = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not found</html>') })
  const dest = path.join(os.tmpdir(), 'me-ollama-small-' + Date.now() + '.exe')
  try {
    await assert.rejects(() => downloadInstaller({ url: base + '/OllamaSetup.exe', dest }), /明显不是安装包/)
    assert.equal(fs.existsSync(dest), false, '失败后不应留下成品文件')
    assert.equal(fs.existsSync(dest + '.part'), false, '失败后要清掉 .part')
  } finally { srv.close() }
})

test('正常大小安装器：落盘 + sha256 + 阶段推进到 verifying（dry-run 不执行）', async () => {
  const SIZE = 11 * 1024 * 1024
  const { srv, base } = await serve((req, res) => {
    res.writeHead(200, { 'content-length': String(SIZE), 'content-type': 'application/octet-stream' })
    const chunk = Buffer.alloc(1024 * 256, 0x4d)
    let sent = 0
    const pump = () => {
      while (sent < SIZE) {
        sent += chunk.length
        if (!res.write(chunk)) { res.once('drain', pump); return }
      }
      res.end()
    }
    pump()
  })
  const dest = path.join(os.tmpdir(), 'me-ollama-ok-' + Date.now() + '.exe')
  try {
    const r = await downloadInstaller({ url: base + '/OllamaSetup.exe', dest })
    assert.equal(r.size, SIZE)
    assert.match(r.sha256, /^[0-9a-f]{64}$/)
    assert.ok(fs.existsSync(dest) && fs.statSync(dest).size === SIZE)
    const dry = await runSilentInstall(dest, { env: { ...process.env, MEMORY_OLLAMA_INSTALL_DRY: '1' } })
    assert.equal(dry.ok, true)
    assert.equal(dry.dry, true)
    assert.equal(installState().phase, 'verifying')
  } finally {
    srv.close()
    try { fs.rmSync(dest, { force: true }) } catch { /* 忽略 */ }
  }
})

test('HTTP 非 2xx 直接报错，不产生文件', async () => {
  const { srv, base } = await serve((req, res) => { res.writeHead(502); res.end('bad gateway') })
  const dest = path.join(os.tmpdir(), 'me-ollama-502-' + Date.now() + '.exe')
  try {
    await assert.rejects(() => downloadInstaller({ url: base + '/x.exe', dest }), /下载失败 HTTP 502/)
    assert.equal(fs.existsSync(dest), false)
  } finally { srv.close() }
})
