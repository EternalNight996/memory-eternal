// 同步身份基础：UUIDv7 + 混合逻辑时钟（HLC）。
//
// 为什么需要：
//   多设备同步不能靠路径/内容 hash 认卡（改标题=新卡、同内容=去重、删除不传播），
//   必须有稳定 uid；"谁最后写"不能靠墙钟（会漂移），要用 HLC：毫秒 + 计数器 + 设备，
//   字符串可直接比较大小，跨设备也能排出全序。
//
// HLC 格式：<15 位毫秒>-<4 位计数器>-<设备>，例如
//   000001795604123456-0000-pc-a1b2
// 同毫秒内计数器递增，保证同一设备内严格单调；收到远端事件时 caller 可把 lastHlc 传进来合并。
import { randomBytes } from 'node:crypto'

/** 本机设备标识（可由环境变量覆盖；云端按请求设置 MEMORY_ETERNAL_DEVICE）。 */
export function deviceId(env = process.env) {
  const raw = String((env && env.MEMORY_ETERNAL_DEVICE) || 'local').trim()
  return raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || 'local'
}

function pad(n, w) { return String(n).padStart(w, '0') }

/** 生成 UUIDv7（时间有序）。 */
export function uuidv7(now = Date.now()) {
  const ms = BigInt(now)
  const b = Buffer.alloc(16)
  b.writeUIntBE(Number(ms & 0xffffffffffffn), 0, 6) // 48 位毫秒
  randomBytes(10).copy(b, 6)
  b[6] = 0x70 | (b[6] & 0x0f) // version 7（第 3 组首字符固定 7）
  b[8] = 0x80 | (b[8] & 0x3f) // variant（第 4 组首字符 8/9/a/b）
  const h = b.toString('hex')
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
}

/** 解析 HLC 字符串 → { ms, counter, device }；非法返回 null。 */
export function parseHlc(v) {
  const m = /^(\d{15})-(\d{4})-(.+)$/.exec(String(v || ''))
  if (!m) return null
  return { ms: Number(m[1]), counter: Number(m[2]), device: m[3] }
}

/** 生成新 HLC：严格大于 lastHlc（如果给了）。 */
export function nowHlc(lastHlc = '', device = deviceId(), now = Date.now()) {
  const prev = parseHlc(lastHlc)
  let ms = now
  let counter = 0
  if (prev && prev.ms >= ms) {
    ms = prev.ms
    counter = prev.counter + 1
    if (counter > 9999) { ms += 1; counter = 0 }
  }
  return pad(ms, 15) + '-' + pad(counter, 4) + '-' + String(device).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32)
}

/** 比较两个 HLC：a>b 返回 1，a<b 返回 -1，相等 0。 */
export function compareHlc(a, b) {
  const x = String(a || '')
  const y = String(b || '')
  return x > y ? 1 : x < y ? -1 : 0
}

/** 从 HLC 字符串取设备（后缀）。 */
export function deviceFromHlc(hlc) {
  const m = /^\d{15}-\d{4}-(.+)$/.exec(String(hlc || ''))
  return m ? m[1] : ''
}
