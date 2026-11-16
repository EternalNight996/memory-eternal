// MEM Pair —— 两个 memory-eternal 实例之间「发现 → 匹配码 → 人工确认 → 互推数据」。
//
// 为什么需要它：运营库（如 127.0.0.1:7999 / memory-vault）和隔离运营的 mem-purge 库
// （如 127.0.0.1:7989 / memory-vault-mem-purge）各自独立，不能共享 SQLite。
// 想让它们互相喂料（运营库把知识卡/口径给 purge，purge 把清理结果/战报回给运营库），
// 就必须有一套**显式、可审计、默认关闭**的配对协议，而不是把两个库混成一个。
//
// 协议（v1）：
//   1) 发现：UDP 广播（默认 7990）—— probe / offer 两种报文；也支持直接给 host:port 探测。
//   2) 配对：发起方生成 **6 位匹配码**（10 分钟有效），对方**弹窗人工确认**，两边看到同一个码才算数。
//      配对时双方各给一个**一次性 ephemeral secret**，共享密钥 = sha256(排序后的两个 ephemeral)
//      —— 长期密钥从不上网。
//   3) 互调：所有 /peer/* 请求用共享密钥做 HMAC-SHA256 签名（id+ts+nonce+body hash），
//      ±300s 时间窗 + nonce 去重，防重放。
//   4) 隔离：配对与推送都只写"对方库"的**待审队列**（tag=peer:<名字>），不直接改对方已审库；
//      默认关闭，必须显式开启 + 逐次人工点确认。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import dgram from 'node:dgram'
import crypto from 'node:crypto'

export const PEER_FILE = 'memory-eternal-peer.json'
/** 匹配码用的字符集：去掉了 0/O/1/I/L 这些肉眼易混的，口头念也不容易错。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
/** 生成一个稳定的 8 位匹配码（XXXX-XXXX）。 */
export function makePairCode() {
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)]
  return s.slice(0, 4) + '-' + s.slice(4)
}
export const MAGIC = 'ME-PAIR-1'
export const DEFAULT_DISCOVERY_PORT = 7990
const CODE_TTL_MS = 10 * 60 * 1000
const SKEW_MS = 300 * 1000
const NONCE_TTL_MS = 10 * 60 * 1000

const b64 = (buf) => Buffer.from(buf).toString('base64url')
const unb64 = (s) => Buffer.from(String(s), 'base64url')
const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex')
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest()

export function peerPath(env = process.env) {
  const home = String((env && env.DSH_HOME) || '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, PEER_FILE)
}

/** 读/建本机身份（instanceId + 长期密钥）。坏了就重建，不让它拖垮启动。 */
export function readIdentity(env = process.env) {
  const p = peerPath(env)
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (raw && raw.instanceId && raw.secret) {
      if (!raw.pairCode) {
        raw.pairCode = makePairCode()
        try { fs.writeFileSync(p, JSON.stringify(raw, null, 2), { mode: 0o600 }) } catch { /* 补不上也不影响启动 */ }
      }
      return {
        instanceId: String(raw.instanceId),
        name: String(raw.name || os.hostname()),
        secret: String(raw.secret),
        createdAt: Number(raw.createdAt) || 0,
        pairCode: String(raw.pairCode || ''),
        port: Number(raw.port) || 0,
        peers: Array.isArray(raw.peers) ? raw.peers : [],
        pending: Array.isArray(raw.pending) ? raw.pending : [],
      }
    }
  } catch { /* 不存在或坏文件 */ }
  const fresh = {
    instanceId: crypto.randomUUID(),
    name: os.hostname(),
    secret: b64(crypto.randomBytes(32)),
    pairCode: makePairCode(),
    createdAt: Date.now(),
    port: 0,
    peers: [],
    pending: [],
  }
  writeIdentity(fresh, env)
  return fresh
}

