// 一键诊断包（dsh-memory support）：把「用户报 issue 时我每次都要挨个要的东西」打成**一个 zip**。
//
// 为什么需要：issue #47 的用户贴了诊断，但被 GitHub 截断（内容过长），我拿不到完整现场，
// 只能来回问。这个命令把 版本矩阵 / doctor / align / status / 锁 / 心跳 / 配置 / 日志尾巴 一次收齐，
// 并在写入前**统一脱敏**（家目录、sk-*/ghp_*、Bearer、配置里 key 类字段）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeZip, listZipNames } from './zip.js'
import { captureLogPath } from './capture-log.js'
import { configFilePath, defaultVaultDir } from './capture-run.js'
import { PACKAGE_ROOT } from './setup.js'

/** 脱敏（纯函数，可单测）：家目录 + 常见凭据形态 + 配置里 key 类字段。 */
export function redactText(text, { home = os.homedir() } = {}) {
  let s = String(text ?? '')
  const h = String(home || '')
  if (h) {
    // 同时处理 Windows 反斜杠与正斜杠两种写法
    s = s.split(h).join('<home>')
    s = s.split(h.replace(/\\/g, '/')).join('<home>')
  }
  s = s.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
  s = s.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, 'gh*_***')
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***')
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{10,}=*/gi, 'Bearer ***')
  // 配置/JSON 里的敏感字段："secretHint": "..." / token=... 等
  s = s.replace(/"((?:secret|token|api_?key|apikey|password|credential)[A-Za-z0-9_]*)"\s*:\s*"[^"]*"/gi, '"$1": "***"')
  s = s.replace(/\b((?:secret|token|api_?key|apikey|password)[A-Za-z0-9_]*)\s*=\s*[^\s,;]+/gi, '$1=***')
  return s
}

/** 跑自己的 CLI 子命令拿 JSON/文本；失败时返回错误文本而不是让整个包失败。 */
function runCli(args, { timeoutMs = 20000 } = {}) {
  try {
    const self = path.join(PACKAGE_ROOT, 'bin', 'dsh-memory.mjs')
    const r = spawnSync(process.execPath, [self, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
    const out = String(r.stdout || '')
    const err = String(r.stderr || '')
    if (r.error) return { ok: false, text: '执行失败：' + String(r.error.message || r.error) + '\n' + out + err }
    return { ok: r.status === 0, text: out || err || ('（无输出，退出码 ' + r.status + '）') }
  } catch (e) {
    return { ok: false, text: '执行异常：' + String((e && e.message) || e) }
  }
}

function readIfExists(file, { tailLines = 0 } = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (!tailLines) return raw
    const lines = raw.split(/\r?\n/).filter((l) => l.trim())
    return lines.slice(-Math.max(1, tailLines)).join('\n')
  } catch { return '' }
}

function versionOfPackage() {
  try { return String(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '') } catch { return '' }
}

function defaultOutDir() {
  const dl = path.join(os.homedir(), 'Downloads')
  try { if (fs.statSync(dl).isDirectory()) return dl } catch { /* 没有 Downloads 就用当前目录 */ }
  return process.cwd()
}

/**
 * 生成诊断包。
 * @returns {{ok:boolean, path:string, bytes:number, entries:string[]}}
 */
export function buildSupportBundle({
  env = process.env,
  vaultRoot = defaultVaultDir(env),
  out = '',
  tail = 200,
  port = 0,
  now = Date.now(),
  spawn = true,
} = {}) {
  const home = os.homedir()
  const entries = []
  const add = (name, text) => entries.push({ name, data: redactText(text, { home }) })

  const meta = {
    at: new Date(now).toISOString(),
    pluginVersion: versionOfPackage(),
    node: process.version,
    platform: process.platform + ' ' + process.arch + ' ' + (os.release ? os.release() : ''),
    vaultDir: vaultRoot,
    dshHome: env.DSH_HOME || '',
    hasLlmEnv: Boolean(env.MEMORY_LLM_BASE_URL || env.MEMORY_LLM_KEY),
    note: '本包已脱敏：家目录→<home>，sk-/ghp_/github_pat/Bearer/配置里的 key 类字段→***',
  }
  add('meta.json', JSON.stringify(meta, null, 2))
  if (spawn) {
    add('doctor.json', runCli(['doctor', '--vault', vaultRoot, '--json']).text)
    add('align.json', runCli(['align', '--json']).text)
    add('status.txt', runCli(['status', ...(port ? ['--port', String(port)] : [])]).text)
  }
  add('lock.json', readIfExists(path.join(path.dirname(configFilePath(env)), 'memory-eternal-watchdog.json')))
  add('host.json', readIfExists(String(configFilePath(env)).replace(/\.json$/i, '.host.json')))
  add('config.json', readIfExists(configFilePath(env)))
  add('capture-log.tail.jsonl', readIfExists(captureLogPath(env), { tailLines: Math.max(1, Number(tail) || 200) }))
  add('README.txt', [
    '记忆核心 · 诊断包',
    '',
    '内容：meta / doctor / align / status / lock / host / config / capture-log.tail / 本说明。',
    '隐私：已脱敏（家目录→<home>；sk-/ghp_/github_pat/Bearer/配置里 key 类字段→***）。',
    '提交 issue 前请自己再扫一眼：日志里可能有你的会话标题或路径片段。',
  ].join('\n'))

  const zipBuf = makeZip(entries, new Date(now))
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const target = out ? path.resolve(out) : path.join(defaultOutDir(), 'memory-eternal-support-' + stamp + '.zip')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, zipBuf)
  return { ok: true, path: target, bytes: zipBuf.length, entries: listZipNames(zipBuf) }
}
