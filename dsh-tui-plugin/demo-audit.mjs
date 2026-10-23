#!/usr/bin/env node
// Memory Atlas TUI 原型
// 运行：node dsh-tui-plugin/demo.mjs
// 只读预览：node dsh-tui-plugin/demo.mjs --once
//
// 这是一个独立的终端 UI 演示，不连接真实 vault，也不会写入任何卡片。

import readline from 'node:readline'

const C = {
  reset: '\x1b[0m',
  ember: '\x1b[38;2;255;122;69m',
  emberBg: '\x1b[48;2;66;44;37m',
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

const CARDS = [
  {
    id: 'memory-eternal-v5',
    kind: 'project',
    title: 'memory-eternal V5 收口：跨宿主入口',
    source: 'deepseek-harness',
    time: '10:52',
    tags: ['memory-eternal', 'V5', 'UI'],
    summary: '一套 Web UI 作为唯一真源，各宿主只做 Launcher；能内嵌的用 Webview，不能内嵌的只做启动器。',
    body: [
      '变更结论',
      '1. 记忆库改成 4 列卡片 + 今日回看',
      '2. 待审改成顶部类型条 + 右侧判词',
      '3. 星图默认缩小，DPR/网格/边优化',
      '4. 读卡器补目录与相关记忆',
      '',
      '边界',
      '· 不复制第二套 UI',
      '· 不新增 agent 审批权限',
      '· 不修改 DSH 官方源码',
    ],
  },
  {
    id: 'mvcheck-camera',
    kind: 'knowledge',
    title: 'MVCheck 多相机独立成像参数',
    source: 'deepseek-harness',
    time: '10:48',
    tags: ['MVCheck', '相机', '多视角'],
    summary: '每路相机独立 SDK 实例，shared_sdk 降级为运行库保活；按序列号绑定，不再全局覆盖。',
    body: [
      '根因',
      '· 全局 shared_sdk 只有一个 handle',
      '· 打开第二台时覆盖第一台句柄',
      '· 关闭只释放自己的句柄，真正资源仍被占用',
      '',
      '修复',
      '· shared_sdk 降级为运行库保活',
      '· open/close 按序列号去重',
      '· 全局覆盖前检测占用并提示',
    ],
  },
  {
    id: 'shj-port',
    kind: 'mistake',
    title: 'shj-web 端口菜单错位与 client 断连',
    source: 'deepseek-harness',
    time: '10:43',
    tags: ['shj-platform', 'shj-web', '#布局'],
    summary: '端口菜单被侧栏删除后，client 仍等待旧端口事件；恢复菜单并补一条回归检查。',
    body: [
      '现象',
      '· client 一直显示连接中',
      '· 端口菜单入口消失',
      '',
      '处理',
      '· 恢复「端口管理」菜单',
      '· 回归：打开菜单 → 连接 → 刷新',
    ],
  },
  {
    id: 'cursor-webview',
    kind: 'project',
    title: 'Cursor Webview 扩展：Memory Atlas',
    source: 'codex',
    time: '10:38',
    tags: ['Cursor', 'Webview', '扩展'],
    summary: 'Activity Bar 增加 Memory Atlas，用 Webview 加载同一套 7999 页面，版本与 DSH/Web 一致。',
    body: [
      '实现',
      '· contributes.viewsContainers.activitybar',
      '· contributes.views type=webview',
      '· iframe 127.0.0.1:7999',
      '',
      '注意',
      '· Web 服务需要先运行',
      '· 不复制第二套前端',
    ],
  },
  {
    id: 'orca-panel',
    kind: 'project',
    title: 'Orca 右侧栏记忆面板',
    source: 'deepseek-harness',
    time: '10:31',
    tags: ['Orca', 'Panel', 'Launcher'],
    summary: 'Orca 官方 panel + terminal.sendText，打开 Memory Atlas；CSP 禁止 iframe，所以是启动器。',
    body: [
      '能力',
      '· 右侧栏「记忆」',
      '· 选择终端',
      '· 执行 orca tab create / dsh-memory open',
      '',
      '限制',
      '· panel 不能 iframe 127.0.0.1:7999',
      '· 不能 fetch 本地 API',
    ],
  },
  {
    id: 'readme',
    kind: 'content',
    title: 'README 平台支持表',
    source: 'deepseek-harness',
    time: '10:24',
    tags: ['README', '平台', '发布'],
    summary: 'DSH / Orca / dsh-tui / Codex / Claude / Cursor / Web 一张表；能内嵌的 Webview，不能的 Launcher。',
    body: [
      '原则',
      '· 一套 Web UI 唯一真源',
      '· 版本统一',
      '· 不复制 UI',
      '',
      '入口',
      '· DSH 左栏',
      '· Orca 右侧栏',
      '· dsh-tui /memory',
      '· Codex / Claude skill',
      '· Cursor Activity Bar',
    ],
  },
]

const argv = new Set(process.argv.slice(2))
const once = argv.has('--once')
const selectAllAtStart = argv.has('--select-all')
const noColor = argv.has('--no-color') || process.env.NO_COLOR
const useColor = !noColor

const sgr = (code, text) => (useColor ? code + text + C.reset : text)
const tone = (text, fg, bg = '') => (useColor ? `${fg || ''}${bg}${text}${C.reset}` : text)
const keycap = (key, label) => tone(` ${key} `, C.text, C.keyBg) + (label ? ' ' + sgr(C.dim, label) : '')

function charWidth(ch) {
  const cp = ch.codePointAt(0)
  if (cp === 0x200b || cp === 0xfe0f) return 0
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff))
  ) return 2
  return 1
}

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
const width = (s) => [...plain(s)].reduce((n, ch) => n + charWidth(ch), 0)

