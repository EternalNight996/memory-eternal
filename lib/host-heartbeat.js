// 宿主心跳：让「独立 Web 端」知道本机此刻有没有活着的 DSH 宿主（issue #21 的宿主无关写路径）。
//
// 为什么需要它：配置只有一个权威写入者 —— DSH 宿主（插件用 settings.update 应用，再由
// index.js 的 syncConfigFile 写共享配置文件）。独立 Web 进程里没有 settings 服务，只能把改动
// 写进「待应用」文件、等宿主来 drain。但**非 DSH 宿主**（Codex / Claude Code / Cursor，
// 或只跑 `dsh-memory serve` 的用户）根本没有宿主来 drain：改动会永远停在 pending 文件里，
// 保存等于没保存 —— 而界面上那句「下次启动生效」在那类环境下是错的（不会有"下次启动 DSH"）。
//
// 判据：宿主活着时周期性刷新 `<共享配置>.host.json`（pid + 版本 + 时间戳）。
// 独立端保存后若「没人消费 pending」且「心跳不新鲜」，即判定本机没有宿主 → 直接原子写共享配置。
// 反之（宿主活着）**绝不**绕过宿主写文件：那会与宿主的 volatile 配置分叉，下一次
// syncConfigFile() 就会把改动盖回去。
import fs from 'node:fs'
import { configFilePath } from './capture-run.js'
import { writeFileAtomicSync } from './config-sync.js'

/** 心跳文件路径（与共享配置同目录：`xxx.json` → `xxx.host.json`）。 */
export function hostMarkerPath(env = process.env) {
  return String(configFilePath(env)).replace(/\.json$/i, '.host.json')
}

/** 进程存活判定（EPERM = 存在但无权发信号，仍算活着）。 */
export function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** 写/刷新心跳（原子写：这是跨进程判据，读方可能正好在写）。 */
export function writeHostMarker(env = process.env, info = {}, now = Date.now()) {
  const data = { pid: process.pid, at: now, ...info }
  writeFileAtomicSync(hostMarkerPath(env), JSON.stringify(data, null, 2))
  return data
}

/** 读心跳；文件不存在 / 内容损坏都返回 null。 */
export function readHostMarker(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(hostMarkerPath(env), 'utf8'))
    if (!data || typeof data !== 'object') return null
    return {
      pid: Number(data.pid) || 0,
      at: Number(data.at) || 0,
      version: String(data.version || ''),
      // 方案 A：宿主把自己 web server 的监听端口与 drain 令牌一起写进心跳，
      // 独立端据此在**请求上下文**里叫醒宿主应用 pending（旧宿主没这两个字段 → 0/''，走回落）。
      port: Number(data.port) || 0,
      token: String(data.token || ''),
    }
  } catch { return null }
}

/** 删除心跳（插件 dispose 时尽力而为；宿主被硬杀时靠新鲜度判定兜底）。 */
export function clearHostMarker(env = process.env) {
  try { fs.unlinkSync(hostMarkerPath(env)); return true } catch { return false }
}

/**
 * 本机此刻有没有活着的 DSH 宿主：心跳新鲜（默认 45s，宿主每 15s 刷一次）**且**那个 pid 还在。
 * 两个条件都要，避免「宿主崩了但心跳文件还在」被误判成有宿主。
 *
 * @param {Record<string,string>} [env]
 * @param {{maxAgeMs?:number, now?:number, isAlive?:(pid:number)=>boolean}} [opts]
 * @returns {boolean}
 */
export function hostAlive(env = process.env, { maxAgeMs = 45000, now = Date.now(), isAlive = isProcessAlive } = {}) {
  const marker = readHostMarker(env)
  if (!marker || !marker.pid || !marker.at) return false
  if (now - marker.at > Math.max(0, Number(maxAgeMs) || 0)) return false
  return isAlive(marker.pid)
}
