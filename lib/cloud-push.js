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
      updatedAt: String(raw.updatedAt || ''),
    }
  } catch {
    return { mode: 'local', url: '', token: '', active: false, owner: '', updatedAt: '' }
  }
}

/** 写云端连接（前端切模式时经 /api/cloud/conn 调进来）。 */
export function writeCloudConn(next, env = process.env) {
  try {
    const payload = {
      mode: next && next.mode === 'cloud' ? 'cloud' : 'local',
      url: String((next && next.url) || '').trim().replace(/\/+$/, ''),
      token: String((next && next.token) || '').trim(),
      active: !!(next && next.active),
      owner: String((next && next.owner) || ''),
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
    const url = c.url + '/memory-eternal/api/import/chunk'
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + c.token,
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
