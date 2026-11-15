#!/usr/bin/env node
// 下载 LongMemEval-S 数据集到 bench/longmemeval/（277MB，**不进仓库**，见 .gitignore）
//
// 为什么要有这个脚本：基准数据集体积远超仓库合理范围，只能按需下载；但这套脚本
// 本身又必须「新人一条命令就能复现 bench」，否则 bench/FINAL-REPORT.md 里的
// 97.2% / 95.4% 就成了没法核对的自报价。
//
// 用法：
//   node scripts/fetch-longmemeval.mjs                # 下到 bench/longmemeval/longmemeval_s_cleaned.json
//   node scripts/fetch-longmemeval.mjs --head          # 只探一次（校验 URL 可达 + 体积），不下载
//   node scripts/fetch-longmemeval.mjs --mirror hf     # 走 huggingface.co（默认 hf-mirror.com，国内更快）
//   node scripts/fetch-longmemeval.mjs --force         # 目标已存在也重下
//   node scripts/fetch-longmemeval.mjs --sha256 <hex>  # 下完校验 sha256（推荐的钉法）
//
// 数据集：xiaowu0162/longmemeval-cleaned → longmemeval_s_cleaned.json
// 下完可直接跑：node scripts/bench-longmemeval.mjs --data bench/longmemeval/longmemeval_s_cleaned.json --label lme
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, readFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

const FILE = 'longmemeval_s_cleaned.json'
const REPO = 'xiaowu0162/longmemeval-cleaned'
const MIRRORS = {
  'hf-mirror': 'https://hf-mirror.com',
  hf: 'https://huggingface.co',
}
const EXPECTED_BYTES = 277383467 // 与本地实测一致；服务端给了长度就对比，没给就跳过

const args = process.argv.slice(2)
const opt = (name, def = '') => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const headOnly = args.includes('--head')
const force = args.includes('--force')
const mirror = opt('mirror', 'hf-mirror')
const wantSha = String(opt('sha256', '')).trim().toLowerCase()
const outDir = opt('outdir', path.join('bench', 'longmemeval'))
const outFile = path.join(outDir, FILE)

const base = MIRRORS[mirror]
if (!base) {
  console.error(`未知 --mirror ${mirror}（可选：${Object.keys(MIRRORS).join(' / ')}）`)
  process.exit(2)
}
const url = `${base}/datasets/${REPO}/resolve/main/${FILE}`
const human = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB')

/** 拿 Content-Length（有的 CDN 走 chunked，没有就返回 0）。 */
async function probe() {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  if (!res.ok) return { ok: false, status: res.status, url }
  const len = Number(res.headers.get('content-length') || 0)
  return { ok: true, status: res.status, len, url }
}

async function download() {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status} — ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  mkdirSync(outDir, { recursive: true })
  const part = outFile + '.part'
  let got = 0
  let last = Date.now()
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length
      hash.update(chunk)
      if (Date.now() - last > 1000) {
        last = Date.now()
        const pct = total ? ((got / total) * 100).toFixed(1) + '%' : ''
        process.stdout.write(`\r  ${human(got)}${total ? ' / ' + human(total) : ''} ${pct}   `)
      }
      cb(null, chunk)
    },
  })
  await pipeline(res.body, tap, createWriteStream(part))
  process.stdout.write('\r' + ' '.repeat(60) + '\r')
  if (total && got !== total) {
    rmSync(part, { force: true })
    throw new Error(`长度不符：期望 ${total}，实际 ${got}（删除半成品，可重跑）`)
  }
  return { sha256: hash.digest('hex'), bytes: got }
}

/** 数据集结构体检：能解析 + 能抽出题目（不然 bench 脚本只会报"数据集为空"）。 */
function inspect(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : [])
  const ok = list.length > 0 && list.every((q) => q && typeof q === 'object')
  const withSessions = list.filter((q) => Array.isArray(q.haystack_sessions) || Array.isArray(q.haystack_dates)).length
  return { questions: list.length, ok, withSessions }
}

const p = await probe()
if (!p.ok) {
  console.error(`探测失败：HTTP ${p.status} — ${url}`)
  console.error('换镜像试试：--mirror hf；或手动下载后放到 ' + outFile)
  process.exit(1)
}
console.log(`数据源：${url}`)
console.log(`远端体积：${p.len ? human(p.len) : '未知（chunked）'}${p.len && Math.abs(p.len - EXPECTED_BYTES) > 1024 ? '（与实测 ' + human(EXPECTED_BYTES) + ' 不同，上游可能已更新）' : ''}`)
if (headOnly) {
  console.log('--head：只探测，不下载 ✓')
  process.exit(0)
}

if (existsSync(outFile) && !force) {
  let size = 0
  try { size = statSync(outFile).size } catch { /* ignore */ }
  console.log(`已存在：${outFile}（${human(size)}）—— 想重下加 --force`)
  process.exit(0)
}

console.log('开始下载（277MB 量级，中断可重跑）…')
const { sha256, bytes } = await download()
try {
  if (wantSha && wantSha !== sha256) {
    rmSync(outFile + '.part', { force: true })
    throw new Error(`sha256 不匹配：期望 ${wantSha}，实际 ${sha256}`)
  }
  renameSync(outFile + '.part', outFile)
} catch (e) {
  rmSync(outFile + '.part', { force: true })
  console.error(String(e && e.message || e))
  process.exit(1)
}
const info = inspect(outFile)
console.log(`落盘：${outFile}（${human(bytes)}）sha256=${sha256}`)
console.log(`体检：题目 ${info.questions} 条，带 haystack 的 ${info.withSessions} 条${info.ok ? ' ✓' : ' ✗（结构不符，bench 脚本会报空集）'}`)
if (!info.ok) process.exit(1)
console.log(`下一步：node scripts/bench-longmemeval.mjs --data ${outFile.replace(/\\/g, '/')} --label lme`)
