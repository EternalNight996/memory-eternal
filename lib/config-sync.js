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
 * 直接把 patch 合并进**共享配置文件**（宿主无关路径：本机没有 DSH 宿主时用）。
 *
 * 只在「确认没有活着的 DSH 宿主」时调用（见 lib/host-heartbeat.js）：宿主活着时共享文件是
 * 它的派生镜像，绕过它直写会与 volatile 配置分叉，下一次 syncConfigFile() 就会盖回来。
 * 合并（而不是整体替换）是有意为之：老版本写下的键、以及其它工具手工加的键都要留住。
 *
 * @returns {object} 合并后的完整配置
 */
export function applySharedConfigDirect(env, patch) {
  const file = configFilePath(env)
  let current = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
  } catch { current = {} }
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  writeFileAtomicSync(file, JSON.stringify(next, null, 2))
  return next
}

// 宿主守卫类报错的特征串 —— 同一族缺陷在不同宿主/不同服务上的措辞不同（issue #21）：
//   · Cordis HMR 宿主（官方桌面版）：runExclusive 拒绝嵌套事务
//   · dsh-tui 一类宿主：能力守卫在 settings.update 内部的 describe() 上抛
const HOST_GUARD_PATTERNS = [
  /HMR transactions cannot be nested/i,
  /is unavailable from a plugin activation/i,
]

/** 这个报错是不是「宿主不允许插件从自己的回调上下文写配置」。 */
export function isHostGuardError(message) {
  const s = String(message || '')
  return HOST_GUARD_PATTERNS.some((re) => re.test(s))
}

/**
 * 把「应用失败」翻译成给用户看的话（诊断信息 / 自动沉淀日志 / 独立页提示共用）。
 *
 * host-guard 类**不是配置内容的问题**，所以说清「去哪改」比重复报错有用得多：
 * 宿主自己的设置页走的写路径由宿主实现，不受插件上下文限制。
 *
 * @returns {{kind:'host-guard'|'other', hint:string}}
 */
export function describeApplyFailure(message) {
  const raw = String(message || '')
  if (!raw) return { kind: 'other', hint: '' }
  if (isHostGuardError(raw)) {
    return {
      kind: 'host-guard',
      hint: '此宿主不允许插件从自己的回调上下文里写配置（原报错：' + raw + '）—— 与配置内容无关。请到「DSH 设置 → 记忆」里改同一项（那条写路径由宿主自己实现，不受此限制），或直接编辑 profile 的配置补丁层。',
    }
  }
  return { kind: 'other', hint: '原报错：' + raw + '；可到「DSH 设置 → 记忆」重试，或查看「反馈异常」里的诊断信息。' }
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
 * patch 里的每个键是否都已在配置快照里生效（浅比较，数组/对象按 JSON 串等价判断）。
 *
 * 用途（issue #21）：dsh-tui 一类宿主的能力守卫会在 settings.update **内部**的
 * describe() 上抛「root.events.emit is unavailable from a plugin activation」，
 * 但写入本身可能已经提交。只认「有没有抛错」，就会把其实已经生效的改动重试 5 次
 * 后标成 dropped，日志里还报成失败 —— 回读是唯一能自证的信号。
 *
 * @returns {boolean} 三个条件全部满足才为 true：patch 非空、config 是对象、每个键取值一致
 */
export function patchApplied(config, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false
  if (!config || typeof config !== 'object') return false
  const keys = Object.keys(patch)
  if (!keys.length) return false
  for (const key of keys) {
    const want = JSON.stringify(patch[key])
    const got = config[key] === undefined ? undefined : JSON.stringify(config[key])
    if (want !== got) return false
  }
  return true
}

/**
 * 只保留「本宿主 schema 里存在」的键（升级期「新独立页 + 旧宿主」的必备过滤）。
 *
 * 为什么必须过滤：独立 Web 端提交的是**整张表单**。升级期它可能带上旧宿主还不认识的键
 * （实测：独立页 0.10.7 提交含 `secretHint` 的整包 → 0.10.6 宿主按白名单丢掉它 →
 * `patchApplied` 回读校验必然对不上 → 连试 5 次后标 `dropped`，用户还会看到
 * 「HMR transactions cannot be nested」这种与配置内容无关的报错）。过滤之后，旧宿主只应用
 * 它认识的那部分，不认识的记一行日志、等宿主升级后自然生效。
 *
 * @param {object} patch
 * @param {Set<string>|string[]} knownKeys
 * @returns {{known:object, ignored:string[]}}
 */
export function filterKnownKeys(patch, knownKeys) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || [])
  const out = {}
  const ignored = []
  for (const [k, v] of Object.entries(patch || {})) {
    if (known.has(k)) out[k] = v
    else ignored.push(k)
  }
  return { known: out, ignored }
}

