// 记忆核心 · 数据访问层（Repository）
//
// 设计原则（对齐 Mem0 / Letta / Zep）：
//   1. 单一路径：本地和云端都走 HTTP，不搞「本地函数调用 + 云端 HTTP」两套。
//      本地 127.0.0.1:7999 本来就暴露完整 /api/*（免鉴权），没理由绕过它。
//   2. base_url 即数据源：只有 resolveDataSource() 决定连谁，工具层不知道也不关心。
//   3. 失败不静默回落：连不上就报错，绝不偷偷换后端（那正是「写进去了但界面看不到」的成因）。
//   4. 写后校验：写完立刻核对待审数，没变化就判失败。

import { search, overview, countCards, listCards, reviseCard } from './vault.js'
import { runStandaloneCapture } from './capture-run.js'

const LOCAL_BASE = 'http://127.0.0.1:' + String(process.env.MEMORY_LOCAL_PORT || 7999)
const TIMEOUT_MS = Number(process.env.MEMORY_API_TIMEOUT_MS) || 15000

/** 统一 HTTP 调用。ds.kind 决定默认 base（本机可被 ds.base 覆盖成「当前这个实例」），path 以 / 开头。 */
async function http(ds, path, init = {}) {
  const base = String((ds.kind === 'cloud' ? ds.base : (ds.base || LOCAL_BASE)) || '').replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json' }
  if (ds.kind === 'cloud' && ds.token) {
    headers.authorization = /^Bearer\s/i.test(ds.token) ? ds.token : 'Bearer ' + ds.token
  }
  const r = await fetch(base + '/api' + path, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = { ok: false, error: 'HTTP ' + r.status + '：' + text.slice(0, 200) } }
  return { status: r.status, ok: r.status >= 200 && r.status < 300, data, base }
}

/** pending 数 —— 写后校验的判据（不是 total，total 只统计已批准卡）。 */
function pendingOf(ov) {
  return Number(ov && ov.quarantine && ov.quarantine.pending) || 0
}

export function createRepo(ds) {
  const where = String((ds.kind === 'cloud' ? ds.base : (ds.base || LOCAL_BASE)) || '').replace(/\/+$/, '')

  return {
    describe() { return { store: ds.kind, target: where, via: ds.via || '' } },

    async recall(query, limit = 5) {
      const q = new URLSearchParams({ q: String(query || ''), limit: String(limit) })
      const { ok, data, base, status } = await http(ds, '/search?' + q.toString())
      if (!ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + status))
      const hits = Array.isArray(data.hits) ? data.hits : (Array.isArray(data.cards) ? data.cards : [])
      return { hits, target: base, store: ds.kind }
    },

    async stats() {
      const { ok, data, base, status } = await http(ds, '/overview')
      if (!ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + status))
      return { overview: data, target: base, store: ds.kind }
    },

    async capture({ title, body, kind = 'knowledge', tags = [], source = 'mcp', ensurePendingGrew = true }) {
      // 幂等：同标题已存在就不重复建
      try {
        const { ok, data } = await http(ds, '/cards?status=all&limit=500')
        if (ok && data && Array.isArray(data.cards)) {
          const dup = data.cards.find((c) => String(c.title || '') === String(title))
          if (dup) return { ok: true, action: 'exists', path: dup.path, status: dup.status || 'pending' }
        }
      } catch { /* 查重失败不阻断写入 */ }

      let before = -1
      try { const { data } = await http(ds, '/overview'); before = pendingOf(data) } catch { /* 忽略 */ }

      const { status, ok, data } = await http(ds, '/write', {
        method: 'POST',
        body: JSON.stringify({ kind, title, body, tags, source }),
      })
      if (!ok || !data || data.ok === false) return { ok: false, error: (data && data.error) || ('HTTP ' + status) }

      let verified = '未校验'
      if (ensurePendingGrew && before >= 0) {
        try {
          const { data: ov2 } = await http(ds, '/overview')
          const after = pendingOf(ov2)
          if (after >= 0 && after <= before) {
            return { ok: false, path: data.path, error: '写入后待审数未变（' + before + ' → ' + after + '），卡片可能没落到目标库' }
          }
          verified = before + ' → ' + after
        } catch { /* 校验失败放行但标注 */ }
      }
      return { ok: true, action: 'pending', path: data.path, status: data.status || 'pending', verified }
    },

    async auditList({ status = 'pending', limit = 20 } = {}) {
      const q = new URLSearchParams({ status: String(status), limit: String(limit) })
      const { ok, data, base, status: hs } = await http(ds, '/cards?' + q.toString())
      if (!ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + hs))
      return { cards: Array.isArray(data.cards) ? data.cards : [], total: Number(data.total) || 0, target: base, store: ds.kind }
    },

    // 云端 /cards/bulk 只支持 delete/reject/restore/approve/archive，没有 revise。
    // 云端模式下明确报错，不假装成功。
    async revise(patch) {
      if (ds.kind === 'cloud') {
        throw new Error('云端暂不支持修改卡片（/cards/bulk 无 revise 动作）；请切到本地模式修改')
      }
      const { ok, data, status } = await http(ds, '/cards/revise', { method: 'POST', body: JSON.stringify(patch) })
      if (!ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + status))
      return { ...data, store: ds.kind }
    },
  }
}

