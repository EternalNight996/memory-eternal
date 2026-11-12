// 创建 Gitee Release（token 由 secrets.py --run 注入，不落盘、不打印）
// 用法：node scripts/gitee-release.mjs v0.40.1 [标题] [notes 文件]
import { readFileSync } from 'node:fs'

const token = process.env.GITEE_TOKEN
if (!token) { console.error('missing GITEE_TOKEN'); process.exit(2) }
const tag = process.argv[2] || 'v0.40.1'
const title = process.argv[3] || `${tag} release`
const notesFile = process.argv[4] || 'gh-notes.md'
let body = ''
try { body = readFileSync(notesFile, 'utf8') } catch { body = `${tag}` }
const res = await fetch('https://gitee.com/api/v5/repos/EternalNight996/memory-eternal/releases', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ access_token: token, tag_name: tag, name: title, body, target_commitish: 'main', prerelease: false }),
})
const text = await res.text()
console.log('status', res.status)
console.log(text.slice(0, 400))