/**
 * 应用一次 patch，并在抛错后**回读确认**（issue #21 的核心修复）。
 *
 * 背景：dsh-tui 一类宿主的能力守卫会在 settings.update **内部**的 describe() 上抛
 * 「root.events.emit is unavailable from a plugin activation」，但写入可能已经提交。
 * 只看有没有抛错，就会把其实已经生效的改动当成失败重试 5 次、最后标成 dropped。
 *
 * @param {object} patch
 * @param {object} opts
 * @param {(patch:object)=>any} opts.apply  真正的写入（可能抛）
 * @param {()=>object} opts.read            回读配置快照
 * @param {(config:object, patch:object)=>boolean} [opts.verify] 判定是否已生效（默认浅比较）
 * @param {(error:any)=>void} [opts.onRepaired] 命中「抛错但其实已生效」时的回调（记日志用）
 * @returns {Promise<{applied:boolean, repaired:boolean}>} repaired=由回读判定成功
 */
export async function applyPatchVerified(patch, { apply, read, verify = patchApplied, tries = 3, delayMs = 120, onRepaired } = {}) {
  try {
    await apply(patch)
    return { applied: true, repaired: false }
  } catch (error) {
    const rounds = Math.max(1, Number(tries) || 1)
    for (let i = 0; i < rounds; i++) {
      let snapshot = null
      try { snapshot = read() } catch { snapshot = null }
      if (verify(snapshot, patch)) {
        if (typeof onRepaired === 'function') { try { onRepaired(error) } catch { /* 回调异常不影响结果 */ } }
        return { applied: true, repaired: true }
      }
      if (i < rounds - 1 && Number(delayMs) > 0) await new Promise((r) => setTimeout(r, Number(delayMs)))
    }
    throw error
  }
}

/**
 * 等一下看这次写入的最终去向（issue #21 建议 3）：宿主在跑时对 pending 文件有
 * fs.watch（毫秒级），稍微等一会儿就能分辨「真的应用了」和「只是排上队了」。
 *
 * @returns {Promise<'applied'|'failed'|'queued'>}
 *   applied = pending 文件已被宿主消费；failed = 已被标记 dropped；
 *   queued  = 到超时还在（DSH 没运行 / 还没轮到它）
 */
