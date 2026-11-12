#!/usr/bin/env node
// 生成召回金标集（bench/golden-recall.json）。
//
// 为什么这么做：没有标注数据就无法判断「优化有没有用」。这里用三种成本可控的方式造题：
//   1. title  —— 用卡片标题当查询（考标题命中，权重 8 的那一路）
//   2. body   —— 从正文抽一句 12~60 字的陈述当查询（考正文内容召回）
//   3. noisy  —— 在 body 句外包一层口语壳（「请问…是怎么处理的？」），考停用词/功能词鲁棒性
//   4. natural—— 人工写的 10 条真实问法（含同义改写），考查询理解
//
// 已知局限（必须写进报告）：自动题与卡片原文共享字面，分数会偏高；只有 natural 那 10 条接近真实难度。
// 用法：node scripts/make-golden.mjs --vault <含 memory-eternal.db 的目录> [--out bench/golden-recall.json]
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const home = process.env.USERPROFILE || process.env.HOME || '.'
const vault = opt('vault', path.join(home, '.dsh', 'memory-vault'))
const out = opt('out', path.join('bench', 'golden-recall.json'))
const SEED = Number(opt('seed', 42))

// 确定性 PRNG：同一快照每次生成同一套题，前后对比才公平。
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(SEED)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

const db = new DatabaseSync(path.join(vault, 'memory-eternal.db'), { readOnly: true })
// 排除 skill 卡：它们是「技能信息」模板（提供方/技能文件/模型可调用），正文几乎同构，
// 拿它出题只会测到模板词而不是记忆内容。
const rows = db.prepare(`
  SELECT path, title, body FROM cards
  WHERE deleted_at IS NULL AND length(body) >= 140 AND title <> ''
    AND kind <> 'skill'
    AND title NOT LIKE '%====%'
`).all()
db.close()
if (!rows.length) {
  console.error('没有可用的卡片；检查 --vault')
  process.exit(1)
}

