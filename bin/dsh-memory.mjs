#!/usr/bin/env node
// 记忆核心 · CLI（多宿主统一入口）
//
// 用法：
//   dsh-memory recall <query> [--limit N] [--vault DIR]   检索知识卡
//   dsh-memory capture <text | - > [--source TAG]         手动沉淀（- 读 stdin）
//   dsh-memory serve [--port N] [--host H] [--vault DIR]  启动 Web UI（前台常驻；--host 0.0.0.0 用于容器/内网，需自行加认证）
//   dsh-memory open [--port N]                            确保 Web 存活并用浏览器打开
//   dsh-memory tui [--live] [--write]                     打开完整终端客户端（无需绝对路径）
//   dsh-memory mcp                                        MCP stdio server（各 agent 挂载）
//   dsh-memory setup [--claude-only|--codex-only|--cursor-only] [--dry-run] [--no-hooks]
//                                                         自动挂载 MCP 到已装的 agent
//   dsh-memory sweep <dir>                                挖掘 Claude Code 会话 JSONL
//   dsh-memory align [--json] [--fix]                     版本对齐检查（宿主/常驻/npm 版本差 + MCP/hooks 旧接线），--fix 重写接线
//   dsh-memory doctor [--vault DIR] [--json]              库健康自检（journal 模式 / 写探针 / 备份清单 / 恢复引导）
//   dsh-memory support [--out FILE] [--tail N] [--no-spawn] 生成诊断包 zip（版本矩阵/doctor/align/status/日志尾巴，已脱敏）
//   dsh-memory doctor --restore latest|备份名 [--yes] [--force]   从备份重建（不带 --yes 只演练；当前库可写时需 --force）
//   dsh-memory refine [--vault DIR] [--json]              矛盾扫描候选（不调模型）；--apply --a A --b B --action keepA|keepB|merge|keepBoth 落裁决
//   dsh-memory refine --junk [--purge --path P] [--json]   注入垃圾卡（技能目录等注入文本沉淀成的卡）：列清单 / 送回收站
//   dsh-memory refine --goals [--keep --path A --path B]   同目标不同做法：聚类需模型（面板里跑）；--keep 落"都保留"
//   dsh-memory ledger [--days N] [--json]                 记忆账本：召回注入 / 蒸馏调用 / 召回有用率
//
// 环境变量：
//   MEMORY_VAULT_DIR       vault 目录（默认 ~/.dsh/memory-vault）
//   MEMORY_LLM_BASE_URL / MEMORY_LLM_KEY / MEMORY_LLM_MODEL   蒸馏 LLM（OpenAI 兼容）
//   MEMORY_ETERNAL_SKIP_AUTO=1   setup 时不动外部配置

import path from 'node:path'
import process from 'node:process'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const has = (name) => argv.includes(name)

/** audit 子命令的位置参数（= 卡片的 vault 相对路径），跳过 flag 与它的值 */
const auditPaths = () => {
  const valueFlags = new Set(['--vault', '--kind', '--reason', '--by', '--limit', '--status'])
  const out = []
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (valueFlags.has(a)) { i++; continue }
    if (typeof a === 'string' && a.startsWith('--')) continue
    out.push(a)
  }
  return out
}

/** 取位置参数（跳过子命令、flag 与 flag 的值） */
const positional = () => {
  const isFlag = (s) => typeof s === 'string' && s.startsWith('--')
  const out = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (isFlag(a)) { i++; continue }   // 跳过 flag + 它的值（任意 flag 都吃掉下一项）
    out.push(a)
  }
  return out
}

