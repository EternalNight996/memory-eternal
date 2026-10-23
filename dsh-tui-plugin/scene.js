// dsh-tui 原生审核场景（最小闭环）
//
// 不复制 Web UI：只把「待审队列 + 全选 + 批准/驳回」做成 dsh-tui 原生场景。
// 日常浏览/长文仍可回到 Web 或外部 TUI 客户端。

const API = process.env.MEMORY_ETERNAL_API || 'http://127.0.0.1:7999/memory-eternal/api'

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

  const load = async () => {
    setLoading(true)
    setStatus('读取待审队列…')
    try {
      const data = await apiJson('/cards?status=pending&limit=300')
      setCards((data.cards || []).map((c) => ({
        path: c.path,
        kind: c.kind || 'knowledge',
        title: c.title || '无标题',
        summary: String(c.summary || '').replace(/^#{1,6}\s*/gm, '').replace(/\s+/g, ' ').slice(0, 260),
        source: c.submittedBy || 'memory',
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
  const apply = async (decision) => {
    const targets = selected ? visible.filter((c) => marked.has(c.path)) : (current ? [current] : [])
    if (!targets.length) return
    setStatus(decision === 'a' ? `批准 ${targets.length} 张…` : `驳回 ${targets.length} 张…`)
    try {
      await Promise.all(targets.map((c) => apiJson('/audit/' + (decision === 'a' ? 'approve' : 'reject'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: c.path }),
      })))
      const ids = new Set(targets.map((c) => c.path))
      setCards((prev) => prev.filter((c) => !ids.has(c.path)))
      setIndex(0)
      setMarked(new Set())
      setStatus(`✓ ${decision === 'a' ? '已批准' : '已驳回'} ${targets.length} 张`)
    } catch (err) {
      setStatus('操作失败：' + err.message)
    }
  }

  useInput((input, key) => {
    if (key.escape || input === 'q') { close(); return }
    if (input === 'r' && !key.ctrl) { void apply('r'); return }
    if (input === 'a' && !key.ctrl) { void apply('a'); return }
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
    previewLines.push(current.kind + ' · ' + current.time + ' · ' + current.source)
    previewLines.push('')
    previewLines.push(current.title)
    previewLines.push('')
    for (let i = 0; i < current.summary.length; i += Math.max(16, previewW - 4)) {
      previewLines.push(current.summary.slice(i, i + Math.max(16, previewW - 4)))
    }
  } else {
    previewLines.push(loading ? '读取中…' : '没有待审卡')
  }

  const h = React.createElement
  return h(Box, { flexDirection: 'column', width: columns, height: rows },
    h(Box, { flexShrink: 0 },
      h(Text, { color: 'remember', bold: true }, '● MEMORY ATLAS'),
      h(Text, { dimColor: true }, `  / 待审   ${cards.length} 张` + (selected ? `   已选 ${selected}` : '')),
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
    h(Text, { color: status.startsWith('✓') ? 'success' : status.startsWith('操作失败') || status.startsWith('读取失败') ? 'error' : undefined, dimColor: !status },
      ' ' + (status || '↑↓ 移动   Space 多选   s 全选   a 批准   r 驳回   Esc 退出')),
  )
}

export default AuditScene
