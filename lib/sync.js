// P2 同步核心：事件应用（字段级 HLC）、outbox、pull、digest。
//
// 不依赖 HTTP，纯函数作用于某个 vault root；api.js 的 /sync/* 与 index.js 的
// 后台同步循环都调用这里。云端与本地是同一份代码。
import { createHash } from 'node:crypto'
import { getDb, nextCardId, tableForStatus, MAIN_STATUS } from './db.js'
import { compareHlc } from './hlc.js'
import { contentHash } from './card-hash.js'

const FIELDS = ['title', 'body', 'tags', 'summary', 'source', 'reason', 'kind']
const nowIso = () => new Date().toISOString()

function parse(s, d) { try { const v = JSON.parse(s); return v == null ? d : v } catch { return d } }
function sha(s) { return createHash('sha256').update(String(s)).digest('hex').slice(0, 32) }
function inTx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { try { db.exec('ROLLBACK') } catch { /* 忽略 */ } throw e }
}
function tableInfo(db, t) { return db.prepare('PRAGMA table_info(' + t + ')').all().map((r) => r.name) }
function findRow(db, uid) {
  return db.prepare('SELECT * FROM cards WHERE uid = ?').get(uid)
    || db.prepare('SELECT * FROM quarantine WHERE uid = ?').get(uid)
    || null
}
function tableOf(row) { return row && Object.prototype.hasOwnProperty.call(row, 'quarantined_at') ? 'quarantine' : row ? 'cards' : '' }

/** 复制一行到另一张表（自动按目标列裁剪；id 重新分配，uid 不变）。 */
function moveRow(db, from, to, row, overrides = {}) {
  const cols = tableInfo(db, to).filter((c) => c !== 'id' && Object.prototype.hasOwnProperty.call(row, c))
  const merged = { ...row, ...overrides }
  const sql = 'INSERT INTO ' + to + ' (id, ' + cols.join(',') + ') VALUES (?, ' + cols.map(() => '?').join(',') + ')'
  const newId = nextCardId(db)
  db.prepare(sql).run(newId, ...cols.map((c) => merged[c]))
  db.prepare('DELETE FROM ' + from + ' WHERE uid = ?').run(row.uid)
  return newId
}

function freePath(db, want, uid, kind) {
  const base = String(want || '').trim() || (String(kind) === 'skill' ? '10-Skills/' : '03-Knowledge/') + 'sync-' + String(uid).slice(0, 8) + '.md'
  const taken = (p) => db.prepare('SELECT 1 FROM cards WHERE path = ? UNION ALL SELECT 1 FROM quarantine WHERE path = ?').get(p, p)
  if (!taken(base)) return base
  const dot = base.lastIndexOf('.md')
  const stem = dot > 0 ? base.slice(0, dot) : base
  for (let i = 2; i < 5000; i++) { const c = stem + '-' + i + '.md'; if (!taken(c)) return c }
  return stem + '-' + Date.now() + '.md'
}

/**
 * 应用一个远端事件（幂等由调用方按 device+device_seq 保证）。
 * 字段合并规则：只有 incoming 的字段 HLC 严格大于本地才覆盖（LWW-per-field）。
 */
