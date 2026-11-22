// 云端连接配置 + 卡片推送（供 DSH 插件侧使用）。
//
// 为什么需要它：用户切到「云端模式」后，agent 自动沉淀的卡片也应该进云端。
// 但插件的 capture 走的是本地 SQLite（vaultDir），它**不知道前端选了云端** ——
// 云端连接信息原来只存在浏览器 localStorage 里，Node 侧读不到。
//
// 所以这里做两件事：
//   ① 把云端连接配置落到 $DSH_HOME 下的文件，让插件与 web 服务都能读；
//   ② 提供 pushCardToCloud() —— capture 写本地成功后异步推一份到云端。
//
// 设计取舍：**本地永远写**（账本，保证不丢；离线也能用），云端是副本。
// 推送失败只在本地记一笔，不影响 capture 主流程，也不阻塞会话。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const FILE = 'memory-eternal-cloud-conn.json'

/** 配置文件路径。 */
export function cloudConnPath(env = process.env) {
  const home = String((env && env.DSH_HOME) || '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, FILE)
}

/** 读云端连接（读不到就当本地模式）。 */
export function readCloudConn(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(cloudConnPath(env), 'utf8'))
    return {
      mode: raw.mode === 'cloud' ? 'cloud' : 'local',
      url: String(raw.url || '').trim().replace(/\/+$/, ''),
      token: String(raw.token || '').trim(),
      active: raw.active !== false,
      owner: String(raw.owner || ''),
      // 浏览器（客户端）的设备 id，由前端经 /cloud/conn 同步下来。
      // 自动沉淀推送要带上它，云端才会写进「这台设备选的库」而不是全局活跃库。
      deviceId: String(raw.deviceId || ''),
      updatedAt: String(raw.updatedAt || ''),
    }
  } catch {
    return { mode: 'local', url: '', token: '', active: false, owner: '', updatedAt: '' }
  }
}

/** 写云端连接（前端切模式时经 /api/cloud/conn 调进来）。 */
export function writeCloudConn(next, env = process.env) {
  try {
    // **合并而非替换**：客户端同步时可能只带部分字段（例如 localStorage 里没有 owner），
    // 直接覆盖会把服务端已有的 owner/token 抹成空。表现就是面板上「已连接但认不出是谁」。
    const prev = readCloudConn(env)
    const pick = (v, old) => {
      const s = String(v == null ? '' : v).trim()
      return s || String(old || '')
    }
    const wantMode = next && next.mode === 'cloud' ? 'cloud' : 'local'
    // 拒绝脏值：'***' 是历史脱敏造成的污染。一旦写进来，后续所有请求都 401，
    // 而且客户端会把它当成真令牌反复回写 —— 必须在这里挡死。
    const incomingToken = String((next && next.token) || '').trim()
    if (incomingToken && /^\*+$/.test(incomingToken)) {
      return { ok: false, error: '令牌是脱敏占位符（***），拒绝写入；请重新登录或填真实 me_ 密钥' }
    }
    // **空令牌也不能覆盖有效令牌**：旧 bundle 的启动同步会拿 localStorage 里的空值回写，
    // 一次就把服务端的有效密钥抹掉，之后整条云端链路 401。
    // 只有「明确要断开云端」（mode=local）时才允许清空。
    const prevHasKey = /^[a-zA-Z0-9_-]{16,}$/.test(String(prev.token || '').trim())
    if (prevHasKey && !incomingToken && wantMode === 'cloud') {
      return { ok: false, error: '空令牌不能覆盖已有密钥（mode 仍是 cloud）；如需断开请先切到本地模式' }
    }
    // 防「旧客户端把状态抹空」：页面还在跑旧 bundle 时，它的启动同步会拿
    // localStorage 里的空 owner / false active 回写服务端，把正确状态冲掉，
    // 表现就是「重启后明明该是个人版，却显示未激活」。
    // 规则：**仍是 cloud 模式**却传来 active=false 且 owner 为空 → 视为误写，保留服务端原值。
    const looksLikeClobber = wantMode === 'cloud'
      && prev.mode === 'cloud'
      && prev.active === true
      && String(prev.owner || '').trim()
      && next && next.active === false
      && !String(next.owner || '').trim()
    const payload = {
      mode: wantMode,
      url: pick(next && next.url, prev.url).replace(/\/+$/, ''),
      token: pick(next && next.token, prev.token),
      active: looksLikeClobber ? true : !!(next && next.active),
      owner: pick(next && next.owner, prev.owner),
      deviceId: pick(next && next.deviceId, prev.deviceId),
      updatedAt: new Date().toISOString(),
    }
    // 云端模式必须有合法地址，否则写进去等于埋个坏配置
    if (payload.mode === 'cloud' && !/^https?:\/\//i.test(payload.url)) {
      return { ok: false, error: '云端模式需要合法的 http(s) 地址' }
    }
    const p = cloudConnPath(env)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: p, conn: payload }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 当前是否该把卡片推到云端。 */
export function shouldPushToCloud(env = process.env) {
  const c = readCloudConn(env)
  return c.mode === 'cloud' && c.active && !!c.token && /^https?:\/\//i.test(c.url)
}

/**
 * 把一张卡推送到云端。
 *
 * 用 `/import/chunk` —— 它按 contentHash 去重，重复推同一张只是 skipped，
 * 所以「重试」是安全的，不需要额外的幂等标记。
 *
 * @param {{title?:string, kind?:string, tags?:string[], body?:string, source?:string, status?:string}} card
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string}>} 永不抛
 */
export async function pushCardToCloud(card, env = process.env) {
  try {
    const c = readCloudConn(env)
    if (c.mode !== 'cloud' || !c.active || !c.token) return { ok: false, error: 'not-cloud' }
    const title = String((card && card.title) || '').trim()
    const body = String((card && card.body) || '').trim()
    if (!title || !body) return { ok: false, error: 'empty-card' }
    const kind = String((card && card.kind) || 'knowledge')
    // 整卡 markdown 形状：importChunk 会再解析 frontmatter
    const text = '---\ntitle: ' + title.replace(/\n/g, ' ') + '\nkind: ' + kind + '\n---\n\n' + body
    const url = c.url + '/api/import/chunk'
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + c.token,
        // 多设备：带上本机浏览器同步下来的 device id。云端 /import/chunk 的 vaultDir
        // 是按设备解析的（activeRootOf(roots, currentDevice())）——不带这个头，
        // 自动沉淀会落进「全局活跃库」（最后一次切库那台的口味），两台设备选不同库时就写错地方。
        ...(c.deviceId ? { 'X-Device-Id': c.deviceId } : {}),
      },
      body: JSON.stringify({ cards: [{ title, kind, body, text, source: String((card && card.source) || 'dsd-capture') }], offset: 0, total: 1 }),
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, error: 'HTTP ' + res.status + ' ' + t.slice(0, 120) }
    }
    const d = await res.json().catch(() => ({}))
    if (!d || !d.ok) return { ok: false, error: (d && d.error) || 'unknown' }
    return { ok: true, skipped: (Number(d.duplicate) || 0) > 0, imported: Number(d.imported) || 0 }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// ── 失败重试队列 ────────────────────────────────────────────────────────────
