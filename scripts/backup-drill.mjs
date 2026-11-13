#!/usr/bin/env node
/**
 * memory-eternal 定期备份 / 容灾巡检 / 还原演练（零依赖，可脱离 DSH 宿主运行）
 *
 * 为什么单独一个脚本：插件内置的定时备份（index.js ⇒ backupTimer）只在
 * 「DSH 进程活着 且 恰好命中小时代码 3」时才跑，失败只打一行日志、当天不再重试，
 * 而且备份只落在 vault/backups 这一个目录（与主库同盘）——进程不在、磁盘坏、误删
 * 任何一种情况都会把「主库 + 全部备份」一起带走。本脚本补的就是这三块：
 *
 *   1) 每天至少一份，且**校验过**的备份（计划任务每小时兜底一次）
 *   2) 第二副本：镜像到另一块物理盘（daily / weekly / monthly 三层保留）
 *   3) 还原演练：把最新备份复制到临时目录，真跑 integrity_check + 写探针 + FTS + 向量，
 *      证明「这份备份是能还原回来用的」，而不是「文件存在」
 *
 * 用法：
 *   node scripts/backup-drill.mjs                    备份一次（今天已备过则跳过）
 *   node scripts/backup-drill.mjs --force            无条件备份一次
 *   node scripts/backup-drill.mjs --ensure-today     仅当今天还没有成功备份时才做（计划任务高频调用）
 *   node scripts/backup-drill.mjs --drill            备份 + 还原演练
 *   node scripts/backup-drill.mjs --verify-only      只校验现有备份与镜像，不新建
 *   node scripts/backup-drill.mjs --json             机器可读输出
 *
 * 参数：
 *   --vault DIR           vault 目录（默认 $MEMORY_VAULT_DIR 或 ~/.dsh/memory-vault）
 *   --mirror DIR          第二副本目录（默认 <vault 同盘改不了就换盘>：F:\Backups\memory-eternal）
 *   --keep-days N         按天过期：超过 N 天的备份直接清掉（默认 30）
 *   --keep-daily N        每日份数上限（默认 14；与 --keep-days **两条都执行**）
 *   --keep-weekly N       每周归档保留份数（默认 8）
 *   --keep-monthly N      每月归档保留份数（默认 6）
 *   --no-dedupe-today     不清理「同一天的旧备份」（默认清理，只留当天最新的一份）
 *
 * 退出码：0 = 成功或按策略跳过；1 = 任何一步失败（计划任务可见）
 */

import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// ───────────────────────────── 参数 ─────────────────────────────
function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) { a._.push(t); continue }
    const key = t.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { a[key] = true } else { a[key] = next; i++ }
  }
  return a
}
const A = parseArgs(process.argv.slice(2))
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
const flag = (k) => A[k] === true || A[k] === 'true' || A[k] === '1'

const VAULT = path.resolve(String(A.vault || process.env.MEMORY_VAULT_DIR || path.join(os.homedir(), '.dsh', 'memory-vault')))
const DEFAULT_MIRROR = process.platform === 'win32' ? 'F:\\Backups\\memory-eternal' : '/var/backups/memory-eternal'
const MIRROR = path.resolve(String(A.mirror || process.env.MEMORY_BACKUP_MIRROR || DEFAULT_MIRROR))
const KEEP_DAYS = num(A['keep-days'], 30)
const KEEP_DAILY = num(A['keep-daily'], 14)
const KEEP_WEEKLY = num(A['keep-weekly'], 8)
const KEEP_MONTHLY = num(A['keep-monthly'], 6)
const DEDUPE_TODAY = !flag('no-dedupe-today')

const DB_NAME = 'memory-eternal.db'
const SRC_DB = path.join(VAULT, DB_NAME)
const BAK_DIR = path.join(VAULT, 'backups')
const MIRROR_DAILY = path.join(MIRROR, 'daily')
const MIRROR_WEEKLY = path.join(MIRROR, 'weekly')
const MIRROR_MONTHLY = path.join(MIRROR, 'monthly')
const LOG_DIR = path.join(MIRROR, 'logs')
const MANIFEST = path.join(MIRROR, 'manifest.json')

const startedAt = Date.now()
const logLines = []
const out = { ok: false, stage: 'init', at: new Date().toISOString(), vault: VAULT, mirror: MIRROR, actions: [], warnings: [], errors: [] }

