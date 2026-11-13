// 记忆核心 · 灾难自动还原（disaster auto-restore）
//
// 为什么要有这个文件：`restoreFromBackup` 是一把**主动的人肉手术刀**（它自己就要求
// 「当前库完好时必须显式 force」），而真实事故里没人会坐在那儿等你去敲 `doctor --restore`：
// WAL 头一坏，宿主/独立 web/看门狗三个常驻进程会各自把「库不可用」当普通故障处理，
// 一路静默降级 —— 用户看到的只是「卡片全没了」。这里补的就是那条自动化路径：
// **探测到库坏了 → 挑一份当场能打开、quick_check 通过、卡片数说得过去的备份 → 重建**。
//
// 四条硬约束（和 restoreFromBackup 一脉相承，宁可什么都不做也不破坏现场）：
//   1. **只认「结构性损坏」**：错误信息必须命中 malformed / not a database / corrupt 一类特征，
//      才认为「库真的坏了」。`database is locked`、权限不足、盘符只读这类**临时/环境**问题
//      自动还原只会把好数据换掉，一律不碰（返回 unhealthy，交给人处理）。
//   2. **备份也当场验**：`probeDbFile` 不通过的备份直接跳过，绝不拿它覆盖现场。
//   3. **绝不删证据**：现场的 .db / -wal / -shm 由 restoreFromBackup 改名成
//      `*.corrupt-<时间戳>` 留证；本模块**从头到尾不删任何文件**。
//   4. **全过程留痕**：`audit_log` 一条（还原后库才可写，所以写在**还原之后**）+ 一行
//      console.error 摘要（常驻进程的 stderr 就是运维唯一看得到的地方）。
//
// 接线三处（都只在启动 / 探测到异常时才真正读盘）：
//   · index.js      插件激活时（DSH 宿主进程）
//   · lib/web.js    startWebServer() 启动时（常驻 web 进程）
//   · lib/watchdog.js tick 里（60s 冷却 + 仅在 /overview 掉线时才查，避免每 5s 读盘）

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { DB_FILE, probeDbFile, restoreFromBackup, listBackupFiles, getDb } from './db.js'

/** 结构性损坏的特征串（错误信息命中它才允许自动还原）。 */
export const CORRUPT_RE = /malformed|not a database|corrupt|disk image|quick_check/i

/** 还原后写一条审计用的 new_status（audit_log.new_status 是自由文本，这里用它区分「自动还原」）。 */
const AUDIT_STATUS = 'db-restored'

/**
 * 读配置（`backupAutoRestore` 等）。
 *
 * 为什么读共享配置文件而不是 getSettings：`ensureHealthy` 要被**三个不同进程**调用，
 * 其中独立 web 与看门狗都没有 DSH 的 settings 服务。宿主每次保存配置都会把它全量写到
 * `$DSH_HOME/memory-eternal-config.json`（见 index.js 的 syncConfigFile），三方读同一份即可。
 * 读不到就按默认值（自动还原**开**）—— 默认值必须让「什么都不配」的用户也能被救回来。
 */
export function readDisasterConfig(env = process.env) {
  let raw = {}
  try {
    const home = String((env && env.DSH_HOME) || '').trim() || path.join(String((env && (env.USERPROFILE || env.HOME)) || ''), '.dsh')
    raw = JSON.parse(readFileSync(path.join(home, 'memory-eternal-config.json'), 'utf8')) || {}
  } catch { raw = {} }
  return {
    // 未配置 = 开（容灾是默认行为）；显式 false 才关
    autoRestore: raw.backupAutoRestore !== false,
    enabled: raw.backupEnabled !== false,
  }
}

/** 在 `<root>/backups` 里从新到旧找**第一份当场可用的**备份。 */
export async function findUsableBackup(root) {
  const list = await listBackupFiles(root)
  for (const item of list) {
    const probe = probeDbFile(item.path)
    if (probe.ok) return { ...item, cards: probe.cards }
  }
  return null
}

/** 写一条审计（库可能还是坏的 → 失败只吞掉，绝不因为审计失败而回滚还原结果）。 */
function audit(root, { file = '', reason = '', cards = -1 } = {}) {
  try {
    const db = getDb(root)
    db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)')
      .run('backups/' + (file || '-'), null, AUDIT_STATUS, 'auto-restore', String(reason || `自动还原：恢复 ${cards} 张卡`))
    return true
  } catch { return false }
}

