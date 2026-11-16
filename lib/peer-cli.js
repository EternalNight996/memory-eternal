// dsh-memory peer —— MEM Pair 的命令行（与面板同一套 /peer/* 接口）。
//
// 典型用法：
//   dsh-memory peer code                        # 看本机匹配码（念给对方/粘到对方面板）
//   dsh-memory peer discover                    # 局域网广播找同类实例
//   dsh-memory peer pair 192.168.1.20:7989      # 首次配对（对方要弹窗确认）
//   dsh-memory peer connect 7K2M-Q9FA           # 后续只凭匹配码重连（免确认）
//   dsh-memory peer upload --to 7K2M-Q9FA       # 把本库已审卡推给对方（对方进待审）
//   dsh-memory peer download --from 7K2M-Q9FA   # 把对方的卡拉进本库（进待审）
//
// 所有命令都支持 --json（给脚本用）与 --api <基础地址>（默认 127.0.0.1:7999）。
const DEFAULT_API = 'http://127.0.0.1:7999'

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1)
      else {
        const next = argv[i + 1]
        if (next && !next.startsWith('--')) { out.flags[a.slice(2)] = next; i++ }
        else out.flags[a.slice(2)] = true
      }
    } else out._.push(a)
  }
  return out
}

const HELP = `dsh-memory peer —— 两个 memory-eternal 实例配对与互传

  status                     本机匹配码 + 已配对节点 + 待确认请求
  code                       只打印本机匹配码
  discover                   局域网广播发现（UDP，默认 7990）
  probe <host:port>          直连探测某个实例
  pair <host:port>           首次配对：向对方敲门（对方面板要确认）
  connect <匹配码> [--url u] 后续只凭匹配码重连（对方认得就直接建立，不再确认）
  pending                    待确认请求（收到别人的敲门）
  accept <id> | reject <id>  确认 / 拒绝某个待确认请求
  peers                      已配对节点列表
  revoke <id>                吊销某个已配对节点
  upload  --to <id|码> [--limit 200] [--since 0] [--status approved]
  download --from <id|码> [--since 0]

通用参数：--api http://127.0.0.1:7999   --json
`

/**
 * @param {string[]} argv
 * @returns {Promise<number>} 进程退出码
 */
