#!/usr/bin/env node
// Memory Atlas TUI —— 完整交互原型
// node dsh-tui-plugin/demo.mjs
// 静态帧：node dsh-tui-plugin/demo.mjs --once --no-color
// 全选预览：node dsh-tui-plugin/demo.mjs --once --no-color --select-all
//
// 示例数据，不连接真实 vault，不写任何卡片。

import readline from 'node:readline'

const C = {
  reset: '\x1b[0m',
  ember: '\x1b[38;2;255;122;69m',
  green: '\x1b[38;2;74;222;128m',
  red: '\x1b[38;2;248;113;113m',
  amber: '\x1b[38;2;251;191;36m',
  blue: '\x1b[38;2;122;162;255m',
  violet: '\x1b[38;2;183;156;255m',
  cyan: '\x1b[38;2;103;232;249m',
  pink: '\x1b[38;2;244;114;182m',
  text: '\x1b[38;2;236;238;242m',
  dim: '\x1b[38;2;126;135;146m',
  faint: '\x1b[38;2;86;95;107m',
  selectedBg: '\x1b[48;2;54;44;40m',
  chipBg: '\x1b[48;2;66;44;37m',
  keyBg: '\x1b[48;2;46;51;60m',
  calloutBg: '\x1b[48;2;38;42;49m',
  border: '\x1b[38;2;72;80;91m',
}

const KIND = {
  project: { label: '项目', color: C.blue, mark: '◆' },
  knowledge: { label: '知识', color: C.violet, mark: '◇' },
  mistake: { label: '教训', color: C.red, mark: '▲' },
  content: { label: '内容', color: C.pink, mark: '▣' },
  tool: { label: '工具', color: C.cyan, mark: '⚙' },
  prompt: { label: '提示词', color: C.amber, mark: '✦' },
}

const SCREENS = {
  library: { label: '记忆库', num: 1 },
  audit: { label: '待审', num: 2 },
  graph: { label: '知识星图', num: 3 },
  status: { label: '运行状态', num: 4 },
  recycle: { label: '回收站', num: 5 },
  settings: { label: '设置', num: 6 },
  reader: { label: '读卡器', num: 0 },
}