export function writeIdentity(id, env = process.env) {
  const p = peerPath(env)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(id, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
  try { fs.chmodSync(p, 0o600) } catch { /* Windows 上无所谓 */ }
  return id
}

/** 对外展示的指纹（不是密钥本身）。 */
export function fingerprint(id) {
  return sha256hex(String(id.secret || '') + '|' + String(id.instanceId || '')).slice(0, 16)
}

/** 本机的对外名片（放进广播/配对请求）。 */
export function selfCard(id, { port = 0 } = {}) {
  return {
    id: id.instanceId,
    name: id.name || os.hostname(),
    fp: fingerprint(id),
    pairCode: String(id.pairCode || ''),
    port: Number(port) || Number(id.port) || 0,
    api: 'memory-eternal',
    version: '',
  }
}

// ── 签名 / 验签 ─────────────────────────────────────────────────────────────

export function canonical(method, p, ts, nonce, bodyText) {
  return [String(method).toUpperCase(), String(p), String(ts), String(nonce), sha256hex(String(bodyText || ''))].join('\n')
}

export function sign(sharedSecret, method, p, ts, nonce, bodyText) {
  return hmac(unb64(sharedSecret), canonical(method, p, ts, nonce, bodyText)).toString('hex')
}

/** 共享密钥 = sha256(按字典序拼接的两个 ephemeral secret) —— 两端独立算出同一个值。 */
export function deriveShared(e1, e2) {
  const [a, b] = [String(e1), String(e2)].sort()
  return b64(crypto.createHash('sha256').update(a + '|' + b).digest())
}

const seenNonces = new Map()
function nonceFresh(nonce) {
  const now = Date.now()
  for (const [k, at] of seenNonces) if (now - at > NONCE_TTL_MS) seenNonces.delete(k)
  if (seenNonces.has(nonce)) return false
  seenNonces.set(nonce, now)
  return true
}

/**
 * 校验一次 /peer/* 调用。
 * @returns {{ok:true, peer:object}|{ok:false, code:string, error:string}}
 */
export function verifyPeerCall(id, req, { method, path: p, bodyText }) {
  const h = (req && req.headers) || {}
  const peerId = String(h['x-me-peer-id'] || '').trim()
  const ts = Number(h['x-me-peer-ts'] || 0)
  const nonce = String(h['x-me-peer-nonce'] || '').trim()
  const sig = String(h['x-me-peer-sig'] || '').trim()
  if (!peerId || !ts || !nonce || !sig) return { ok: false, code: 'peer_not_signed', error: '缺少配对签名（先完成配对）' }
  const peer = (id.peers || []).find((x) => x && x.id === peerId && x.enabled !== false)
  if (!peer) return { ok: false, code: 'peer_unknown', error: '这个实例没有配对过对方' }
  if (Math.abs(Date.now() - ts) > SKEW_MS) return { ok: false, code: 'peer_skew', error: '时间戳超出 ±5 分钟（检查两边系统时间）' }
  // 先验签、再消费 nonce：否则伪造请求也能把 nonce 烧掉（等于给攻击者一个廉价的拒绝服务点）
  const want = sign(peer.shared, method, p, ts, nonce, bodyText)
  const got = Buffer.from(sig, 'hex')
  const exp = Buffer.from(want, 'hex')
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return { ok: false, code: 'peer_bad_sig', error: '签名不匹配' }
  if (!nonceFresh(peerId + ':' + nonce)) return { ok: false, code: 'peer_replay', error: '重复的请求（nonce 已用过）' }
  return { ok: true, peer }
}

/** 给对外的请求生成签名头。 */
export function signedHeaders(peer, method, p, bodyText, selfId) {
  const ts = Date.now()
  const nonce = b64(crypto.randomBytes(9))
  return {
    'content-type': 'application/json',
    'x-me-peer-id': selfId,
    'x-me-peer-ts': String(ts),
    'x-me-peer-nonce': nonce,
    'x-me-peer-sig': sign(peer.shared, method, p, ts, nonce, bodyText),
  }
}

// ── 发现：UDP 广播 + 直连探测 ───────────────────────────────────────────────

/** 收集各网卡的定向广播地址（255.255.255.255 在某些系统/防火墙下不回来）。 */
export function broadcastTargets() {
  const out = new Set(['255.255.255.255'])
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      const ip = String(ni.address || '').split('.').map(Number)
      const mask = String(ni.netmask || '').split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4) continue
      const bc = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255))
      out.add(bc.join('.'))
    }
  }
  return [...out]
}

/**
 * 广播发现（默认 1200ms）。返回 [{id,name,fp,host,port,version}]
 * 只做发现，不做任何写入；配对永远需要人工确认。
 */
