// 把本机库整份推到云端：一条命令跑通，不依赖 UI。
//
// 用法：node scripts/push-cloud.mjs [--vault <本机库>] [--url <云端>] [--token <key>] [--limit N]
//
// 走的就是 UI 里那个「上传当前库到云端」的同一套接口：
//   GET  /memory-eternal/api/vaults/export?path=<本机库>   读本机卡片
//   POST /memory-eternal/api/import/chunk                  200 张一片推到云端
// 幂等由 contentHash 保证：重复推只 skipped，中断重跑安全。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argOf = (n) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : ''
}

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const vault = argOf('--vault') || path.join(home, 'memory-vault')
const cfgFile = path.join(home, 'memory-eternal-cloud-conn.json')
let cfg = {}
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) } catch { /* 没配过 */ }
const url = (argOf('--url') || cfg.url || 'https://mem.mengbot.com.cn').replace(/\/+$/, '')
const token = argOf('--token') || cfg.token || ''
const limit = Number(argOf('--limit')) || 0
const localApi = argOf('--local') || 'http://127.0.0.1:7999/memory-eternal/api'

if (!token) {
  console.error('缺少云端访问密钥（--token，或先在面板里登录云端）')
  process.exit(2)
}

const say = (s) => process.stdout.write(s + '\n')

// ① 读本机库
say(`[1/3] 读本机库 ${vault}`)
const expRes = await fetch(localApi + '/vaults/export?path=' + encodeURIComponent(vault)).catch((e) => null)
if (!expRes || !expRes.ok) {
  console.error('  读本机库失败：本机服务没起？先跑 dsh-memory web 或打开面板')
  process.exit(3)
}
const exp = await expRes.json()
let cards = Array.isArray(exp.cards) ? exp.cards : []
say(`  本机共 ${cards.length} 张`)
if (limit > 0) { cards = cards.slice(0, limit); say(`  本次只推前 ${cards.length} 张（--limit）`) }
if (!cards.length) { say('  没有卡片可推'); process.exit(0) }

// ② 分片推
const CHUNK = 200
const total = cards.length
let imported = 0, duplicate = 0, failed = 0
const t0 = Date.now()
say(`[2/3] 推送到 ${url}（每片 ${CHUNK} 张）`)
for (let off = 0; off < total; off += CHUNK) {
  const slice = cards.slice(off, off + CHUNK)
  let ok = false
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try {
      const r = await fetch(url + '/memory-eternal/api/import/chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ cards: slice, offset: off, total }),
        signal: AbortSignal.timeout(60000),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status))
      imported += Number(d.imported) || 0
      duplicate += Number(d.duplicate) || 0
      ok = true
    } catch (e) {
      if (attempt === 3) { failed += slice.length; say(`  第 ${off + 1}-${off + slice.length} 张失败：${String(e.message).slice(0, 100)}`) }
      else await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  const done = Math.min(off + slice.length, total)
  const pct = Math.round((done / total) * 100)
  say(`  ${String(done).padStart(6)} / ${total}  (${pct}%)  新增 ${imported} · 重复 ${duplicate}${failed ? ' · 失败 ' + failed : ''}`)
}

// ③ 结果
const secs = ((Date.now() - t0) / 1000).toFixed(1)
say(`[3/3] 完成：新增 ${imported} · 重复 ${duplicate}${failed ? ' · 失败 ' + failed : ''} · 用时 ${secs}s`)

// 读回云端库状态确认
try {
  const v = await fetch(url + '/memory-eternal/api/vaults', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) }).then((r) => r.json())
  const cur = (v.vaults || []).find((x) => x.isCurrent) || (v.vaults || [])[0]
  if (cur) say(`  云端库 ${cur.name}：${cur.cards} 张 · ${cur.sizeMB}MB`)
} catch { /* 忽略 */ }

process.exit(failed ? 1 : 0)
