#!/usr/bin/env node
// 记忆核心 · CLI（多宿主统一入口）
//
// 用法：
//   dsh-memory recall <query> [--limit N] [--vault DIR]   检索知识卡
//   dsh-memory capture <text | - > [--source TAG]         手动沉淀（- 读 stdin）
//   dsh-memory serve [--port N] [--vault DIR]             启动 Web UI（前台常驻）
//   dsh-memory open [--port N]                            确保 Web 存活并用浏览器打开
//   dsh-memory mcp                                        MCP stdio server（各 agent 挂载）
//   dsh-memory setup [--claude-only|--codex-only|--cursor-only] [--dry-run] [--no-hooks]
//                                                         自动挂载 MCP 到已装的 agent
//   dsh-memory sweep <dir>                                挖掘 Claude Code 会话 JSONL
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
      const vault = path.resolve(argOf('--vault') || defaultVaultDir())
      await startWebServer({ port, vaultRoot: vault })
      process.on('SIGINT', () => process.exit(0))
      process.on('SIGTERM', () => process.exit(0))
      return
    }
    case 'open': {
      const { ensureWebServer, DEFAULT_WEB_PORT } = await import('../lib/web.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const port = Number(argOf('--port')) || DEFAULT_WEB_PORT
      const { url } = await ensureWebServer({ port, vaultRoot: path.resolve(defaultVaultDir()) })
      console.log(url)
      const plat = process.platform
      const { exec } = await import('node:child_process')
      if (plat === 'win32') exec(`start "" "${url}"`)
      else if (plat === 'darwin') exec(`open "${url}"`)
      else exec(`xdg-open "${url}"`)
      return
    }
    case 'mcp': {
      const { startMcpServer } = await import('../lib/mcp.js')
      startMcpServer()
      return
    }
    case 'status': {
      const { watchdogStatus } = await import('../lib/watchdog.js')
      const port = argOf('--port')
      const st = watchdogStatus({ port: port || undefined })
      if (has('--json')) { console.log(JSON.stringify({ ok: true, ...st }, null, 2)); return }
      console.log(`锁文件：${st.lockPath}`)
      console.log(`本机包版本：${st.pkgVersion || '?'}`)
      if (!st.watchdogs.length) { console.log('锁文件里没有登记的看门狗（没有常驻实例）。'); return }
      for (const w of st.watchdogs) {
        console.log(`- pid ${w.pid} · 端口 ${w.port} · ${w.alive ? '运行中' : '已退出（陈旧记录）'}${w.pkgVersion ? ' · v' + w.pkgVersion : ''}${w.startedAt ? ' · 启动于 ' + w.startedAt : ''}${w.vault ? ' · vault ' + w.vault : ''}`)
        if (w.webPid) console.log(`    web 子进程：pid ${w.webPid}（端口 ${w.webPort || w.port}，${w.webAlive ? '运行中' : '已退出'}）`)
        if (w.versionMismatch) console.log(`    ⚠ 常驻实例是旧版本（v${w.pkgVersion} ≠ 本机 v${st.pkgVersion}）→ 执行 dsh-memory restart --port ${w.port} 替换`)
      }
      return
    }
    case 'stop': {
      const { stopWatchdogs } = await import('../lib/watchdog.js')
      const port = argOf('--port')
      const out = await stopWatchdogs({ port: port || undefined })
      if (has('--json')) { console.log(JSON.stringify({ ok: out.failed.length === 0, ...out }, null, 2)); return }
      if (!out.stopped.length && !out.failed.length && !out.webStopped.length) console.log('没有需要停止的常驻看门狗（锁里没有活着的实例）。')
      if (out.stopped.length) console.log(`已停止看门狗：pid ${out.stopped.join(', ')}`)
      if (out.webStopped.length) console.log(`已停止它拉起的 web：pid ${out.webStopped.join(', ')}`)
      if (out.failed.length) { console.error(`未能停止：pid ${out.failed.join(', ')}（可能无权限，请手动任务管理器 / kill 处理）`); process.exitCode = 1 }
      return
    }
    case 'restart': {
      // 显式替换常驻实例（#19）：同端口已有实例时新进程只会让位，所以必须先停再起。
      const { stopWatchdogs } = await import('../lib/watchdog.js')
      const { nodeBinary, childEnv } = await import('../lib/node-bin.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const { spawn } = await import('node:child_process')
      const { fileURLToPath } = await import('node:url')
      const port = Number(argOf('--port')) || 7999
      const interval = Number(argOf('--interval')) || 5000
      const maxRestart = Number(argOf('--max-restart')) || 10
      const vaultRoot = argOf('--vault') ? path.resolve(argOf('--vault')) : defaultVaultDir()
      const stopped = await stopWatchdogs({ port })
      if (stopped.failed.length) { console.error(`旧实例未能停止：pid ${stopped.failed.join(', ')}，放弃重启`); process.exitCode = 1; return }
      if (stopped.stopped.length) console.log(`已停止旧实例：pid ${stopped.stopped.join(', ')}`)
      if (stopped.webStopped && stopped.webStopped.length) console.log(`已停止旧实例拉起的 web：pid ${stopped.webStopped.join(', ')}`)
      const bin = nodeBinary()
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'watchdog.js')
      const wd = spawn(bin, [script, '--port', String(port), '--interval', String(interval), '--max-restart', String(maxRestart), '--vault', vaultRoot], {
        detached: true, stdio: 'ignore', env: childEnv({ MEMORY_VAULT_DIR: vaultRoot }), windowsHide: true,
      })
      wd.unref()
      console.log(`已在后台启动新看门狗 pid=${wd.pid} port=${port} vault=${vaultRoot}`)
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
      const { startWatchdog, reapStaleWatchdogs } = await import('../lib/watchdog.js')
      const { defaultVaultDir } = await import('../lib/capture-run.js')
      const port = Number(argOf('--port')) || 7999
      if (has('--reap')) {
        const out = await reapStaleWatchdogs({ port, keepPid: 0 })
        console.log(`扫描到 ${out.scanned} 个 watchdog 进程，清理孤儿 ${out.killed.length} 个${out.killed.length ? '（pid ' + out.killed.join(', ') + '）' : ''}，保留 ${out.skipped.length} 个（锁中登记的活跃实例 / 其它端口不会被动）`)
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
  dsh-memory serve [--port N]                 Web UI（前台）
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
  dsh-memory audit list [--status pending] [--kind K] [--json]  列出待审/驳回卡片
  dsh-memory audit approve <path...> | reject <path...> [--reason "原因"]  人工批量审批

环境变量：MEMORY_VAULT_DIR / MEMORY_LLM_BASE_URL / MEMORY_LLM_KEY / MEMORY_LLM_MODEL`)
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error))
  process.exit(1)
})