function clip(s, max) {
  let out = ''
  let n = 0
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
      if (m) { out += m[0]; i += m[0].length; continue }
    }
    const ch = String.fromCodePoint(s.codePointAt(i))
    const w = charWidth(ch)
    if (n + w > max) break
    out += ch
    n += w
    i += ch.length
  }
  return out + (useColor && out.includes('\x1b[') ? C.reset : '')
}

function pad(s, n, align = 'left') {
  const gap = Math.max(0, n - width(s))
  if (align === 'right') return ' '.repeat(gap) + s
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2))
  return s + ' '.repeat(gap)
}

function wrap(text, n) {
  const lines = []
  let line = ''
  let used = 0
  for (const ch of String(text)) {
    const w = charWidth(ch)
    if (used + w > n) {
      lines.push(line)
      line = ''
      used = 0
    }
    line += ch
    used += w
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function panel(title, lines, w, h, accent = C.border) {
  const inner = Math.max(1, w - 2)
  const titleText = ' ' + title + ' '
  const topFill = Math.max(0, inner - width(titleText))
  const top = sgr(accent, '╭─') + sgr(accent, titleText) + sgr(accent, '─'.repeat(topFill) + '╮')
  const bottom = sgr(accent, '╰' + '─'.repeat(inner) + '╯')
  const body = []
  for (let i = 0; i < h - 2; i++) {
    const line = lines[i] || ''
    body.push(sgr(C.border, '│') + pad(clip(line, inner), inner) + sgr(C.border, '│'))
  }
  return [top, ...body, bottom].join('\n')
}

function kindOf(card) {
  return KIND[card.kind] || KIND.project
}

function queueLines(cards, state, w) {
  if (!cards.length) {
    return [
      '',
      sgr(C.green, '  ✓ 全部处理完了'),
      '',
      sgr(C.dim, '  待审队列已经清空；新的卡会在下一轮对话后出现。'),
    ]
  }
  const lines = []
  const selectedCount = cards.filter((c) => state.marked.has(c.id)).length
  const allSelected = cards.length > 0 && selectedCount === cards.length
  lines.push(
    `  ${allSelected ? sgr(C.ember, '▣') : sgr(C.faint, '☐')} ${sgr(C.dim, allSelected ? '反选' : '全选')} ${cards.length}` +
    `    ${selectedCount ? sgr(C.amber, '已选 ' + selectedCount) : sgr(C.faint, '已选 0')}` +
    `    ${keycap('s', allSelected ? '反选' : '全选')}`,
  )
  lines.push('')
  cards.forEach((card, i) => {
    const k = kindOf(card)
    const selected = i === state.index
    const marked = state.marked.has(card.id)
    const marker = marked ? sgr(C.amber, '◉') : sgr(C.faint, '○')
    const lead = selected ? sgr(C.ember, '▌') : ' '
    const badge = tone(' ' + k.mark + ' ', k.color, selected ? C.selectedBg : '')
    let line = `${lead}${marker} ${badge} ${sgr(k.color, '[' + k.label + ']')}  ${sgr(C.text, card.title)}`
    line = clip(line, w)
    if (selected) line = tone(pad(line, w), C.text, C.selectedBg)
    lines.push(line)
    const meta = `   ${sgr(C.faint, card.source)} ${sgr(C.faint, '·')} ${sgr(C.dim, card.time)}   ${sgr(C.amber, '待审')}`
    let metaLine = clip(meta, w)
    if (selected) metaLine = tone(pad(metaLine, w), '', C.selectedBg)
    lines.push(metaLine)
    lines.push('')
  })
  return lines
}

function previewLines(card, w) {
  if (!card) return [sgr(C.dim, '没有可预览的卡片')]
  const k = kindOf(card)
  const inner = Math.max(8, w - 2)
  const lines = []
  lines.push([
    tone(' ' + k.mark + ' ' + k.label + ' ', k.color, C.chipBg),
    tone(' 待审核 ', C.amber, C.chipBg),
    sgr(C.faint, '  ' + card.time + '  ' + card.source),
  ].join(''))
  lines.push('')
  lines.push(sgr(C.text, card.title))
  lines.push('')
  const tabs = [
    tone(' 判词 ', C.ember, C.chipBg),
    sgr(C.dim, ' 原文 '),
    sgr(C.dim, ' 相关 '),
  ].join('  ')
  lines.push(tabs)
  lines.push('')
  for (const part of wrap('摘要  ' + card.summary, inner)) {
    lines.push(tone(part, C.text, C.calloutBg))
  }
  lines.push('')
  lines.push(card.tags.map((t) => tone(' #' + t + ' ', C.ember, C.chipBg)).join(' '))
  lines.push('')
  lines.push(sgr(C.border, '─'.repeat(inner)))
  lines.push('')
  const headings = /^(变更结论|根因|现象|处理|修复|边界|实现|限制|能力|原则|入口|注意|背景|验证)$/
  for (const line of card.body) {
    if (!line) { lines.push(''); continue }
    if (headings.test(line)) lines.push(sgr('\x1b[1m' + C.ember, line))
    else lines.push(line.startsWith('·') ? sgr(C.dim, line) : sgr(C.text, line))
  }
  const related = CARDS.filter((c) => c.id !== card.id).slice(0, 2)
  if (related.length) {
    lines.push('')
    lines.push(sgr(C.dim, '相关记忆'))
    for (const r of related) {
      lines.push(`${sgr(kindOf(r).color, '→')} ${sgr(C.dim, r.title)}`)
    }
  }
  lines.push('')
  lines.push([keycap('a', '批准'), keycap('r', '驳回'), keycap('Space', '多选')].join('   '))
  return lines
}

function frame(state) {
  const w = Math.max(64, Math.min(useColor ? 130 : 110, process.stdout.columns || 110))
  const rows = Math.max(22, process.stdout.rows || 34)
  const inner = w - 2
  const allCards = state.cards
  const cards = state.kind && state.kind !== 'all' ? allCards.filter((c) => c.kind === state.kind) : allCards
  const selected = cards[state.index]
  const marked = state.marked.size
  const out = []

  const title = `${sgr(C.ember, '●')} ${sgr(C.ember, 'MEMORY ATLAS')}  ${sgr(C.faint, 'LOCAL MEMORY')}  ${sgr(C.faint, '/')} ${sgr(C.text, '待审')}`
  const bar = sgr(C.ember, '▰▰▰') + sgr(C.faint, '▱▱')
  const stat = `${sgr(C.amber, String(cards.length))} ${sgr(C.dim, '待审')}${marked ? `  ${sgr(C.amber, '已选 ' + marked)}` : ''}  ${bar}  ${keycap('?', '帮助')} ${keycap('q', '退出')}`
  const titleRoom = Math.max(12, inner - width(stat) - 1)
  out.push(pad(clip(title, titleRoom), titleRoom) + ' ' + stat)
  out.push(sgr(C.border, '─'.repeat(w)))

  const typeLine = sgr(C.faint, '类型  ') + [
    ['全部', 'all'],
    ['项目', 'project'],
    ['知识', 'knowledge'],
    ['教训', 'mistake'],
    ['内容', 'content'],
    ['工具', 'tool'],
    ['提示词', 'prompt'],
  ].map(([label, key], i) => {
    const active = (state.kind || 'all') === key
    const count = key === 'all' ? CARDS.length : CARDS.filter((c) => c.kind === key).length
    return tone(` ${active ? '●' : '○'} ${label} ${count} `, active ? C.text : C.dim, active ? C.chipBg : '')
  }).join(' ') 
  out.push(' ' + clip(typeLine, inner - 1))
  out.push('')

  const chrome = 7
  const panelH = Math.max(10, rows - chrome)
  const narrow = w < 96
  const queueW = narrow ? w : Math.max(42, Math.floor((w - 3) * 0.4))
  const previewW = w - queueW - 3

  if (state.help) {
    const help = [
      sgr(C.ember, '键盘'),
      '',
      `  ${keycap('↑↓')} ${keycap('j k')}   移动选择`,
      `  ${keycap('Space')}          多选 / 取消`,
      `  ${keycap('a')}              批准选中或已选`,
      `  ${keycap('r')}              驳回选中或已选`,
      `  ${keycap('Enter')}          窄屏打开详情`,
      `  ${keycap('?')}              关闭帮助`,
      `  ${keycap('q')}              退出演示`,
      '',
      sgr(C.dim, '所有操作只作用于示例数据，不会写入真实 vault。'),
    ]
    out.push(panel('帮助', help, w, panelH, C.ember))
  } else if (narrow && state.view === 'detail') {
    out.push(panel('判词', previewLines(selected, inner - 2), w, panelH, C.ember))
  } else if (narrow) {
    out.push(panel(`待审 ${cards.length}`, queueLines(cards, state, inner - 2), w, panelH, C.border))
  } else {
    const q = panel(`队列 ${cards.length}${marked ? '  ◉' + marked : ''}`, queueLines(cards, state, queueW - 2), queueW, panelH)
    const p = panel('判词', previewLines(selected, previewW - 2), previewW, panelH, C.ember)
    const ql = q.split('\n')
    const pl = p.split('\n')
    for (let i = 0; i < Math.max(ql.length, pl.length); i++) {
      out.push((ql[i] || ' '.repeat(queueW)) + ' ' + (pl[i] || ' '.repeat(previewW)))
    }
  }

  const toast = state.toast ? ` ${sgr(state.toast.ok ? C.green : C.red, state.toast.text)}` : ''
  const keys = marked
    ? [keycap('a', '批准 ' + marked), keycap('r', '驳回'), keycap('s', '反选'), keycap('Esc', '清空')].join(' ')
    : [keycap('↑↓', '移动'), keycap('Space', '多选'), keycap('s', '全选'), keycap('1-7', '筛选'), keycap('?', '帮助')].join(' ')
  out.push(' ' + clip(toast || keys, inner - 1))
  return out.join('\n')
}

function draw(state) {
  if (once) {
    process.stdout.write(frame(state) + '\n')
    return
  }
  process.stdout.write('\x1b[H' + frame(state))
  process.stdout.write('\x1b[J')
}

function main() {
  const state = {
    cards: CARDS.slice(),
    kind: 'all',
    index: 0,
    marked: selectAllAtStart ? new Set(CARDS.map((c) => c.id)) : new Set(),
    view: 'list',
    help: false,
    toast: null,
  }

  if (once) {
    draw(state)
    return
  }

  if (!process.stdout.isTTY) {
    process.stderr.write('请在有 TTY 的终端里运行；只预览一帧可加 --once\n')
    process.exitCode = 1
    return
  }

  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdout.write('\x1b[?1049h\x1b[?25l')
  draw(state)

  const cleanup = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l')
    try { process.stdin.setRawMode(false) } catch {}
    process.stdin.pause()
  }

  const toastTimer = { id: null }
  const showToast = (text, ok = true) => {
    state.toast = { text, ok }
    if (toastTimer.id) clearTimeout(toastTimer.id)
    toastTimer.id = setTimeout(() => { state.toast = null; draw(state) }, 1800)
  }

  const removeSelected = (decision) => {
    if (!state.cards.length) return
    const visible = state.kind && state.kind !== 'all' ? state.cards.filter((c) => c.kind === state.kind) : state.cards
    const targets = state.marked.size > 0
      ? visible.filter((c) => state.marked.has(c.id))
      : (visible[state.index] ? [visible[state.index]] : [])
    if (!targets.length) return
    const ids = new Set(targets.map((c) => c.id))
    state.cards = state.cards.filter((c) => !ids.has(c.id))
    state.index = 0
    state.marked.clear()
    showToast(`${decision === 'a' ? '✓ 已批准' : '✕ 已驳回'} ${targets.length} 张：${targets[0].title}`, decision === 'a')
  }

  const onKey = (str, key = {}) => {
    if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0) }
    if (state.help) {
      if (key.name === 'escape' || str === '?' || str === 'q') {
        state.help = false
        draw(state)
      }
      return
    }
    if (str === 'q') { cleanup(); process.exit(0) }
    if (str === '?') { state.help = true; draw(state); return }
    if (/^[1-7]$/.test(str)) {
      state.kind = ['all', 'project', 'knowledge', 'mistake', 'content', 'tool', 'prompt'][Number(str) - 1]
      state.index = 0
      state.marked.clear()
      draw(state)
      return
    }
    const visible = state.kind && state.kind !== 'all' ? state.cards.filter((c) => c.kind === state.kind) : state.cards
    if (str === 's' || (key.ctrl && key.name === 'a')) {
      const all = visible.length > 0 && visible.every((c) => state.marked.has(c.id))
      if (all) visible.forEach((c) => state.marked.delete(c.id))
      else visible.forEach((c) => state.marked.add(c.id))
      draw(state)
      return
    }
    if (key.name === 'up' || str === 'k') { state.index = Math.max(0, state.index - 1); draw(state); return }
    if (key.name === 'down' || str === 'j') { state.index = Math.min(Math.max(0, visible.length - 1), state.index + 1); draw(state); return }
    if (key.name === 'return' || key.name === 'enter') {
      if (process.stdout.columns < 96) state.view = state.view === 'detail' ? 'list' : 'detail'
      draw(state)
      return
    }
    if (key.name === 'escape') {
      if (state.marked.size) state.marked.clear()
      else state.view = 'list'
      draw(state)
      return
    }
    if (key.name === 'space' || str === ' ') {
      const card = visible[state.index]
      if (card) {
        if (state.marked.has(card.id)) state.marked.delete(card.id)
        else state.marked.add(card.id)
        draw(state)
      }
      return
    }
    if (str === 'a' || str === 'r') { removeSelected(str); draw(state) }
  }

  process.stdin.on('keypress', onKey)
  process.stdout.on('resize', () => draw(state))
}

main()
