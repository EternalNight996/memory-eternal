#!/usr/bin/env node
// 用环境变量 NPM_TOKEN 发布（不改 ~/.npmrc，token 不落盘）。
// 用法（PowerShell）：
//   $env:NPM_TOKEN = Read-Host -AsSecureString | ...（或直接粘贴）
//   node scripts/publish-npm.mjs
// 前提：npm 上该 token 有 memory-eternal 的写权限（granular token + bypass 2FA）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = String(process.env.NPM_TOKEN || '').trim()
if (!token) { console.error('缺少 NPM_TOKEN 环境变量'); process.exit(2) }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-npmrc-'))
const rc = path.join(tmp, '.npmrc')
fs.writeFileSync(rc, '//registry.npmjs.org/:_authToken=' + token + '\n')
try {
  const args = ['publish', '--userconfig', rc, '--access', 'public', ...process.argv.slice(2)]
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit' })
  process.exit(r.status == null ? 1 : r.status)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
}