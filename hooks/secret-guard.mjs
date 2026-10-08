#!/usr/bin/env node
// 记忆核心 · 凭据读取守卫（Claude Code PreToolUse hook，纯 node、静默失败）
//
// 为什么需要它：一旦 agent 知道「本机有密钥」，它很可能直接 `cat ~/.dsh/.credentials.yaml`
// 或 Read 那个文件 —— 值就进了它的上下文（再经 provider / 日志 / 蒸馏扩散出去）。
// 「知道去哪取」与「不许直接读」必须成对存在，否则索引反而放大了泄漏面。
//
// 生效条件（**默认不打扰任何人**）：本机存在密钥加载器
//   ~/.config/memory-eternal/secrets.py
// 没有它（其它用户 / 其它机器）这个 hook 直接放行，什么也不做。
//
// 命中判定：工具参数里出现下列文件（Read 的 file_path / Bash 的命令行 / Grep 的 pattern 等）
//   .credentials.y(a)ml、~/.dsh/.env、gitee-token
// 命中即以 PreToolUse permissionDecision=deny 拒绝，并指路到 secrets.py --names / --run。
//
// 由 hooks/hooks.claude.json 注册（PreToolUse）。也可以手工测试：
//   echo '{"tool_name":"Read","tool_input":{"file_path":"/x/.credentials.yaml"}}' | node hooks/secret-guard.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOADER = path.join(os.homedir(), '.config', 'memory-eternal', 'secrets.py')
const SENSITIVE = [
  /\.credentials\.ya?ml/i,
  /[\\/]\.dsh[\\/]\.env(?:$|[\s"'])/i,
  /[\\/]\.env(?:$|["'\s])/i,          // 通用 .env（含值）——只在本机装了加载器时才拦
  /gitee-token/i,
]
const REASON = [
  '这道读取被「记忆核心」的凭据守卫拦下了：该文件里是密钥**明文**，读进上下文就等于泄漏',
  '（值经 provider / 日志 / 自动蒸馏会扩散到多处，且删除也无法收回）。',
  '',
  '正确做法：',
  '  1) 先列名字（不输出值）：python ~/.config/memory-eternal/secrets.py --names',
  '  2) 再带值执行命令（值只进子进程环境变量）：python ~/.config/memory-eternal/secrets.py --require <KEY> --run -- <命令>',
  '  3) 需要「有哪些键、放在哪、干什么用」的说明：memory_recall("密钥 目录")',
  '',
  '确实需要人工查看时，请在终端里自己打开该文件 —— 不要经由 Agent 的工具读取。',
].join('\n')

async function readStdin() {
  try {
    return await new Promise((resolve) => {
      let buf = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (c) => { buf += c })
      process.stdin.on('end', () => resolve(buf))
      setTimeout(() => resolve(buf), 1500) // hook 不能挂住宿主
    })
  } catch { return '' }
}

function targetsCredential(input) {
  if (!input || typeof input !== 'object') return false
  const fields = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'glob', 'query', 'url', 'content']
  const haystack = fields
    .map((f) => (typeof input[f] === 'string' ? input[f] : ''))
    .filter(Boolean)
    .join('\n')
  if (!haystack) return false
  return SENSITIVE.some((re) => re.test(haystack))
}

async function main() {
  if (!fs.existsSync(LOADER)) return // 没装加载器 → 不打扰
  const raw = await readStdin()
  let payload = null
  try { payload = JSON.parse(raw || '{}') } catch { return }
  const tool = String(payload?.tool_name || '')
  if (!tool) return
  if (!targetsCredential(payload.tool_input)) return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
    },
  }))
}

main().catch(() => { /* hook 静默失败：绝不因为守卫崩了而挡住正常工具 */ })