/** 一行摘要（常驻进程 stderr，是运维唯一能"事后看到"的地方）。 */
function say(line) {
  try { console.error('[memory-eternal] auto-restore: ' + line) } catch { /* stderr 不可用就算了 */ }
}

// 同进程内的并发闸门：宿主 + web 可能在同一进程里都调一次，别做两遍手术。
let inflight = null

/**
 * 确保 `<root>` 下的记忆库是**可用的**；坏了就用最新可用备份重建。
 *
 * @param {string} root vault 目录
 * @param {{env?:NodeJS.ProcessEnv, force?:boolean}} [opts]
 *   force=true 时即使错误信息不像结构性损坏也尝试还原（人工兜底用，默认 false）
 * @returns {Promise<{ok:boolean, action:'no-db'|'none'|'restored'|'no-backup'|'disabled'|'unhealthy'|'restore-failed',
 *   cards?:number, from?:string, movedAside?:string[], error?:string, note?:string}>}
 */
export async function ensureHealthy(root, { env = process.env, force = false } = {}) {
  const dir = path.resolve(root || '.')
  // 同一个库同时只做一轮（并发调用共享结果，见上）
  if (inflight && inflight.root === dir) return inflight.promise
  const promise = ensureHealthyNow(dir, { env, force }).finally(() => { if (inflight && inflight.promise === promise) inflight = null })
  inflight = { root: dir, promise }
  return promise
}

async function ensureHealthyNow(dir, { env, force }) {
  const dbPath = path.join(dir, DB_FILE)
  if (!existsSync(dbPath)) return { ok: false, action: 'no-db' }

  // ① 当场探（不复用 dbStatus 的缓存结论：文件可能在它之后才被写坏）
  const probe = probeDbFile(dbPath)
  if (probe.ok) return { ok: true, action: 'none', cards: probe.cards }

  const corrupt = CORRUPT_RE.test(String(probe.error || ''))
  if (!corrupt && !force) {
    // 临时/环境类问题（锁定、权限、只读盘）：自动还原会把好数据换掉，坚决不碰
    say(`库当前不可用但不是结构性损坏（${probe.error || '未知原因'}），不做自动还原 —— 交给人排查权限/占用`)
    return { ok: false, action: 'unhealthy', error: probe.error || '' }
  }

  // ② 开关：显式关闭就什么都不做（连备份都不读）
  const cfg = readDisasterConfig(env)
  if (!cfg.autoRestore) {
    say(`库已损坏（${probe.error || '未知原因'}），但 backupAutoRestore=false → 不自动还原`)
    return { ok: false, action: 'disabled', error: probe.error || '' }
  }

  // ③ 从新到旧找第一份**当场可用**的备份
  const usable = await findUsableBackup(dir)
  if (!usable) {
    say(`库已损坏（${probe.error || '未知原因'}），但 ${path.join(dir, 'backups')} 里没有一份可用备份 → 保持现场不动`)
    return { ok: false, action: 'no-backup', error: probe.error || '' }
  }

  // ④ 重建（force=true：当前库已经坏了，不需要"防手滑"那道确认）
  const out = await restoreFromBackup(dir, { from: usable.path, force: true })
  const movedAside = Array.isArray(out.movedAside) ? out.movedAside : []
  if (!out.ok) {
    say(`自动还原失败（备份 ${usable.name}，现场已留证 ${movedAside.length} 项）：${out.error || '未知原因'}`)
    audit(dir, { file: usable.name, reason: `自动还原失败：${out.error || '未知原因'}（现场留证 ${movedAside.length} 项）`, cards: -1 })
    return { ok: false, action: 'restore-failed', from: usable.path, movedAside, error: out.error || '' }
  }

  // ⑤ 留痕（顺序有意：库可写了才写审计）+ 一行摘要
  const cards = Number.isFinite(Number(out.cards)) ? Number(out.cards) : -1
  const auditOk = audit(dir, {
    file: usable.name,
    reason: `库损坏（${probe.error || '未知原因'}）→ 用备份 ${usable.name} 重建；现场留证 ${movedAside.length} 项；恢复 ${cards} 张卡`,
    cards,
  })
  say(`已用备份重建：${usable.name}（${cards} 张卡）；现场留证 ${movedAside.length} 项；审计${auditOk ? '已记录' : '未写入（库不可写）'}`)
  return {
    ok: true,
    action: 'restored',
    from: usable.path,
    cards,
    movedAside,
    error: '',
    note: '原现场已改名 *.corrupt-<时间戳> 留证（未删除任何文件）',
  }
}
