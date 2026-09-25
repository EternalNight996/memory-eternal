// node-bin 自测：解析出的可执行文件必须真的能跑 .js 脚本，且 childEnv() 打开 node 模式。
// 在普通 node 宿主与 Electron 宿主（Electron 以 node 模式运行本文件）下都应通过。
// 用法：node tests/node-bin.test.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { nodeBinary, nodeBinarySource, childEnv, usesElectronBinary } from '../lib/node-bin.js'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message || error}`)
  }
}

console.log(`宿主：node ${process.versions.node}${process.versions.electron ? ` / electron ${process.versions.electron}` : ''}`)
console.log(`execPath：${process.execPath}`)

await check('解析结果是一个存在的绝对路径', () => {
  const bin = nodeBinary()
  assert.equal(typeof bin, 'string')
  assert.ok(bin.length > 0)
  assert.ok(path.isAbsolute(bin), `应为绝对路径，实际 ${bin}`)
  assert.equal(nodeBinary(), bin, '同一进程内应稳定（有缓存）')
})

await check('childEnv() 始终打开 ELECTRON_RUN_AS_NODE（真 node 会忽略它）', () => {
  const env = childEnv({ FOO: 'bar' })
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.FOO, 'bar', '不应吞掉传入的额外变量')
  // Windows 上父进程的键名是 `Path`：展开后是普通对象，读取需按大小写不敏感匹配
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  assert.ok(pathKey !== undefined, '应继承父进程环境')
  assert.equal(typeof env[pathKey], 'string')
})

await check('解析出的可执行文件能真正跑起脚本（关键回归点）', async () => {
  const bin = nodeBinary()
  const out = await new Promise((resolve, reject) => {
    let stdout = ''
    const child = spawn(bin, ['-e', 'console.log("NODE_BIN_OK:" + process.versions.node)'], {
      env: childEnv({}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const timer = setTimeout(() => { try { child.kill() } catch {} ; reject(new Error('子进程 15s 未退出')) }, 15000)
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`退出码 ${code}`)) })
  })
  assert.match(out, /NODE_BIN_OK:/)
})

await check('诊断信息自洽', () => {
  const source = nodeBinarySource()
  assert.ok(['env', 'execPath', 'path', 'electron-run-as-node'].includes(source), `未知来源 ${source}`)
  assert.equal(usesElectronBinary(), source === 'electron-run-as-node')
  if (!process.versions.electron) {
    assert.equal(source, 'execPath', '非 Electron 宿主应直接用 execPath')
    assert.equal(usesElectronBinary(), false)
  }
})

console.log(failed === 0 ? '\n全部通过 ✔' : `\n有 ${failed} 项失败 ✘`)
process.exit(failed === 0 ? 0 : 1)
