// dsh-tui 原生审核场景（最小闭环）
//
// 不复制 Web UI：只把「待审队列 + 全选 + 批准/驳回」做成 dsh-tui 原生场景。
// 日常浏览/长文仍可回到 Web 或外部 TUI 客户端。
//
// issue #50：审核是**人**的动作，所以这里区分两件事——
//   1) 进入确认态再提交（批量误触的代价太大）；
//   2) 驳回可以顺手写理由（复用 API 的 reason 语义，落到 audit_log）。
// 判词面板同时把卡片的 reason / severity 亮出来：自动沉淀里「蒸馏兜底原文卡」
// 是最该优先复核的一类，以前在 TUI 里完全看不出来。

const API = process.env.MEMORY_ETERNAL_API || 'http://127.0.0.1:7999/memory-eternal/api'
const MAX_REASON = 120

async function apiJson(path, options = {}) {
  const res = await fetch(API + path, { ...options, signal: AbortSignal.timeout(10000) })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data
}

function timeOf(value) {
  const d = new Date(value || Date.now())
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// ── 纯函数（导出给 tests/tui-audit-scene.test.mjs 真调用，不依赖 React 或宿主） ──

/** 判词面板第一行：kind · 时间 · 来源 · 严重度（info 是默认值，不占位置）。 */
export function cardMeta(card) {
  const c = card || {}
  const parts = [c.kind || 'knowledge', c.time || '', c.source || '']
  const severity = String(c.severity || '').trim()
  if (severity && severity !== 'info') parts.push('严重度 ' + severity)
  return parts.filter(Boolean).join(' · ')
}

/**
 * `依据：<reason>`。没有 reason 返回空串 —— 调用方据此**不占空行**。
 * reason 来自卡片 DB（lib/vault.js rowToCard）：'AI 自动沉淀（蒸馏卡）'、
 * 'AI 自动沉淀（原文卡）'、'手动创建'、'多卡合并' 等。
 */
export function reasonLine(card) {
  const reason = String((card && card.reason) || '').trim()
  if (!reason) return ''
  return '依据：' + (reason.length > MAX_REASON ? reason.slice(0, MAX_REASON - 1) + '…' : reason)
}

/** 蒸馏兜底原文卡标记：没有 LLM 精炼的降级卡，最该先复核（没有就返回空串）。 */
export function reasonFlag(card) {
  const reason = String((card && card.reason) || '')
  return /原文卡|raw/i.test(reason) ? '⚠ 蒸馏兜底原文卡（无 LLM 精炼，优先复核）' : ''
}

/** 列表标题位置文本 `起-止/总数`；空队列 `0/0`。start 是窗口首项下标（0 基）。 */
export function positionLabel(start = 0, count = 0, total = 0) {
  const t = Math.max(0, Number(total) || 0)
  if (!t) return '0/0'
  const s = Math.max(0, Math.min(Number(start) || 0, t - 1))
  const c = Math.max(0, Number(count) || 0)
  const first = s + 1
  const last = Math.min(t, s + c)
  if (last < first) return `0/${t}`
  return `${first}-${last}/${t}`
}

/** 底栏确认文案：批准 = 二次确认；驳回 = 确认态同时收理由（可空）。 */
export function confirmLabel(kind, count = 1, reason = '') {
  const n = Math.max(0, Number(count) || 0)
  if (kind === 'reject') return `驳回 ${n} 张 · 理由（可空）：${String(reason || '')}   Enter 确认 / Esc 取消`
  return `确认批准 ${n} 张？Enter 确认 / Esc 取消`
}

/** 审核请求体：批准只带 path；驳回总是带 reason（空串也带，服务端按缺省 '' 记 audit_log）。 */
export function auditPayload(action, path, reason = '') {
  if (action === 'reject') return { path, reason: String(reason || '').trim() }
  return { path }
}

export function AuditScene(props) {
  const { React, ui, close } = props
  const { Box, Text, useInput, useTerminalSize } = ui
  const { useState, useEffect } = React
  const size = useTerminalSize ? useTerminalSize() : { columns: 110, rows: 34 }
  const columns = size.columns || 110
  const rows = size.rows || 34

  const [cards, setCards] = useState([])
  const [index, setIndex] = useState(0)
  const [marked, setMarked] = useState(() => new Set())
  const [status, setStatus] = useState('读取待审队列…')
  const [loading, setLoading] = useState(true)
  // 二次确认态（issue #50）：null = 列表；否则 { action:'approve'|'reject', count, paths }
  const [confirm, setConfirm] = useState(null)
  const [reason, setReason] = useState('')

  const load = async () => {
    setLoading(true)
    setStatus('读取待审队列…')
    setConfirm(null)
    setReason('')
    try {
      const data = await apiJson('/cards?status=pending&limit=300')
      setCards((data.cards || []).map((c) => ({
        path: c.path,
        kind: c.kind || 'knowledge',
        title: c.title || '无标题',
        summary: String(c.summary || '').replace(/^#{1,6}\s*/gm, '').replace(/\s+/g, ' ').slice(0, 260),
        source: c.submittedBy || 'memory',
        severity: c.severity || 'info',
        reason: String(c.reason || '').trim(),
        time: timeOf(c.updated || c.created),
      })))
      setIndex(0)
      setMarked(new Set())
      setStatus('')
    } catch (err) {
      setStatus('读取失败：' + err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const current = cards[index]
  const visible = cards
  const selected = marked.size

  // 目标在进入确认时就冻结：确认期间即使列表/选择变化，Enter 提交的也是用户看到的那批卡。
  const beginConfirm = (action) => {
    const targets = selected ? visible.filter((c) => marked.has(c.path)) : (current ? [current] : [])
    if (!targets.length) { setStatus('没有可操作的卡片'); return }
    setConfirm({ action, count: targets.length, paths: targets.map((c) => c.path) })
    setReason('')
    setStatus('')
  }

  const runConfirm = async () => {
    if (!confirm) return
    const { action, paths, count } = confirm
    setStatus(`${action === 'reject' ? '驳回' : '批准'} ${count} 张…`)
    try {
      await Promise.all(paths.map((path) => apiJson('/audit/' + (action === 'reject' ? 'reject' : 'approve'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(auditPayload(action, path, reason)),
      })))
      const ids = new Set(paths)
      setCards((prev) => prev.filter((c) => !ids.has(c.path)))
      setIndex(0)
      setMarked(new Set())
      setConfirm(null)
      setReason('')
      setStatus(`✓ ${action === 'reject' ? '已驳回' : '已批准'} ${count} 张`)
    } catch (err) {
      // 失败留在确认态：检查网络/权限后可直接 Enter 重试，Esc 才是放弃。
      setStatus('操作失败：' + err.message)
    }
  }

  useInput((input, key) => {
    const esc = key.escape || input === '\u001b'
    const enter = key.return || key.enter || input === '\r' || input === '\n'
    if (confirm) {
      if (esc) { setConfirm(null); setReason(''); setStatus(''); return }
      if (enter) { void runConfirm(); return }
      if (confirm.action === 'reject') {
        if (key.backspace || key.delete || input === '\u007f' || input === '\b') { setReason((r) => r.slice(0, -1)); return }
        // 只收可见字符；方向键/Tab/Ctrl 组合不进理由（理由可空，Enter 直接提交）。
        if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
          setReason((r) => (r + input).slice(0, MAX_REASON))
        }
      }
      return
    }
    if (esc || input === 'q') { close(); return }
    if (input === 'a' && !key.ctrl) { beginConfirm('approve'); return }
    if (input === 'r' && !key.ctrl) { beginConfirm('reject'); return }
    if (input === 's' || (key.ctrl && input === 'a')) {
      setMarked((prev) => {
        const all = visible.length > 0 && visible.every((c) => prev.has(c.path))
        return all ? new Set() : new Set(visible.map((c) => c.path))
      })
      return
    }
    if (key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return }
    if (key.downArrow) { setIndex((i) => Math.min(Math.max(0, visible.length - 1), i + 1)); return }
    if (key.space || input === ' ') {
      if (!current) return
      setMarked((prev) => {
        const next = new Set(prev)
        if (next.has(current.path)) next.delete(current.path)
        else next.add(current.path)
        return next
      })
    }
  })

  const listH = Math.max(3, rows - 7)
  const rowW = Math.max(36, Math.floor((columns - 3) * 0.42))
  const previewW = Math.max(20, columns - rowW - 3)
  const start = Math.max(0, Math.min(index - Math.floor(listH / 2), Math.max(0, visible.length - listH)))
  const list = (visible || []).slice(start, start + listH)
  const previewLines = []
  if (current) {
    previewLines.push(cardMeta(current))
    const why = reasonLine(current)
    if (why) previewLines.push(why)
    const flag = reasonFlag(current)
    if (flag) previewLines.push(flag)
    previewLines.push('')
    previewLines.push(current.title)
    previewLines.push('')
    const wrapW = Math.max(16, previewW - 4)
    for (let i = 0; i < current.summary.length; i += wrapW) {
      previewLines.push(current.summary.slice(i, i + wrapW))
    }
  } else {
    previewLines.push(loading ? '读取中…' : '没有待审卡')
  }

  const errored = status.startsWith('操作失败') || status.startsWith('读取失败')
  const confirmText = confirm ? confirmLabel(confirm.action, confirm.count, reason) : ''
  // 确认态里也要能看到「提交中… / 操作失败」（失败会留在确认态让用户重试）。
  const footer = confirm
    ? (errored || status.endsWith('…') ? status + '   ' + confirmText : confirmText)
    : (status || '↑↓ 移动   Space 多选   s 全选   a 批准   r 驳回（可填理由）   Esc 退出')
  const footerColor = confirm ? (errored ? 'error' : 'remember')
    : status.startsWith('✓') ? 'success'
      : errored ? 'error'
        : undefined

  const h = React.createElement
  return h(Box, { flexDirection: 'column', width: columns, height: rows },
    h(Box, { flexShrink: 0 },
      h(Text, { color: 'remember', bold: true }, '● MEMORY ATLAS'),
      h(Text, { dimColor: true }, `  / 待审   ${cards.length} 张   ${positionLabel(start, list.length, cards.length)}` + (selected ? `   已选 ${selected}` : '')),
    ),
    h(Text, { dimColor: true }, '─'.repeat(Math.max(1, columns - 1))),
    h(Box, { flexDirection: 'row', flexGrow: 1, overflow: 'hidden' },
      h(Box, { flexDirection: 'column', width: rowW, borderStyle: 'round', flexShrink: 0 },
        h(Text, { dimColor: true }, ` ${selected ? '▣' : '☐'} 全选 ${visible.length}   s 全选`),
        ...list.map((c, i) => {
          const on = start + i === index
          const mark = marked.has(c.path) ? '◉' : '○'
          const label = ` ${on ? '▌' : ' '}${mark} [${c.kind}] ${c.title}`
          return h(Text, { key: c.path, inverse: on, wrap: 'truncate' }, label.slice(0, rowW - 2))
        }),
      ),
      h(Box, { flexDirection: 'column', width: previewW, borderStyle: 'round', flexGrow: 1 },
        ...previewLines.slice(0, Math.max(1, rows - 4)).map((line, i) =>
          h(Text, { key: i, wrap: 'truncate', color: i === 0 ? 'remember' : undefined }, ' ' + line)),
      ),
    ),
    h(Text, { color: footerColor, dimColor: !status && !confirm, wrap: 'truncate' }, ' ' + footer),
  )
}

export default AuditScene