function say(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  logLines.push(line)
  if (!flag('json')) console.log(msg)
}
function warn(msg) { out.warnings.push(msg); say('⚠ ' + msg) }
function fail(stage, err) {
  out.ok = false
  out.stage = stage
  const msg = err && err.message ? err.message : String(err)
  out.errors.push({ stage, message: msg })
  say('✗ ' + stage + '：' + msg)
  return out
}

// ───────────────────────────── 工具 ─────────────────────────────
const pad = (n) => String(n).padStart(2, '0')
function stamp(d = new Date()) {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    iso: d.toISOString(),
  }
}
function sha256File(p) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(p, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}
const mb = (n) => +(n / 1048576).toFixed(2)

/** 读一份库的「完整性与内容指纹」。只读打开，绝不写。 */
function inspectDb(file) {
  const r = { file, sizeMB: mb(fs.statSync(file).size), integrity: '', quick: '', journal: '', counts: {}, kinds: [], fts: null, vec: null, error: '' }
  let db
  try { db = new DatabaseSync(file, { readOnly: true }) } catch (e) { r.error = String(e.message || e); return r }
  try {
    r.integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check || '')
    r.quick = String(db.prepare('PRAGMA quick_check').get().quick_check || '')
    try { r.journal = String(db.prepare('PRAGMA journal_mode').get().journal_mode || '') } catch {}
    for (const t of ['cards', 'card_updates', 'feedback', 'ledger', 'audit_log', 'quarantine', 'card_vec', 'cards_fts']) {
      try { r.counts[t] = Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n) } catch { r.counts[t] = null }
    }
    try { r.kinds = db.prepare('SELECT kind, count(*) AS n FROM cards GROUP BY kind ORDER BY n DESC').all().map(x => `${x.kind}:${x.n}`) } catch {}
    try { r.fts = Number(db.prepare("SELECT count(*) AS n FROM cards_fts WHERE cards_fts MATCH 'memory'").get().n) } catch { r.fts = null }
    try { r.vec = Number(db.prepare('SELECT count(*) AS n FROM card_vec').get().n) } catch { r.vec = null }
  } catch (e) {
    r.error = String(e.message || e)
  } finally { try { db.close() } catch {} }
  return r
}

/**
 * 把备份文件归一成「自包含单文件」：backup API 会原样复制源库的 journal_mode=wal 头部，
 * 于是备份旁边会留下 -wal/-shm。还原时只搬 .db，旁边多两个文件既容易误判，也会让人
 * 以为备份「不完整」。这里主动 checkpoint 回 rollback journal 模式再把残件删掉。
 */
function normalizeBackup(file) {
  let db
  try {
    db = new DatabaseSync(file)
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
    db.exec('PRAGMA journal_mode=DELETE')
  } catch (e) {
    warn('归一备份格式失败（不影响可用性）：' + (e.message || e))
  } finally { try { db && db.close() } catch {} }
  for (const suffix of ['-wal', '-shm']) {
    const f = file + suffix
    try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {}
  }
}

function listBackups(dir = BAK_DIR) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => /^memory-eternal-.*\.db$/.test(f))
    .map(f => path.join(dir, f))
    .sort((x, y) => path.basename(y).localeCompare(path.basename(x))) // 新 → 旧
}

/** 主库比「今天已生成的备份」新到什么程度就该重备：大量新卡片（批量导入）或放了大半天。 */
const STALE_CARD_DELTA = 200
const STALE_AGE_MS = 6 * 60 * 60 * 1000

function todayOk() {
  const { date } = stamp()
  const hit = listBackups().filter(p => path.basename(p).startsWith(`memory-eternal-${date}`))
  if (!hit.length) return null
  const live = inspectDb(SRC_DB)
  const liveCards = live.counts.cards || 0
  for (const p of hit) {
    const i = inspectDb(p)
    if (i.integrity !== 'ok' || !((i.counts.cards || 0) > 0)) continue
    // 今天这份备份「已经不代表现状」的两种情形：卡片暴增（批量导入/大量沉淀）、或者隔了大半天。
    // 早先只按「当天有没有文件」判断，导致导入 4000+ 张卡之后当天不会再备一次。
    const grew = liveCards - (i.counts.cards || 0) >= STALE_CARD_DELTA
    const aged = Date.now() - fs.statSync(p).mtimeMs >= STALE_AGE_MS
    if (grew || aged) {
      say(`今天已有备份但已过时（备份 ${i.counts.cards} 张 → 主库 ${liveCards} 张${aged ? ' · 距今超 6 小时' : ''}），重备一份`)
      return null
    }
    return { path: p, info: i }
  }
  return null
}

