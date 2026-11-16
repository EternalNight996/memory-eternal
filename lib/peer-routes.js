// /peer/* 路由实现（MEM Pair 的 HTTP 面）。挂在 lib/api.js 分发前面，独立成文件便于审计。
//
// 三条通道：
//   · 发现：/peer/hello（名片）、/peer/discover（UDP 广播）、/peer/probe（直连 host:port）
//   · 配对：/peer/pair/request → 对方面板弹窗 → /peer/pair/accept → 回调 /peer/pair/confirm
//           + /peer/pair/connect（**后续只需知道匹配码**：命中且指纹一致就直接建立，不再弹窗）
//   · 数据：/peer/upload（把本库卡推给对方）、/peer/download（把对方卡拉进本库）
//           /peer/push、/peer/pull 是这两者的底层，都必须 HMAC 签名
//
// 安全口径：
//   · 只读接口（hello/discover/probe/status）不写库；
//   · pair/request 允许匿名（这是"敲门"），但只落一条 10 分钟过期的待确认记录，上限 10 条；
//   · 配对必须人工确认 —— **除非**对方的匹配码已在本地配对表里且指纹一致（那是"重连"，不是"新配对"）；
//     指纹变了（对方重装/被冒充）一律回到人工确认；
//   · 所有写入都进**待审队列**（tags 带 peer:<对方名字>），绝不直接进已审库。
import crypto from 'node:crypto'
import {
  readIdentity, writeIdentity, selfCard, peerStatus, discover, probeHttp,
  startPairing, pushIncoming, acceptPairing, finishPairing, revokePeer,
  verifyPeerCall, signedHeaders, touchPeer, findPeerByCode, deriveShared, DEFAULT_DISCOVERY_PORT,
} from './peer.js'

const MAX_PENDING = 10
const MAX_PULL = 100
const MAX_UPLOAD = 500

const hostPortOf = (req) => Number(String((req.headers && req.headers.host) || '').split(':')[1]) || 0
const stripSlash = (u) => String(u || '').replace(/\/+$/, '')

/** 把"已配对"落到身份文件里（重连时复用：只有 shared 需要重算）。 */
function upsertPeer(id, { remote, shared, pairCode, fp, url }) {
  const peer = {
    id: remote.id,
    name: remote.name || remote.id,
    url: stripSlash(url || remote.url || ''),
    fp: fp || remote.fp || '',
    pairCode: String(pairCode || remote.pairCode || ''),
    shared,
    pairedAt: Date.now(),
    lastSeenAt: 0,
    enabled: true,
    scopes: ['cards'],
  }
  const next = {
    ...id,
    peers: [...(id.peers || []).filter((p) => p.id !== peer.id), peer],
    pending: (id.pending || []).filter((p) => p.id !== peer.id),
  }
  writeIdentity(next)
  return peer
}

/**
 * @returns {Promise<boolean>} true=已处理；false=不是 /peer/* 路由
 */
