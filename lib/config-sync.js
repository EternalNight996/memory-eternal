// 配置同步（共享文件协议）：让「独立 Web 页」也能保存配置。
//
// 背景：独立 web server 进程里没有 DSH 的 settings 服务，`ctx.settings.update` 不存在，
// 所以它的 /config 过去只能只读 —— 用户点保存永远没反应（issue #12 的另一半）。
// 方案：独立端把改动写进 `memory-eternal-config.pending.json`，DSH 宿主激活时与运行期
// 轮询该文件，用 settings.update 应用后删除。DSH 没运行时改动留在文件里，下次启动生效。
import fs from 'node:fs'
import { configFilePath } from './capture-run.js'

/** 待应用配置文件的路径（与共享配置文件同目录）。 */
export function pendingConfigPath(env = process.env) {
  return String(configFilePath(env)).replace(/\.json$/i, '.pending.json')
}

/** 读待应用改动；文件不存在/损坏都返回 null（不影响主流程）。 */
export function readPendingConfig(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(pendingConfigPath(env), 'utf8'))
    if (!data || typeof data.patch !== 'object' || data.patch === null || Array.isArray(data.patch)) return null
    return { at: Number(data.at) || 0, tries: Number(data.tries) || 0, patch: data.patch }
  } catch { return null }
}

/** 原子写入待应用改动（tmp + rename），返回写入内容。 */
export function writePendingConfig(env, patch, now = Date.now(), tries = 0) {
  const file = pendingConfigPath(env)
  const data = tries > 0 ? { at: now, tries, patch } : { at: now, patch }
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return data
}

/** 删除待应用文件；不存在也算成功。 */
export function clearPendingConfig(env = process.env) {
  try { fs.unlinkSync(pendingConfigPath(env)); return true } catch { return false }
}

/**
 * 取出并应用一次待应用改动：apply(patch) 成功后删除文件；失败保留（下轮重试）。
 * @returns {Promise<object|null>} 应用成功的 patch，没有待应用项时返回 null
 */
export async function drainPendingConfig(env, apply, maxTries = 5) {
  const pending = readPendingConfig(env)
  if (!pending) return null
  try {
    await apply(pending.patch)
  } catch (error) {
    const tries = (pending.tries || 0) + 1
    if (tries >= maxTries) {
      // 连续失败（多半是值不合法）：放弃并删掉，否则会每 5 秒无限重试
      clearPendingConfig(env)
      const dropped = new Error('待应用配置连续失败 ' + tries + ' 次已放弃：' + String((error && error.message) || error))
      dropped.dropped = true
      throw dropped
    }
    writePendingConfig(env, pending.patch, pending.at, tries)
    throw error
  }
  clearPendingConfig(env)
  return pending.patch
}
