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
//   2. 非 Electron 宿主：process.execPath 本身就是 node，直接用；
//   3. Electron 宿主：优先从 PATH 找真正的 node；
//   4. 都找不到时退回 process.execPath，并由 childEnv() 打开
//      ELECTRON_RUN_AS_NODE，让 Electron 二进制以纯 node 模式运行。

import fs from 'node:fs'
import path from 'node:path'

let cachedBinary = null
let cachedSource = null

/** 在 PATH 中查找真正的 node 可执行文件；找不到返回 null。 */
function findNodeOnPath() {
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
export function nodeBinary() {
  if (cachedBinary) return cachedBinary

  if (process.env.MEMORY_ETERNAL_NODE) {
    cachedBinary = process.env.MEMORY_ETERNAL_NODE
    cachedSource = 'env'
    return cachedBinary
  }

  if (!process.versions.electron) {
    cachedBinary = process.execPath
    cachedSource = 'execPath'
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