// ───────────────────────────── 备份 ─────────────────────────────
async function doBackup() {
  if (!fs.existsSync(SRC_DB)) throw new Error('主库不存在：' + SRC_DB)
  fs.mkdirSync(BAK_DIR, { recursive: true })
  const s = stamp()
  const target = path.join(BAK_DIR, `memory-eternal-${s.date}_${s.time}.db`)

  const before = inspectDb(SRC_DB)
  out.source = { path: SRC_DB, sizeMB: before.sizeMB, integrity: before.integrity, counts: before.counts }

  // 在线热备（node:sqlite backup API）：页级一致快照，不阻塞正在写入的 DSH / web 进程
  let db
  try {
    db = new DatabaseSync(SRC_DB)
    await sqliteBackup(db, target)
  } finally { try { db && db.close() } catch {} }
  normalizeBackup(target)
  say(`已备份 → ${target}（${mb(fs.statSync(target).size)} MB）`)

  // 备份后立刻自校验：能打开 + 两种 check 通过 + 卡片数对得上（允许主库在备份期间继续写入）
  const info = inspectDb(target)
  info.sha256 = sha256File(target)
  const liveCards = inspectDb(SRC_DB).counts.cards || 0
  const bakCards = info.counts.cards || 0
  const okIntegrity = info.integrity === 'ok' && info.quick === 'ok'
  const okCards = bakCards > 0 && bakCards >= liveCards - 50
  out.backup = { path: target, sizeMB: info.sizeMB, sha256: info.sha256, integrity: info.integrity, quick: info.quick, cards: bakCards, liveCards, kinds: info.kinds, fts: info.fts, vec: info.vec, ok: okIntegrity && okCards }
  if (!okIntegrity) throw new Error(`备份自校验失败：integrity=${info.integrity} quick=${info.quick} ${info.error || ''}`)
  if (!okCards) throw new Error(`备份卡片数异常：备份 ${bakCards} / 主库 ${liveCards}`)
  if (bakCards !== liveCards) warn(`备份与主库卡片数差 ${liveCards - bakCards}（备份期间有写入，属正常）`)
  out.actions.push('backup')

  // 同一天只留最新一份（插件内置 timer 在同一小时重启时会重复备份，旧逻辑会把保留窗口挤掉）
  if (DEDUPE_TODAY) {
    const sameDay = listBackups().filter(p => path.basename(p).startsWith(`memory-eternal-${s.date}`) && p !== target)
    for (const p of sameDay) {
      try { fs.unlinkSync(p); say(`清理同日重复备份：${path.basename(p)}`); out.actions.push('dedupe') } catch (e) { warn('删除失败 ' + p + '：' + (e.message || e)) }
    }
  }
  return target
}

// ───────────────────────────── 第二副本 ─────────────────────────────
function mirrorCopy(latest) {
  fs.mkdirSync(MIRROR_DAILY, { recursive: true })
  const base = path.basename(latest)
  const dailyName = `memory-eternal-${base.slice('memory-eternal-'.length, 'memory-eternal-'.length + 10)}.db`
  const dest = path.join(MIRROR_DAILY, dailyName)
  if (!fs.existsSync(dest) || sha256File(dest) !== sha256File(latest)) {
    fs.copyFileSync(latest, dest + '.tmp')
    fs.renameSync(dest + '.tmp', dest)
    say(`镜像 → ${dest}`)
    out.actions.push('mirror')
  } else {
    say(`镜像已是最新：${dest}`)
  }
  for (const suffix of ['-wal', '-shm']) {
    const f = dest + suffix
    try { if (fs.existsSync(f) && fs.statSync(f).size === 0) fs.unlinkSync(f) } catch {}
  }
  const info = inspectDb(dest)
  if (info.integrity !== 'ok') throw new Error('镜像副本校验失败：' + dest)
  return dest
}

