// 核心记忆（前置强制记忆）：被人工批准并标记为 core 的卡片，
// 每次会话都注入 systemPrompt，不依赖模型主动调用 memory_recall。
//
// 注意：只读取主库（cards 表）里 kind='core' 的已批准卡片；
// 待审/驳回卡永远不会进入这里。

import { listCards } from './vault.js'

export const CORE_KIND = 'core'
export const CORE_HEADER = '【核心记忆 · 必须遵守】\n以下内容已被用户批准为核心记忆，每次会话都必须优先遵守；与其他记忆或默认习惯冲突时，以此处为准。'

export function normalizeCoreOptions({ enabled = true, limit = 6, maxChars = 2000 } = {}) {
  return {
    enabled: enabled !== false,
    limit: Math.min(Math.max(Math.floor(Number(limit) || 6), 1), 20),
    maxChars: Math.min(Math.max(Math.floor(Number(maxChars) || 2000), 200), 10000),
  }
}

/** 生成要注入 systemPrompt 的核心记忆文本；没有核心卡时返回空文本。 */
export async function coreMemoryPrompt(root, opts = {}) {
  const { enabled, limit, maxChars } = normalizeCoreOptions(opts)
  if (!enabled) return { ok: true, count: 0, text: '', chars: 0 }
  let cards = []
  try {
    cards = await listCards(root, { kind: CORE_KIND, limit })
  } catch {
    return { ok: false, count: 0, text: '', chars: 0 }
  }
  const lines = []
  let chars = CORE_HEADER.length
  for (const card of cards) {
    const title = String(card.title || '').replace(/\s+/g, ' ').trim()
    const summary = String(card.summary || '').replace(/\s+/g, ' ').trim()
    if (!title && !summary) continue
    let line = '- ' + (title || '核心记忆') + (summary ? '：' + summary : '')
    if (line.length > maxChars) line = line.slice(0, maxChars)
    if (chars + 1 + line.length > maxChars && lines.length) break
    lines.push(line)
    chars += 1 + line.length
  }
  if (!lines.length) return { ok: true, count: 0, text: '', chars: 0 }
  const text = CORE_HEADER + '\n' + lines.join('\n')
  return { ok: true, count: lines.length, text: text.slice(0, maxChars), chars: Math.min(chars, maxChars) }
}