export async function discover(id, { port = 0, discoveryPort = DEFAULT_DISCOVERY_PORT, timeoutMs = 1200 } = {}) {
  const card = { magic: MAGIC, kind: 'probe', ...selfCard(id, { port }) }
  const payload = Buffer.from(JSON.stringify(card), 'utf8')
  const found = new Map()
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { try { sock.close() } catch { /* 已关 */ } ; resolve() }, timeoutMs)
    sock.on('message', (msg, rinfo) => {
      try {
        const m = JSON.parse(msg.toString('utf8'))
        if (!m || m.magic !== MAGIC || m.kind !== 'offer' || !m.id || m.id === id.instanceId) return
        if (found.has(m.id)) return
        found.set(m.id, { id: m.id, name: m.name || '', fp: m.fp || '', host: rinfo.address, port: Number(m.port) || 0, version: m.version || '' })
      } catch { /* 非本协议报文，忽略 */ }
      clearTimeout(timer)
    })
    sock.on('error', () => { clearTimeout(timer); resolve() })
    sock.bind(0, () => {
      try { sock.unref() } catch { /* 老 node 无此方法 */ }
      try { sock.setBroadcast(true) } catch { /* 受限网卡 */ }
      for (const t of broadcastTargets()) {
        try { sock.send(payload, 0, payload.length, discoveryPort, t) } catch { /* 忽略单个目标 */ }
      }
    })
  })
  await done
  return [...found.values()]
}

/** 收到 probe 时回一个 offer（单播回源）。 */
export function startDiscoveryResponder(id, { port = 0, discoveryPort = DEFAULT_DISCOVERY_PORT, onLog = () => {} } = {}) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('message', (msg, rinfo) => {
    try {
      const m = JSON.parse(msg.toString('utf8'))
      if (!m || m.magic !== MAGIC || m.kind !== 'probe' || m.id === id.instanceId) return
      const offer = Buffer.from(JSON.stringify({ magic: MAGIC, kind: 'offer', ...selfCard(id, { port }), version: '' }), 'utf8')
      sock.send(offer, 0, offer.length, rinfo.port, rinfo.address)
      onLog({ event: 'probe', from: rinfo.address, peer: m.name || m.id })
    } catch { /* 忽略 */ }
  })
  sock.on('error', (e) => onLog({ event: 'error', error: String((e && e.message) || e) }))
  sock.bind(discoveryPort, () => {
    try { sock.unref() } catch { /* 老 node 无此方法 */ }
    try { sock.setBroadcast(true) } catch { /* 忽略 */ }
  })
  return { close: () => { try { sock.close() } catch { /* 已关 */ } } }
}

/** 直连探测某个 host:port（HTTP，不依赖广播）。 */
export async function probeHttp(host, port, { timeoutMs = 1500 } = {}) {
  const url = `http://${host}:${port}/memory-eternal/api/peer/hello`
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null)
  if (!r || !r.ok) return null
  const j = await r.json().catch(() => null)
  if (!j || !j.ok || !j.peer || !j.peer.id) return null
  return { ...j.peer, host, port: Number(port) }
}

// ── 配对 ────────────────────────────────────────────────────────────────────

/** 发起方：生成 6 位匹配码 + 一次性 ephemeral secret，并把待确认请求存本地。 */
export function startPairing(id, target, env = process.env) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const eph = b64(crypto.randomBytes(32))
  const pending = {
    id: target.id,
    name: target.name || target.id,
    url: String(target.url || '').trim() || `http://${target.host}:${target.port}`,
    fp: target.fp || '',
      // 记住对方的**稳定匹配码**：后续「只凭匹配码重连」与 upload/download 找节点都靠它
      pairCode: String(target.pairCode || ''),
    code,
    eph,
    ts: Date.now(),
    expiresAt: Date.now() + CODE_TTL_MS,
  }
  const next = { ...id, pending: [...(id.pending || []).filter((p) => p.id !== target.id), pending] }
  writeIdentity(next, env)
  return { ok: true, code, request: { from: selfCard(id), code, eph, ts: pending.ts, pairCode: String(id.pairCode || '') } }
}

/** 接收方：记录待人工确认的请求（面板据此弹窗）。 */
export function pushIncoming(id, { from, code, eph, ts } = {}, env = process.env) {
  if (!from || !from.id) return { ok: false, error: '缺少对方身份' }
  if (!/^\d{6}$/.test(String(code || ''))) return { ok: false, error: '匹配码必须是 6 位数字' }
  const item = {
    id: String(from.id),
    name: String(from.name || from.id),
    url: String(from.url || ''),
    fp: String(from.fp || ''),
    // 对方的稳定匹配码：确认时一并落到 peers 里，后续「只凭匹配码重连」才认得出
    pairCode: String(from.pairCode || ''),
    code: String(code),
    eph: String(eph || ''),
    ts: Number(ts) || Date.now(),
    expiresAt: Date.now() + CODE_TTL_MS,
    direction: 'incoming',
  }
  const next = { ...id, pending: [...(id.pending || []).filter((p) => !(p.id === item.id && p.direction === 'incoming')), item] }
  writeIdentity(next, env)
  return { ok: true, item }
}