/** 同盘优先用硬链接（归档文件只读，省几十 MB 重复占用）；跨卷或不支持时回退复制 */
function archiveFile(src, dst) {
  const s = fs.statSync(src)
  if (fs.existsSync(dst)) {
    const d = fs.statSync(dst)
    // 内容口径：大小 + mtime 都没变才算同一份（daily 当天被新备份替换时 mtime 会变）
    if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 1000) return false
    try { fs.unlinkSync(dst) } catch {}
  }
  try {
    fs.linkSync(src, dst)
  } catch {
    fs.copyFileSync(src, dst)
  }
  return true
}

function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${pad(wk)}`
}

/** 备份文件名里的日期（YYYY-MM-DD）；认不出返回 ''。 */
function dayOf(name) {
  const m = /^memory-eternal-(\d{4}-\d{2}-\d{2})/.exec(String(name || ''))
  return m ? m[1] : ''
}

/**
 * 按天过期：删掉落在 keepDays 窗口之外的备份（当天算第 1 天）。
 *
 * 为什么必须与「份数上限」并存：份数上限只能防「太多」，防不住「太老」——
 * 备份目录里被别的工具塞进来 20 份都是半年前的，份数上限一份都不会删。
 * 认不出日期的文件名一律不删（宁可留着，也不猜）。
 */
function expireByDays(dir, keepDays) {
  if (!(keepDays > 0) || !fs.existsSync(dir)) return 0
  const cut = new Date()
  cut.setHours(0, 0, 0, 0)
  cut.setDate(cut.getDate() - (keepDays - 1))
  const cutKey = `${cut.getFullYear()}-${pad(cut.getMonth() + 1)}-${pad(cut.getDate())}`
  let n = 0
  for (const f of fs.readdirSync(dir)) {
    if (!/^memory-eternal-.*\.db$/.test(f)) continue
    const day = dayOf(f)
    if (!day || day >= cutKey) continue
    try { fs.unlinkSync(path.join(dir, f)); n++; out.actions.push('expire') } catch (e) { warn('过期清理失败 ' + f + '：' + (e.message || e)) }
  }
  return n
}

/** 从 mirror/daily 重建 weekly / monthly 归档（幂等），再按保留份数裁剪 */
function rotate() {
  // ① 按天过期先跑：只备份在 vault/backups、没有任何镜像的用户同样需要过期清理，
  //    因此它**不能**放在「daily 为空就 return」之后。
  let expired = expireByDays(BAK_DIR, KEEP_DAYS)
  const daily = fs.existsSync(MIRROR_DAILY)
    ? fs.readdirSync(MIRROR_DAILY).filter(f => /^memory-eternal-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
    : []
  if (!daily.length) {
    out.retention = { days: KEEP_DAYS, daily: KEEP_DAILY, weekly: KEEP_WEEKLY, monthly: KEEP_MONTHLY, expired, vault: listBackups().length }
    return
  }
  fs.mkdirSync(MIRROR_WEEKLY, { recursive: true })
  fs.mkdirSync(MIRROR_MONTHLY, { recursive: true })

  // 每周保留当周最后一天
  const byWeek = new Map()
  const byMonth = new Map()
  for (const f of daily) {
    const d = f.slice('memory-eternal-'.length, 'memory-eternal-'.length + 10)
    byWeek.set(isoWeekKey(d), d)
    byMonth.set(d.slice(0, 7), d)
  }
  const keepWeekly = [...byWeek.values()].sort().slice(-KEEP_WEEKLY)
  const keepMonthly = [...byMonth.values()].sort().slice(-KEEP_MONTHLY)

  for (const d of keepWeekly) {
    const src = path.join(MIRROR_DAILY, `memory-eternal-${d}.db`)
    if (fs.existsSync(src) && archiveFile(src, path.join(MIRROR_WEEKLY, `memory-eternal-${d}.db`))) out.actions.push('weekly')
  }
  for (const d of keepMonthly) {
    const src = path.join(MIRROR_DAILY, `memory-eternal-${d}.db`)
    if (fs.existsSync(src) && archiveFile(src, path.join(MIRROR_MONTHLY, `memory-eternal-${d}.db`))) out.actions.push('monthly')
  }
  // 裁剪：daily 按日期保留最近 N 天；weekly / monthly 按各自上限
  // 先按「天数过期」（keep-days），再按「份数上限」（keep-daily）—— 两条都执行。
  expired += expireByDays(MIRROR_DAILY, KEEP_DAYS)
  const trim = (dir, keep) => {
    if (!fs.existsSync(dir)) return
    const files = fs.readdirSync(dir).filter(f => /^memory-eternal-.*\.db$/.test(f)).sort().reverse()
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, f)); out.actions.push('trim') } catch {}
    }
  }
  trim(MIRROR_DAILY, KEEP_DAILY)
  trim(MIRROR_WEEKLY, KEEP_WEEKLY)
  trim(MIRROR_MONTHLY, KEEP_MONTHLY)

  // vault/backups 内部：按「每天只留最新一份」去重（历史遗留的同日双份就是 7 份窗口只覆盖 6 天的根因），
  // 再按 KEEP_DAILY 裁剪。
  const byDay = new Map()
  for (const p of listBackups()) {
    const name = path.basename(p)
    const day = name.slice('memory-eternal-'.length, 'memory-eternal-'.length + 10)
    if (!byDay.has(day)) byDay.set(day, p) // listBackups 已按新→旧排序，首次出现即当天最新
    else { try { fs.unlinkSync(p); out.actions.push('dedupe-day') } catch {} }
  }
  const kept = listBackups()
  for (const p of kept.slice(KEEP_DAILY)) {
    try { fs.unlinkSync(p); out.actions.push('trim-vault') } catch {}
  }
  out.retention = { days: KEEP_DAYS, daily: KEEP_DAILY, weekly: KEEP_WEEKLY, monthly: KEEP_MONTHLY, expired, vault: Math.min(kept.length, KEEP_DAILY) }
}

// ───────────────────────────── 还原演练 ─────────────────────────────
function drill(latest) {
  const t0 = Date.now()
  const dir = path.join(os.tmpdir(), `me-drill-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  const copy = path.join(dir, DB_NAME)
  fs.copyFileSync(latest, copy)
  const r = { from: latest, copy, pass: false, steps: {}, ms: 0 }
  let db
  try {
    db = new DatabaseSync(copy) // 可写：还原后的宿主就是这么打开的
    r.steps.integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check)
    r.steps.quick = String(db.prepare('PRAGMA quick_check').get().quick_check)
    try {
      db.exec('CREATE TABLE IF NOT EXISTS _me_write_probe(x INTEGER)')
      db.exec('DROP TABLE IF EXISTS _me_write_probe')
      r.steps.writable = true
    } catch (e) { r.steps.writable = false; r.steps.writeError = String(e.message || e) }
    r.steps.cards = Number(db.prepare('SELECT count(*) AS n FROM cards').get().n)
    r.steps.emptyBodies = Number(db.prepare("SELECT count(*) AS n FROM cards WHERE body IS NULL OR trim(body)=''").get().n)
    try { r.steps.ftsHits = Number(db.prepare("SELECT count(*) AS n FROM cards_fts WHERE cards_fts MATCH 'memory'").get().n) } catch (e) { r.steps.ftsHits = null; r.steps.ftsError = String(e.message || e) }
    try { r.steps.vecRows = Number(db.prepare('SELECT count(*) AS n FROM card_vec').get().n) } catch { r.steps.vecRows = null }
    try {
      r.steps.sampleSkill = db.prepare("SELECT title, length(body) AS L FROM cards WHERE kind='skill' ORDER BY updated_at DESC LIMIT 1").get() || null
    } catch { r.steps.sampleSkill = null }
    r.steps.newest = String(db.prepare('SELECT max(updated_at) AS m FROM cards').get().m || '')
  } catch (e) {
    r.steps.error = String(e.message || e)
  } finally { try { db && db.close() } catch {} }

  r.pass = r.steps.integrity === 'ok' && r.steps.quick === 'ok' && r.steps.writable === true && (r.steps.cards || 0) > 0 && r.steps.emptyBodies === 0
  r.ms = Date.now() - t0
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  out.drill = r
  out.actions.push(r.pass ? 'drill-pass' : 'drill-fail')
  if (r.pass) say(`还原演练通过：${r.steps.cards} 张卡 · FTS ${r.steps.ftsHits} 命中 · 向量 ${r.steps.vecRows} · 可写 · ${r.ms}ms`)
  else say('✗ 还原演练失败：' + JSON.stringify(r.steps))
  return r.pass
}

