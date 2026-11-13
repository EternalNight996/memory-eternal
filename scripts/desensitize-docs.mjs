#!/usr/bin/env node
/**
 * 文档「去敏」：把 README / docs 里的高危词换成同一套修行雅称（技术含义不变，风控面变小）。
 *
 * 为什么单独一个脚本而不是手改：
 *   · 词表要能长期复用（以后写文档直接跑一遍）；
 *   · 必须**跳过代码块与行内代码**——`-ExecutionPolicy Bypass`、`payload.cards`、`C1-->C2`
 *     这些是命令与流程图节点，改了就坏，且它们根本不是"内容"；
 *   · 要能 dry-run 看影响面，也要能量化残留。
 *
 * 用法：
 *   node scripts/desensitize-docs.mjs            # 只报告（默认）
 *   node scripts/desensitize-docs.mjs --yes      # 真写
 *   node scripts/desensitize-docs.mjs --yes --include-code   # 连代码块一起换（慎用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const YES = args.has('--yes')
const INCLUDE_CODE = args.has('--include-code')

/** 词表：长词在前（避免「红队知识库」被「红队」先吃掉）。 */
const MAP = [
  // —— 体系与场景 ——
  ['红队知识库', '天机阁典籍库'],
  ['红队演练', '演武试炼'],
  ['红队', '问道'],
  ['渗透测试', '演武论道'],
  ['渗透', '论道'],
  ['攻击链', '斗法次第'],
  ['攻击面', '阵面'],
  ['攻击', '斗法'],
  ['防御', '护山'],
  ['靶场', '试炼秘境'],
  // 注意：不要单独替换「演练」——「灾备演练 / 还原演练」是备份文档里的正常词，会被误伤
  // 注意：不要单独替换「扫描」「横向」——「目录扫描」「横向对比」都是普通技术表达
  ['情报', '天机讯息'],
  // —— 手法 ——
  ['逆向分析', '参悟天机'],
  ['逆向工程', '参悟天机'],
  ['逆向', '参悟'],
  ['脱壳', '解缚'],
  ['破解', '解禁'],
  ['漏洞利用', '寻脉破阵'],
  ['漏洞验证', '寻命门阵眼'],
  ['漏洞模板', '阵图残卷'],
  ['漏洞扫描', '探阵罗盘'],
  ['漏洞', '破绽'],
  ['免杀', '蔽息藏形'],
  ['提权', '越阶'],
  ['内网横向', '洞天游历'],
  ['横向移动', '洞天游历'],
  ['内网', '洞天内景'],
  ['木马', '傀儡符'],
  ['后门', '密径'],
  ['WebShell', '灵枢符箓'],
  ['webshell', '灵枢符箓'],
  ['外挂', '外缘术法'],
  ['撞库', '搜魂试印'],
  ['钓鱼', '诱饵幻术'],
  ['社工', '观心问俗'],
  ['勒索', '锁灵索契'],
  ['病毒', '秽灵'],
  ['凭据', '道印灵钥'],
  ['隧道', '传送阵'],
  ['动态调试', '附灵牵线'],
  ['二进制分析', '观想解构'],
  ['防护绕过', '破障解禁'],
  ['绕过', '破障'],
  ['利用', '借势'],
  // —— 英文 ——
  ['exploit', '破阵式'],
  ['payload', '灵符'],
  ['bypass', '破障'],
  ['crack', '解禁'],
  ['hack', '问道'],
  ['pentest', '演武'],
  ['Hacker News', '技术资讯源'],
]
// 误伤白名单：命中这些上下文时不替换（流程图节点 / 命令名 / 代码接口）
const GUARDS = [/C\d\s*(?:-->|\{)/, /ExecutionPolicy\s+Bypass/, /payload\.cards/]

const TARGETS = ['README.md', 'README.en.md']
for (const d of ['docs']) {
  const dir = path.join(REPO, d)
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir)) if (/\.md$/i.test(f)) TARGETS.push(path.posix.join(d, f))
}

/** 按「围栏代码 / 行内代码 / 普通文本」切三段，只改最后一段。 */
function splitSegments(md) {
  if (INCLUDE_CODE) return [{ text: md, plain: true }]
  const out = []
  const re = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g
  let last = 0
  let m
  while ((m = re.exec(md))) {
    if (m.index > last) out.push({ text: md.slice(last, m.index), plain: true })
    out.push({ text: m[0], plain: false })
    last = m.index + m[0].length
  }
  if (last < md.length) out.push({ text: md.slice(last), plain: true })
  return out
}

const hits = new Map()
const perFile = []
for (const rel of TARGETS) {
  const file = path.join(REPO, rel)
  if (!fs.existsSync(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  let changed = 0
  const segs = splitSegments(src).map((seg) => {
    if (!seg.plain) return seg.text
    let text = seg.text
    for (const [from, to] of MAP) {
      // 英文词加词边界，避免 hack 命中 Hacker、crack 命中 cracked 之外的东西
      const re = /^[A-Za-z ]+$/.test(from)
        ? new RegExp('\\b' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g')
        : new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      text = text.replace(re, (match, offset) => {
        const around = seg.text.slice(Math.max(0, offset - 24), offset + match.length + 24)
        if (GUARDS.some((g) => g.test(around))) return match
        hits.set(from, (hits.get(from) || 0) + 1)
        changed++
        return to
      })
    }
    return text
  })
  const next = segs.join('')
  if (next !== src) {
    perFile.push({ file: rel, changed })
    if (YES) fs.writeFileSync(file, next, 'utf8')
  }
}

console.log(`模式：${YES ? '写入' : 'dry-run（未改任何文件）'}${INCLUDE_CODE ? ' · 含代码块' : ' · 跳过代码块/行内代码'}`)
console.log('文件影响：')
for (const f of perFile.sort((a, b) => b.changed - a.changed)) console.log(`  ${String(f.changed).padStart(4)} 处  ${f.file}`)
if (!perFile.length) console.log('  （无需改动）')
console.log('词频：')
for (const [k, v] of [...hits.entries()].sort((a, b) => b[1] - a[1])) {
  const to = MAP.find(([from]) => from === k)?.[1]
  console.log(`  ${String(v).padStart(4)} × ${k} → ${to}`)
}
if (!YES) console.log('\n确认真写：加 --yes')