async function main() {
  switch (cmd) {
    case 'recall': {
      const query = positional().join(' ')
      const { search } = await import('../lib/vault.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const root = path.resolve(argOf('--vault') || defaultVaultDir())
      const limit = Math.min(Math.max(Number(argOf('--limit')) || 5, 1), 20)
      const hits = await search(root, query, { limit, minScore: 2 })
      if (!hits.length) {
        console.log(JSON.stringify({ ok: true, hits: [], note: `记忆库中没有与「${query}」相关的内容` }, null, 2))
        return
      }
      console.log(JSON.stringify({ ok: true, vaultDir: root, hits }, null, 2))
      return
    }
    case 'capture': {
      const raw = positional().join(' ')
      let text = raw
      if (raw === '-' || (!raw && !process.stdin.isTTY)) {
        // 同步读 stdin 在 Windows 重定向下偶尔返回空（Node 22/24 行为差异）。
        // 改用流式读：先确保 readable 事件触发，再收集全部 data/end。
        text = await new Promise((resolve) => {
          let buf = ''
          const done = () => resolve(buf)
          process.stdin.setEncoding('utf8')
          process.stdin.on('data', (c) => { buf += c })
          process.stdin.on('end', done)
          process.stdin.on('error', done)
          // 兜底：若 stdin 已被消费完（同步场景），立即结束
          if (process.stdin.readableEnded) done()
          setTimeout(done, 3000)
        })
      }
      const { runStandaloneCapture, defaultVaultDir } = await import('../lib/capture-run.js')
      const root = path.resolve(defaultVaultDir())
      const out = await runStandaloneCapture(root, text, { source: argOf('--source') || 'cli' })
      console.log(JSON.stringify({ ...out, vaultDir: root }, null, 2))
      process.exitCode = out.ok ? 0 : 1
      return
    }
    case 'serve': {
      const { startWebServer, DEFAULT_WEB_PORT } = await import('../lib/web.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const port = Number(argOf('--port')) || DEFAULT_WEB_PORT
      // 默认只监听本机：私有化/容器部署时显式 --host 0.0.0.0，并在前面加 TLS + 认证的反向代理
      const host = argOf('--host') || process.env.MEMORY_WEB_HOST || '127.0.0.1'
      const vault = path.resolve(argOf('--vault') || defaultVaultDir())
      await startWebServer({ port, vaultRoot: vault, host })
      process.on('SIGINT', () => process.exit(0))
      process.on('SIGTERM', () => process.exit(0))
      return
    }
    case 'tui': {
      const { spawn } = await import('node:child_process')
      const { fileURLToPath } = await import('node:url')
      const demo = fileURLToPath(new URL('../dsh-tui-plugin/demo.mjs', import.meta.url))
      const child = spawn(process.execPath, [demo, ...argv.slice(1)], { stdio: 'inherit', windowsHide: false })
      child.on('exit', (code) => process.exit(code ?? 0))
      return
    }
    case 'open': {
      const { ensureWebServer, DEFAULT_WEB_PORT } = await import('../lib/web.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const port = Number(argOf('--port')) || DEFAULT_WEB_PORT
      const { url } = await ensureWebServer({ port, vaultRoot: path.resolve(defaultVaultDir()) })
      console.log(url)
      const plat = process.platform
      // 用 spawn + 参数数组，而不是把值拼进 shell 命令字符串：
      // 后者正是扫描器（HOL Guard / ai-plugin-scanner）判定 SHELL_INJECTION_PATTERN 的形态，
      // 而且一旦 url 里有空格/引号就会被 shell 重新解析。参数数组不经 shell，天然免疫。
      // （注意：扫描器是**按文本正则**扫的，连注释里的示例写法也会命中，这里就不写示例了。）
      const { spawn } = await import('node:child_process')
      const launch = (cmd, args) => {
        try {
          const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
          child.on('error', () => { /* 打不开浏览器不影响 ensureWeb 的结果 */ })
          child.unref()
        } catch { /* 同上 */ }
      }
      if (plat === 'win32') launch('cmd', ['/c', 'start', '', url])
      else if (plat === 'darwin') launch('open', [url])
      else launch('xdg-open', [url])
      return
    }
    case 'mcp': {
      const { startMcpServer } = await import('../lib/mcp.js')
      startMcpServer()
      return
    }
    case 'ledger': {
      const { ledgerSummary } = await import('../lib/ledger.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const root = path.resolve(argOf('--vault') || defaultVaultDir())
      const days = Math.min(Math.max(Math.floor(Number(argOf('--days')) || 7), 1), 90)
      let s
      try { s = ledgerSummary(root, { days }) } catch (e) {
        console.error('读取记忆账本失败：' + (e?.message || e))
        process.exitCode = 1
        return
      }
      if (has('--json')) { console.log(JSON.stringify(s, null, 2)); return }
      const fmt = (n) => Number(n || 0).toLocaleString('en-US')
      console.log('记忆账本（最近 ' + s.days + ' 天）\n')
      console.log('召回   ' + fmt(s.totals.recalls) + ' 次 · 注入 ' + fmt(s.totals.injectedChars) + ' 字符')
      console.log('沉淀   ' + fmt(s.totals.captures) + ' 次 · LLM ' + fmt(s.totals.llmCalls) + ' 次 · 输入 ' + fmt(s.totals.captureInChars) + ' / 输出 ' + fmt(s.totals.captureOutChars) + ' 字符')
      console.log('估算   ≈ ' + fmt(s.totals.estTokens) + ' tokens（中英混排按 2 字符 ≈ 1 token，仅看量级）')
      console.log('')
      console.log(s.feedback.rate === null
        ? '召回有用率  暂无反馈（Agent 回传 useful 后才有数据）'
        : '召回有用率  ' + Math.round(s.feedback.rate * 100) + '%（有用 ' + fmt(s.feedback.useful) + ' / 无用 ' + fmt(s.feedback.useless) + '）')
      console.log('\n最近 ' + s.days + ' 天：')
      for (const d of s.byDay) console.log('  ' + d.date + '  召回 ' + fmt(d.recalls) + ' · 注入 ' + fmt(d.injectedChars) + ' 字符 · 沉淀 ' + fmt(d.captures))
      console.log('\n提示：--json 输出原始数据；Web 面板「运行状态 → 记忆账本」可看趋势。')
      return
    }
    case 'status': {
      const { watchdogStatus, probeServedVersion, findPortListener, looksLikeOurWeb } = await import('../lib/watchdog.js')
      const port = argOf('--port')
      const st = watchdogStatus({ port: port || undefined })
      // issue #23：锁里的 pkgVersion 是「看门狗自述」，与端口上真正跑着的代码无关 ——
      // 升级后旧 web 仍占端口时它会骗人地报新版本。这里直接问端口上服务的那个进程。
      const probePort = Number(port) || (st.watchdogs[0] && Number(st.watchdogs[0].port)) || 0
      // issue #45 后续（报告者第 3 条）：`超时` 与 `没有服务` 必须分开报。
      // 那台机器上旧进程回一次 /version-check 要 8–15s，而这里默认预算 1200ms ——
      // 旧文案把「超时」写成了「没有服务在响应」，排查时极易误判成服务挂了。
      const detail = probePort ? await (await import('../lib/watchdog.js')).probeServedVersionDetailed(probePort) : { version: '', timedOut: false, lastError: '' }
      const served = detail.version
      const occupant = probePort && !served ? await findPortListener(probePort) : null
      // 旧版（< v0.10.4）的 /overview 里**没有 version 字段**，所以探不到版本不等于「不是我们的服务」。
      // 这正是 v0.10.3 → v0.10.4 升级时的常见现场，必须说清楚，否则用户会以为端口空着。
      const oursNoVersion = Boolean(occupant && occupant.pid && looksLikeOurWeb(occupant.command))
      if (has('--json')) { console.log(JSON.stringify({ ok: true, ...st, servedPort: probePort, servedVersion: served, portOccupant: occupant, portOccupantIsOurs: oursNoVersion }, null, 2)); return }
      console.log(`锁文件：${st.lockPath}`)
      console.log(`本机包版本：${st.pkgVersion || '?'}`)
      // issue #30：报告者指出旧输出把「端口探测」与「锁登记」并列，读起来像「端口上是旧版」。
      // 两者是**两个独立来源**，必须显式分段标注，否则会把人引向错误的排查方向。
      console.log('')
      console.log('— 端口探测（直接问端口上那个进程，最可靠）—')
      if (probePort) {
        if (served) console.log(`端口 ${probePort} 实际服务版本：${served}`)
        else if (oursNoVersion) console.log(`端口 ${probePort} 上跑的是本插件的 web（pid ${occupant.pid}），但它不会自报版本 —— 说明是 v0.10.4 之前的旧版，升级尚未生效 → 执行 dsh-memory restart --port ${probePort}`)
        else if (detail.timedOut) console.log(`端口 ${probePort} 有进程在听，但**响应超时**（>${1200}ms，最后错误 ${detail.lastError || 'TIMEOUT'}）—— 这不等于「没有服务」；可能是实例正忙/被旧版递归拖慢，稍后重试或 dsh-memory restart --port ${probePort}`)
        else if (occupant && occupant.unknown) console.log(`端口 ${probePort} 的占用者**无法判定**（进程枚举超时/不可用）—— 未知，不代表空闲`)
        else console.log(`端口 ${probePort} 上没有本插件的服务在响应${occupant && occupant.pid ? `（被 pid ${occupant.pid} 占用：${occupant.command || '命令行未知'}）` : ''}`)
      }
      console.log('')
      console.log('— 锁登记（看门狗自己写的记录，可能滞后/陈旧）—')
      if (!st.watchdogs.length) { console.log('锁文件里没有登记的看门狗（没有常驻实例）。'); return }
      for (const w of st.watchdogs) {
        console.log(`- pid ${w.pid} · 端口 ${w.port} · ${w.alive ? '运行中' : '已退出（陈旧记录）'}${w.pkgVersion ? ' · v' + w.pkgVersion : ''}${w.startedAt ? ' · 启动于 ' + w.startedAt : ''}${w.vault ? ' · vault ' + w.vault : ''}`)
        if (w.webPid) console.log(`    web 子进程：pid ${w.webPid}（端口 ${w.webPort || w.port}，${w.webAlive ? '运行中' : '已退出'}）`)
        if (w.versionMismatch) console.log(`    ⚠ 常驻实例是旧版本（v${w.pkgVersion} ≠ 本机 v${st.pkgVersion}）→ 执行 dsh-memory restart --port ${w.port} 替换`)
        if (probePort && Number(w.port) === probePort && served && st.pkgVersion && served !== st.pkgVersion) {
          console.log(`    ⚠ 端口 ${probePort} 上真正服务的是 v${served}（本机 v${st.pkgVersion}）—— 升级尚未生效，执行 dsh-memory restart --port ${probePort}`)
        }
      }
      return
    }
    case 'refine': {
      // issue #36：矛盾扫描的 CLI 入口。**列候选不调模型、不写库**；裁决可直接落（只做可恢复动作）。
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const { refineCandidates, refineApply, readDecisions } = await import('../lib/refine.js')
      const root = argOf('--vault') ? path.resolve(argOf('--vault')) : defaultVaultDir()
      if (has('--goals')) {
        // 「同目标、不同做法」聚类：需要模型（CLI 里通常拿不到 llm）→ 提示去面板；--keep 可落"都保留"
        const { goalScan, markClusterKept } = await import('../lib/refine.js')
        const paths = []
        for (let i = 0; i < argv.length; i++) if (argv[i] === '--path' && argv[i + 1]) paths.push(argv[i + 1])
        if (has('--keep')) {
          const out = await markClusterKept(root, { paths })
          if (has('--json')) { console.log(JSON.stringify(out, null, 2)); if (!out.ok) process.exitCode = 1; return }
          if (out.ok) console.log('已记录「都保留」：' + out.recorded + ' 对')
          else { console.error('失败：' + out.error); process.exitCode = 1 }
          return
        }
        const out = await goalScan(root, { llm: null, limit: Number(argOf('--limit')) || 30 })
        if (has('--json')) { console.log(JSON.stringify(out, null, 2)); if (!out.ok) process.exitCode = 1; return }
        console.error('带模型的目标聚类请在 DSH 面板跑：记忆 → 整理 → 🎯 同目标不同做法')
        console.error('（CLI 可用 --goals --keep --path A --path B 把一组标成"都保留"）')
        process.exitCode = 1
        return
      }
      if (has('--junk')) {
        // 存量「注入垃圾卡」：--junk 列清单；--junk --purge --path <p>（可重复）送回收站
        const { findInjectedCards, purgeInjected } = await import('../lib/refine.js')
        if (has('--purge')) {
          const paths = []
          for (let i = 0; i < argv.length; i++) if (argv[i] === '--path' && argv[i + 1]) paths.push(argv[i + 1])
          const out = await purgeInjected(root, { paths })
          if (has('--json')) { console.log(JSON.stringify(out, null, 2)); if (!out.ok) process.exitCode = 1; return }
          console.log('已送回收站 ' + out.removed.length + ' 张（可从回收中心还原）' + (out.failed.length ? '，失败 ' + out.failed.length + ' 张' : ''))
          for (const x of out.failed) console.error('  ✗ ' + x.path + '：' + x.error)
          if (!out.ok) process.exitCode = 1
          return
        }
        const items = await findInjectedCards(root)
        if (has('--json')) { console.log(JSON.stringify({ ok: true, count: items.length, items }, null, 2)); return }
        console.log('注入垃圾卡（提议回收，未动数据）：' + items.length + ' 张')
        for (const it of items) console.log('  ' + it.path + '  —— ' + it.reasons.join('；'))
        console.log('')
        console.log('回收（进回收站，可还原）：dsh-memory refine --junk --purge --path <路径> [--path <路径>…]')
        return
      }
      if (has('--apply')) {
        const out = await refineApply(root, {
          a: argOf('--a'), b: argOf('--b'), action: argOf('--action'),
          note: argOf('--note') || '', relation: argOf('--relation') || '',
        })
        if (has('--json')) { console.log(JSON.stringify(out, null, 2)); if (!out.ok) process.exitCode = 1; return }
        if (out.ok) console.log('已记录裁决：' + out.action + (out.removed ? '（' + out.removed + ' 已进回收站，可从回收中心还原）' : ''))
        else { console.error('失败：' + out.error); process.exitCode = 1 }
        return
      }
      const cands = await refineCandidates(root)
      const decisions = Object.keys(readDecisions(root)).length
      // 只出元信息（path/title/kind）—— 正文是给模型判别用的，CLI 里没必要吐 2KB×N
      const slim = (x) => ({ path: x.path, title: x.title, kind: x.kind })
      if (has('--json')) { console.log(JSON.stringify({ ok: true, candidates: cands.map((c) => ({ a: slim(c.a), b: slim(c.b), sim: c.sim })), decisions }, null, 2)); return }
      console.log(`矛盾扫描 · 候选 ${cands.length} 对（已裁决 ${decisions} 对）`)
      for (const c of cands) console.log(`  sim ${c.sim} · ${c.a.path}  ⇄  ${c.b.path}`)
      console.log('')
      console.log('（这一步不调模型、不写库）模型判别「重复 / 补充 / 矛盾 / 无关」请在 DSH 面板：记忆 → 整理 → 🧭 矛盾扫描')
      console.log('落裁决：dsh-memory refine --apply --a <路径> --b <路径> --action keepA|keepB|merge|keepBoth')
      return
    }
    case 'align': {
      // 版本对齐检查：宿主/常驻/npm 的版本差 + 持久接线（MCP / hooks）里的旧路径与旧事件键
      const { inspectAlignment } = await import('../lib/align.js')
      const port = Number(argOf('--port')) || 7999
      const rep = await inspectAlignment({ hostVersion: process.env.MEMORY_ETERNAL_VERSION || '', residentPort: port })
      if (has('--json')) { console.log(JSON.stringify(rep, null, 2)); if (!rep.ok) process.exitCode = 1; return }
      console.log('记忆核心 · 版本对齐检查')
      console.log('磁盘 v' + (rep.onDisk || '?') + (rep.residentServed ? ' · 常驻实例 v' + rep.residentServed : '') + (rep.latest ? ' · npm 最新 v' + rep.latest : ''))
      console.log('')
      for (const x of rep.findings) {
        console.log((x.level === 'fix' ? '✗ ' : x.level === 'warn' ? '⚠ ' : '✓ ') + x.title)
        if (x.detail) console.log('    ' + x.detail)
        if (x.command) console.log('    → ' + x.command)
      }
      if (has('--fix')) {
        const { runSetup } = await import('../lib/setup.js')
        console.log('')
        console.log('重写接线（只碰自己的键：mcpServers.memory / 带标记的 hooks）：')
        await runSetup({ log: (m) => console.log('  ' + m) })
        console.log('完成。若上面有「宿主进程旧」，仍需**完全退出并重开 DSH**。')
      } else if (!rep.ok) {
        console.log('')
        console.log('执行 dsh-memory align --fix 可重写 MCP / hooks 接线（不动你的数据与配置）')
      }
      if (!rep.ok) process.exitCode = 1
      return
    }
    case 'support': {
      // 一键诊断包：版本矩阵 / doctor / align / status / 锁 / 心跳 / 配置 / 日志尾巴 → 一个 zip（已脱敏）
      const { buildSupportBundle } = await import('../lib/support.js')
      const out = argOf('--out') || ''
      const tailN = Number(argOf('--tail')) || 200
      const portN = Number(argOf('--port')) || 0
      // --no-spawn：跳过 doctor/align/status 子进程（受限环境排障用）
      const r = buildSupportBundle({ out, tail: tailN, port: portN, spawn: !has('--no-spawn') })
      if (!r.ok) { console.error('诊断包生成失败'); process.exitCode = 1; return }
      console.log('诊断包已生成（已脱敏）：' + r.path)
      console.log('大小：' + Math.round(r.bytes / 1024) + ' KB · 条目：' + r.entries.join(', '))
      console.log('提交 issue 时把这个 zip 拖进去即可；内含 README.txt 说明。')
      return
    }
    case 'doctor': {
      // ⑤ 损坏/不可写时的「引导」（issue #33）：只体检、只列备份、只打印下一步 —— 绝不自动替换/删除数据。
      // --restore：把「损坏时从备份重建」从**引导**升级成**可执行**（#31 里 WAL 头损坏的唯一现实出路）。
      // 安全设计：不带 --yes 只做演练（dryRun，一个文件都不动）；带 --yes 才真正执行，
      // 且执行前检查「有没有常驻实例正开着这个库」（有就先停下来，除非 --force）。
      if (argOf('--restore')) {
        const { defaultVaultDir: dvd } = await import('../lib/capture-run.js')
        const { restoreFromBackup } = await import('../lib/db.js')
        const { readWatchdogLock, isPidAlive } = await import('../lib/watchdog.js')
        const root = argOf('--vault') ? path.resolve(argOf('--vault')) : dvd()
        const from = argOf('--restore')
        const live = readWatchdogLock(process.env).watchdogs.filter((w) => isPidAlive(w.pid))
        const plan = await restoreFromBackup(root, { from, dryRun: true, force: has('--force') })
        if (has('--json')) { console.log(JSON.stringify({ planned: plan, liveWatchdogs: live.map((w) => w.pid) }, null, 2)); if (!plan.ok) process.exitCode = 1; return }
        if (!plan.ok) { console.error('不能恢复：' + plan.error); if (plan.code === 'DB_HEALTHY') console.error('  （确认要覆盖可写库：加 --force）'); process.exitCode = 1; return }
        console.log('备份：' + plan.from)
        console.log('备份里的卡片数：' + (plan.cards >= 0 ? plan.cards : '（读不出，可能不是本插件的库）'))
        console.log('当前库：' + root + '\\memory-eternal.db')
        if (live.length) {
          console.log('⚠ 检测到常驻看门狗还活着（pid ' + live.map((w) => w.pid).join(', ') + '）—— 恢复前应先：dsh-memory stop --port 7999（或完全退出 DSH）')
          if (!has('--force')) { console.error('为避免边写边换，已中止。确认可强做：加 --force'); process.exitCode = 1; return }
        }
        if (!has('--yes')) {
          console.log('')
          console.log('这是**演练**（没有改动任何文件）。确认执行请加 --yes：')
          console.log('  dsh-memory doctor --restore ' + from + ' --yes' + (argOf('--vault') ? ' --vault "' + root + '"' : ''))
          process.exitCode = 1
          return
        }
        const out = await restoreFromBackup(root, { from, force: has('--force') })
        if (!out.ok) { console.error('恢复失败：' + out.error); process.exitCode = 1; return }
        console.log('✓ 已用备份重建：卡片 ' + out.cards + ' 张，写探针 ' + (out.health.writable ? 'OK' : '仍失败'))
        for (const m of out.movedAside || []) console.log('  原现场留证：' + m)
        console.log('  ' + out.note)
        return
      }
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const { getDb, dbStatus, checkDbHealth, rebuildGuidance } = await import('../lib/db.js')
      const fsPromises = await import('node:fs/promises')
      const root = argOf('--vault') ? path.resolve(argOf('--vault')) : defaultVaultDir()
      let health = null
      try {
        const db = getDb(root)                       // 打开即体检（写探针在建表之后跑一次）
        health = dbStatus(root) || checkDbHealth(db)
      } catch (e) {
        health = { journalMode: '', writable: false, error: String((e && e.message) || e), corrupt: /malformed|not a database|corrupt/i.test(String((e && e.message) || e)), checkedAt: Date.now() }
      }
      // 看门狗锁文件可写性（#33 第③层）：受限环境写不进去时，「是否被托管」将无法判断 —— 说清楚，
      // 免得用户把「判不出来」读成「未托管 / 实例坏了」。
      const { probeLockWritable } = await import('../lib/watchdog.js')
      const lockInfo = probeLockWritable()
      const backupDir = path.join(root, 'backups')
      const backups = (await fsPromises.readdir(backupDir).catch(() => []))
        .filter((x) => x.startsWith('memory-eternal-') && x.endsWith('.db')).sort().reverse()
      const guidance = rebuildGuidance(root, health)
      if (has('--json')) {
        console.log(JSON.stringify({ ok: Boolean(health.writable), vault: root, health, lock: lockInfo, backups, guidance }, null, 2))
        if (!health.writable) process.exitCode = 1
        return
      }
      console.log('记忆核心 · 自检（doctor）')
      console.log('vault：' + root)
      console.log('journal_mode：' + (health.journalMode || '（未知）'))
      console.log('写探针：' + (health.writable ? 'OK（这个库现在可写）' : '失败 → ' + health.error))
      if (health.corrupt) console.log('损坏判定：疑似文件损坏（见下方引导）')
      // issue #44：长命 watchdog 若用一份**已被删除的** node 绝对路径（brew 升级后很常见），
      // spawn web 每次都 ENOENT 且被静默吞掉 —— 这里把实际用的 node 与存在性直接打出来。
      try {
        const { nodeBinary, binaryUsable } = await import('../lib/node-bin.js')
        const nb = nodeBinary()
        console.log('子进程 node：' + nb + (binaryUsable(nb) ? '' : '（**不存在** → spawn web 会静默失败；请用当前 node 执行 dsh-memory restart）'))
      } catch { /* 取不到就不打印 */ }
      console.log('看门狗锁：' + (lockInfo.writable ? '可写（' + lockInfo.path + '）' : '**写不进去** → ' + lockInfo.error + '（' + lockInfo.path + '）—— 保活一般仍有效，但「是否被托管」将无法判断'))
      // 托管方式一眼可见（#30 ⑤/⑥）：看门狗登记 / 宿主托管 / 因环境限制不可替换
      try {
        const st = await import('../lib/resident-state.js')
        const hm = st.hostManagedInfo()
        const rb = st.replaceBlockedInfo()
        const how = hm && hm.fresh ? '宿主托管（锁不可写 → 由宿主进程停旧起新并保活；原因 ' + (hm.reason || '未记录') + '）' : (rb && rb.fresh ? '不可替换（环境限制：锁目录不可写）' : '看门狗（无异常记录）')
        console.log('常驻实例托管：' + how)
      } catch { /* 状态读不到就不打印 */ }
      console.log('备份：' + (backups.length ? backups.length + ' 个（最近：' + backups[0] + '）' : '（还没有备份 —— 可在面板或 backupDb 生成）'))
      if (guidance.length) { console.log(''); for (const line of guidance) console.log('· ' + line) }
      if (!health.writable) process.exitCode = 1
      return
    }
    case 'stop': {
      const { stopWatchdogs } = await import('../lib/watchdog.js')
      const port = argOf('--port')
      // checkPort：停完再问一次「端口上还有谁在服务」，把「停了却还占着端口」显式说出来（#23）
      // forcePortOccupant：**显式 stop 就该把端口腾出来** —— 端口上那个自家 web 很可能不是看门狗拉起的
      // （宿主 ensureWeb 直接起、或看门狗被 kill -9 后残留的孤儿），锁里没有 webPid 就谁也收不到它。
      // 闸门没松：只有 looksLikeOurWeb(命令行) 为真才会终止，认不出的照旧只告警。
      const out = await stopWatchdogs({ port: port || undefined, checkPort: true, forcePortOccupant: true })
      if (has('--json')) { console.log(JSON.stringify({ ok: out.failed.length === 0, ...out }, null, 2)); return }
      if (!out.stopped.length && !out.failed.length && !out.webStopped.length) console.log('没有需要停止的常驻看门狗（锁里没有活着的实例）。')
      if (out.stopped.length) console.log(`已停止看门狗：pid ${out.stopped.join(', ')}`)
      if (out.webStopped.length) console.log(`已停止它拉起的 web：pid ${out.webStopped.join(', ')}`)
      for (const w of out.warnings || []) console.error('⚠ ' + w)
      if (out.failed.length) { console.error(`未能停止：pid ${out.failed.join(', ')}（可能无权限，请手动任务管理器 / kill 处理）`); process.exitCode = 1 }
      return
    }
    case 'restart': {
      // 显式替换常驻实例（#19）：同端口已有实例时新进程只会让位，所以必须先停再起。
      // 统一走 lib/watchdog.js 的 restartResident —— 宿主启动自愈与面板「重启常驻实例」按钮
      // 用的是同一个实现：spawn 一个 detached 的 `watchdog.js --replace` 助手收旧实例并接管，
      // 再自检「端口上真正服务的版本 == 本机版本」（issue #23 建议 2）。
      const { restartResident, watchdogStatus } = await import('../lib/watchdog.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const port = Number(argOf('--port')) || 7999
      const interval = Number(argOf('--interval')) || 5000
      const maxRestart = Number(argOf('--max-restart')) || 10
      const vaultRoot = argOf('--vault') ? path.resolve(argOf('--vault')) : defaultVaultDir()
      const before = watchdogStatus({ port }).watchdogs.filter((w) => w.alive)
      if (before.length) {
        const webs = before.filter((w) => w.webPid).map((w) => w.webPid)
        console.log(`将替换常驻实例：pid ${before.map((w) => w.pid).join(', ')}${webs.length ? `（它拉起的 web：pid ${webs.join(', ')}）` : ''}`)
      }
      // 助手拿到的是「旧实例留下的孤儿也不放过」的口径（按端口占用者兜底收掉，见 #23）
      const out = await restartResident({ port, vaultRoot, interval, maxRestart })
      if (!out.ok) {
        console.error(`替换失败（${out.stage}）：${out.error || '未知原因'}`)
        // issue #30：提示里写着「接管结论也会写进自动沉淀日志」，但 CLI 这条路径过去**不写** ——
        // 用户按提示去「设置 → 记忆 → 用量/今日」里什么也找不到。这里补齐（与宿主侧同一份日志）。
        try {
          const { appendCaptureLog } = await import('../lib/capture-log.js')
          await appendCaptureLog({ time: Date.now(), sessionId: 'system', action: 'warn', reason: `CLI 替换常驻实例失败（${out.stage}）：${out.error || '未知原因'}` })
        } catch { /* 日志写不了不影响主流程 */ }
        console.error(`排查：dsh-memory status --port ${port}；若端口被别的进程占着，先结束它再 restart；`)
        console.error('     接管结论也会写进「自动沉淀日志」（设置 → 记忆 → 用量/今日）里。')
        process.exitCode = 1
        return
      }
      try {
        const { appendCaptureLog } = await import('../lib/capture-log.js')
        await appendCaptureLog({ time: Date.now(), sessionId: 'system', action: 'boot', reason: `CLI 替换常驻实例成功：端口 ${port} 现在服务 v${out.served}（等待 ${Math.round(out.waitedMs / 1000)}s）` })
      } catch { /* 日志写不了不影响主流程 */ }
      console.log(`已在后台启动新看门狗 pid=${out.helperPid} port=${port} vault=${vaultRoot}`)
      console.log(`自检通过：端口 ${port} 正在服务 v${out.served}（等待 ${Math.round(out.waitedMs / 1000)}s）`)
      return
    }
    case 'audit': {
      const sub = argv[1] || ''
      const { listCards, setCardStatus, countCards } = await import('../lib/vault.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const root = path.resolve(argOf('--vault') || defaultVaultDir())
      const asJson = has('--json')
      if (sub === 'list') {
        // 状态别名：all = 「审核队列」的全部（pending + rejected）。
        // approved 是已出队状态、deleted 归回收中心，都要显式指定（issue #20 的问号）。
        const STATUS = { pending: ['pending'], rejected: ['rejected'], deleted: ['deleted'], approved: ['approved'], all: ['pending', 'rejected'], queue: ['pending', 'rejected'] }
        const wanted = String(argOf('--status') || 'pending').toLowerCase()
        const status = STATUS[wanted] || [wanted]
        const kind = argOf('--kind') || undefined
        // issue #20：总数必须与 --limit 解耦。
        //   旧实现把 listCards(limit) 的**截断后条数**当成「共 N 张」，且默认 limit=50 静默截断 ——
        //   队列规模被系统性低估（报告者因此把 32 张待审看成 5 张）。
        //   现在：不给 --limit（或 --limit 0）= 全部；给了只限制**显示条数**，总数永远是匹配总数。
        const rawLimit = argOf('--limit')
        const wantedLimit = Number(rawLimit)
        const limit = rawLimit === null || !Number.isFinite(wantedLimit) || wantedLimit <= 0
          ? null
          : Math.min(Math.floor(wantedLimit), 5000)
        const total = await countCards(root, { status, kind })
        const cards = await listCards(root, { status, kind, limit: limit ?? undefined, sort: 'recent' })
        const returned = cards.length
        const hidden = Math.max(0, total - returned)
        if (asJson) {
          console.log(JSON.stringify({
            ok: true, vaultDir: root, status: wanted,
            total,                // 匹配总数（与 --limit 无关）
            returned,             // 本次实际返回条数
            count: total,         // 兼容别名：0.10.2 起曾误等于 returned，属 bug（issue #20），现与 total 一致
            limit: limit ?? null, // 生效的显示上限；null = 全部
            hasMore: hidden > 0,
            cards: cards.map((c) => ({ path: c.path, title: c.title, kind: c.kind, status: c.status, tags: c.tags, reason: c.reason, createdAt: c.createdAt, submittedBy: c.submittedBy })),
          }, null, 2))
          return
        }
        if (!total) { console.log(`没有 ${wanted} 状态的卡片（库：${root}）`); return }
        console.log(hidden > 0
          ? `${wanted} 共 ${total} 张，显示前 ${returned} 张（库：${root}）：`
          : `${wanted} 共 ${total} 张（库：${root}）：`)
        for (const c of cards) console.log(`- [${c.status}] ${c.kind} | ${c.title}\n    ${c.path}`)
        if (hidden > 0) console.log(`… 还有 ${hidden} 张未显示（用 --limit N 调整，--limit 0 = 全部）`)
        return
      }
      if (sub === 'approve' || sub === 'reject') {
        const paths = auditPaths()
        if (!paths.length) {
          console.error(`用法：dsh-memory audit ${sub} <卡片路径...> [--reason "原因"] [--vault DIR]`)
          process.exitCode = 1
          return
        }
        const status = sub === 'approve' ? 'approved' : 'rejected'
        const reason = argOf('--reason') || (sub === 'approve' ? 'CLI 人工批准' : 'CLI 人工驳回')
        const changedBy = argOf('--by') || 'cli'
        const results = []
        for (const p of paths) {
          try {
            await setCardStatus(root, p, status, { changedBy, reason })
            results.push({ path: p, ok: true, status })
            if (!asJson) console.log(`✓ ${status} ${p}`)
          } catch (error) {
            results.push({ path: p, ok: false, error: String(error?.message || error) })
            if (!asJson) console.error(`✗ ${p}：${String(error?.message || error)}`)
          }
        }
        if (asJson) console.log(JSON.stringify({ ok: results.every((r) => r.ok), vaultDir: root, results }, null, 2))
        else console.log(`完成：${results.filter((r) => r.ok).length}/${results.length}（库：${root}）`)
        process.exitCode = results.some((r) => !r.ok) ? 1 : 0
        return
      }
      console.error(`用法：
  dsh-memory audit list [--status pending|rejected|approved|deleted|all] [--kind KIND] [--limit N] [--json] [--vault DIR]
  dsh-memory audit approve <卡片路径...> [--reason "原因"] [--vault DIR]
  dsh-memory audit reject  <卡片路径...> [--reason "原因"] [--vault DIR]

说明：审核写入仍走 setCardStatus（DB 层守卫 + 不可变 audit_log 都不绕过）。
      --status all = 审核队列（pending + rejected），不含已出队的 approved / 回收中心的 deleted。
      --limit 只限制「显示条数」（默认全部显示，--limit 0 同义）；总数始终是匹配总数，不会被 --limit 改写。
      --json 字段：total（匹配总数）/ returned（本次返回条数）/ count（= total 的兼容别名）
                    / limit（生效上限，null = 全部）/ hasMore / cards
MCP 侧只提供只读的 memory_audit_list —— 批准/驳回必须由人显式发起。`)
      process.exitCode = 1
      return
    }
    case 'watchdog': {
      const { startWatchdog, reapStaleWatchdogs, formatReapSummary } = await import('../lib/watchdog.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const port = Number(argOf('--port')) || 7999
      if (has('--reap')) {
        const out = await reapStaleWatchdogs({ port, keepPid: 0 })
        // 计数口径与文案必须一起看齐：scanned 含 web、清理要分开报 watchdog / web（0.10.13 的文案漏报
        // webKilled，读者会把「真收了一个 web」读成「什么都没收」）
        console.log(formatReapSummary(out))
        return
      }
      const interval = Number(argOf('--interval')) || 5000
      const maxRestart = Number(argOf('--max-restart')) || 10
      const vaultRoot = argOf('--vault') ? path.resolve(argOf('--vault')) : defaultVaultDir()
      const autoStart = !has('--no-restart')
      console.log(`dsh-memory watchdog 启动 → 目标端口 ${port}，间隔 ${interval}ms，最大重拉 ${maxRestart} 次${autoStart ? '' : '（--no-restart）'}`)
      console.log(`vault: ${vaultRoot}\n按 Ctrl+C 退出`)
      startWatchdog({ port, interval, maxRestart, vaultRoot, autoStart })
      return
    }
    case 'setup': {
      const { runSetup } = await import('../lib/setup.js')
      const only = []
      if (has('--claude-only')) only.push('claude')
      if (has('--codex-only')) only.push('codex')
      if (has('--cursor-only')) only.push('cursor')
      const out = await runSetup({ only, withHooks: !has('--no-hooks'), dryRun: has('--dry-run') })
      const done = out.results.filter((r) => r.ok).length
      console.log(`\n记忆库目录：默认 ~/.dsh/memory-vault（MEMORY_VAULT_DIR 可改）`)
      console.log(`完成：${done}/${out.results.length} 项。Web UI: dsh-memory open`)
      return
    }
    case 'connect': {
      // 会话结束自动沉淀 hook：不依赖 plugin（Codex Desktop 也适用），写用户级 hooks.json
      const agent = positional()[0] || ''
      if (!agent) {
        console.error('用法：dsh-memory connect <claude|codex|cursor> [--dry-run]')
        process.exitCode = 1
        return
      }
      const { connectAgentHooks } = await import('../lib/setup.js')
      const out = await connectAgentHooks(agent, { dryRun: has('--dry-run'), log: (m) => console.log(m) })
      if (out && out.ok) console.log(`\n✓ ${agent} 会话结束自动沉淀 hook 已就绪（写入统一 ~/.dsh/memory-vault，新卡进待审核）`)
      else { console.error(`✗ ${agent} 连接失败：` + JSON.stringify(out)); process.exitCode = 1 }
      return
    }
    case 'sweep': {
      const dir = argv[1]
      if (!dir || dir.startsWith('--')) {
        console.error('用法：dsh-memory sweep <dir>（如 ~/.claude/projects）')
        process.exitCode = 1
        return
      }
      const { sweepSessions } = await import('../lib/sweep.js')
      const out = await sweepSessions(dir)
      console.log(JSON.stringify(out, null, 2))
      return
    }
    default:
      console.log(`dsh-memory — 记忆核心 CLI

用法：
  dsh-memory recall <query> [--limit N]       检索知识卡
  dsh-memory capture <text | -> [--source T]  手动沉淀（- 读 stdin）
  dsh-memory serve [--port N] [--host H]      Web UI（前台；私有化部署见 docs/DEPLOY.md）
  dsh-memory open                             确保 Web 存活并打开浏览器
  dsh-memory mcp                              MCP stdio server
  dsh-memory setup [--dry-run] ...            自动挂载 MCP 到已装 agent
  dsh-memory connect <claude|codex|cursor>   写会话结束自动沉淀 hook（不依赖 plugin，含 Codex Desktop）
  dsh-memory sweep <dir>                      挖掘会话 JSONL
  dsh-memory watchdog [--port N] [--interval MS] [--max-restart N]  看门狗保活 web server
  dsh-memory watchdog --reap [--port N]      清理不在锁里的孤儿看门狗
  dsh-memory status [--port N] [--json]      查看常驻看门狗（pid/端口/版本/存活）
  dsh-memory stop [--port N] [--json]        停止常驻看门狗（显式命令，配置变更不会自动停）
  dsh-memory restart [--port N] [--vault DIR] 停止并重新拉起看门狗（应用新版本）
  dsh-memory ledger [--days N] [--json]      记忆账本：召回注入 / 蒸馏调用 / 有用率
  dsh-memory audit list [--status pending] [--kind K] [--json]  列出待审/驳回卡片
  dsh-memory audit approve <path...> | reject <path...> [--reason "原因"]  人工批量审批

环境变量：MEMORY_VAULT_DIR / MEMORY_LLM_BASE_URL / MEMORY_LLM_KEY / MEMORY_LLM_MODEL`)
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error))
  process.exit(1)
})
