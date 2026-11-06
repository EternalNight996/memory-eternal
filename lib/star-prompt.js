// 记忆核心 · Star 引导：等价值出现再问，而不是装机即求
//
// 观察（来自真实数据）：star 主要来自插件内的引导，而不是 README。但「首次打开就求 star」
// 是在用户还没感受到任何好处时提出请求 —— 转化率低，而且显得功利。
//
// 所以这里换成一个**价值触发**的提示：
//   · 门槛：账本里累计召回 ≥ 8 次，或主库已有 ≥ 15 张卡（说明它确实被用起来了）
//   · 频次：7 天冷却、最多问 3 次；点「不再提示」永久关闭
//   · 证据：不空喊「求 star」，而是把已经做过的事摆出来（召回次数 / 沉淀卡数 / 注入字符）
//
// 状态放在 config 文件旁边（<config>.star.json），与 vault 数据无关，
// 删掉 vault 不会重置它；写失败也绝不影响面板。
import fs from 'node:fs'
import path from 'node:path'
import { configFilePath } from './capture-run.js'
import { ledgerSummary } from './ledger.js'
import { getDb } from './db.js'

export const ASK_MIN_RECALLS = 8
export const ASK_MIN_CARDS = 15
export const ASK_COOLDOWN_MS = 7 * 86400000
export const ASK_MAX_TIMES = 3

/** 状态文件与 config 同目录，便于用户自己查看/删除。 */
export function starStateFile(env) {
  return String(configFilePath(env)).replace(/\.json$/i, '.star.json')
}

export function readStarState(env) {
  try {
    const raw = JSON.parse(fs.readFileSync(starStateFile(env), 'utf8'))
    return { asks: Number(raw.asks) || 0, lastAskAt: Number(raw.lastAskAt) || 0, dismissed: !!raw.dismissed }
  } catch {
    return { asks: 0, lastAskAt: 0, dismissed: false }
  }
}

function writeStarState(env, next) {
  try {
    const file = starStateFile(env)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 1))
    return true
  } catch { return false }
}

/**
 * 纯函数：是否该弹一次 star 提示。抽出来是为了能单测（时间注入，不依赖真实时钟）。
 */
export function shouldAsk({ recalls = 0, cards = 0, state = {}, now = Date.now() } = {}) {
  if (state.dismissed) return false
  if (Number(state.asks) >= ASK_MAX_TIMES) return false
  const last = Number(state.lastAskAt) || 0
  if (last && now - last < ASK_COOLDOWN_MS) return false
  return Number(recalls) >= ASK_MIN_RECALLS || Number(cards) >= ASK_MIN_CARDS
}

/** 面板启动时查询：该不该问 + 用来「讲证据」的数字。 */
export function starPromptStatus({ root, env, now = Date.now() } = {}) {
  const state = readStarState(env)
  let totals = { recalls: 0, captures: 0, injectedChars: 0 }
  try { totals = ledgerSummary(root, { days: 30, now }).totals } catch { /* 账本坏了不影响提示 */ }
  let cards = 0
  try { cards = Number(getDb(root).prepare('SELECT COUNT(*) AS n FROM cards').get().n) || 0 } catch { /* 没库就按 0 算 */ }
  return {
    ok: true,
    shouldAsk: shouldAsk({ recalls: totals.recalls, cards, state, now }),
    dismissed: !!state.dismissed,
    asks: Number(state.asks) || 0,
    nextAskAt: (Number(state.lastAskAt) || 0) + ASK_COOLDOWN_MS,
    evidence: {
      recalls: totals.recalls,
      captures: totals.captures,
      cards,
      injectedChars: totals.injectedChars,
    },
  }
}

/**
 * 记录一次动作：
 *   shown  → 面板确实展示了（计入一次、开始冷却）
 *   later  → 用户点了「晚点再说」（开始冷却）
 *   never  → 永久关闭
 */
export function markStarAction(env, action, now = Date.now()) {
  const state = readStarState(env)
  const asks = Number(state.asks) || 0
  if (action === 'never') return writeStarState(env, { ...state, dismissed: true, lastAskAt: now })
  if (action === 'shown') return writeStarState(env, { ...state, asks: asks + 1, lastAskAt: now })
  return writeStarState(env, { ...state, lastAskAt: now })
}
