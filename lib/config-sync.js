// 配置同步（共享文件协议）：让「独立 Web 页」也能保存配置。
//
// 背景：独立 web server 进程里没有 DSH 的 settings 服务，`ctx.settings.update` 不存在，
// 所以它的 /config 过去只能只读 —— 用户点保存永远没反应（issue #12 的另一半）。
// 方案：独立端把改动写进 `memory-eternal-config.pending.json`，DSH 宿主激活时与运行期
// 轮询该文件，用 settings.update 应用后删除。DSH 没运行时改动留在文件里，下次启动生效。
import fs from 'node:fs'
import path from 'node:path'
import { configFilePath } from './capture-run.js'

/** 待应用配置文件的路径（与共享配置文件同目录）。 */
export function pendingConfigPath(env = process.env) {
  return String(configFilePath(env)).replace(/\.json$/i, '.pending.json')
}

/**
 * 读待应用改动；文件不存在/损坏都返回 null（不影响主流程）。
 *
 * 除 patch 之外还带出应用状态：tries（连续失败次数）、dropped（已放弃）、lastError
 * （最近一次失败原因）—— #16 之前这些信息只存在文件里却没人看，失败只能靠人肉盯 tries。
 */
export function readPendingConfig(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(pendingConfigPath(env), 'utf8'))
    if (!data || typeof data.patch !== 'object' || data.patch === null || Array.isArray(data.patch)) return null
    return {
      at: Number(data.at) || 0,
      tries: Number(data.tries) || 0,
      dropped: data.dropped === true,
      lastError: typeof data.lastError === 'string' ? data.lastError : '',
      patch: data.patch,
    }
  } catch { return null }
}

/**
 * 原子写文本文件（同目录 tmp + rename）。
 *
 * 为什么必须原子：这些文件是**跨进程共享的读源**（独立 web 的 lib/web.js 每次请求都
 * JSON.parse 共享配置、MCP hook 也读）。非原子的 writeFile/writeFileSync 是「先截断再写入」，
 * 读方在窗口内会读到空文件或半截内容 → JSON.parse 失败 → 调用方静默回落成默认值。
 * 同目录 rename 在同一文件系统上是原子的：读方要么看到旧的完整文件，要么看到新的完整文件。
 *
 * @param {string} file 目标文件绝对路径
 * @param {string} text 完整内容
 * @returns {string} 目标文件路径
 */
export function writeFileAtomicSync(file, text, { retries = 8, delayMs = 20 } = {}) {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  const retriable = (code) => code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file)
      return file
    } catch (error) {
      if (!retriable(error && error.code)) { try { fs.unlinkSync(tmp) } catch { /* 已清理 */ } throw error }
      // Windows 实测：目标文件正被另一个进程读取时，rename 会 EPERM/EBUSY（Windows 的
      // 「不能替换被打开的文件」语义）。短暂退避后重试 —— 读方打开文件都是短窗口。
      if (i < retries) { sleepSync(delayMs); continue }
      // 退避仍失败（极端争用）：退回直接覆盖写。宁可短暂退化到非原子，也不能把用户的
      // 配置改动整份丢掉 —— 这是这个函数存在的第一原则。
      fs.writeFileSync(file, text, 'utf8')
      try { fs.unlinkSync(tmp) } catch { /* 已清理 */ }
      return file
    }
  }
}

/** 同步 sleep（不烧 CPU）：同步 API 里做退避重试要用它，而不是忙等。 */
function sleepSync(ms) {
  const timeout = Math.max(0, Number(ms) || 0)
  if (!timeout) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout)
  } catch {
    const end = Date.now() + timeout
    while (Date.now() < end) { /* 兜底忙等（老运行时没有 Atomics.wait） */ }
  }
}

/**
 * 原子写入待应用改动，返回写入内容。
 * @param {number} [tries] 连续失败次数
 * @param {{dropped?:boolean,lastError?:string}} [state] 失败状态（#16：不再静默删文件，改为标注）
 */
export function writePendingConfig(env, patch, now = Date.now(), tries = 0, state = {}) {
  const file = pendingConfigPath(env)
  const data = { at: now, ...(tries > 0 ? { tries } : {}), patch }
  if (state.lastError) data.lastError = String(state.lastError)
  if (state.dropped) data.dropped = true
  writeFileAtomicSync(file, JSON.stringify(data, null, 2))
  return data
}

/** 删除待应用文件；不存在也算成功。 */
export function clearPendingConfig(env = process.env) {
  try { fs.unlinkSync(pendingConfigPath(env)); return true } catch { return false }
}

/**
 * 监听待应用文件的变化（毫秒级触发），用于把「独立页保存 → DSH 应用」从 5 秒轮询
 * 提升到准即时。监听失败（平台/权限）时退化为不监听 —— 仍有 5 秒轮询兜底。
 * @returns {() => void} 停止监听
 */
export function watchPendingConfig(env, onChange, { debounceMs = 60 } = {}) {
  const file = pendingConfigPath(env)
  let timer = null
  let watcher = null
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { try { onChange() } catch { /* 回调异常不影响监听 */ } }, debounceMs)
  }
  try {
    // 监听**文件本身**而不是父目录：
    // 父目录被删除 / 重命名时（临时 HOME、清理脚本、测试收尾），Windows 上 libuv 会断言崩溃
    // （`Assertion failed: !_wcsnicmp(filename, dir, dirlen), src\win\fs-event.c`），
    // 而监听文件时目录消失只会得到 ENOENT，不会带崩进程。也顺带免掉了按文件名过滤。
    watcher = fs.watch(file, () => fire())
    if (typeof watcher.unref === 'function') watcher.unref()
  } catch { return () => {} }
  return () => {
    if (timer) clearTimeout(timer)
    try { watcher.close() } catch { /* 已关闭 */ }
  }
}

/**
 * 取出并应用一次待应用改动：apply(patch) 成功后删除文件；失败保留（下轮重试）。
 *
 * #16 的两处修正：
 *   1. 重试耗尽后**不再静默删除**用户的改动 —— 改为在文件里标 dropped:true + lastError，
 *      并抛出一个说明「改动还在哪个文件里」的错误（由调用方写日志）。丢用户改动是这里
 *      最不该有的行为，保留文件也让「反馈异常」能带上现场。
 *   2. 已标记 dropped 的文件不再重试（否则每 5 秒无限重试），但文件继续留着作为证据；
 *      用户在独立 Web 端重新保存会写入一份新的 pending 并清除该标记。
 *
 * @returns {Promise<object|null>} 应用成功的 patch；没有待应用项 / 已放弃时返回 null
 */
export async function drainPendingConfig(env, apply, maxTries = 5) {
  const pending = readPendingConfig(env)
  if (!pending) return null
  if (pending.dropped) return null
  try {
    await apply(pending.patch)
  } catch (error) {
    const tries = (pending.tries || 0) + 1
    const reason = String((error && error.message) || error)
    if (tries >= maxTries) {
      writePendingConfig(env, pending.patch, pending.at, tries, { dropped: true, lastError: reason })
      const dropped = new Error('待应用配置连续失败 ' + tries + ' 次已放弃（原报错：' + reason + '）；改动仍保留在 ' + pendingConfigPath(env) + '，可修正后重新保存')
      dropped.dropped = true
      dropped.lastError = reason
      throw dropped
    }
    writePendingConfig(env, pending.patch, pending.at, tries, { lastError: reason })
    throw error
  }
  clearPendingConfig(env)
  return pending.patch
}