const CARDS = [
  {
    id: 'memory-eternal-v5', kind: 'project', title: 'memory-eternal V5 收口：跨宿主入口',
    source: 'deepseek-harness', time: '10:52', tags: ['memory-eternal', 'V5', 'UI'],
    summary: '一套 Web UI 作为唯一真源，各宿主只做 Launcher；能内嵌的用 Webview，不能内嵌的只做启动器。',
    body: [
      '变更结论', '1. 记忆库改成 4 列卡片 + 今日回看', '2. 待审改成顶部类型条 + 右侧判词',
      '3. 星图默认缩小，DPR/网格/边优化', '4. 读卡器补目录与相关记忆', '',
      '边界', '· 不复制第二套 UI', '· 不新增 agent 审批权限', '· 不修改 DSH 官方源码',
    ],
  },
  {
    id: 'mvcheck-camera', kind: 'knowledge', title: 'MVCheck 多相机独立成像参数',
    source: 'deepseek-harness', time: '10:48', tags: ['MVCheck', '相机', '多视角'],
    summary: '每路相机独立 SDK 实例，shared_sdk 降级为运行库保活；按序列号绑定，不再全局覆盖。',
    body: [
      '根因', '· 全局 shared_sdk 只有一个 handle', '· 打开第二台时覆盖第一台句柄',
      '· 关闭只释放自己的句柄，真正资源仍被占用', '', '修复',
      '· shared_sdk 降级为运行库保活', '· open/close 按序列号去重', '· 全局覆盖前检测占用并提示',
    ],
  },
  {
    id: 'shj-port', kind: 'mistake', title: 'shj-web 端口菜单错位与 client 断连',
    source: 'deepseek-harness', time: '10:43', tags: ['shj-platform', 'shj-web', '布局'],
    summary: '端口菜单被侧栏删除后，client 仍等待旧端口事件；恢复菜单并补一条回归检查。',
    body: [
      '现象', '· client 一直显示连接中', '· 端口菜单入口消失', '', '处理',
      '· 恢复「端口管理」菜单', '· 回归：打开菜单 → 连接 → 刷新',
    ],
  },
  {
    id: 'cursor-webview', kind: 'project', title: 'Cursor Webview 扩展：Memory Atlas',
    source: 'codex', time: '10:38', tags: ['Cursor', 'Webview', '扩展'],
    summary: 'Activity Bar 增加 Memory Atlas，用 Webview 加载同一套 7999 页面，版本与 DSH/Web 一致。',
    body: [
      '实现', '· contributes.viewsContainers.activitybar', '· contributes.views type=webview',
      '· iframe 127.0.0.1:7999', '', '注意', '· Web 服务需要先运行', '· 不复制第二套前端',
    ],
  },
  {
    id: 'orca-panel', kind: 'project', title: 'Orca 右侧栏记忆面板',
    source: 'deepseek-harness', time: '10:31', tags: ['Orca', 'Panel', 'Launcher'],
    summary: 'Orca 官方 panel + terminal.sendText，打开 Memory Atlas；CSP 禁止 iframe，所以是启动器。',
    body: [
      '能力', '· 右侧栏「记忆」', '· 选择终端', '· 执行 orca tab create / dsh-memory open',
      '', '限制', '· panel 不能 iframe 127.0.0.1:7999', '· 不能 fetch 本地 API',
    ],
  },
  {
    id: 'readme', kind: 'content', title: 'README 平台支持表',
    source: 'deepseek-harness', time: '10:24', tags: ['README', '平台', '发布'],
    summary: 'DSH / Orca / dsh-tui / Codex / Claude / Cursor / Web 一张表；能内嵌的 Webview，不能的 Launcher。',
    body: [
      '原则', '· 一套 Web UI 唯一真源', '· 版本统一', '· 不复制 UI', '',
      '入口', '· DSH 左栏', '· Orca 右侧栏', '· dsh-tui /memory', '· Codex / Claude skill', '· Cursor Activity Bar',
    ],
  },
  {
    id: 'longform', kind: 'content', title: '长文复盘：Memory Atlas 的一年',
    source: 'deepseek-harness', time: '10:18', tags: ['长文', '复盘', 'V5'],
    summary: '从一张知识卡到一个跨宿主记忆系统：这是一篇故意写长的读卡器样例，用来测试目录、换行和滚动。',
    body: [
      '背景',
      '这个项目最开始并不叫 Memory Atlas。它只是 DSH 会话结束后的一段收尾动作：把值得留下的决定、踩过的坑和还没做完的事，写成一张卡片。',
      '后来卡片越来越多，问题开始出现。不是“记不住”，而是“记得太多”。同一个决定有三种说法，同一个 bug 有三个版本，同一个方案在不同项目里重复出现。',
      '于是我们做了一个现在看起来很自然的决定：把记忆当成一个需要被整理、被审核、被再次阅读的资产，而不是聊天记录旁边的一堆附件。',
      '',
      '变更结论',
      '第一，卡片必须有类型。项目、知识、教训、内容、工具、提示词，不是装饰，而是检索和批驳时最基本的上下文。',
      '第二，沉淀和审核必须分开。自动沉淀负责“先记下来”，审核负责“决定它是否值得长期保留”。这两件事如果混在一起，人就会在错误的时间做错误的判断。',
      '第三，一套 Web UI 作为唯一真源。DSH 左栏、Orca 右侧栏、Cursor Webview、浏览器，都打开同一套界面。能内嵌的用 Webview，不能内嵌的只做启动器，不复制第二套前端。',
      '第四，版本必须对齐。宿主、常驻服务、npm 包、Web 静态资源，任何一个版本漂移，用户看到的行为就会不一致。',
      '',
      '实现',
      '记忆库使用卡片网格。每张卡展示类型、标题、摘要、标签和更新时间；今日回看放在最上面，用少量空间提醒“最近有什么值得再看一眼”。',
      '待审页面使用顶部类型条 + 左侧队列 + 右侧判词。判词不是弹窗，因为弹窗会遮住上下文；右侧栏可以同时看到队列位置、卡片正文和批准/驳回按钮。',
      '知识星图没有做复杂画布，而是先做连接簇和邻接表。对大多数用户来说，“这张卡和哪些卡有关”比“让我拖动一千个节点”更有用。',
      '读卡器负责长内容。目录在右侧，相关记忆在下面，正文支持换行和滚动。一篇文章可以很长，但界面不能因此变成一堵墙。',
      '',
      '边界',
      '· 不复制第二套 UI。Web 端是唯一实现，宿主只做容器或启动器。',
      '· 不新增 agent 审批权限。批准和驳回必须由人完成。',
      '· 不修改 DSH 官方源码。所有扩展都走插件和公开接口。',
      '· 不为了“看起来完整”而牺牲可维护性。终端 UI 可以少一点效果，但不能多一套数据逻辑。',
      '',
      '限制',
      'Orca 的 panel CSP 禁止 iframe 和 connect-src，所以右侧栏只能做启动器，完整 UI 仍在 Orca 内置浏览器或外部浏览器。',
      'dsh-tui 没有 WebView，所以只能打开浏览器，或者做终端原生 TUI。终端原生不是 Web UI 的像素级复刻，而是同一套信息架构在字符网格里的重排。',
      'Codex 和 Claude Code 的官方入口是 skill/command，没有通用侧栏；Cursor 的 Webview 才是真正可内嵌的宿主。',
      '',
      '原则',
      '先让人看见，再让人决定。自动沉淀只负责让卡片出现，审核负责让卡片留下。',
      '先做少而准的入口，再做多而全的适配。一个能用的启动器，比一个假的“内嵌”更诚实。',
      '先统一数据，再统一外观。外观可以每个宿主不同，卡片、队列、审核结果必须相同。',
      '',
      '验证',
      '长文读卡器要验证三件事：目录是否完整、正文是否换行、滚动是否跟手。这个样例故意超过一屏，用来暴露分页、截断和滚动边界的问题。',
      '如果目录里的章节和正文对不上，或者滚动到底部时最后一行被吞掉，说明读卡器的视口计算还需要修。',
      '',
      '复盘',
      '这一年最大的变化不是 UI 变漂亮了，而是我们终于把“记忆”当成一个完整生命周期：产生、沉淀、审核、阅读、关联、回收。',
      '当这六个动作都能被看见，记忆库就不再是一个搜索结果页，而是一个可以反复回来的地方。',
      '',
      '下一步',
      '把终端原型接进 dsh-tui 的真实场景，复用同一套审核守卫；把读卡器的滚动、目录和长文换行先打磨好，再谈更多宿主。',
      '慢一点，但每一张卡都算数。',
    ],
  },
]
const RECYCLE = [
  { title: '旧版 V5 布局草稿', kind: 'content', time: '昨天 18:20', reason: '过期方案' },
  { title: '端口菜单临时修复', kind: 'mistake', time: '10-20 09:12', reason: '已合并' },
  { title: 'Orca panel iframe 尝试', kind: 'project', time: '10-19 22:40', reason: 'CSP 阻塞' },
]

const SETTINGS = [
  { label: '自动沉淀', detail: '对话结束后写入知识卡', value: '开' },
  { label: '失败提醒', detail: '沉淀失败时提示', value: '开' },
  { label: '审核后批准', detail: '批准即写入正式库', value: '开' },
  { label: '回收站保留', detail: '自动清理时间', value: '30 天' },
  { label: '主题', detail: 'Memory Atlas 配色', value: '余烬橙' },
  { label: '匿名统计', detail: '只统计运行状态', value: '关' },
]

const argv = new Set(process.argv.slice(2))
const once = argv.has('--once')
const selectAllAtStart = argv.has('--select-all')
const liveMode = argv.has('--live')
const writeMode = argv.has('--write')
const API = process.env.MEMORY_ETERNAL_API || 'http://127.0.0.1:7999/memory-eternal/api'
const screenArg = (process.argv.find((a) => a.startsWith('--screen=')) || '').split('=')[1]
const scrollArg = Number((process.argv.find((a) => a.startsWith('--scroll=')) || '').split('=')[1] || 0)
const useColor = !argv.has('--no-color') && !process.env.NO_COLOR