export async function runPeerCli(argv) {
  const { _, flags } = parseArgs(argv)
  const api = String(flags.api || process.env.MEMORY_API || DEFAULT_API).replace(/\/+$/, '')
  const base = api + '/memory-eternal/api'
  const asJson = !!flags.json
  const cmd = String(_[0] || 'status')

  const call = async (p, init) => {
    const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(Number(flags.timeout) || 8000) }).catch((e) => ({ ok: false, _err: String(e && e.message) }))
    if (!r || r._err) return { ok: false, error: '连不上本机记忆服务（' + base + '）：' + (r && r._err) }
    const text = await r.text().catch(() => '')
    try { return JSON.parse(text) } catch { return { ok: false, error: 'HTTP ' + r.status + '：' + text.slice(0, 200) } }
  }
  const post = (p, body) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const out = (v) => { if (asJson) console.log(JSON.stringify(v, null, 2)); return v }
  const die = (msg) => { console.error('✗ ' + msg); return 1 }

  if (flags.help || cmd === 'help' || cmd === '-h') { console.log(HELP); return 0 }

  if (cmd === 'code') {
    const s = await call('/peer/status')
    if (!s.ok) return die(s.error || '取不到本机匹配码')
    if (asJson) return out({ pairCode: s.self.pairCode, instanceId: s.self.id, name: s.self.name }), 0
    console.log(s.self.pairCode)
    return 0
  }

  if (cmd === 'status' || cmd === 'peers') {
    const s = await call('/peer/status')
    if (!s.ok) return die(s.error || '取不到状态')
    if (asJson) { out(s); return 0 }
    console.log(`本机：${s.self.name}  匹配码 ${s.self.pairCode}  指纹 ${s.self.fp}  端口 ${s.self.port}  (发现 UDP ${s.discoveryPort})`)
    if (!s.peers.length) console.log('已配对：无')
    else {
      console.log('已配对：')
      for (const p of s.peers) console.log(`  · ${p.name}  ${p.url}  码 ${p.pairCode || '-'}  指纹 ${p.fp}  ${p.enabled === false ? '（已停用）' : ''}`)
    }
    if (s.pending.length) {
      console.log('待确认：')
      for (const p of s.pending) console.log(`  · ${p.name}  ${p.url}  匹配码 ${p.code}  ${p.direction === 'incoming' ? '（对方在等我们确认）' : '（等对方确认）'}  id=${p.id}`)
    }
    return 0
  }

  if (cmd === 'discover') {
    const r = await post('/peer/discover', { timeoutMs: Number(flags.timeout) || 1200 })
    if (!r.ok) return die(r.error || '广播失败')
    if (asJson) { out(r); return 0 }
    if (!r.found.length) { console.log('没发现同类实例（检查对方是否在跑、UDP 7990 是否被防火墙挡）'); return 0 }
    for (const f of r.found) console.log(`  · ${f.name}  ${f.host}:${f.port}  码 ${f.pairCode || '-'}  指纹 ${f.fp}  v${f.version || '?'}`)
    return 0
  }

  if (cmd === 'probe') {
    const [host, port] = String(_[1] || '').split(':')
    if (!host || !port) return die('用法：peer probe <host:port>')
    const r = await post('/peer/probe', { host, port: Number(port) })
    if (!r.ok) return die(r.error || '探测失败')
    if (asJson) { out(r); return 0 }
    console.log(`可达：${r.peer.name}  码 ${r.peer.pairCode}  指纹 ${r.peer.fp}`)
    return 0
  }

  if (cmd === 'pair') {
    const [host, port] = String(_[1] || '').split(':')
    if (!host || !port) return die('用法：peer pair <host:port>')
    const r = await post('/peer/pair/start', { host, port: Number(port) })
    if (asJson) { out(r); return r.ok ? 0 : 1 }
    if (!r.ok) return die(r.error || '发起配对失败')
    if (r.auto) { console.log(`✓ 对方认得本机匹配码，已直接建立配对：${r.peer.name}（无需确认）`); return 0 }
    console.log(`✓ 已向 ${r.peer.name}（码 ${r.peer.pairCode}）发起配对请求`)
    console.log('  对方面板会弹窗确认；确认后本机自动完成配对。也可以让对方执行：dsh-memory peer accept ' + (r.pending?.id || '<id>'))
    if (r.code) console.log(`  本次握手码：${r.code}`)
    return 0
  }

  if (cmd === 'connect') {
    const code = String(_[1] || '').trim()
    if (!code) return die('用法：peer connect <匹配码> [--url http://host:port]')
    const r = await post('/peer/pair/connect', { code, url: flags.url || '', host: flags.host || '', port: flags.port ? Number(flags.port) : 0 })
    if (asJson) { out(r); return r.ok ? 0 : 1 }
    if (!r.ok) return die(r.error || '重连失败')
    if (r.auto) { console.log(`✓ 凭匹配码直接重连成功：${r.peer.name}（无需再确认）`); return 0 }
    console.log('已敲门，等待对方在面板确认。本次握手码：' + (r.code || ''))
    return 0
  }

  if (cmd === 'pending') {
    const s = await call('/peer/status')
    if (!s.ok) return die(s.error || '取不到状态')
    if (asJson) return out(s.pending), 0
    if (!s.pending.length) { console.log('没有待确认请求'); return 0 }
    for (const p of s.pending) console.log(`  · ${p.name}  码 ${p.code}  ${p.direction}  id=${p.id}`)
    return 0
  }

  if (cmd === 'accept' || cmd === 'reject') {
    const peerId = String(_[1] || '')
    if (!peerId) return die(`用法：peer ${cmd} <id>`)
    const r = await post(cmd === 'accept' ? '/peer/pair/accept' : '/peer/pair/reject', { id: peerId })
    if (asJson) { out(r); return r.ok ? 0 : 1 }
    if (!r.ok) return die(r.error || (cmd + ' 失败'))
    console.log(cmd === 'accept' ? `✓ 已确认配对${r.peer ? '：' + r.peer.name + (r.peer.notified ? '（已回推对方）' : '（对方未回执，它下次会自己重连）') : ''}` : '✓ 已拒绝')
    return 0
  }

  if (cmd === 'revoke') {
    const peerId = String(_[1] || '')
    if (!peerId) return die('用法：peer revoke <id|匹配码>')
    const r = await post('/peer/revoke', { id: peerId })
    if (asJson) { out(r); return r.ok ? 0 : 1 }
    console.log(r.ok ? '✓ 已吊销' : '✗ 没有这个节点')
    return r.ok ? 0 : 1
  }

  if (cmd === 'upload') {
    const to = String(flags.to || _[1] || '')
    if (!to) return die('用法：peer upload --to <id|匹配码> [--limit 200] [--since 0]')
    const body = { peerId: to, code: to, limit: Number(flags.limit) || 200, since: Number(flags.since) || 0, status: flags.status || 'approved' }
    const r = await post('/peer/upload', body)
    if (asJson) { out(r); return r.ok ? 0 : 1 }
    if (!r.ok) return die(r.error || '上传失败')
    console.log(`✓ 上传完成：发出 ${r.sent} 张 → 对方写入 ${r.written}（失败 ${r.failed}），对方库进待审`)
    return 0
  }

  if (cmd === 'download') {
    const from = String(flags.from || _[1] || '')
    if (!from) return die('用法：peer download --from <id|匹配码> [--since 0]')
    const r = await post('/peer/download', { peerId: from, code: from, since: Number(flags.since) || 0 })
    if (asJson) { out(r); return r.ok ? 0 : 1 }
    if (!r.ok) return die(r.error || '下载失败')
    console.log(`✓ 下载完成：拉取 ${r.fetched} 张 → 本库写入 ${r.written}（失败 ${r.failed}，进待审）`)
    return 0
  }

  console.error('未知子命令：' + cmd + '\n')
  console.log(HELP)
  return 1
}
