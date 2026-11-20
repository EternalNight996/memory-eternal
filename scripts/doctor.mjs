#!/usr/bin/env node
// 一键自检：插件版本 / 实例 / 数据一致性 / 云端授权 / MCP 路径
// 用法：node scripts/doctor.mjs   （在有插件的机器上直接跑）
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PLUGIN = path.join(DSH, 'profiles', 'desktop', 'node_modules', 'memory-eternal')
const pass = (s) => console.log('  \x1b[32m✓\x1b[0m ' + s)
const fail = (s) => console.log('  \x1b[31m✗\x1b[0m ' + s)
const info = (s) => console.log('    ' + s)

console.log('════ 1. 安装版本 ════')
let diskVer = ''
try { diskVer = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).version } catch {}
diskVer ? pass('磁盘版本 ' + diskVer) : fail('插件目录不存在: ' + PLUGIN)

console.log('════ 2. 运行实例 ════')
const ports = [7999, 7990, 7901]
let live = null
for (const p of ports) {
  try {
    const r = await fetch('http://127.0.0.1:' + p + '/memory-eternal/api/health', { signal: AbortSignal.timeout(3000) })
    if (!r.ok) continue
    const d = await r.json()
    live = { port: p, ...d }
    pass('端口 ' + p + '  运行版本 ' + d.version + '  卡片 ' + d.cards)
    if (diskVer && d.version !== diskVer) fail('  运行版本(' + d.version + ') ≠ 磁盘版本(' + diskVer + ') → 需要重启 DSH')
  } catch { /* 端口没开 */ }
}
if (!live) fail('没有任何实例在跑')

console.log('════ 3. 数据一致性 ════')
if (live) {
  const B = 'http://127.0.0.1:' + live.port + '/memory-eternal/api'
  try {
    const [c, v, s] = await Promise.all([
      fetch(B + '/cards?limit=1').then((r) => r.json()),
      fetch(B + '/vaults').then((r) => r.json()),
      fetch(B + '/stats').then((r) => r.json()),
    ])
    const cur = (v.vaults || []).find((x) => x.isCurrent)
    info('/cards.total=' + c.total + '  /vaults.current=' + (cur && cur.cards) + '  /stats.total=' + s.total)
    if (c.total === (cur && cur.cards) && c.total === s.total) pass('三处一致')
    else fail('三处不一致 —— 数据口径有问题')
  } catch (e) { fail('查询失败: ' + e.message) }
}

console.log('════ 4. 云端授权 ════')
try {
  // 兼容 BOM：PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
  // 直接 JSON.parse 会报 Unexpected token —— 实测踩到过一次。
  const cfg = JSON.parse(readFileSync(path.join(DSH, 'memory-eternal-cloud-conn.json'), 'utf8').replace(/^\uFEFF/, ''))
  info('mode=' + cfg.mode + ' active=' + cfg.active + ' owner=' + (cfg.owner || '-'))
  if (!cfg.token) fail('没有访问密钥')
  else if (!cfg.url) fail('没有实例地址')
  else {
    const r = await fetch(String(cfg.url).replace(/\/+$/, '') + '/api/cloud/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    const d = await r.json().catch(() => ({}))
    if (r.ok && d.granted) {
      pass('授权有效  plan=' + d.connect.plan + '  到期=' + String(d.connect.expiresAt || '').slice(0, 10))
      info('云端库: ' + (d.connect.vaults || []).map((x) => x.name + '(' + x.cards + ')').join(', '))
    } else fail('授权失败 ' + r.status + ' ' + (d.code || '') + ' ' + (d.error || ''))
  }
} catch (e) { fail('读配置失败: ' + e.message) }

console.log('════ 5. MCP 挂载路径 ════')
if (live) {
  try {
    const d = await fetch('http://127.0.0.1:' + live.port + '/memory-eternal/api/setup-status', { signal: AbortSignal.timeout(6000) }).then((r) => r.json())
    for (const a of (d.agents || []).slice(0, 5)) {
      info(String(a.label || a.name).padEnd(28) + (a.installed ? '[已装]' : '[未装]') + '  ' + (a.mcpPath || '-'))
    }
    const bad = (d.agents || []).filter((a) => a.mcpPath && /^\/(root|opt|var|etc)\b/.test(a.mcpPath))
    bad.length ? fail('出现服务器路径（说明被代理到云端了）: ' + bad.map((a) => a.mcpPath).join(',')) : pass('全是本机路径')
  } catch (e) { fail('查询失败: ' + e.message) }
}
console.log('')
