// 记忆核心 · 子进程用的 node 可执行文件解析
//
// 背景（真实故障）：
// 在 Electron 宿主里（例如 DSH Desktop），`process.execPath` 指向的是
// Electron 主程序，而不是 node。此前 `ensureWebServer()` / watchdog / 插件的
// 保活逻辑都用 `spawn(process.execPath, ['.../web.js', ...])` 拉起子进程，
// 于是在 Electron 宿主下 spawn 出来的是「第二个 Electron 实例」：
// 它不会执行 web.js，而是立刻退出（或被单实例锁挡掉），而调用方用的是
// `stdio: 'ignore'` + `.catch(() => {})`，失败被彻底吞掉——表现就是侧边栏
// 「记忆」弹窗里那个指向 127.0.0.1:7999 的 iframe 永远白屏。
//
// 本模块把「找出一个真正能跑 node 脚本的子进程入口」收敛到一处：
//   1. MEMORY_ETERNAL_NODE 显式指定（逃生口，便于测试与非常规宿主）；
//   2. 非 Electron 宿主：**优先从 PATH 找 node**（issue #56：brew/nvm/volta 在 PATH 上的入口
//      是稳定 shim，而 process.execPath 是带版本号的真实路径），execPath 降为兜底；
//   3. Electron 宿主：同样优先从 PATH 找真正的 node；
//   4. 都找不到时退回 process.execPath，并由 childEnv() 打开
//      ELECTRON_RUN_AS_NODE，让 Electron 二进制以纯 node 模式运行。

import fs from 'node:fs'
import path from 'node:path'

let cachedBinary = null
let cachedSource = null

/** 在 PATH 中查找真正的 node 可执行文件；找不到返回 null。（导出便于测试断言 PATH 优先） */
export function findNodeOnPath() {
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node', 'node.exe']
  const dirs = String(process.env.PATH || '').split(path.delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // 目录不存在或无权访问：继续找下一个
      }
    }
  }
  return null
}

/**
 * 返回用于 spawn 子进程（跑 .js 脚本）的可执行文件路径。
 * @returns {string}
 */
function exists(p) {
  try { return Boolean(p) && fs.statSync(p).isFile() } catch { return false }
}

/** 该候选路径现在还能用吗（issue #44：Homebrew 升级会把旧 node 目录删掉）。 */
export function binaryUsable(p) { return exists(p) }

export function nodeBinary() {
  // issue #44（macOS/Homebrew）：watchdog 是长命进程，它启动时用的是当时的 node 绝对路径。
  // `brew upgrade node` 之后旧目录被删，长命进程的 process.execPath 就指向**已不存在的路径** →
  // 每次 spawn web 都 ENOENT，而调用方是静默吞错的 —— 端口没人应答、锁里却写着「运行中」。
  // 所以缓存命中前先**验存在**：失效就重新解析（PATH 里通常已经是新 node）。
  if (cachedBinary && cachedSource !== 'env' && !exists(cachedBinary)) {
    cachedBinary = null
    cachedSource = null
  }
  if (cachedBinary) return cachedBinary

  if (process.env.MEMORY_ETERNAL_NODE) {
    // 显式指定的逃生口优先，但也要求它存在（否则会静默 spwan 失败）
    if (exists(process.env.MEMORY_ETERNAL_NODE) || process.versions.electron) {
      cachedBinary = process.env.MEMORY_ETERNAL_NODE
      cachedSource = 'env'
      return cachedBinary
    }
  }

  if (!process.versions.electron) {
    // issue #56：非 Electron 下**必须 PATH 优先**。process.execPath 是「这一次装的那份 node」的
    // 真实路径（macOS Homebrew：/opt/homebrew/Cellar/node/26.13.0_2/bin/node），它会被写进
    // ~/.claude.json 等外部客户端的 MCP 条目；brew upgrade node 一删旧目录，这些条目就 ENOENT。
    // PATH 上的入口（/opt/homebrew/bin/node、~/.volta/bin/node、nvm 的 shim）才是稳定的。
    // 同时它决定了 align 的 currentNodePath —— 写入侧与校验侧一起收敛到 shim，才不会互相打脸。
    // execPath 仍保留为兜底（PATH 上没有 node 时行为与 #44 之前一致）。
    const viaPath = findNodeOnPath()
    if (viaPath) {
      cachedBinary = viaPath
      cachedSource = 'path'
      return cachedBinary
    }
    if (exists(process.execPath)) {
      cachedBinary = process.execPath
      cachedSource = 'execPath'
      return cachedBinary
    }
    cachedBinary = process.execPath
    cachedSource = 'execPath-missing'
    return cachedBinary
  }

  const found = findNodeOnPath()
  if (found) {
    cachedBinary = found
    cachedSource = 'path'
    return cachedBinary
  }

  cachedBinary = process.execPath
  cachedSource = 'electron-run-as-node'
  return cachedBinary
}

/** 说明 nodeBinary() 最终选了哪条路径（诊断用，不参与逻辑）。 */
export function nodeBinarySource() {
  nodeBinary()
  return cachedSource
}

/**
 * 子进程环境：始终打开 ELECTRON_RUN_AS_NODE。
 * 真正的 node 会忽略这个变量，所以无条件设置是安全的；而当 nodeBinary()
 * 只能退回 Electron 二进制时，它就是让子进程以 node 模式运行的关键。
 * @param {Record<string, string>} [extra]
 */
export function childEnv(extra) {
  return { ...process.env, ...(extra || {}), ELECTRON_RUN_AS_NODE: '1' }
}

/** 是否只能依赖 Electron 二进制的 node 模式（PATH 上没有真 node）。 */
export function usesElectronBinary() {
  return nodeBinarySource() === 'electron-run-as-node'
}

/** 仅测试用：清掉进程内缓存。 */
export function resetNodeBinaryCache() {
  cachedBinary = null
  cachedSource = null
}