// ───────────────────────────── manifest / 日志 ─────────────────────────────
function saveManifest() {
  fs.mkdirSync(MIRROR, { recursive: true })
  let m = { version: 1, vault: VAULT, mirror: MIRROR, runs: [], lastSuccessAt: '', lastDrillAt: '', lastDrillPass: null, failures: [] }
  try { m = { ...m, ...JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } } catch {}
  out.ok = out.errors.length === 0
  out.ms = Date.now() - startedAt
  m.vault = VAULT
  m.mirror = MIRROR
  m.runs = [...(m.runs || []), out].slice(-200)
  if (out.ok) { m.lastSuccessAt = out.at } else { m.failures = [...(m.failures || []), { at: out.at, stage: out.stage, errors: out.errors }].slice(-50) }
  if (out.drill) { m.lastDrillAt = out.at; m.lastDrillPass = out.drill.pass }
  try { fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1), 'utf8') } catch (e) { warn('manifest 写入失败：' + (e.message || e)) }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const lf = path.join(LOG_DIR, `backup-${out.at.slice(0, 7)}.log`)
    fs.appendFileSync(lf, logLines.join('\n') + '\n')
    out.log = lf
  } catch {}
}

// ───────────────────────────── 主流程 ─────────────────────────────
async function main() {
  say(`vault=${VAULT}`)
  say(`mirror=${MIRROR}`)

  if (flag('verify-only')) {
    out.stage = 'verify'
    const list = listBackups()
    out.verify = list.slice(0, 30).map(p => { const i = inspectDb(p); return { file: path.basename(p), sizeMB: i.sizeMB, integrity: i.integrity, quick: i.quick, cards: i.counts.cards, sha256: sha256File(p), ok: i.integrity === 'ok' && i.quick === 'ok' } })
    const bad = out.verify.filter(v => !v.ok)
    if (bad.length) throw new Error(`${bad.length} 份备份校验失败：` + bad.map(b => b.file).join(', '))
    const dailies = fs.existsSync(MIRROR_DAILY) ? fs.readdirSync(MIRROR_DAILY).filter(f => f.endsWith('.db')) : []
    out.verifyMirror = { dir: MIRROR_DAILY, files: dailies.length }
    say(`校验完成：vault 备份 ${list.length} 份，镜像 ${dailies.length} 份，全部通过`)
    return
  }

  if (flag('ensure-today') || (!flag('force') && !flag('drill'))) {
    const hit = todayOk()
    if (hit) {
      out.stage = 'skip'
      out.skipped = { reason: '今天已有可用备份', path: hit.path, cards: hit.info.counts.cards }
      say(`跳过：今天已有可用备份 ${path.basename(hit.path)}（${hit.info.counts.cards} 张卡）`)
      // 仍然保证镜像与保留策略在跑（幂等、很便宜）
      mirrorCopy(hit.path)
      rotate()
      // 带了 --drill 就**复用当天这份**做还原演练：计划任务在 03:00–04:00 窗口里
      // 只需要一份备份，演练不该再逼着做第二份（否则窗口内会连备两次）。
      if (flag('drill')) {
        out.stage = 'drill'
        // drill() 返回布尔（内部已把详情写进 out.drill），不要用返回值当对象
        const ok = drill(hit.path)
        if (!ok) {
          say('演练失败', true)
          process.exitCode = 1
          return
        }
        out.stage = 'done'
        say(`演练通过（复用 ${path.basename(hit.path)}）`)
      }
      return
    }
  }

  out.stage = 'backup'
  const latest = await doBackup()
  out.stage = 'mirror'
  const mirrored = mirrorCopy(latest)
  out.mirrored = mirrored
  out.stage = 'rotate'
  rotate()
  out.stage = 'drill'
  if (flag('drill')) {
    const pass = drill(latest)
    // drill() 返回布尔（详情已在 out.drill 里）；不要对象判真值，也不要用 .pass
    if (!pass) throw new Error('还原演练未通过')
  }
  out.stage = 'done'
}

try {
  await main()
  out.ok = out.errors.length === 0
} catch (e) {
  fail(out.stage, e)
} finally {
  saveManifest()
  if (flag('json')) console.log(JSON.stringify(out, null, 1))
  else say(out.ok ? `完成（${out.ms}ms）` : `失败（${out.ms}ms）`)
}
process.exit(out.ok ? 0 : 1)
