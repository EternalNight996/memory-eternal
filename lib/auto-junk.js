// 定时自动体检：把「垃圾清理」从"想起来才点"变成"每天自己跑一遍"。
//
// 设计上有一条不可越过的红线：**只归档，绝不删除**。
//   · 归档是可逆的（/cards/bulk action=restore 全部恢复）
//   · 删除不可逆（回收站 30 天后清空）
// 自动流程不该拥有不可逆的权力 —— 宁可放过一批垃圾，也不能自动删掉用户的东西。
//
// 另外三道闸：
//   · 默认**关闭**（junkAutoEnabled），用户明确开启才跑
//   · 单次上限（默认 200 张），避免第一次开启时一口气归档几千张
//   · 每次动作写 audit_log，可追溯、可回溯恢复
//
// 调度交给调用方（lib/web.js 每小时检查一次是否到了周期），这里只做"跑一遍"。

import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './db.js'
import { scanJunk } from './junk.js'
import { setCardStatus } from './vault.js'

/** 自动体检的状态文件名（与库同目录）。 */
const STATE_FILE = '.junk-auto-state.json'

/** 只允许自动归档的类别 —— 删除永远不自动做。 */
export const AUTO_ARCHIVE_REASONS = ['neverRecalled', 'stale']

/** 默认参数。 */
export const AUTO_DEFAULTS = {
  enabled: false,
  intervalHours: 24,
  maxPerRun: 200,
  neverRecalledDays: 90,
  staleDays: 180,
}

function statePath(root) {
  return path.join(root, STATE_FILE)
}

/** 读调度状态（上次跑的时间与结果）。 */
export function readAutoState(root) {
  try {
    return JSON.parse(fs.readFileSync(statePath(root), 'utf8'))
  } catch {
    return { lastRunAt: 0, lastReport: null }
  }
}

function writeAutoState(root, state) {
  try {
    fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch { /* 写不了就算了，下次重来 */ }
}

/** 从插件设置里读自动体检参数（缺省即关闭）。 */
export function autoConfigFrom(settings = {}) {
  const s = settings || {}
  const num = (v, d) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n > 0 ? n : d
  }
  return {
    enabled: s.junkAutoEnabled === true,
    intervalHours: num(s.junkAutoIntervalHours, AUTO_DEFAULTS.intervalHours),
    maxPerRun: Math.min(num(s.junkAutoMaxPerRun, AUTO_DEFAULTS.maxPerRun), 2000),
    neverRecalledDays: num(s.junkAutoNeverRecalledDays, AUTO_DEFAULTS.neverRecalledDays),
    staleDays: num(s.junkAutoStaleDays, AUTO_DEFAULTS.staleDays),
  }
}

/** 到点了吗？（供调度器判断，避免每次都真跑） */
export function autoJunkDue(root, cfg, now = Date.now()) {
  if (!cfg || !cfg.enabled) return { due: false, reason: 'disabled' }
  const st = readAutoState(root)
  const last = Number(st.lastRunAt) || 0
  if (!last) return { due: true, reason: 'never-ran' }
  const next = last + Math.max(1, cfg.intervalHours) * 3600000
  if (now < next) return { due: false, reason: 'not-due', nextAt: next, lastAt: last }
  return { due: true, reason: 'due', nextAt: next, lastAt: last }
}

/**
 * 跑一次自动体检：扫描 → 只归档「从未召回 / 长期未更新」→ 写审计日志。
 *
 * @param {string} root 库根
 * @param {{enabled?:boolean, maxPerRun?:number, neverRecalledDays?:number, staleDays?:number, dryRun?:boolean}} cfg
 * @returns {{ok:boolean, scanned:object, archived:number, skipped:number, dryRun:boolean, paths:string[], error?:string}}
 */
export async function runAutoJunk(root, cfg = {}) {
  const c = { ...AUTO_DEFAULTS, ...cfg }
  const maxPerRun = Math.min(Number(c.maxPerRun) > 0 ? Number(c.maxPerRun) : AUTO_DEFAULTS.maxPerRun, 2000)
  const dryRun = c.dryRun !== false // 默认预演

  const scan = scanJunk(root, {
    neverRecalledDays: c.neverRecalledDays,
    staleDays: c.staleDays,
    limit: 5000,
  })

  // 只挑「可以自动归档」的类别；duplicate/tooShort/quarantineStale 一律不碰
  const pool = (scan.candidates || []).filter(
    (x) => AUTO_ARCHIVE_REASONS.includes(x.reason) && (x.suggestion === 'archive' || x.reason === 'neverRecalled'),
  )
  const take = pool.slice(0, maxPerRun)
  const paths = take.map((x) => x.path).filter(Boolean)

  const result = {
    ok: true,
    dryRun,
    scanned: scan.summary,
    candidates: pool.length,
    archived: 0,
    skipped: 0,
    paths: [],
    error: null,
  }

  if (!paths.length) {
    if (!dryRun) writeAutoState(root, { lastRunAt: Date.now(), lastReport: { ...result, paths: [] } })
    return result
  }

  if (dryRun) {
    result.paths = paths
    return result
  }

  // 真归档：失败逐条记，不影响其余。
  // **不要在外面包 BEGIN**：setCardStatus 内部的 moveCardBetweenStores 自己开事务，
  // 嵌套会直接抛错（实测：真跑 archived=0 / skipped=N，全被 catch 吞掉）。
  // 逐条独立提交反而更稳 —— 一条失败不连累其他。
  const db = getDb(root)
  for (const p of paths) {
    try {
      const r = await setCardStatus(root, p, 'archived', { changedBy: 'auto-junk', reason: '自动体检：长期未使用' })
      if (r && r.ok) {
        result.archived++
        result.paths.push(p)
        // 手动补一条更明确的审计记录（setCardStatus 已经写了一条，这条标出是自动跑的）
        try {
          db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)')
            .run(p, 'approved', 'archived', 'auto-junk', '定时自动归档（可在归档管理里全部恢复）')
        } catch { /* 忽略 */ }
      } else {
        result.skipped++
      }
    } catch {
      result.skipped++
    }
  }

  const state = { lastRunAt: Date.now(), lastReport: { ...result, paths: result.paths.slice(0, 50) } }
  writeAutoState(root, state)
  return result
}

/**
 * 调度入口：到点就跑一次（供 lib/web.js 的定时器调用）。
 * @returns {{ran:boolean, reason:string, result?:object}}
 */
export async function tickAutoJunk(root, settings, now = Date.now()) {
  const cfg = autoConfigFrom(settings)
  const due = autoJunkDue(root, cfg, now)
  if (!due.due) return { ran: false, reason: due.reason }
  try {
    const result = await runAutoJunk(root, { ...cfg, dryRun: false })
    return { ran: true, reason: due.reason, result }
  } catch (e) {
    return { ran: false, reason: 'error: ' + String((e && e.message) || e) }
  }
}
