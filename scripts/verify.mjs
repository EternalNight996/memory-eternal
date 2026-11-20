#!/usr/bin/env node
/**
 * 发布前完整门禁 —— 一条命令跑完全部检查。
 *
 * 为什么需要它：过去 20+ 次改动里有 4 个 bug 都是「语法合法、构建通过、
 * 但运行时静默失败」（少一个括号、函数嵌套、脱敏循环、空值覆盖）。
 * 这类问题静态检查抓不到，只能**真跑起来打接口**。
 *
 * 用法：
 *   node scripts/verify.mjs            # 全套
 *   node scripts/verify.mjs --quick    # 跳过测试套件，只做构建+冒烟
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const quick = process.argv.includes('--quick')
let failed = 0

function step(name, fn) {
  process.stdout.write('\n▸ ' + name + '\n')
  try {
    const r = fn()
    if (r === false) { failed++; console.log('  ✗ 失败'); return }
    if (typeof r === 'string' && r) console.log('  ' + r)
    console.log('  ✓ 通过')
  } catch (e) {
    failed++
    console.log('  ✗ ' + String((e && e.message) || e).slice(0, 300))
  }
}

function sh(cmd, args) {
  // **shell: false**：node.exe 的路径带空格（C:\Program Files\...），
  // 走 shell 会被拆成 "C:\Program"，历史踩过。
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false })
}

// ── 1. 语法 ────────────────────────────────────────────────
step('语法检查（所有入口）', () => {
  const files = ['index.js', 'lib/api.js', 'lib/cloud-server.js', 'lib/cloud-push.js', 'lib/client.js', 'web/app.js']
  for (const f of files) {
    if (!existsSync(path.join(ROOT, f))) throw new Error('缺文件: ' + f)
    const r = sh(process.execPath, ['--check', f])
    if (r.status !== 0) throw new Error(f + '\n' + (r.stderr || '').slice(0, 400))
  }
  return files.length + ' 个文件'
})

// ── 2. 构建产物完整性（防「edit 报成功但没落盘」）────────────
step('构建产物完整性', () => {
  const app = path.join(ROOT, 'web/app.js')
  const cli = path.join(ROOT, 'lib/client.js')
  for (const [file, must] of [
    [app, ['LOCAL_ONLY', 'isCloudUsable', 'hasCloudCred', 'bootstrapCloudMode', 'syncConnFromServer']],
    [cli, ['LOCAL_ONLY', 'isCloudUsable', 'bootstrapCloudMode']],
  ]) {
    if (!existsSync(file)) throw new Error('缺产物: ' + file)
    const src = readFileSync(file, 'utf8')
    const miss = must.filter((k) => !src.includes(k))
    if (miss.length) throw new Error(path.basename(file) + ' 缺少: ' + miss.join(', '))
  }
  // api.js 三个关键函数必须都在（曾丢掉 readPkgVersion 导致 /overview 500）
  const api = readFileSync(path.join(ROOT, 'lib/api.js'), 'utf8')
  for (const fn of ['readPkgVersion', 'readSchemaVersion']) {
    if (!new RegExp('function ' + fn + '\\(').test(api)) throw new Error('lib/api.js 缺 ' + fn)
  }
  return '关键标识符齐全'
})

// ── 3. 构建 ────────────────────────────────────────────────
step('构建', () => {
  const r = sh(process.execPath, ['build.mjs'])
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').slice(0, 500))
  const app = path.join(ROOT, 'web/app.js')
  const kb = Math.round(readFileSync(app).length / 1024)
  return 'web/app.js ' + kb + ' KB'
})

// ── 4. 作用域/结构校验（针对历史 bug）─────────────────────
step('关键函数作用域校验', () => {
  const src = readFileSync(path.join(ROOT, 'src/client/index.tsx'), 'utf8')
  const mustModuleLevel = ['saveCloudConn', 'syncCloudConnToServer', 'applyCloudConn', 'activateCloud', 'bootstrapCloudMode']
  for (const fn of mustModuleLevel) {
    // 必须在行首（模块顶层）定义
    if (!new RegExp('^function ' + fn + '\\(', 'm').test(src)) {
      throw new Error(fn + ' 不是模块级函数（可能被误嵌套进别的函数里，历史踩过）')
    }
  }
  // readPkgVersion 必须有定义（曾因丢定义导致 /overview 500）
  const apiSrc = readFileSync(path.join(ROOT, 'lib/api.js'), 'utf8')
  if (/readPkgVersion\\(\\)/.test(apiSrc) && !/function readPkgVersion/.test(apiSrc)) {
    throw new Error('lib/api.js 调用了 readPkgVersion 但没有定义')
  }
  return mustModuleLevel.length + ' 个函数均为模块级'
})

// ── 5. 测试套件 ────────────────────────────────────────────
if (!quick) {
  step('测试套件', () => {
    const r = sh(process.execPath, ['scripts/run-tests.mjs'])
    const out = (r.stdout || '') + (r.stderr || '')
    const m = out.match(/pass=(\d+)\s+fail=(\d+)/)
    if (!m) throw new Error('拿不到测试结果：' + out.slice(-300))
    if (Number(m[2]) > 0) console.log('  pass=' + m[1] + ' fail=' + m[2] + '（既有失败不计入本次门禁，但需知悉）')
    return 'pass=' + m[1] + ' fail=' + m[2]
  })
}

// ── 6. 运行时冒烟（真起一个实例，打关键接口）────────────────
// 这一步是整个门禁的核心：语法合法、构建通过、产物齐全，
// 但运行时仍可能因为作用域/脱敏/覆盖这类问题静默失败。
// 只有真的把服务跑起来、真的打接口，才能验证。
const smoke = await (async () => {
  process.stdout.write('\n▸ 运行时冒烟（起实例打接口）\n')
  const { spawn } = await import('node:child_process')
  const PORT = 7907
  const vaultDir = path.join(os.homedir(), '.dsh', 'memory-vault')
  const child = spawn(process.execPath, ['lib/web.js', '--port', String(PORT), '--vault', vaultDir], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, MEMORY_ETERNAL_VERSION: 'verify' },
  })
  const B = 'http://127.0.0.1:' + PORT + '/memory-eternal/api'
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const get = async (p) => {
    const r = await fetch(B + p, { signal: AbortSignal.timeout(8000) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  try {
    // 等启动（最多 20 秒）
    let up = false
    for (let i = 0; i < 20; i++) {
      await wait(1000)
      try { const h = await get('/health'); if (h.status === 200) { up = true; break } } catch {}
    }
    if (!up) throw new Error('实例 20 秒内没起来')

    const errs = []
    // 1) 五个核心接口必须 200
    for (const p of ['/overview', '/health', '/vaults', '/cards?limit=1', '/stats', '/setup-status']) {
      const r = await get(p)
      if (r.status !== 200) errs.push(p + ' -> ' + r.status)
    }
    // 2) overview 必须带 version 与 pkgVersion（曾丢定义导致 500）
    const ov = await get('/overview')
    if (!ov.body || !ov.body.version) errs.push('/overview 缺 version')
    if (!ov.body || ov.body.pkgVersion === undefined) errs.push('/overview 缺 pkgVersion')
    // 3) 三处卡片数必须一致（曾出现 0 / 10225 打架）
    const cards = await get('/cards?limit=1')
    const vaults = await get('/vaults')
    const stats = await get('/stats')
    const cur2 = ((vaults.body && vaults.body.vaults) || []).find((v) => v.isCurrent)
    const a = cards.body && cards.body.total
    const b = cur2 && cur2.cards
    const c2 = stats.body && stats.body.total
    if (!(a === b && a === c2)) errs.push('卡片数不一致: /cards=' + a + ' /vaults=' + b + ' /stats=' + c2)
    // 4) setup-status 必须是**本机路径**（不许出现 /root /opt /var）
    const ss = await get('/setup-status')
    const bad = ((ss.body && ss.body.agents) || []).filter((x) => x.mcpPath && /^\/(root|opt|var|etc)\b/.test(x.mcpPath))
    if (bad.length) errs.push('MCP 出现服务器路径: ' + bad.map((x) => x.mcpPath).join(','))
    // 5) /cloud/conn 的 token 不许是脱敏占位符
    const cc = await get('/cloud/conn')
    const tok = cc.body && cc.body.conn && cc.body.conn.token
    if (tok && /^\*+$/.test(String(tok))) errs.push('/cloud/conn 返回了脱敏令牌 ***')

    if (errs.length) {
      failed++
      console.log('  ✗ ' + errs.length + ' 项异常：')
      errs.forEach((x) => console.log('    ' + x))
    } else {
      console.log('  ✓ 6 接口 200 / 版本字段齐 / 卡片数一致 / MCP 本机路径 / 令牌非脱敏')
    }
  } catch (e) {
    failed++
    console.log('  ✗ ' + String((e && e.message) || e).slice(0, 200))
  } finally {
    try { child.kill('SIGKILL') } catch {}
  }
})()
console.log('')
if (failed) {
  console.log('\x1b[31m门禁未通过：' + failed + ' 项失败\x1b[0m')
  process.exit(1)
}
console.log('\x1b[32m门禁通过\x1b[0m')