//
// 推送是旁路，失败不能回滚本地写卡；但也不能就这么丢了 ——
// 用户切过云端、后来断网或云端抖动，那些卡就永远到不了云端。
//
// 用 JSONL 追加（无 schema 变更、坏一行不影响其它行），条数封顶防无限增长。
// 重试安全：云端 importChunk 按 contentHash 去重，重复推只会 skipped。

const QUEUE_FILE = 'memory-eternal-cloud-queue.jsonl'
const QUEUE_MAX = 500

/** 队列文件路径。 */
export function cloudQueuePath(env = process.env) {
  const home = String((env && env.DSH_HOME) || '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, QUEUE_FILE)
}

/** 把一张推送失败的卡记进队列（自动封顶，保留最新的）。 */
export function enqueueFailedPush(card, error, env = process.env) {
  try {
    const p = cloudQueuePath(env)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    try {
      const all = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      if (all.length >= QUEUE_MAX) {
        fs.writeFileSync(p, all.slice(-(QUEUE_MAX - 1)).join('\n') + '\n', 'utf8')
      }
    } catch { /* 文件还不存在 */ }
    const row = {
      at: new Date().toISOString(),
      title: String((card && card.title) || '').slice(0, 200),
      kind: String((card && card.kind) || 'knowledge'),
      body: String((card && card.body) || ''),
      source: String((card && card.source) || ''),
      // 带上本地相对路径：补推成功后要回写「已同步」标记
      path: String((card && card.path) || ''),
      error: String(error || '').slice(0, 200),
    }
    fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 读队列（不删）。 */
export function readQueue(env = process.env) {
  try {
    return fs.readFileSync(cloudQueuePath(env), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 把队列里的卡全部重推一遍。
 *
 *   · 成功（含 skipped）→ 出队
 *   · 失败 → 留在队列等下次
 *   · 连续失败 3 次就停（大概率云端整体不可达，继续打只是白等）
 */
export async function flushQueue(env = process.env) {
  const rows = readQueue(env)
  if (!rows.length) return { ok: true, total: 0, sent: 0, failed: 0 }
  if (!shouldPushToCloud(env)) return { ok: false, total: rows.length, sent: 0, failed: rows.length, error: 'not-cloud' }

  const remaining = []
  let sent = 0
  let consecutiveFail = 0
  for (const row of rows) {
    if (consecutiveFail >= 3) { remaining.push(row); continue }
    const r = await pushCardToCloud(row, env)
    if (r && r.ok) {
      sent++
      consecutiveFail = 0
    } else {
      consecutiveFail++
      remaining.push(row)
    }
  }
  try {
    const p = cloudQueuePath(env)
    if (remaining.length) fs.writeFileSync(p, remaining.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    else if (fs.existsSync(p)) fs.rmSync(p, { force: true })
  } catch { /* 写回失败就保留原文件 */ }
  return { ok: true, total: rows.length, sent, failed: remaining.length }
}
