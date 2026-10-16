// 「常驻实例不可替换」这个**长期状态**的记忆（issue #30 第五轮复测：A: 盘那台的稳态）。
//
// 现场（报告者实测 5 天 44 次）：
//   升级 → 端口上那个常驻实例仍是上一代 → 宿主探测到"漂移" → 拉起 --replace 助手
//   → 助手前置探到 lock.writable = false → **正确地拒绝**（宁可拒绝也不留孤儿）
//   → 旧实例继续存活 → 下次开机再报一次…… 于是「每一步都按设计工作，合起来永远换不掉」。
//
// 所以：**环境限制要当成状态记下来**，而不是每次都当"漂移"重试一遍。记下之后：
//   · 面板 / align / version-check 能显示「常驻实例不可替换（环境限制）」并给出路；
//   · 宿主不再每次开机都重试注定失败的替换（首次 warn，之后降级为 boot 级别的一条已知状态）。
import fs from 'node:fs'
import path from 'node:path'
import { watchdogLockPath } from './watchdog.js'

/** 状态文件与看门狗锁同目录（同一个 DSH_HOME）。 */
export function residentStatePath(env = process.env) {
  return path.join(path.dirname(watchdogLockPath(env)), 'memory-eternal-state.json')
}

/** 读状态：不存在/损坏都返回 {}（绝不影响主流程）。 */
export function readResidentState(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(residentStatePath(env), 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch { return {} }
}

function writeResidentState(env, data) {
  const file = residentStatePath(env)
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 记下「常驻实例不可替换（环境限制）」。
 * @returns {{ok:boolean, recordedAt:number, firstTime:boolean}}
 */
export function recordReplaceBlocked(env = process.env, { error = '', lockPath = '', port = 0, version = '', served = '' } = {}) {
  const prev = readResidentState(env).replaceBlocked
  const firstTime = !prev
  const at = Date.now()
  const data = { ...readResidentState(env), replaceBlocked: { at, error: String(error || '').slice(0, 300), lockPath: String(lockPath || ''), port: Number(port) || 0, version: String(version || ''), served: String(served || ''), count: (prev && Number(prev.count) || 0) + 1 } }
  try { writeResidentState(env, data); return { ok: true, recordedAt: at, firstTime } } catch { return { ok: false, recordedAt: at, firstTime } }
}

/**
 * 记下「常驻实例由**宿主**托管」（issue #30 ④ 的落地）：锁不可写时看门狗路径被永久拒绝，
 * 于是宿主自己停掉旧实例、在原端口拉起新的并保活 —— 这条状态让面板/接口知道「虽然锁里没登记，
 * 但实例是有人管的」，而不是显示成「未托管 / 孤儿」。
 */
export function recordHostManaged(env = process.env, { port = 0, version = '', served = '', reason = '' } = {}) {
  const at = Date.now()
  const data = { ...readResidentState(env), hostManaged: { at, port: Number(port) || 0, version: String(version || ''), served: String(served || ''), reason: String(reason || '').slice(0, 300), count: (Number((readResidentState(env).hostManaged || {}).count) || 0) + 1 } }
  try { writeResidentState(env, data); return { ok: true, at } } catch { return { ok: false, at } }
}

/** 宿主托管状态（默认 24h 内算有效 —— 宿主进程一重启，这条就该被重新确认）。 */
export function hostManagedInfo(env = process.env, { freshMs = 24 * 3600 * 1000 } = {}) {
  const h = readResidentState(env).hostManaged
  if (!h) return null
  return { ...h, fresh: Date.now() - Number(h.at || 0) < freshMs }
}

/** 看门狗重新登记（或用户手工接管）→ 清掉宿主托管状态。 */
export function clearHostManaged(env = process.env) {
  const cur = readResidentState(env)
  if (!cur.hostManaged) return false
  delete cur.hostManaged
  try { writeResidentState(env, cur); return true } catch { return false }
}

/** 环境修好（锁可写了）→ 清掉这条状态。 */
export function clearReplaceBlocked(env = process.env) {
  const cur = readResidentState(env)
  if (!cur.replaceBlocked) return false
  delete cur.replaceBlocked
  try { writeResidentState(env, cur); return true } catch { return false }
}

/** 供界面/报告用：这条状态是否仍然成立（默认 7 天内算"当前有效"）。 */
export function replaceBlockedInfo(env = process.env, { freshMs = 7 * 24 * 3600 * 1000 } = {}) {
  const b = readResidentState(env).replaceBlocked
  if (!b) return null
  return { ...b, fresh: Date.now() - Number(b.at || 0) < freshMs }
}