/** 接收方点「确认」：返回给发起方的确认载荷（含自己的 ephemeral）。 */
export function acceptPairing(id, peerId, env = process.env) {
  const item = (id.pending || []).find((p) => p.id === peerId && p.direction === 'incoming')
  if (!item) return { ok: false, error: '没有这个待确认请求（可能已过期）' }
  if (Number(item.expiresAt) < Date.now()) return { ok: false, error: '匹配码已过期，请让对方重新发起' }
  const eph = b64(crypto.randomBytes(32))
  const peer = {
    id: item.id,
    name: item.name,
    url: item.url,
    fp: item.fp,
    pairCode: String(item.pairCode || ''),
    shared: deriveShared(item.eph, eph),
    pairedAt: Date.now(),
    lastSeenAt: 0,
    enabled: true,
    scopes: ['cards'],
  }
  const next = {
    ...id,
    peers: [...(id.peers || []).filter((p) => p.id !== peer.id), peer],
    pending: (id.pending || []).filter((p) => p.id !== peerId),
  }
  writeIdentity(next, env)
  return { ok: true, peer, confirm: { from: selfCard(id), eph, code: item.code, ts: Date.now() } }
}

/** 发起方收到确认：校验匹配码一致后落盘（共享密钥两端各自算出）。 */
export function finishPairing(id, { from, eph, code } = {}, env = process.env) {
  const item = (id.pending || []).find((p) => p.id === (from && from.id) && !p.direction)
  if (!item) return { ok: false, error: '没有这个待确认的配对（可能已过期）' }
  if (String(item.code) !== String(code)) return { ok: false, error: '匹配码不一致 —— 可能配错了对象，已拒绝' }
  if (Number(item.expiresAt) < Date.now()) return { ok: false, error: '匹配码已过期，请重新发起' }
  const peer = {
    id: item.id,
    name: from.name || item.name,
    url: item.url,
    fp: from.fp || item.fp,
    pairCode: String(from.pairCode || item.pairCode || ''),
    shared: deriveShared(item.eph, eph),
    pairedAt: Date.now(),
    lastSeenAt: 0,
    enabled: true,
    scopes: ['cards'],
  }
  const next = {
    ...id,
    peers: [...(id.peers || []).filter((p) => p.id !== peer.id), peer],
    pending: (id.pending || []).filter((p) => p.id !== item.id),
  }
  writeIdentity(next, env)
  return { ok: true, peer }
}

export function revokePeer(id, peerId, env = process.env) {
  const before = (id.peers || []).length
  const next = { ...id, peers: (id.peers || []).filter((p) => p.id !== peerId), pending: (id.pending || []).filter((p) => p.id !== peerId) }
  writeIdentity(next, env)
  return { ok: before !== next.peers.length }
}

/**
 * 按匹配码找"已经配对过的对方"。
 * 这是「下次只要知道匹配码就能连上」的核心：命中且指纹一致 → 免人工确认；
 * 命中但指纹变了（对方重装/被冒充）→ 必须重新确认，别静默信任。
 * @returns {{hit:boolean, peer?:object, fpChanged?:boolean}}
 */
export function findPeerByCode(id, code) {
  const want = String(code || '').trim().toUpperCase()
  if (!want) return { hit: false }
  const peer = (id.peers || []).find((p) => String(p.pairCode || '').trim().toUpperCase() === want)
  return peer ? { hit: true, peer } : { hit: false }
}

/** 对外可展示的配对状态（不含任何密钥）。 */
export function peerStatus(id) {
  return {
    ok: true,
    self: { ...selfCard(id), pairCode: String(id.pairCode || ''), discoveryPort: DEFAULT_DISCOVERY_PORT },
    peers: (id.peers || []).map((p) => ({
      id: p.id, name: p.name, url: p.url, fp: p.fp, pairCode: p.pairCode || '', pairedAt: p.pairedAt,
      lastSeenAt: p.lastSeenAt || 0, enabled: p.enabled !== false, scopes: p.scopes || ['cards'],
    })),
    pending: (id.pending || []).map((p) => ({
      id: p.id, name: p.name, url: p.url, fp: p.fp, code: p.code,
      ts: p.ts, expiresAt: p.expiresAt, direction: p.direction || 'outgoing',
    })),
  }
}

export function touchPeer(id, peerId, env = process.env) {
  const peers = (id.peers || []).map((p) => (p.id === peerId ? { ...p, lastSeenAt: Date.now() } : p))
  const next = { ...id, peers }
  try { writeIdentity(next, env) } catch { /* 记账失败不影响请求 */ }
  return next
}
