// 创建 Gitee Release（token 由 secrets.py --run 注入，不落盘、不打印）
import { readFileSync } from 'node:fs'

const token = process.env.GITEE_TOKEN
if (!token) { console.error('missing GITEE_TOKEN'); process.exit(2) }
const body = readFileSync('gh-notes.md', 'utf8')
const res = await fetch('https://gitee.com/api/v5/repos/EternalNight996/memory-eternal/releases', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ access_token: token, tag_name: 'v0.40.0', name: 'v0.40.0 — 语义召回正式版 · 长记忆评测 · 首次引导', body, target_commitish: 'main', prerelease: false }),
})
const text = await res.text()
console.log('status', res.status)
console.log(text.slice(0, 400))