export { LOCAL_BASE, pendingOf }

/**
 * 本机「进程内」仓储：没有可达 HTTP 基址时用（stdio MCP / CLI / 嵌入式调用 / 测试）。
 *
 * 为什么必须有它：Repository 把本机也改成走 http://127.0.0.1:7999，但调用方传进来的
 * vaultRoot 可能是**另一个库**（测试临时库 / 多库 / 非 7999 端口的独立实例）。
 * 7999 上跑的是宿主那个进程的库 —— memory_audit_list 就报出「待处理 6033 张」这种
 * 别人的数字（issue #20 回归），memory_recall 也搜不到调用方刚写的技能卡。
 *
 * 语义与 HTTP 版逐项对齐：recall 用同一套评分门槛、capture 幂等 + 写后校验、auditList 区分总数与条数。
 */
export function createLocalRepo(root) {
  const target = root
  /** 某个状态的卡片数（跨主库 / 隔离区）。 */
  const countOf = async (statuses) => {
    let n = 0
    for (const s of statuses) n += await countCards(root, { status: [s] })
    return n
  }

  return {
    describe() { return { store: 'local', target, via: 'in-process' } },

    async recall(query, limit = 5) {
      const hits = await search(root, String(query || ''), { limit, minScore: 2 })
      return { hits, target, store: 'local' }
    },

    async stats() {
      return { overview: await overview(root), target, store: 'local' }
    },

    async capture({ body, source = 'mcp', ensurePendingGrew = true }) {
      const text = String(body || '')
      if (!text.trim()) return { ok: false, error: '（空正文）' }
      const beforePending = await countOf(['pending'])
      const beforeAll = beforePending + await countOf(['approved'])
      const out = await runStandaloneCapture(root, text, { source })
      if (!out || !out.ok) {
        return { ok: false, action: out && out.action, error: (out && out.reason) || '写入失败' }
      }
      const afterPending = await countOf(['pending'])
      let verified = '未校验'
      if (ensurePendingGrew) {
        const afterAll = afterPending + await countOf(['approved'])
        if (afterAll <= beforeAll) {
          return { ok: false, path: out.path, error: '写入后卡片总数未变（' + beforeAll + ' → ' + afterAll + '），卡片可能没落库' }
        }
        verified = beforeAll + ' → ' + afterAll
      }
      return {
        ok: true,
        action: out.action || 'created',
        path: out.path,
        // 审核模式决定它是 pending 还是直接 approved —— 按 pending 实际增长判断，别硬编码
        status: afterPending > beforePending ? 'pending' : 'approved',
        verified,
      }
    },

    async auditList({ status = 'pending', limit = 20 } = {}) {
      const statuses = Array.isArray(status) ? status.map(String) : [String(status)]
      const total = await countOf(statuses)
      const cards = total ? await listCards(root, { status: statuses, limit }) : []
      return { cards, total, target, store: 'local' }
    },

    async revise(patch) {
      const out = await reviseCard(root, patch)
      return { ...out, store: 'local' }
    },
  }
}