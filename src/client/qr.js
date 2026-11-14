// 二维码矩阵生成。
//
// 为什么用 `qrcode` 的核心模块而不是自己写：自己实现 QR 编码（RS 纠错 + 掩码 + 格式信息）
// 容易在细节上出错，而且**错得很安静** —— 矩阵看着像二维码、扫不出来，肉眼无法判断。
// 这一版先写了个自研实现，用 jsQR 解码 + 与参考库逐模块对比才发现格式信息 bit 序反了，
// 修完仍解不出来。既然这是登录主路径的一环（手机扫码直达确认页），可靠性优先：
// 只 import `qrcode/lib/core/qrcode.js`（纯计算，不涉及 canvas/fs，约 10 KB），
// 由 esbuild 内联进产物，**不引入运行时依赖**。
import Core from 'qrcode/lib/core/qrcode.js'

/**
 * 生成二维码矩阵。
 *
 * @param {string} text 要编码的内容（设备码登录用 `verification_uri_complete`）
 * @param {{ ecLevel?: 'L'|'M'|'Q'|'H' }} [opts] 纠错等级，默认 M（15% 冗余，屏幕扫码够用）
 * @returns {{ size: number, modules: boolean[][] } | null} 失败返回 null（内容过长等）
 */
export function makeQrMatrix(text, opts) {
  const value = String(text || '')
  if (!value) return null
  try {
    const qr = Core.create(value, { errorCorrectionLevel: (opts && opts.ecLevel) || 'M' })
    const size = qr.modules.size
    const data = qr.modules.data
    const modules = []
    for (let r = 0; r < size; r++) {
      const row = new Array(size)
      for (let c = 0; c < size; c++) row[c] = !!data[r * size + c]
      modules.push(row)
    }
    return { size, modules }
  } catch {
    return null
  }
}

/** 内容能否编码（UI 提前提示用）。 */
export function qrFits(text) {
  return makeQrMatrix(text) !== null
}