export function applyEvent(root, ev) {
  const db = getDb(root)
  const uid = String(ev && ev.uid || '')
  if (!uid) return { ok: false, error: 'uid 为空' }
  const op = String(ev.op || '')
  const patch = ev.patch && typeof ev.patch === 'object' ? ev.patch : parse(ev.patch, {})
  const incomingFh = ev.field_hlc && typeof ev.field_hlc === 'object' ? ev.field_hlc : parse(ev.field_hlc || ev.fieldHlc, {})
  const device = String(ev.device || '')
  const now = nowIso()

  return inTx(db, () => {
    const row = findRow(db, uid)
    if (op === 'create') {
      if (row) return mergeInto(db, row, patch, incomingFh, device, now)
      const status = String(patch.status || 'pending')
      const table = tableForStatus(status)
      const kind = String(patch.kind || 'knowledge')
      const body = String(patch.body || patch.text || '')
      const title = String(patch.title || '')
      const tags = Array.isArray(patch.tags) ? patch.tags : parse(patch.tags, [])
      const pathRel = freePath(db, patch.path, uid, kind)
      const id = nextCardId(db)
      db.prepare(`INSERT INTO ${table} (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, content_hash, uid, field_hlc, origin_device)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, pathRel, kind, title, JSON.stringify(tags), body, String(patch.summary || body.slice(0, 200)), status,
        String(patch.source || ''), '', 'info', String(patch.reason || ''), patch.created_at || now, now, null,
        contentHash(title, body), uid, JSON.stringify(incomingFh), device,
      )
      return { ok: true, applied: 'create', uid }
    }
    if (!row) {
      // update/delete 收到未知 uid：按 create 兜底（事件可能先于 create 到达）
      return applyEvent(root, { ...ev, op: 'create', patch: { ...patch, status: patch.status || 'pending' } })
    }
    if (op === 'delete') {
      if (patch.permanent) { db.prepare('DELETE FROM ' + tableOf(row) + ' WHERE uid = ?').run(uid); return { ok: true, applied: 'purge', uid } }
      const src = tableOf(row)
      if (src === 'cards') {
        moveRow(db, 'cards', 'quarantine', row, { status: 'deleted', deleted_at: now, updated_at: now, quarantine_reason: '同步删除', origin_device: device })
      } else {
        db.prepare("UPDATE quarantine SET status = 'deleted', deleted_at = ?, updated_at = ?, origin_device = ? WHERE uid = ?").run(now, now, device, uid)
      }
      return { ok: true, applied: 'delete', uid }
    }
    if (op === 'restore') {
      const want = String(patch.status || MAIN_STATUS)
      const row2 = findRow(db, uid) || row
      if (want === MAIN_STATUS) {
        if (tableOf(row2) === 'quarantine') moveRow(db, 'quarantine', 'cards', row2, { status: MAIN_STATUS, deleted_at: null, updated_at: now, origin_device: device })
        else db.prepare('UPDATE cards SET status = ?, deleted_at = NULL, updated_at = ? WHERE uid = ?').run(MAIN_STATUS, now, uid)
      } else {
        db.prepare('UPDATE quarantine SET status = ?, deleted_at = NULL, updated_at = ? WHERE uid = ?').run(want, now, uid)
      }
      return { ok: true, applied: 'restore', uid }
    }
    // update
    return mergeInto(db, row, patch, incomingFh, device, now)
  })
}

function mergeInto(db, row, patch, incomingFh, device, now) {
  const table = tableOf(row)
  const fh = parse(row.field_hlc, {})
  const sets = {}
  for (const f of FIELDS) {
    if (patch[f] === undefined) continue
    const inc = String(incomingFh[f] || '')
    if (!inc) continue
    const cur = String(fh[f] || '')
    if (cur && compareHlc(inc, cur) <= 0) continue // 旧值不覆盖
    sets[f] = f === 'tags' ? (Array.isArray(patch[f]) ? JSON.stringify(patch[f]) : String(patch[f])) : String(patch[f])
    fh[f] = inc
  }
  if (Object.keys(sets).length) {
    const setSql = Object.keys(sets).map((k) => k + ' = ?').join(', ')
    db.prepare('UPDATE ' + table + ' SET ' + setSql + ', field_hlc = ?, origin_device = ?, updated_at = ? WHERE uid = ?')
      .run(...Object.values(sets), JSON.stringify(fh), device, now, row.uid)
    if (sets.title || sets.body) {
      const t = sets.title !== undefined ? sets.title : row.title
      const b = sets.body !== undefined ? sets.body : row.body
      db.prepare('UPDATE ' + table + ' SET content_hash = ?, summary = ? WHERE uid = ?').run(contentHash(t, b), String(b).slice(0, 200), row.uid)
    }
  }
  // 状态变更（批准/驳回/归档）：搬表，不参与字段 HLC
  if (patch.status && patch.status !== row.status) {
    const want = String(patch.status)
    const current = findRow(db, row.uid) || row
    const from = tableOf(current)
    const to = tableForStatus(want)
    if (from !== to) moveRow(db, from, to, current, { status: want, deleted_at: want === 'deleted' ? now : null, updated_at: now, origin_device: device })
    else db.prepare('UPDATE ' + to + ' SET status = ?, updated_at = ? WHERE uid = ?').run(want, now, row.uid)
  }
  return { ok: true, applied: 'update', uid: row.uid, fields: Object.keys(sets) }
}

/** 服务端/接收端：幂等接收一批事件（按 device+device_seq 去重），应用并分配 server_seq。 */
export function appendRemoteEvents(root, events) {
  const db = getDb(root)
  const list = Array.isArray(events) ? events : []
  let accepted = 0
  let skipped = 0
  const applied = []
  let seq = Number(db.prepare('SELECT COALESCE(MAX(server_seq), 0) n FROM card_events').get().n) || 0
  for (const ev of list) {
    const dev = String(ev.device || '')
    const dseq = Number(ev.device_seq)
    if (dev && Number.isFinite(dseq)) {
      const hit = db.prepare('SELECT id FROM card_events WHERE device = ? AND device_seq = ?').get(dev, dseq)
      if (hit) { skipped++; continue }
    }
    const r = applyEvent(root, ev)
    if (!r.ok) { skipped++; continue }
    seq += 1
    try {
      db.prepare(`INSERT INTO card_events (uid, op, patch, hlc, field_hlc, device, device_seq, server_seq, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(ev.uid), String(ev.op || ''), JSON.stringify(ev.patch || {}), String(ev.hlc || ev.fieldHlc || ''),
        JSON.stringify(ev.field_hlc || {}), dev, Number.isFinite(dseq) ? dseq : null, seq, nowIso(),
      )
    } catch { /* 幂等索引冲突：忽略 */ }
    accepted++
    applied.push(r)
  }
  return { ok: true, accepted, skipped, applied, server_seq: seq }
}

/** 本地 outbox：本设备尚未被服务端确认的事件。 */
export function pendingEvents(root, device, limit = 200) {
  const db = getDb(root)
  const rows = db.prepare(`SELECT id, uid, op, patch, hlc, field_hlc, device, device_seq
    FROM card_events WHERE device = ? AND server_seq IS NULL ORDER BY device_seq LIMIT ?`).all(String(device || ''), Number(limit) || 200)
  return rows.map((r) => ({ ...r, patch: parse(r.patch, {}), field_hlc: parse(r.field_hlc, {}) }))
}

/** 服务端确认后标记已同步（避免重复推送）。 */
export function markEventsSynced(root, ids, serverSeq = null) {
  const db = getDb(root)
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite)
  if (!list.length) return 0
  const upd = db.prepare('UPDATE card_events SET server_seq = COALESCE(server_seq, ?), synced_at = ? WHERE id = ?')
  let n = 0
  db.exec('BEGIN IMMEDIATE')
  try { for (const id of list) n += upd.run(serverSeq == null ? id : serverSeq, nowIso(), id).changes; db.exec('COMMIT') }
  catch (e) { try { db.exec('ROLLBACK') } catch { /* 忽略 */ } throw e }
  return n
}

/** 拉取 since 之后的事件（server_seq 递增）。 */
export function pullEvents(root, since = 0, limit = 500) {
  const db = getDb(root)
  const rows = db.prepare(`SELECT id, uid, op, patch, hlc, field_hlc, device, device_seq, server_seq
    FROM card_events WHERE server_seq IS NOT NULL AND server_seq > ? ORDER BY server_seq LIMIT ?`).all(Number(since) || 0, Math.min(Math.max(Number(limit) || 500, 1), 2000))
  const events = rows.map((r) => ({ ...r, patch: parse(r.patch, {}), field_hlc: parse(r.field_hlc, {}) }))
  return { events, nextSince: events.length ? Number(events[events.length - 1].server_seq) : Number(since) || 0, hasMore: events.length >= Math.min(Math.max(Number(limit) || 500, 1), 2000) }
}

/** 同步摘要：uid + 每字段 HLC + 状态 + 墓碑。两边相等 = 版本集一致。 */
export function digestOf(root) {
  const db = getDb(root)
  const rows = db.prepare(`SELECT uid, field_hlc, status, deleted_at FROM cards
    UNION ALL SELECT uid, field_hlc, status, deleted_at FROM quarantine`).all()
  const lines = rows.map((r) => {
    const fh = parse(r.field_hlc, {})
    const norm = Object.keys(fh).sort().map((k) => k + '=' + String(fh[k] || '')).join(',')
    return String(r.uid) + '|' + sha(norm) + '|' + String(r.status || '') + '|' + String(r.deleted_at || '')
  }).sort()
  return { digest: sha(lines.join('\n')), count: lines.length, cards: rows.length }
}

/** 读写本设备的 pull cursor（存在 config 表，跟库走）。 */
export function readCursor(root, device) {
  try {
    const db = getDb(root)
    const r = db.prepare("SELECT value FROM config WHERE key = ?").get('sync_cursor:' + String(device || ''))
    return r && Number(r.value) > 0 ? Number(r.value) : 0
  } catch { return 0 }
}
export function writeCursor(root, device, seq) {
  try {
    const db = getDb(root)
    db.prepare("INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run('sync_cursor:' + String(device || ''), String(Number(seq) || 0))
    return true
  } catch { return false }
}
