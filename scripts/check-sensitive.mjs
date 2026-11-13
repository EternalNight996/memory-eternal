#!/usr/bin/env node
/**
 * 提交前自检：文档与提交信息里是否还有需要换成雅称的高危词。
 *
 * 与 desensitize-docs.mjs 的分工：
 *   · desensitize 负责**改**（跳代码块）；
 *   · 本脚本负责**查**——查得更狠：连代码块、文件名、以及待提交的 commit message 一起看，
 *     并按「文档 / 代码注释 / 数据标识」分级：文档必须干净，数据标识（tag）在白名单里放行。
 *
 * 用法：
 *   node scripts/check-sensitive.mjs                 # 查 README + docs
 *   node scripts/check-sensitive.mjs --staged        # 只查 git 暂存区里的文件（提交前推荐）
 *   node scripts/check-sensitive.mjs --message "feat(x): ..."   # 额外检查一条提交信息
 *   node scripts/check-sensitive.mjs --strict        # 连代码块也查
 *
 * 退出码：0 = 干净；1 = 有残留（CI / pre-commit 可直接用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const STAGED = argv.includes('--staged')
const STRICT = argv.includes('--strict')
const msgIdx = argv.indexOf('--message')
const MESSAGE = msgIdx >= 0 ? String(argv[msgIdx + 1] || '') : ''

/** 高危词（按长度倒序匹配，报告里给出应有的雅称）。 */
const WORDS = [
  ['红队知识库', '天机阁典籍库'], ['红队', '问道'], ['渗透测试', '演武论道'], ['渗透', '论道'],
  ['攻击链', '斗法次第'], ['攻击面', '阵面'], ['攻击', '斗法'], ['靶场', '试炼秘境'],
  ['逆向分析', '参悟天机'], ['逆向工程', '参悟天机'], ['逆向', '参悟'], ['脱壳', '解缚'], ['破解', '解禁'],
  ['漏洞利用', '寻脉破阵'], ['漏洞验证', '寻命门阵眼'], ['漏洞模板', '阵图残卷'], ['漏洞', '破绽'],
  ['免杀', '蔽息藏形'], ['提权', '越阶'], ['内网横向', '洞天游历'], ['内网', '洞天内景'],
  ['木马', '傀儡符'], ['后门', '密径'], ['WebShell', '灵枢符箓'], ['webshell', '灵枢符箓'],
  ['外挂', '外缘术法'], ['撞库', '搜魂试印'], ['钓鱼', '诱饵幻术'], ['社工', '观心问俗'],
  ['勒索', '锁灵索契'], ['病毒', '秽灵'], ['凭据', '道印灵钥'], ['绕过', '破障'],
  ['exploit', '破阵式'], ['payload', '灵符'], ['bypass', '破障'], ['crack', '解禁'],
  ['hack', '问道'], ['pentest', '演武'], ['Hacker News', '技术资讯源'],
]
/** 放行：数据侧标识（tag / 字段名 / 命令片段），改了会破功能。 */
const ALLOW = [
  /redteam-kb/g,
  /type:(?:sqli|rce|xss|ssrf|xxe|deserialization|unauthorized|file-upload|path-traversal|auth-bypass|weak-password|info-leak|privesc|tunnel|other)/g,
  /skill-type:[a-z-]+/g,
  /knowledge-type:[a-z-]+/g,
  /ExecutionPolicy\s+Bypass/g,
  /payload\.cards/g,
  /C\d\s*(?:-->|\{)/g,
]
/** 整个文件放行：术语对照表天然要列出「工程说法」那一列，它是映射表本身。 */
const ALLOW_FILES = new Set(['docs/GLOSSARY.md'])

const files = []
if (STAGED) {
  let out = ''
  try { out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: REPO, encoding: 'utf8' }) } catch { out = '' }
  for (const rel of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    if (!/\.(md|txt)$/i.test(rel)) continue
    files.push(rel)
  }
} else {
  if (fs.existsSync(path.join(REPO, 'README.md'))) files.push('README.md')
  if (fs.existsSync(path.join(REPO, 'README.en.md'))) files.push('README.en.md')
  const docs = path.join(REPO, 'docs')
  if (fs.existsSync(docs)) for (const f of fs.readdirSync(docs)) if (/\.md$/i.test(f)) files.push(path.posix.join('docs', f))
}

function scan(text, label) {
  let s = String(text)
  if (!STRICT) {
    // 非严格模式仍跳过围栏代码块与行内代码（那是命令，不是叙述）
    s = s.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(0) + m.replace(/[^\n]/g, ' '))
    s = s.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
  }
  for (const re of ALLOW) s = s.replace(re, (m) => ' '.repeat(m.length))
  const found = []
  for (const [w, to] of WORDS) {
    const re = /^[A-Za-z ]+$/.test(w) ? new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi') : new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    const lines = []
    let m
    while ((m = re.exec(s))) {
      const line = s.slice(0, m.index).split('\n').length
      lines.push(line)
      if (lines.length >= 5) break
    }
    if (lines.length) found.push({ word: w, to, lines, count: lines.length })
  }
  if (found.length) {
    console.log('✗ ' + label)
    for (const f of found) console.log(`    ${f.word} → ${f.to}  行 ${f.lines.join(', ')}${f.count >= 5 ? ' …' : ''}`)
  }
  return found.length
}

let bad = 0
for (const rel of files) {
  if (ALLOW_FILES.has(rel)) continue
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs)) continue
  bad += scan(fs.readFileSync(abs, 'utf8'), rel)
}
if (MESSAGE) bad += scan(MESSAGE, 'commit message')

console.log(bad ? `\n共 ${bad} 类残留，改法见 docs/GLOSSARY.md（或跑 node scripts/desensitize-docs.mjs --yes）` : '✓ 干净：没有高危词残留')
process.exit(bad ? 1 : 0)