const CJK = /[\u4e00-\u9fff]/g
const BOILER = /(提供方|技能文件|模型可调用|用户可调用|来源：|路径：|技能信息|http)/i
const sentences = (body) => String(body || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .split(/[。！？；\n]+/)
  .map((s) => s.replace(/[#>*_`|\[\]()]/g, ' ').replace(/\s+/g, ' ').trim())
  .filter((s) => {
    const cjk = (s.match(CJK) || []).length
    return s.length >= 12 && s.length <= 80 && cjk >= 8 && !BOILER.test(s) && !/^[-*\d]/.test(s)
  })

const cases = []
const seen = new Set()
const usedPaths = new Set()

// 1) title 题：30 条
let guard = 0
while (cases.filter((c) => c.kind === 'title').length < 30 && guard++ < 5000) {
  const r = pick(rows)
  const q = r.title.trim()
  if (usedPaths.has(r.path) || seen.has(q)) continue
  if (q.length < 6 || (q.match(/[\u4e00-\u9fff]/g) || []).length < 4) continue
  seen.add(q); usedPaths.add(r.path)
  cases.push({ id: 't' + cases.length, kind: 'title', query: q, expected: [r.path] })
}

// 2) body 题：30 条（正文句前 18 字）
guard = 0
while (cases.filter((c) => c.kind === 'body').length < 30 && guard++ < 5000) {
  const r = pick(rows)
  if (usedPaths.has(r.path)) continue
  const ss = sentences(r.body)
  if (!ss.length) continue
  const s = pick(ss)
  const q = s.slice(0, 18).trim()
  if (q.length < 8 || seen.has(q)) continue
  seen.add(q); usedPaths.add(r.path)
  cases.push({ id: 'b' + cases.length, kind: 'body', query: q, expected: [r.path] })
}

// 3) noisy 题：20 条（口语壳 + 正文句 14 字）
guard = 0
while (cases.filter((c) => c.kind === 'noisy').length < 20 && guard++ < 8000) {
  const r = pick(rows)
  const ss = sentences(r.body)
  if (!ss.length) continue
  const s = pick(ss).slice(0, 14).trim()
  if (s.length < 8) continue
  const q = `请问 ${s} 是怎么处理的？`
  if (seen.has(q)) continue
  seen.add(q)
  cases.push({ id: 'n' + cases.length, kind: 'noisy', query: q, expected: [r.path] })
}

// 4b) held-out 题：10 条与调参无关的中性问法（先写题、后跑分，用来验证同义扩展是否过拟合）
const known = new Set(rows.map((r) => r.path))
const heldout = [
  ['开宗请求一直卡着不动是怎么回事', '08-Mistakes/开宗请求卡死客户端90s服务端65s双层超时修复.md'],
  ['首页点应用进不去页面', '08-Mistakes/首页应用mcp-列表页-404-修复buildmjs-补索引页.md'],
  ['Umami 怎么保存访客真实 IP', '03-Knowledge/umami-原始-ip-存储方案ingestion-sidecar.md'],
  ['用 npx 装插件时路径对不上', '03-Knowledge/dsh-插件发布与安装的版本路径陷阱.md'],
  ['help 示例怎么补的', '08-Mistakes/cvte-mes-帮助示例补全与-g-盘同步误报教训.md'],
  ['插件要提交到哪几个市场', '03-Knowledge/dsh-plugin-submit-marketplace-收录与发布流程.md'],
  ['默认验收条件被强加给用户是怎么改的', '03-Knowledge/模式默认值被误当用户验收根因与修复规则.md'],
  ['验证脚本全部 FAIL 怎么排查', '08-Mistakes/cvte-mes-验证脚本-21-项-pc-拆分与-dns-全-fail-排障.md'],
  ['滚动条拖不到底怎么回事', '08-Mistakes/egui-交互命中与滚动条映射三处修复p0-徽标命中thumb-夹取显示真实优先级.md'],
  ['更新按钮位置乱跑怎么固定', '06-BestPractices/dsh-desktop-更新入口固定设置左侧栏底部.md'],
]
for (const [q, p] of heldout) {
  if (!known.has(p)) { console.error('heldout 目标卡不存在，跳过：' + p); continue }
  cases.push({ id: 'h' + cases.length, kind: 'natural2', query: q, expected: [p] })
}

// 4) natural 题：人工写的真实问法（expected 已在快照里核对过存在；一条可对应多张卡）
const natural = [
  ['之前跟 Hindsight 比过一次分数，结论是什么', '03-Knowledge/hindsight-与-memory-eternal-分数对比及评测口径.md'],
  ['Hindsight 和这个插件的定位有什么不同', '03-Knowledge/memory-eternal-与-hindsight-的区别及-v0313-默认参数.md'],
  ['中文两个字搜不到是怎么修的', '03-Knowledge/mengbot-记忆系统中文检索修复cjk-bigram-影子索引.md'],
  ['v0.24 那版检索层改了什么', '02-Projects/v0240-检索层改造fts5-bigram-预切词-增量索引.md'],
  ['端到端召回测试怎么做的', '02-Projects/memory-eternal-端到端召回测试三步骤验证实现经验.md'],
  ['Bitwarden 的 Argon2id 是怎么配的', '02-Projects/mengbot-国产实时语音bitwarden-argon2idlint-清零工程记录.md'],
  ['记忆库跑了 60 天效率怎么样', '03-Knowledge/dsh-memory-记忆库-60-天效率评估结论.md'],
  ['这个插件的职责边界有哪些', '03-Knowledge/记忆插件职责边界与三项可优化点.md'],
  ['findany 日志落盘和双远端发布怎么做的', '02-Projects/findany-日志落盘与双远端发布流程.md'],
  ['memory-eternal 和 mengbot 的记忆系统架构区别', '03-Knowledge/mengbot-与-memory-eternal-记忆系统架构对比.md'],
  ['自动沉淀为什么会被静默关掉', '08-Mistakes/memory-eternal-0314缺键导致自动沉淀召回被静默关闭的修复.md'],
  ['核心记忆常驻注入要花多少 token', '03-Knowledge/核心记忆常驻注入的token成本与设计约束.md'],
  ['待审核卡片时间显示不对是怎么修的', '02-Projects/memory-eternal-55待审核卡片时间时区未本地化修复.md'],
  ['知识图谱星球视图放大掉帧怎么办', '03-Knowledge/知识图谱星球视图放大掉帧优化与公转随机化.md'],
  ['npm 包和 github clone 体积差多少', '02-Projects/memory-eternal-插件-npm-与-github-clone-体积对比.md'],
  ['插件市场收录要提几个 PR', '03-Knowledge/ds插件市场收录-pr提交三大市场踩坑与正确流程.md'],
  ['皮肤一共几套，怎么做响应式的', '02-Projects/memory-eternal-主题皮肤系统defaultpoplight与三端响应式设置页.md'],
  ['评分表里成本效率那列是怎么算的', '03-Knowledge/记忆系统评分表成本效率列方向与各方案实测依据.md'],
  ['长期记忆哪个系统更好用', '03-Knowledge/memory-eternal-与-hindsight-的区别及-v0313-默认参数.md|03-Knowledge/hindsight-与-memory-eternal-分数对比及评测口径.md|03-Knowledge/mengbot-与-memory-eternal-记忆系统架构对比.md'],
]
for (const [q, p] of natural) {
  const paths = p.split('|')
  const missing = paths.filter((x) => !known.has(x))
  if (missing.length) { console.error('natural 目标卡不存在，跳过：' + missing.join(', ')); continue }
  cases.push({ id: 'q' + cases.length, kind: 'natural', query: q, expected: paths })
}

mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ version: 1, seed: SEED, cards: rows.length, cases }, null, 2))
const by = {}
for (const c of cases) by[c.kind] = (by[c.kind] || 0) + 1
console.log('已写入 ' + out + '：' + cases.length + ' 条 ' + JSON.stringify(by) + '（语料 ' + rows.length + ' 张卡）')