export async function handlePeerRoute({
  req, res, route, query, vaultRoot,
  json, broadcast, writeCard, ensureVault, getSettings, readRaw, logActivity, clientIpOf,
}) {
  if (!route.startsWith('/peer/')) return false
  const id = readIdentity()
  const selfPort = hostPortOf(req)
  const method = req.method

  // ── 只读 ────────────────────────────────────────────────────────────────
  if (route === '/peer/hello' && method === 'GET') {
    json(res, 200, { ok: true, peer: selfCard(id, { port: selfPort }) })
    return true
  }

  if (route === '/peer/status' && method === 'GET') {
    const st = peerStatus(id)
    st.self.port = selfPort
    st.discoveryPort = Number(process.env.MEMORY_PEER_DISCOVERY_PORT) || DEFAULT_DISCOVERY_PORT
    json(res, 200, st)
    return true
  }

  // ── 发现 ────────────────────────────────────────────────────────────────
  if (route === '/peer/discover' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const list = await discover(id, {
      port: selfPort,
      discoveryPort: Number(body.discoveryPort) || Number(process.env.MEMORY_PEER_DISCOVERY_PORT) || DEFAULT_DISCOVERY_PORT,
      timeoutMs: Math.min(Math.max(Number(body.timeoutMs) || 1200, 300), 5000),
    })
    json(res, 200, { ok: true, found: list, took: Date.now() })
    return true
  }

  if (route === '/peer/probe' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const host = String(body.host || '').trim()
    const port = Number(body.port) || 0
    if (!host || !port) return json(res, 400, { ok: false, error: '需要 host 与 port' }), true
    const peer = await probeHttp(host, port).catch(() => null)
    if (!peer) return json(res, 404, { ok: false, error: `连不上 ${host}:${port}（对端未开 MEM Pair 或端口不对）` }), true
    if (peer.id === id.instanceId) return json(res, 400, { ok: false, error: '这就是本机自己' }), true
    json(res, 200, { ok: true, peer })
    return true
  }

  // ── 配对：敲门（可能自动完成，也可能等人工确认）──────────────────────────
  if (route === '/peer/pair/request' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const from = body.from || {}
    if (!from.id) return json(res, 400, { ok: false, error: '缺少对方身份' }), true

    // ① 重连：匹配码已在配对表里 + 指纹一致 → 直接建立，**不再弹窗**
    const known = findPeerByCode(id, from.pairCode)
    if (known.hit) {
      const sameFp = String(known.peer.fp || '') === String(from.fp || '')
      if (sameFp) {
        const eph = String(body.eph || '')
        if (!eph) return json(res, 400, { ok: false, error: '重连请求需要带 eph' }), true
        // 重连握手：本次响应用一个新的 ephemeral，两端各自 deriveShared 得到同一把共享密钥
        const eph2 = crypto.randomBytes(32).toString('base64url')
        const me = readIdentity()
        const peer = upsertPeer(me, {
          remote: { ...from, url: from.url || known.peer.url },
          shared: deriveShared(eph, eph2),
          pairCode: from.pairCode || known.peer.pairCode,
          fp: from.fp,
          url: from.url || known.peer.url,
        })
        try { broadcast('peer', { event: 'paired', peer: { id: peer.id, name: peer.name }, auto: true }) } catch { /* 忽略 */ }
        json(res, 200, {
          ok: true,
          auto: true,
          peer: { id: peer.id, name: peer.name },
          confirm: { from: { ...selfCard(me, { port: selfPort }), url: 'http://' + (req.headers.host || '') }, eph: eph2, code: '', auto: true },
        })
        return true
      }
      // ② 匹配码认得、但指纹变了 → 必须重新人工确认（防"码泄露后被冒用"）
      if ((id.pending || []).length >= MAX_PENDING) return json(res, 429, { ok: false, error: '待确认请求太多（上限 10）' }), true
      const r = pushIncoming(id, { from: { ...from, url: from.url || '' }, code: String(body.code || ''), eph: String(body.eph || '') })
      if (!r.ok) return json(res, 400, r), true
      r.item.reason = 'fingerprint-changed'
      r.item.knownName = known.peer.name
      const next = { ...readIdentity(), pending: (readIdentity().pending || []).map((p) => (p.id === r.item.id ? r.item : p)) }
      writeIdentity(next)
      try { broadcast('peer', { event: 'pair-request', item: r.item }) } catch { /* 忽略 */ }
      json(res, 200, { ok: true, needsConfirm: true, reason: 'fingerprint-changed', message: '匹配码是老的，但对方指纹变了（重装或被冒充），请在面板确认' })
      return true
    }

    // ③ 陌生匹配码 → 落待确认 + 弹窗
    if ((id.pending || []).length >= MAX_PENDING) return json(res, 429, { ok: false, error: '待确认请求太多（上限 10）' }), true
    const r = pushIncoming(id, body)
    if (!r.ok) return json(res, 400, r), true
    try { broadcast('peer', { event: 'pair-request', item: r.item }) } catch { /* 没有订阅者也无妨 */ }
    try { logActivity(vaultRoot, { ip: clientIpOf(req), agent: 'peer', action: 'pair-request', title: r.item.name, target: r.item.url }) } catch { /* 旁路 */ }
    json(res, 200, { ok: true, needsConfirm: true, pending: { id: r.item.id, code: r.item.code, expiresAt: r.item.expiresAt } })
    return true
  }

  if (route === '/peer/pair/accept' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const acc = acceptPairing(id, String(body.id || ''))
    if (!acc.ok) return json(res, 400, acc), true
    const peerUrl = stripSlash(acc.peer.url)
    let notified = false
    if (peerUrl) {
      const r = await fetch(peerUrl + '/memory-eternal/api/peer/pair/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(acc.confirm),
        signal: AbortSignal.timeout(4000),
      }).catch(() => null)
      notified = !!(r && r.ok)
    }
    try { broadcast('peer', { event: 'paired', peer: { id: acc.peer.id, name: acc.peer.name } }) } catch { /* 忽略 */ }
    json(res, 200, { ok: true, peer: { id: acc.peer.id, name: acc.peer.name, url: acc.peer.url, notified } })
    return true
  }

  if (route === '/peer/pair/confirm' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    // 重连分支：对方返回 auto:true 时，用同一套派生重建共享密钥
    if (body && body.auto && body.from && body.from.id) {
      const mine = (id.pending || []).find((p) => p.id === body.from.id && !p.direction)
      if (!mine) return json(res, 400, { ok: false, error: '没有这个待确认的配对' }), true
      const shared = deriveShared(mine.eph, stripSlash(body.eph))
      const peer = upsertPeer(readIdentity(), { remote: body.from, shared, pairCode: body.from.pairCode, fp: body.from.fp, url: body.from.url })
      try { broadcast('peer', { event: 'paired', peer: { id: peer.id, name: peer.name }, auto: true }) } catch { /* 忽略 */ }
      json(res, 200, { ok: true, auto: true, peer: { id: peer.id, name: peer.name } })
      return true
    }
    const fin = finishPairing(id, body)
    if (!fin.ok) return json(res, 400, fin), true
    try { broadcast('peer', { event: 'paired', peer: { id: fin.peer.id, name: fin.peer.name } }) } catch { /* 忽略 */ }
    json(res, 200, { ok: true, peer: { id: fin.peer.id, name: fin.peer.name } })
    return true
  }

  if (route === '/peer/pair/reject' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const next = { ...id, pending: (id.pending || []).filter((p) => p.id !== String(body.id || '')) }
    writeIdentity(next)
    json(res, 200, { ok: true })
    return true
  }

  if (route === '/peer/revoke' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const r = revokePeer(id, String(body.id || ''))
    try { broadcast('peer', { event: 'revoked', id: body.id }) } catch { /* 忽略 */ }
    json(res, 200, r)
    return true
  }

  /**
   * /peer/pair/connect —— **下次只需知道匹配码**：
   * body { code, host?, port? }
   *   · 本地配对表里有这个匹配码 → 直接用它记的 url 重连（对方自动接受，不再弹窗）
   *   · 没有 → 用 host:port（不给就报错）探测，走一次"敲门"
   */
  // ── 配对：发起（首次要对方确认；重连命中匹配码则免确认）──────────────────
  if ((route === '/peer/pair/start' || route === '/peer/pair/connect') && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }

    // 目标地址：url 优先；否则 host:port；connect 还会去配对表里按匹配码找
    let targetUrl = stripSlash(body.url || '')
    const code = String(body.code || '').trim().toUpperCase()
    const known = code ? findPeerByCode(id, code) : { hit: false }
    if (!targetUrl && known.hit) targetUrl = stripSlash(known.peer.url)
    if (!targetUrl && body.host) targetUrl = `http://${body.host}:${Number(body.port) || 7999}`
    if (!targetUrl) return json(res, 400, { ok: false, error: code ? '这个匹配码还没配对过，请同时提供 host 与 port' : '需要 url 或 host+port' }), true

    // 探测拿对方名片（拿不到就不建 pending，避免留下垃圾）
    const u = (() => { try { return new URL(targetUrl) } catch { return null } })()
    if (!u) return json(res, 400, { ok: false, error: '地址不合法：' + targetUrl }), true
    const card = await probeHttp(u.hostname, Number(u.port) || 80).catch(() => null)
    if (!card) return json(res, 404, { ok: false, error: '连不上 ' + targetUrl + '（对端没开 MEM Pair 或端口不对）' }), true
    if (card.id === id.instanceId) return json(res, 400, { ok: false, error: '这就是本机自己' }), true

    const started = startPairing(readIdentity(), { id: card.id, name: card.name, url: targetUrl, fp: card.fp })
    const self = readIdentity()
    const payload = JSON.stringify({
      from: { ...selfCard(self, { port: selfPort }), url: `http://${req.headers.host}` },
      code: started.code,
      eph: started.request.eph,
      ts: Date.now(),
      pairCode: String(self.pairCode || ''),
    })
    const r = await fetch(targetUrl + '/memory-eternal/api/peer/pair/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    const jr = r ? await r.json().catch(() => null) : null
    if (!jr) return json(res, 502, { ok: false, error: '对方没响应：' + targetUrl }), true
    if (jr && jr.ok === false) return json(res, 502, { ok: false, error: '对方拒绝配对：' + (jr.error || jr.code || '未知'), remote: jr }), true

    const peerBrief = { id: card.id, name: card.name, pairCode: card.pairCode || '' }
    if (jr.auto && jr.confirm) {
      // 对方凭匹配码直接接受（重连）：两端用同一套派生立刻建好共享密钥
      const mine = (readIdentity().pending || []).find((x) => x.id === card.id && !x.direction)
      const shared = deriveShared(mine ? mine.eph : started.request.eph, stripSlash(jr.confirm.eph))
      const peer = upsertPeer(readIdentity(), { remote: { ...jr.confirm.from, url: targetUrl }, shared, pairCode: card.pairCode || code, fp: card.fp, url: targetUrl })
      try { broadcast('peer', { event: 'paired', peer: { id: peer.id, name: peer.name }, auto: true }) } catch { /* 忽略 */ }
      return json(res, 200, { ok: true, auto: true, peer: peerBrief }), true
    }
    json(res, 200, {
      ok: true, auto: false, needsConfirm: true, peer: peerBrief,
      code: started.code, pending: jr.pending || null,
      message: jr.message || '已向对方发起配对请求，等它在面板点确认',
    })
    return true
  }

  // ── 数据：底层 push / pull（签名）────────────────────────────────────────
  if (route === '/peer/push' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    const v = verifyPeerCall(id, req, { method: 'POST', path: '/memory-eternal/api/peer/push', bodyText: raw })
    if (!v.ok) return json(res, 401, { ok: false, code: v.code, error: v.error }), true
    touchPeer(id, v.peer.id)
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }), true }
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_UPLOAD) : []
    if (!items.length) return json(res, 400, { ok: false, error: 'items 为空' }), true
    const out = await importItems({ vaultRoot, items, peerName: v.peer.name, writeCard, ensureVault })
    try { logActivity(vaultRoot, { ip: clientIpOf(req), agent: 'peer', action: 'peer-push', title: v.peer.name, target: `写入 ${out.written} / 失败 ${out.failed}` }) } catch { /* 旁路 */ }
    try { broadcast('cards', { reason: 'peer-push', written: out.written, from: v.peer.name }) } catch { /* 忽略 */ }
    json(res, 200, { ok: true, ...out, pending: true })
    return true
  }

  if (route === '/peer/pull' && method === 'GET') {
    const v = verifyPeerCall(id, req, { method: 'GET', path: '/memory-eternal/api/peer/pull', bodyText: '' })
    if (!v.ok) return json(res, 401, { ok: false, code: v.code, error: v.error }), true
    touchPeer(id, v.peer.id)
    const since = Number(query.get('since')) || 0
    const r = await listApprovedSince(vaultRoot, since, MAX_PULL)
    json(res, 200, { ok: true, ...r })
    return true
  }

  // ── 摘要：对方库有多少卡（面板显示"对方库"，并决定要不要上传/下载）──────
  if (route === '/peer/summary' && method === 'GET') {
    const v = verifyPeerCall(id, req, { method: 'GET', path: '/memory-eternal/api/peer/summary', bodyText: '' })
    if (!v.ok) return json(res, 401, { ok: false, code: v.code, error: v.error }), true
    touchPeer(id, v.peer.id)
    const { getDb } = await import('./db.js')
    let total = 0
    const byKind = {}
    try {
      const db = getDb(vaultRoot)
      const rows = db.prepare("SELECT kind, COUNT(*) AS n FROM cards WHERE (status IS NULL OR status = 'approved') GROUP BY kind").all()
      for (const r of rows) { byKind[r.kind || '?'] = Number(r.n) || 0; total += Number(r.n) || 0 }
    } catch { /* 库还没建出来 */ }
    json(res, 200, { ok: true, total, byKind, at: Date.now(), instance: 'memory-eternal' })
    return true
  }

  if (route === '/peer/stats' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const peer = (id.peers || []).find((x) => x.id === String(body.peerId || '') || (x.pairCode || '').toUpperCase() === String(body.code || '').toUpperCase())
    if (!peer) return json(res, 404, { ok: false, error: '没有这个已配对节点' }), true
    const r = await fetch(stripSlash(peer.url) + '/memory-eternal/api/peer/summary', {
      method: 'GET',
      headers: signedHeaders(peer, 'GET', '/memory-eternal/api/peer/summary', '', id.instanceId),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    const j = r ? await r.json().catch(() => null) : null
    if (!j || !j.ok) return json(res, 502, { ok: false, error: '取对方库摘要失败：' + ((j && (j.error || j.code)) || '对方没响应') }), true
    json(res, 200, { ok: true, peer: { id: peer.id, name: peer.name }, total: j.total, byKind: j.byKind || {}, at: j.at })
    return true
  }

  // ── 数据：上层"上传 / 下载"（本机发起，无需签名头）──────────────────────
  if (route === '/peer/upload' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const peer = (id.peers || []).find((p) => p.id === String(body.peerId || '') || (p.pairCode || '').toUpperCase() === String(body.code || '').toUpperCase())
    if (!peer) return json(res, 404, { ok: false, error: '没有这个已配对节点（先用匹配码配对）' }), true
    const limit = Math.min(Math.max(Number(body.limit) || 200, 1), MAX_UPLOAD)
    const since = Number(body.since) || 0
    const { cards } = await localCardsForUpload(vaultRoot, { since, limit, status: String(body.status || 'approved') })
    if (!cards.length) return json(res, 200, { ok: true, sent: 0, written: 0, failed: 0, note: '没有可上传的卡' }), true
    const payloadText = JSON.stringify({ items: cards })
    const r = await fetch(stripSlash(peer.url) + '/memory-eternal/api/peer/push', {
      method: 'POST',
      headers: signedHeaders(peer, 'POST', '/memory-eternal/api/peer/push', payloadText, id.instanceId),
      body: payloadText,
      signal: AbortSignal.timeout(20000),
    }).catch(() => null)
    const j = r ? await r.json().catch(() => null) : null
    if (!j || !j.ok) return json(res, 502, { ok: false, error: '上传失败：' + ((j && (j.error || j.code)) || '对方没响应') }), true
    json(res, 200, { ok: true, sent: cards.length, written: j.written, failed: j.failed, peer: peer.name })
    return true
  }

  if (route === '/peer/download' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const peer = (id.peers || []).find((p) => p.id === String(body.peerId || '') || (p.pairCode || '').toUpperCase() === String(body.code || '').toUpperCase())
    if (!peer) return json(res, 404, { ok: false, error: '没有这个已配对节点（先用匹配码配对）' }), true
    const since = Number(body.since) || 0
    const r = await fetch(stripSlash(peer.url) + '/memory-eternal/api/peer/pull?since=' + since, {
      method: 'GET',
      headers: signedHeaders(peer, 'GET', '/memory-eternal/api/peer/pull', '', id.instanceId),
      signal: AbortSignal.timeout(20000),
    }).catch(() => null)
    const j = r ? await r.json().catch(() => null) : null
    if (!j || !j.ok) return json(res, 502, { ok: false, error: '下载失败：' + ((j && (j.error || j.code)) || '对方没响应') }), true
    const cards = Array.isArray(j.cards) ? j.cards : []
    const items = cards.filter((c) => c && c.body).map((c) => ({ title: c.title, kind: c.kind, body: c.body, tags: c.tags || [] }))
    const out = await importItems({ vaultRoot, items, peerName: peer.name, writeCard, ensureVault })
    json(res, 200, { ok: true, fetched: cards.length, ...out, peer: peer.name })
    return true
  }

  json(res, 404, { ok: false, error: '未知的 /peer 路由：' + route })
  return true
}

/** 把对方条目写进本库（一律 pending + peer:<名字> 标签）。 */
async function importItems({ vaultRoot, items, peerName, writeCard, ensureVault }) {
  await ensureVault(vaultRoot)
  const tag = 'peer:' + String(peerName || 'peer').slice(0, 24)
  let written = 0
  let failed = 0
  for (const c of items) {
    const title = String((c && c.title) || '').trim()
    const text = String((c && c.body) || '').trim()
    if (!title || !text) { failed++; continue }
    try {
      const r = await writeCard(vaultRoot, {
        kind: String(c.kind || 'knowledge'),
        title: title.slice(0, 120),
        tags: [...new Set([...(Array.isArray(c.tags) ? c.tags : []), tag, 'from-peer'])].slice(0, 12),
        body: text,
        source: 'peer',
        status: 'pending',
        submittedBy: tag,
      })
      if (r && r.ok) written++; else failed++
    } catch { failed++ }
  }
  return { written, failed }
}

/** 从本库取要上传的卡（带全文）。 */
async function localCardsForUpload(vaultRoot, { since, limit, status }) {
  const { getDb } = await import('./db.js')
  const { readCard } = await import('./vault.js')
  const db = getDb(vaultRoot)
  const rows = db.prepare(
    `SELECT path, title, kind, tags, body FROM cards WHERE (status IS NULL OR status = ?) AND updated_at > datetime(?/1000, 'unixepoch') ORDER BY updated_at ASC LIMIT ?`,
  ).all(status === 'all' ? 'approved' : status, since, limit)
  const cards = rows.filter((r) => r && r.body).map((r) => ({
    title: r.title, kind: r.kind, body: r.body,
    tags: (() => { try { return JSON.parse(r.tags || '[]') } catch { return [] } })(),
  }))
  return { cards }
}

/** 取 since 之后更新的已审卡（给 pull 用）。 */
async function listApprovedSince(vaultRoot, since, limit) {
  const { getDb } = await import('./db.js')
  try {
    const db = getDb(vaultRoot)
    const rows = db.prepare(
      "SELECT path, title, kind, summary, body, tags, updated_at FROM cards WHERE (status IS NULL OR status = 'approved') AND updated_at > datetime(?/1000, 'unixepoch') ORDER BY updated_at ASC LIMIT ?",
    ).all(since, limit)
    return { since, cards: rows.map((r) => ({ path: r.path, title: r.title, kind: r.kind, summary: r.summary || '', body: r.body || '', tags: (() => { try { return JSON.parse(r.tags || '[]') } catch { return [] } })(), updated: r.updated_at })), more: rows.length >= limit }
  } catch {
    return { since, cards: [], more: false }
  }
}
