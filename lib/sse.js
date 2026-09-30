// SSE 推送中心：把「配置/卡片变更」即时推给所有已打开的页面（不必手动刷新）。
// 两个宿主（DSH 内嵌 + 独立 web）共用同一套实现；纯逻辑，便于单测（注入假 res）。
export function createHub({ heartbeatMs = 25000 } = {}) {
  const clients = new Set()
  let timer = null
  const send = (res, chunk) => {
    try { res.write(chunk); return true } catch { return false }
  }
  const drop = (res) => {
    clients.delete(res)
    try { res.end() } catch { /* 已断开 */ }
  }
  const ensureTimer = () => {
    if (timer || !(heartbeatMs > 0)) return
    timer = setInterval(() => {
      for (const res of [...clients]) if (!send(res, ': ping\n\n')) drop(res)
    }, heartbeatMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  return {
    /** 接入一个连接（保持长连接，不要 end）。 */
    add(res) {
      try {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
      } catch { return false }
      if (!send(res, 'retry: 3000\n\n')) return false
      clients.add(res)
      ensureTimer()
      const onClose = () => drop(res)
      try { res.on('close', onClose); res.on('error', onClose) } catch { /* 某些响应对象没有 on */ }
      return true
    },
    /** 广播事件（event: <name>，data: JSON）。返回当前连接数。 */
    broadcast(event, data) {
      const chunk = 'event: ' + event + '\ndata: ' + JSON.stringify(data === undefined ? {} : data) + '\n\n'
      for (const res of [...clients]) if (!send(res, chunk)) drop(res)
      return clients.size
    },
    get size() { return clients.size },
    close() {
      if (timer) clearInterval(timer)
      timer = null
      for (const res of [...clients]) drop(res)
    },
  }
}