export async function waitPendingOutcome(env = process.env, { timeoutMs = 800, intervalMs = 100 } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  for (;;) {
    const pending = readPendingConfig(env)
    if (!pending) return 'applied'
    if (pending.dropped) return 'failed'
    if (Date.now() >= deadline) return 'queued'
    await new Promise((r) => setTimeout(r, Math.max(20, Number(intervalMs) || 100)))
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
      // 失败原因分两类：宿主守卫类（不是配置内容的问题，要说清去哪改）与其它。
      const advice = describeApplyFailure(reason)
      const dropped = new Error('待应用配置连续失败 ' + tries + ' 次已放弃（原报错：' + reason + '）'
        + (advice.kind === 'host-guard' ? '。' + advice.hint : '')
        + '；改动仍保留在 ' + pendingConfigPath(env) + '，可修正后重新保存')
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

// ---- 方案 A：把「应用 pending」搬进宿主允许的上下文（2026-10-08 实测结论）----------------
//
// 实测（同一宿主机、同一个 settings.update）：
//   · 从插件**回调**（setInterval / fs.watch）里调 → 抛「HMR transactions cannot be nested」，
//     且**一个字节都没提交**（与 patch 内容无关：只含宿主认识的键、值真的变了，同样失败）；
//   · 从插件**HTTP 请求处理器**里调 → 真的提交（130→132→130，revision 4→6）。
// 所以修法不是「换个 API」，而是**换调用上下文**：独立端保存后，请宿主在这条路由里应用 pending。

/** 宿主 drain 路由的令牌请求头（令牌写在心跳文件里，只有本机进程读得到）。 */
export const DRAIN_TOKEN_HEADER = 'x-memory-eternal-token'

/** 这个地址算不算「本机」：IPv4/IPv6 回环，含 IPv4-mapped 形式。 */
export function isLoopbackAddress(address) {
  const s = String(address || '').trim().toLowerCase()
  if (!s) return false
  if (s === 'localhost' || s === '::1' || s === '0:0:0:0:0:0:0:1') return true
  const v4 = s.startsWith('::ffff:') ? s.slice(7) : s
  return /^127\./.test(v4)
}

/**
 * 宿主侧：校验一次「请立刻应用 pending」的调用。放行返回空串，否则返回人话原因。
 *
 * 为什么两件都要验：宿主上的插件 API 是**无鉴权**的（任何本机页面都能 POST），所以这里必须同时
 * 卡「只接受本机来源」与「心跳里的令牌」——令牌只写在共享配置目录的心跳文件里，远端页面拿不到。
 */
export function drainRequestError({ method, headers, remoteAddress } = {}, token = '') {
  if (String(method || '').toUpperCase() !== 'POST') return '需 POST'
  if (!isLoopbackAddress(remoteAddress)) return '只接受本机请求'
  if (!token) return '宿主未准备令牌'
  const h = headers || {}
  const got = String(h[DRAIN_TOKEN_HEADER] || h['X-Memory-Eternal-Token'] || '')
  if (got !== token) return '令牌不匹配'
  return ''
}

/**
 * 独立端：请宿主**在 HTTP 请求上下文里**立刻应用 pending（方案 A 的客户端一半）。
 *
 * 失败分两类，调用方要区别对待：
 *   · status 404/405/0（旧宿主没这条路由 / 连不上）→ 退回「等宿主自己 drain」的老路，不是错误；
 *   · 其它 → 真错误（令牌不匹配、应用失败），把 body.error 如实报给用户。
 *
 * @param {{port?:number, token?:string, host?:string, timeoutMs?:number, fetchImpl?:Function}} opts
 * @returns {Promise<{ok:boolean, status:number, body?:object, error?:string}>}
 */
export async function triggerHostDrain({ port, token, host = '127.0.0.1', timeoutMs = 2000, fetchImpl } = {}) {
  const listenPort = Number(port) || 0
  if (!listenPort || !token) return { ok: false, status: 0, error: '宿主端口/令牌未知（旧宿主，或心跳还没刷新）' }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) return { ok: false, status: 0, error: '当前运行时没有 fetch' }
  const url = 'http://' + host + ':' + listenPort + '/memory-eternal/api/drain-pending'
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => { try { controller.abort() } catch { /* 已中止 */ } }, Math.max(0, Number(timeoutMs) || 0)) : null
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { [DRAIN_TOKEN_HEADER]: String(token) },
      ...(controller ? { signal: controller.signal } : {}),
    })
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    const status = Number(res.status) || 0
    if (!res.ok || !body || body.ok !== true) {
      return { ok: false, status, body, error: (body && body.error) || ('HTTP ' + status) }
    }
    return { ok: true, status, body }
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