const sgr = (code, text) => (useColor ? code + text + C.reset : text)
const tone = (text, fg, bg = '') => (useColor ? `${fg || ''}${bg}${text}${C.reset}` : text)
const keycap = (key, label) => tone(` ${key} `, C.text, C.keyBg) + (label ? ' ' + sgr(C.dim, label) : '')

function charWidth(ch) {
  const cp = ch.codePointAt(0)
  if (cp === 0x200b || cp === 0xfe0f) return 0
  if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff))) return 2
  return 1
}
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
const width = (s) => [...plain(s)].reduce((n, ch) => n + charWidth(ch), 0)

function clip(s, max) {
  let out = '', n = 0
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
      if (m) { out += m[0]; i += m[0].length; continue }
    }
    const ch = String.fromCodePoint(s.codePointAt(i))
    const w = charWidth(ch)
    if (n + w > max) break
    out += ch; n += w; i += ch.length
  }
  return out + (useColor && out.includes('\x1b[') ? C.reset : '')
}
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))
const wrap = (text, n) => {
  const lines = []; let line = '', used = 0
  for (const ch of String(text)) {
    const w = charWidth(ch)
    if (used + w > n) { lines.push(line); line = ''; used = 0 }
    line += ch; used += w
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function panel(title, lines, w, h, accent = C.border) {
  const inner = Math.max(1, w - 2)
  const t = ' ' + title + ' '
  const top = sgr(accent, '╭─') + sgr(accent, t) + sgr(accent, '─'.repeat(Math.max(0, inner - width(t))) + '╮')
  const bottom = sgr(accent, '╰' + '─'.repeat(inner) + '╯')
  const body = []
  for (let i = 0; i < h - 2; i++) body.push(sgr(C.border, '│') + pad(clip(lines[i] || '', inner), inner) + sgr(C.border, '│'))
  return [top, ...body, bottom].join('\n')
}

const kindOf = (c) => KIND[c.kind] || KIND.project
const filtered = (state) => {
  const q = state.query.trim().toLowerCase()
  const base = state.screen === 'library' ? (state.libraryCards || state.cards) : state.cards
  return base.filter((c) => {
    if (state.kind !== 'all' && c.kind !== state.kind) return false
    if (!q) return true
    return (c.title + ' ' + c.summary + ' ' + c.tags.join(' ')).toLowerCase().includes(q)
  })
}

function typeRow(state, w) {
  const labels = [['全部', 'all'], ['项目', 'project'], ['知识', 'knowledge'], ['教训', 'mistake'], ['内容', 'content'], ['工具', 'tool'], ['提示词', 'prompt']]
  const base = state.screen === 'library' ? (state.libraryCards || state.cards) : state.cards
  const line = sgr(C.faint, '类型  ') + labels.map(([label, key]) => {
    const active = state.kind === key
    const count = key === 'all' ? base.length : base.filter((c) => c.kind === key).length
    return tone(` ${active ? '●' : '○'} ${label} ${count} `, active ? C.text : C.dim, active ? C.chipBg : '')
  }).join(' ')
  return ' ' + clip(line + '   ' + sgr(C.faint, '←→ 类型'), w - 1)
}

function searchRow(state, w) {
  const text = state.searchMode ? state.query + '▌' : (state.query || '搜索记忆、标签…')
  return ' ' + sgr(C.faint, '/ ') + sgr(state.searchMode ? C.text : C.faint, text) + '   ' + sgr(C.faint, 'Enter 确认 · Esc 清空')
}

function queueLines(cards, state, w) {
  if (!cards.length) return ['', sgr(C.green, '  ✓ 没有匹配的卡片'), '', sgr(C.dim, '  按 Esc 清空搜索 / 筛选')]
  const lines = []
  const chosen = cards.filter((c) => state.marked.has(c.id)).length
  const all = cards.length > 0 && chosen === cards.length
  lines.push(`  ${all ? sgr(C.ember, '▣') : sgr(C.faint, '☐')} ${sgr(C.dim, all ? '反选' : '全选')} ${cards.length}    ${chosen ? sgr(C.amber, '已选 ' + chosen) : sgr(C.faint, '已选 0')}    ${keycap('s', all ? '反选' : '全选')}`)
  lines.push('')
  cards.forEach((card, i) => {
    const k = kindOf(card)
    const selected = i === state.index
    const marked = state.marked.has(card.id)
    const marker = marked ? sgr(C.amber, '◉') : sgr(C.faint, '○')
    const lead = selected ? sgr(C.ember, '▌') : ' '
    let line = `${lead}${marker} ${tone(' ' + k.mark + ' ', k.color, selected ? C.selectedBg : '')} ${sgr(k.color, '[' + k.label + ']')}  ${sgr(C.text, card.title)}`
    line = clip(line, w)
    if (selected) line = tone(pad(line, w), C.text, C.selectedBg)
    lines.push(line)
    let meta = `   ${sgr(C.faint, card.source)} ${sgr(C.faint, '·')} ${sgr(C.dim, card.time)}   ${sgr(C.amber, '待审')}`
    if (selected) meta = tone(pad(clip(meta, w), w), '', C.selectedBg)
    lines.push(clip(meta, w))
    lines.push('')
  })
  return lines
}

function previewLines(card, w) {
  if (!card) return [sgr(C.dim, '没有可预览的卡片')]
  const k = kindOf(card)
  const inner = Math.max(8, w - 2)
  const lines = [
    tone(' ' + k.mark + ' ' + k.label + ' ', k.color, C.chipBg) + tone(' 待审核 ', C.amber, C.chipBg) + sgr(C.faint, '  ' + card.time + '  ' + card.source),
    '', sgr(C.text, card.title), '',
    tone(' 判词 ', C.ember, C.chipBg) + '  ' + sgr(C.dim, '原文') + '  ' + sgr(C.dim, '相关'), '',
  ]
  for (const part of wrap('摘要  ' + card.summary, inner)) lines.push(tone(part, C.text, C.calloutBg))
  lines.push('', card.tags.map((t) => tone(' #' + t + ' ', C.ember, C.chipBg)).join(' '), '', sgr(C.border, '─'.repeat(inner)), '')
  const headings = /^(变更结论|根因|现象|处理|修复|边界|实现|限制|能力|原则|入口|注意|背景|验证)$/
  for (const line of card.body) {
    if (!line) { lines.push(''); continue }
    lines.push(headings.test(line) ? sgr('\x1b[1m' + C.ember, line) : line.startsWith('·') ? sgr(C.dim, line) : sgr(C.text, line))
  }
  const related = CARDS.filter((c) => c.id !== card.id).slice(0, 2)
  if (related.length) {
    lines.push('', sgr(C.dim, '相关记忆'))
    for (const r of related) lines.push(`${sgr(kindOf(r).color, '→')} ${sgr(C.dim, r.title)}`)
  }
  lines.push('', [keycap('a', '批准'), keycap('r', '驳回'), keycap('Space', '多选')].join('   '))
  return lines
}

function auditView(state, w, h) {
  const cards = filtered(state)
  const selected = cards[state.index]
  const qw = Math.max(40, Math.floor((w - 1) * 0.4))
  const pw = w - qw - 1
  const ph = h - 2
  const q = panel(`队列 ${cards.length}${state.marked.size ? ' ◉' + state.marked.size : ''}`, queueLines(cards, state, qw - 2), qw, ph)
  const p = panel('判词', previewLines(selected, pw - 2), pw, ph, C.ember)
  const ql = q.split('\n'), pl = p.split('\n')
  const out = [typeRow(state, w), '']
  for (let i = 0; i < Math.max(ql.length, pl.length); i++) out.push((ql[i] || ' '.repeat(qw)) + ' ' + (pl[i] || ' '.repeat(pw)))
  return out.slice(0, h)
}

function cardRow(card, selected, w, compact) {
  const k = kindOf(card)
  const lead = selected ? sgr(C.ember, '▌') : ' '
  let line = `${lead} ${tone(' ' + k.mark + ' ', k.color, selected ? C.selectedBg : '')} ${sgr(k.color, '[' + k.label + ']')}  ${sgr(C.text, card.title)}`
  if (selected) line = tone(pad(clip(line, w), w), C.text, C.selectedBg)
  const meta = `   ${sgr(C.faint, card.source)} ${sgr(C.faint, '·')} ${sgr(C.dim, card.time)}  ${card.tags.slice(0, 3).map((t) => sgr(C.ember, '#' + t)).join(' ')}`
  return [clip(line, w), selected ? tone(pad(clip(meta, w), w), '', C.selectedBg) : clip(meta, w)]
}

function libraryView(state, w, h) {
  const cards = filtered(state)
  const lines = [typeRow(state, w), '', searchRow(state, w), '']
  const feature = cards[0] || CARDS[0]
  lines.push(`${sgr(C.ember, '✦ 今日回看')}   ${sgr(C.text, feature.title)}`)
  lines.push(`  ${sgr(C.dim, feature.summary)}`)
  lines.push(`  ${feature.tags.map((t) => tone(' #' + t + ' ', C.ember, C.chipBg)).join(' ')}`)
  lines.push('', sgr(C.border, '─'.repeat(Math.max(1, w - 2))), '')
  lines.push(`${sgr(C.dim, '全部记忆')}  ${sgr(C.faint, cards.length + ' 张 · 按 Enter 读卡')}`)
  lines.push('')
  cards.forEach((card, i) => {
    lines.push(...cardRow(card, i === state.index, w - 2, true))
    lines.push('')
  })
  return [panel('记忆库', lines, w, h, C.border)]
}

function readerView(state, w, h) {
  const card = state.readerCard || CARDS.find((c) => c.id === 'longform') || CARDS[0]
  const k = kindOf(card)
  const left = Math.max(40, Math.floor((w - 1) * 0.66))
  const right = w - left - 1
  const inner = Math.max(12, left - 4)
  const all = [
    tone(' ' + k.mark + ' ' + k.label + ' ', k.color, C.chipBg) + tone(' 长文 ', C.amber, C.chipBg) + sgr(C.faint, '  ' + card.time + '  ' + card.source),
    '', sgr(C.text, card.title), '',
    ...wrap(card.summary, inner).map((l) => sgr(C.dim, l)),
    '', sgr(C.border, '─'.repeat(inner)), '',
  ]
  const headings = /^(背景|变更结论|实现|边界|限制|原则|验证|复盘|下一步|根因|现象|处理|修复|能力|入口|注意)$/
  for (const line of card.body) {
    if (!line) { all.push(''); continue }
    if (headings.test(line)) {
      all.push('', sgr('\x1b[1m' + C.ember, line), '')
    } else if (line.startsWith('·')) {
      all.push(...wrap(line, inner).map((l) => sgr(C.dim, l)))
    } else {
      all.push(...wrap(line, inner).map((l) => sgr(C.text, l)))
    }
  }
  const page = Math.max(4, h - 2)
  const maxScroll = Math.max(0, all.length - page)
  const scroll = Math.min(Math.max(0, state.readerScroll || 0), maxScroll)
  state.readerScroll = scroll
  state.readerMax = maxScroll
  const toc = [sgr(C.dim, '目录'), '']
  const heads = card.body.filter((l) => headings.test(l))
  heads.forEach((head, i) => toc.push(`${sgr(C.faint, String(i + 1).padStart(2, '0'))}  ${sgr(C.text, head)}`))
  toc.push('', sgr(C.dim, '相关记忆'))
  CARDS.filter((c) => c.id !== card.id).slice(0, 3).forEach((r) => toc.push(`${sgr(kindOf(r).color, '→')} ${sgr(C.dim, r.title)}`))
  toc.push('', sgr(C.faint, `第 ${scroll + 1}-${Math.min(all.length, scroll + page)} 行 / 共 ${all.length} 行`))
  const l = panel(`读卡器 · ${scroll + 1}-${Math.min(all.length, scroll + page)}/${all.length}`, all.slice(scroll, scroll + page), left, h, C.ember)
  const r = panel('目录 / 相关', toc, right, h)
  const ll = l.split('\n'), rl = r.split('\n')
  const out = []
  for (let i = 0; i < Math.max(ll.length, rl.length); i++) out.push((ll[i] || ' '.repeat(left)) + ' ' + (rl[i] || ' '.repeat(right)))
  return out.slice(0, h)
}

function graphView(state, w, h) {
  const data = state.graphData
  const nodes = Array.isArray(data?.nodes) ? data.nodes : []
  const edges = Array.isArray(data?.edges) ? data.edges : []
  const node = nodes[state.graphIndex] || nodes[0]
  const counts = {}
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1
  const labels = [['项目', 'project', C.blue], ['知识', 'knowledge', C.violet], ['内容', 'content', C.pink], ['教训', 'mistake', C.red], ['工具', 'tool', C.cyan], ['提示词', 'prompt', C.amber]]
  const lines = [sgr(C.ember, '知识星图'), `${sgr(C.dim, `${nodes.length} 节点 · ${edges.length} 连线`)}`, '', sgr(C.dim, '连接簇')]
  labels.forEach(([label, key, color]) => lines.push(`  ${sgr(color, '●')} ${sgr(C.text, label).padEnd(8)} ${sgr(C.dim, String(counts[key] || 0))}`))
  lines.push('', sgr(C.border, '─'.repeat(Math.max(1, w - 2))), '', `${sgr(C.dim, '选中')}  ${sgr(C.text, node?.title || '暂无节点')}`)
  if (node) {
    const rel = []
    for (const e of edges) {
      if (e.source === node.id) rel.push(e.target)
      else if (e.target === node.id) rel.push(e.source)
    }
    const byId = new Map(nodes.map((n) => [n.id, n]))
    lines.push(`  ${sgr(C.dim, `↔ ${rel.length} 张相连`)}  ${(node.tags || []).slice(0, 4).map((t) => sgr(C.ember, '#' + t)).join(' ')}`, '', sgr(C.dim, '相关卡片'))
    rel.slice(0, 4).forEach((id) => {
      const r = byId.get(id)
      if (r) lines.push(`${sgr(kindOf(r).color, '→')} ${sgr(C.dim, r.title)}`)
    })
  }
  return [panel('知识星图', lines, w, h, C.violet)]
}

function statusView(state, w, h) {
  const o = state.overview
  const total = o?.total ?? state.libraryCards?.length ?? 0
  const backups = o?.backups?.count ?? 0
  const version = o?.version || '—'
  const pending = o?.quarantine?.pending ?? state.cards.length
  const rejected = o?.quarantine?.rejected ?? 0
  const deleted = o?.quarantine?.deleted ?? state.recycle.length
  const recent = o?.recent ?? 0
  const dbOk = o?.db?.writable !== false
  const lines = [
    `${sgr(C.ember, '●')} ${sgr(C.text, '记忆库')} ${sgr(C.amber, String(total))}     ${sgr(C.dim, '备份')} ${sgr(C.text, String(backups))}     ${sgr(C.dim, '版本')} ${sgr(C.text, version)}`,
    `${sgr(dbOk ? C.green : C.red, '●')} ${sgr(C.text, '数据库')} ${sgr(dbOk ? C.green : C.red, dbOk ? '可写' : '不可写')}   ${sgr(C.dim, '近 7 天')} ${sgr(C.text, String(recent))}   ${sgr(C.dim, '待审')} ${sgr(C.text, String(pending))}`,
    '', sgr(C.border, '─'.repeat(Math.max(1, w - 2))), '', sgr(C.dim, '队列'),
    `${sgr(C.amber, String(pending))} 张待审    ${sgr(C.red, String(rejected))} 张已驳回    ${sgr(C.dim, String(deleted))} 张回收站`,
    '', sgr(C.dim, '库根目录'), `${sgr(C.text, o?.vaultDir || '示例数据')}`,
    '', sgr(C.faint, '数据来自实时 /overview；没有日志接口时不伪造日志。'),
  ]
  return [panel('运行状态', lines, w, h, C.green)]
}

function recycleView(state, w, h) {
  const lines = [sgr(C.dim, '回收站里的卡片不会进入检索；恢复后回到记忆库。'), '']
  if (!state.recycle.length) lines.push(sgr(C.green, '  ✓ 回收站为空'))
  state.recycle.forEach((item, i) => {
    const k = kindOf(item)
    const sel = i === state.recycleIndex
    let line = `${sel ? sgr(C.ember, '▌') : ' '} ${sgr(k.color, '[' + k.label + ']')} ${sgr(C.text, item.title)}`
    if (sel) line = tone(pad(clip(line, w - 2), w - 2), C.text, C.selectedBg)
    lines.push(line)
    lines.push(`   ${sgr(C.faint, item.time)}  ${sgr(C.dim, item.reason)}`)
    lines.push('')
  })
  lines.push(sgr(C.dim, 'r 恢复   d 彻底删除'))
  return [panel('回收站', lines, w, h, C.red)]
}

function settingsView(state, w, h) {
  const lines = [sgr(C.dim, '这些是示例开关，只改当前演示，不写配置。'), '']
  state.settings.forEach((s, i) => {
    const sel = i === state.settingsIndex
    const on = s.value === '开' || s.value === '余烬橙'
    let line = `${sel ? sgr(C.ember, '▌') : ' '} ${sgr(on ? C.green : C.faint, on ? '●' : '○')} ${sgr(C.text, s.label.padEnd(12))} ${sgr(C.amber, s.value)}`
    if (sel) line = tone(pad(clip(line, w - 2), w - 2), C.text, C.selectedBg)
    lines.push(line)
    lines.push(`   ${sgr(C.dim, s.detail)}`)
    lines.push('')
  })
  lines.push(sgr(C.dim, 'Enter / Space 切换'))
  return [panel('设置', lines, w, h, C.amber)]
}

function helpView(w, h) {
  const lines = [
    sgr(C.ember, '键盘'), '',
    `  ${keycap('1')}–${keycap('6')}        记忆库 / 待审 / 星图 / 状态 / 回收 / 设置`,
    `  ${keycap('Tab')}        切换页面`,
    `  ${keycap('↑↓')} ${keycap('jk')}   移动`,
    `  ${keycap('←→')} ${keycap('t')}   切换类型`,
    `  ${keycap('Enter')}      读卡 / 切换设置`,
    `  ${keycap('Space')}      多选 / 切换设置`,
    `  ${keycap('s')} ${keycap('Ctrl+A')}  全选 / 反选`,
    `  ${keycap('a')} ${keycap('r')}      批准 / 驳回`,
    `  ${keycap('r')} ${keycap('d')}      回收站：恢复 / 彻底删除`,
    `  ${keycap('/')}          搜索`,
    `  ${keycap('L')}          打开长文读卡器`,
    `  ${keycap('j k')}        读卡器滚动（PgUp/PgDn 翻页）`,
    `  ${keycap('Esc')}        返回 / 清空选择`,
    `  ${keycap('?')} ${keycap('q')}      帮助 / 退出`,
    '', sgr(C.dim, '示例数据，不会写入真实 vault。'),
  ]
  return [panel('帮助', lines, w, h, C.ember)]
}

function footer(state, w) {
  if (state.searchMode) return ' ' + [keycap('Enter', '确认'), keycap('Esc', '取消')].join(' ')
  if (state.help) return ' ' + [keycap('Esc', '关闭帮助'), keycap('?', '关闭')].join(' ')
  if (state.screen === 'reader') return ' ' + [keycap('↑↓', '滚动'), keycap('PgUp/PgDn', '翻页'), keycap('g/G', '首/尾'), keycap('Esc', '返回')].join(' ')
  if (state.screen === 'settings') return ' ' + [keycap('↑↓', '移动'), keycap('Enter', '切换'), keycap('Space', '切换'), keycap('Esc', '返回')].join(' ')
  if (state.screen === 'recycle') return ' ' + [keycap('↑↓', '移动'), keycap('r', '恢复'), keycap('d', '删除')].join(' ')
  if (state.screen === 'audit' && state.marked.size) return ' ' + [keycap('a', '批准 ' + state.marked.size), keycap('r', '驳回'), keycap('s', '反选'), keycap('Esc', '清空')].join(' ')
  if (state.screen === 'audit') return ' ' + [keycap('↑↓', '移动'), keycap('←→', '类型'), keycap('Space', '多选'), keycap('s', '全选'), keycap('a', '批准'), keycap('r', '驳回'), keycap('Enter', '读卡'), keycap('1-6', '页面'), keycap('?', '帮助')].join(' ')
  if (state.screen === 'library') return ' ' + [keycap('↑↓', '移动'), keycap('←→', '类型'), keycap('/', '搜索'), keycap('Enter', '读卡'), keycap('1-6', '页面')].join(' ')
  if (state.screen === 'graph') return ' ' + [keycap('↑↓', '切换卡片'), keycap('Enter', '读卡'), keycap('1-6', '页面')].join(' ')
  if (state.screen === 'status') return ' ' + [keycap('1-6', '页面'), keycap('Tab', '切换'), keycap('?', '帮助')].join(' ')
  return ' ' + [keycap('1-6', '页面'), keycap('Tab', '切换'), keycap('?', '帮助')].join(' ')
}

function frame(state) {
  const w = Math.max(72, Math.min(useColor ? 140 : 120, process.stdout.columns || 120))
  const rows = Math.max(24, process.stdout.rows || 36)
  const screen = state.help ? 'help' : state.screen
  const label = screen === 'help' ? '帮助' : SCREENS[screen]?.label || '记忆库'
  const totalNow = state.screen === 'library' ? (state.libraryCards || state.cards).length : state.cards.length
  const counts = `${sgr(C.amber, String(totalNow))} ${sgr(C.dim, state.screen === 'library' ? '记忆' : '待审')}` + (state.marked.size ? `  ${sgr(C.amber, '已选 ' + state.marked.size)}` : '')
  const mode = state.live ? (writeMode ? 'LIVE / WRITE' : 'LIVE / READONLY') : 'LOCAL MEMORY'
  const title = `${sgr(C.ember, '●')} ${sgr(C.ember, 'MEMORY ATLAS')}  ${sgr(C.faint, mode)}  ${sgr(C.faint, '/')} ${sgr(C.text, label)}`
  const right = `${counts}  ${keycap('?', '帮助')} ${keycap('q', '退出')}`
  const room = Math.max(16, w - width(right) - 2)
  const out = [pad(clip(title, room), room) + ' ' + right, sgr(C.border, '─'.repeat(w))]
  const nav = Object.entries(SCREENS).filter(([id]) => id !== 'reader').map(([id, s]) => {
    const active = state.screen === id
    return tone(` ${s.num} ${s.label}${id === 'audit' ? ' ' + state.cards.length : ''} `, active ? C.text : C.dim, active ? C.chipBg : '')
  }).join(' ')
  out.push(' ' + clip(nav, w - 1))
  const bodyH = Math.max(12, rows - 5)
  let body
  if (state.help) body = helpView(w, bodyH)
  else if (state.screen === 'audit') body = auditView(state, w, bodyH)
  else if (state.screen === 'library') body = libraryView(state, w, bodyH)
  else if (state.screen === 'reader') body = readerView(state, w, bodyH)
  else if (state.screen === 'graph') body = graphView(state, w, bodyH)
  else if (state.screen === 'status') body = statusView(state, w, bodyH)
  else if (state.screen === 'recycle') body = recycleView(state, w, bodyH)
  else body = settingsView(state, w, bodyH)
  out.push(...body.slice(0, bodyH))
  const line = state.toast ? sgr(state.toast.ok ? C.green : C.red, state.toast.text) : footer(state, w).trimStart()
  out.push(' ' + clip(line, w - 1))
  return out.join('\n')
}

function draw(state) {
  if (once) { process.stdout.write(frame(state) + '\n'); return }
  process.stdout.write('\x1b[H' + frame(state) + '\x1b[J')
}

async function apiJson(path, options = {}) {
  const res = await fetch(API + path, { ...options, signal: AbortSignal.timeout(10000) })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data
}

function fmtTime(value) {
  const d = new Date(value || Date.now())
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function cleanSummary(value) {
  return String(value || '').replace(/^---[\s\S]*?---\s*/, '').replace(/^#{1,6}\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 220)
}

function toLiveCard(c) {
  return {
    id: c.path,
    kind: c.kind || 'knowledge',
    title: c.title || '无标题',
    source: c.submittedBy || c.source || 'memory',
    time: fmtTime(c.updated || c.created),
    tags: Array.isArray(c.tags) ? c.tags.slice(0, 5) : [],
    summary: cleanSummary(c.summary || ''),
    status: c.status || 'pending',
    body: [],
  }
}

function parseCardBody(text) {
  const clean = String(text || '').replace(/^---[\s\S]*?---\s*/, '')
  return clean.split(/\r?\n/).map((line) => line.replace(/^#{1,6}\s*/, '').replace(/^\s*[-*]\s+/, '· ').trimEnd())
}

async function loadAllCards(status) {
  const out = []
  let offset = 0
  for (;;) {
    const page = await apiJson(`/cards?status=${status}&limit=500&offset=${offset}`)
    out.push(...(page.cards || []))
    if (!page.cards?.length || out.length >= (page.total || 0)) break
    offset += page.cards.length
  }
  return { cards: out, total: out.length }
}

async function loadLive(state) {
  try {
    const [cardsData, libraryData, overview, graphData, recycleData] = await Promise.all([
      loadAllCards('pending'),
      loadAllCards('approved').catch(() => ({ cards: [] })),
      apiJson('/overview').catch(() => null),
      apiJson('/graph').catch(() => null),
      apiJson('/recycle/list').catch(() => ({ items: [] })),
    ])
    state.cards = cardsData.cards.map(toLiveCard)
    state.libraryCards = libraryData.cards.map(toLiveCard)
    state.overview = overview
    state.graphData = graphData
    state.recycle = (recycleData.items || []).map((c) => ({
      title: c.title || c.path,
      kind: c.kind || 'knowledge',
      time: fmtTime(c.deletedAt || c.updated || c.created),
      reason: c.reason || '已删除',
      path: c.path,
    }))
    state.index = 0
    state.marked.clear()
    if (selectAllAtStart) state.cards.forEach((c) => state.marked.add(c.id))
    if (!state.cards.length) {
      state.toast = { text: `0 张待审 · 已加载 ${state.libraryCards.length} 张记忆`, ok: true }
    }
    state.live = true
    state.liveError = ''
  } catch (err) {
    state.live = false
    state.liveError = err.message
    state.toast = { text: '实时 API 不可用，已回退示例数据：' + err.message, ok: false }
  }
}


async function main() {
  const state = {
    screen: SCREENS[screenArg] ? screenArg : 'audit', cards: CARDS.slice(), index: 0, kind: 'all', query: '', searchMode: false,
    marked: selectAllAtStart ? new Set(CARDS.map((c) => c.id)) : new Set(),
    readerCard: screenArg === 'reader' ? CARDS.find((c) => c.id === 'longform') || CARDS[0] : null,
    readerBack: 'audit', readerScroll: scrollArg > 0 ? scrollArg : 0, readerMax: 0, recycle: RECYCLE.slice(), recycleIndex: 0,
    settings: SETTINGS.map((s) => ({ ...s })), settingsIndex: 0, help: screenArg === 'help', toast: null,
    live: false, liveError: '', overview: null, libraryCards: CARDS.slice(), graphData: null, graphIndex: 0,
  }
  if (liveMode) await loadLive(state)
  if (once) { draw(state); return }
  if (!process.stdout.isTTY) { process.stderr.write('请在有 TTY 的终端里运行；预览用 --once\n'); process.exitCode = 1; return }

  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdout.write('\x1b[?1049h\x1b[?25l')
  draw(state)
  const cleanup = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l')
    try { process.stdin.setRawMode(false) } catch {}
    process.stdin.pause()
  }
  const toast = (text, ok = true) => { state.toast = { text, ok }; draw(state); setTimeout(() => { state.toast = null; draw(state) }, 1600) }
  const visible = () => filtered(state)
  const selectedCard = () => visible()[state.index]

  const recycleAction = async (purge) => {
    const item = state.recycle[state.recycleIndex]
    if (!item) return
    if (state.live && item.path) {
      try {
        await apiJson('/recycle/' + (purge ? 'purge' : 'restore') + '?path=' + encodeURIComponent(item.path))
      } catch (err) {
        toast('操作失败：' + err.message, false)
        return
      }
    }
    state.recycle.splice(state.recycleIndex, 1)
    state.recycleIndex = Math.max(0, state.recycleIndex - 1)
    toast((purge ? '✕ 已彻底删除：' : '✓ 已恢复：') + item.title, !purge)
  }

  const removeSelected = async (decision) => {
    const cards = visible()
    const targets = state.marked.size ? cards.filter((c) => state.marked.has(c.id)) : (cards[state.index] ? [cards[state.index]] : [])
    if (!targets.length) return
    if (state.live && !writeMode) {
      toast('实时模式只读；加 --write 才允许批准/驳回')
      return
    }
    if (state.live) {
      try {
        await Promise.all(targets.map((c) => apiJson('/audit/' + (decision === 'a' ? 'approve' : 'reject'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: c.id }),
        })))
      } catch (err) {
        toast('操作失败：' + err.message, false)
        return
      }
    }
    const ids = new Set(targets.map((c) => c.id))
    state.cards = state.cards.filter((c) => !ids.has(c.id))
    state.index = 0
    state.marked.clear()
    toast(`${decision === 'a' ? '✓ 已批准' : '✕ 已驳回'} ${targets.length} 张：${targets[0].title}`, decision === 'a')
  }

  const openReader = async (override) => {
    const card = override || selectedCard()
    if (!card) return
    state.readerCard = card
    state.readerBack = state.screen
    state.readerScroll = 0
    state.screen = 'reader'
    if (state.live && !card.body.length) {
      card.body = ['加载正文…']
      draw(state)
      const status = card.status || (state.readerBack === 'audit' ? 'pending' : 'approved')
      try {
        const data = await apiJson('/card?path=' + encodeURIComponent(card.id) + '&status=' + status)
        card.body = parseCardBody(data.text)
      } catch (err) {
        card.body = ['正文加载失败：' + err.message]
      }
    }
    draw(state)
  }

  const cycle = (dir) => {
    const ids = Object.keys(SCREENS).filter((id) => id !== 'reader')
    const i = ids.indexOf(state.screen === 'reader' ? state.readerBack : state.screen)
    state.screen = ids[(i + dir + ids.length) % ids.length]
    state.index = 0
    draw(state)
  }

  const onKey = (str, key = {}) => {
    if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0) }
    if (state.searchMode) {
      if (key.name === 'escape') { state.searchMode = false; state.query = ''; draw(state); return }
      if (key.name === 'return' || key.name === 'enter') { state.searchMode = false; draw(state); return }
      if (key.name === 'backspace') { state.query = state.query.slice(0, -1); draw(state); return }
      if (str && str.length === 1 && !key.ctrl) { state.query += str; draw(state); return }
      return
    }
    if (state.help) { if (key.name === 'escape' || str === '?' || str === 'q') { state.help = false; draw(state) } return }
    if (str === 'q') { cleanup(); process.exit(0) }
    if (str === '?') { state.help = true; draw(state); return }
    if (str === '/') { state.searchMode = true; draw(state); return }
    if (str === 'L') { state.readerCard = CARDS.find((c) => c.id === 'longform') || CARDS[0]; state.readerBack = state.screen; state.readerScroll = 0; state.screen = 'reader'; draw(state); return }
    if (key.name === 'tab') { cycle(key.shift ? -1 : 1); return }
    if (/^[1-6]$/.test(str)) {
      const id = ['library', 'audit', 'graph', 'status', 'recycle', 'settings'][Number(str) - 1]
      state.screen = id; state.index = 0; draw(state); return
    }
    if (state.screen === 'reader') {
      if (key.name === 'escape') { state.screen = state.readerBack; draw(state); return }
      if (key.name === 'up' || str === 'k') { state.readerScroll = Math.max(0, state.readerScroll - 1); draw(state); return }
      if (key.name === 'down' || str === 'j') { state.readerScroll = Math.min(state.readerMax, state.readerScroll + 1); draw(state); return }
      if (key.name === 'pageup') { state.readerScroll = Math.max(0, state.readerScroll - 8); draw(state); return }
      if (key.name === 'pagedown' || str === ' ') { state.readerScroll = Math.min(state.readerMax, state.readerScroll + 8); draw(state); return }
      if (str === 'g') { state.readerScroll = 0; draw(state); return }
      if (str === 'G') { state.readerScroll = state.readerMax; draw(state); return }
      return
    }
    if (state.screen === 'settings') {
      if (key.name === 'up' || str === 'k') { state.settingsIndex = Math.max(0, state.settingsIndex - 1); draw(state); return }
      if (key.name === 'down' || str === 'j') { state.settingsIndex = Math.min(state.settings.length - 1, state.settingsIndex + 1); draw(state); return }
      if (key.name === 'return' || key.name === 'space' || str === ' ') {
        const s = state.settings[state.settingsIndex]
        if (s) s.value = s.value === '开' ? '关' : s.value === '关' ? '开' : s.value
        draw(state); return
      }
      return
    }
    if (state.screen === 'recycle') {
      if (key.name === 'up' || str === 'k') { state.recycleIndex = Math.max(0, state.recycleIndex - 1); draw(state); return }
      if (key.name === 'down' || str === 'j') { state.recycleIndex = Math.min(state.recycle.length - 1, state.recycleIndex + 1); draw(state); return }
      if (str === 'r' && state.recycle.length) { void recycleAction(false); return }
      if (str === 'd' && state.recycle.length) { void recycleAction(true); return }
      return
    }
    if (state.screen === 'graph') {
      const nodes = Array.isArray(state.graphData?.nodes) ? state.graphData.nodes : []
      if (key.name === 'up' || str === 'k') { state.graphIndex = Math.max(0, state.graphIndex - 1); draw(state); return }
      if (key.name === 'down' || str === 'j') { state.graphIndex = Math.min(Math.max(0, nodes.length - 1), state.graphIndex + 1); draw(state); return }
      if (key.name === 'return' || key.name === 'enter') {
        const node = nodes[state.graphIndex]
        if (node) void openReader({ ...node, id: node.id, status: 'approved', body: [] })
        return
      }
      return
    }
    if (state.screen === 'status') return
    const cards = visible()
    if (str === 't' || key.name === 'right' || str === 'l') {
      const keys = ['all', 'project', 'knowledge', 'mistake', 'content', 'tool', 'prompt']
      state.kind = keys[(keys.indexOf(state.kind) + 1) % keys.length]
      state.index = 0; state.marked.clear(); draw(state); return
    }
    if (key.name === 'left' || str === 'h') {
      const keys = ['all', 'project', 'knowledge', 'mistake', 'content', 'tool', 'prompt']
      state.kind = keys[(keys.indexOf(state.kind) - 1 + keys.length) % keys.length]
      state.index = 0; state.marked.clear(); draw(state); return
    }
    if (state.screen === 'audit' && (str === 's' || (key.ctrl && key.name === 'a'))) {
      const all = cards.length > 0 && cards.every((c) => state.marked.has(c.id))
      cards.forEach((c) => all ? state.marked.delete(c.id) : state.marked.add(c.id))
      draw(state); return
    }
    if (key.name === 'up' || str === 'k') { state.index = Math.max(0, state.index - 1); draw(state); return }
    if (key.name === 'down' || str === 'j') { state.index = Math.min(Math.max(0, cards.length - 1), state.index + 1); draw(state); return }
    if (key.name === 'return' || key.name === 'enter') { openReader(); return }
    if (key.name === 'escape') { state.query = ''; state.kind = 'all'; state.marked.clear(); state.index = 0; draw(state); return }
    if (state.screen === 'audit' && (key.name === 'space' || str === ' ')) {
      const c = cards[state.index]; if (c) { state.marked.has(c.id) ? state.marked.delete(c.id) : state.marked.add(c.id) } draw(state); return
    }
    if (state.screen === 'audit' && (str === 'a' || str === 'r')) removeSelected(str)
  }

  process.stdin.on('keypress', onKey)
  process.stdout.on('resize', () => draw(state))
}

main()
