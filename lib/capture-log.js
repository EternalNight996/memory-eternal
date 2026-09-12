// 记忆核心 · 自动沉淀日志的持久层（JSONL 追加）。
//
// 为什么要有它：
// 1) 独立 Web 页（lib/web.js 起的进程）拿不到宿主内存里的日志，面板只能显示
//    「日志仅在 DSH 宿主内可用」——用户看到的就是"记录里没内容"；
// 2) 宿主重启后内存环形缓冲清空，历史诊断信息全丢。
// 落一个 JSONL 到 DSH_HOME 里，两边都能读：宿主写、两边读，最多保留最近 500 条。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const FILE = 'memory-eternal-capture.jsonl'
export const CAPTURE_LOG_MAX_LINES = 500

/** 日志文件路径（与 vault 同级的 DSH_HOME 下）。 */
export function captureLogPath(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, FILE)
}

/** 追加一条（失败静默：日志不能反过来搞坏沉淀管线）。 */
export async function appendCaptureLog(entry, env = process.env) {
  try { await fs.appendFile(captureLogPath(env), JSON.stringify(entry) + '\n', 'utf8') } catch { /* 忽略 */ }
}

/** 读最近 limit 条，**最新在前**（与 /capture-log 接口语义一致）。 */
export async function readCaptureLog(limit = 100, env = process.env) {
  try {
    const txt = await fs.readFile(captureLogPath(env), 'utf8')
    const lines = txt.split('\n').filter(Boolean)
    const out = []
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
    return out.reverse()
  } catch { return [] }
}

/** 从日志推健康状态（独立 Web 页没有宿主内存状态，只能看最近一条结论）。 */
export function deriveHealth(entries) {
  for (const e of entries || []) {
    if (e.action === 'fail') return { ok: false, reason: e.reason || '', since: e.time || 0, lastOkAt: 0, lastFailAt: e.time || 0 }
    if (e.action === 'created' || e.action === 'appended') return { ok: true, reason: '', since: 0, lastOkAt: e.time || 0, lastFailAt: 0 }
  }
  return null
}

/** 行数超上限时重写为最近 CAPTURE_LOG_MAX_LINES 行（由宿主定期调用）。 */
export async function rotateCaptureLog(env = process.env) {
  try {
    const p = captureLogPath(env)
    const txt = await fs.readFile(p, 'utf8')
    const lines = txt.split('\n').filter(Boolean)
    if (lines.length <= CAPTURE_LOG_MAX_LINES) return false
    await fs.writeFile(p, lines.slice(-CAPTURE_LOG_MAX_LINES).join('\n') + '\n', 'utf8')
    return true
  } catch { return false }
}
