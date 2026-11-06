// 记忆核心 · Star 引导（价值触发）
//
// 锁定的行为契约：
//   1. 用户还没用起来（召回 <8 且卡 <15）时**不许问** —— 这是「装机即求 star」的病根
//   2. 达到任一阈值才问，且 7 天冷却、最多 3 次
//   3. 「不再提示」必须永久生效（面板重启也不能忘）
//   4. 状态写失败不能抛（提示功能坏了不许影响记忆面板）
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shouldAsk, starPromptStatus, markStarAction, readStarState, starStateFile,
  ASK_COOLDOWN_MS, ASK_MAX_TIMES, ASK_MIN_CARDS, ASK_MIN_RECALLS,
} from '../lib/star-prompt.js'
import { ensureVault, writeCard } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-star-'))
const env = { DSH_HOME: tmp }
const root = path.join(tmp, 'vault')

after(async () => {
  closeAllDb()
  try { await fsp.rm(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
})

beforeEach(async () => {
  try { await fsp.rm(starStateFile(env), { force: true }) } catch { /* 不存在 */ }
})

const NOW = 1_760_000_000_000

test('还没用起来：召回和卡片都没到阈值 → 不问', () => {
  assert.equal(shouldAsk({ recalls: ASK_MIN_RECALLS - 1, cards: ASK_MIN_CARDS - 1, state: {}, now: NOW }), false)
  assert.equal(shouldAsk({ recalls: 0, cards: 0, state: {}, now: NOW }), false)
})

test('召回次数到阈值 → 问', () => {
  assert.equal(shouldAsk({ recalls: ASK_MIN_RECALLS, cards: 0, state: {}, now: NOW }), true)
})

test('卡片数到阈值 → 问（没用召回、但确实在沉淀也算用起来了）', () => {
  assert.equal(shouldAsk({ recalls: 0, cards: ASK_MIN_CARDS, state: {}, now: NOW }), true)
})

test('「不再提示」永久关闭，哪怕数据再漂亮', () => {
  assert.equal(shouldAsk({ recalls: 999, cards: 999, state: { dismissed: true }, now: NOW }), false)
})

test('最多问 3 次', () => {
  assert.equal(shouldAsk({ recalls: 999, cards: 999, state: { asks: ASK_MAX_TIMES }, now: NOW }), false)
  assert.equal(shouldAsk({ recalls: 999, cards: 999, state: { asks: ASK_MAX_TIMES - 1 }, now: NOW }), true)
})

test('7 天冷却：刚问过不重复打扰，过期后再问', () => {
  const justAsked = { lastAskAt: NOW - 1000 }
  assert.equal(shouldAsk({ recalls: 99, cards: 99, state: justAsked, now: NOW }), false)
  const weekAgo = { lastAskAt: NOW - ASK_COOLDOWN_MS - 1000 }
  assert.equal(shouldAsk({ recalls: 99, cards: 99, state: weekAgo, now: NOW }), true)
})

test('markStarAction 持久化：shown 计数并开始冷却，never 永久关闭', () => {
  markStarAction(env, 'shown', NOW)
  let s = readStarState(env)
  assert.equal(s.asks, 1)
  assert.equal(s.lastAskAt, NOW)
  assert.equal(s.dismissed, false)

  markStarAction(env, 'never', NOW + 10)
  s = readStarState(env)
  assert.equal(s.dismissed, true)
  assert.equal(shouldAsk({ recalls: 999, cards: 999, state: s, now: NOW + 20 }), false)
})

test('状态文件放在 config 旁边（<config>.star.json），不是塞进 vault', () => {
  const f = starStateFile(env)
  assert.match(f, /memory-eternal-config\.star\.json$/)
  assert.ok(f.startsWith(tmp), '应落在 DSH_HOME 下')
})

test('真实库集成：沉淀够 15 张卡后 status 就会建议问', async () => {
  await ensureVault(root)
  for (let i = 0; i < ASK_MIN_CARDS; i++) {
    await writeCard(root, {
      kind: 'knowledge',
      title: '集成测试卡 ' + i,
      // 必须让每张卡的内容差异足够大，否则会被 MinHash 去重合并成一张（测试会假绿）
      body: '卡片编号 ' + i + '-' + Math.random().toString(36).slice(2, 12) + ' 的正文，用于触发阈值判定。' + Math.random().toString(36).slice(2, 14) + ' 结束。',
      status: 'approved',
    })
  }
  const db = (await import('../lib/db.js')).getDb(root)
  const written = Number(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n)
  assert.ok(written >= ASK_MIN_CARDS, '测试前提：实际写入 ' + written + ' 张卡（去重可能合并）')
  const st = starPromptStatus({ root, env, now: NOW })
  assert.equal(st.ok, true)
  assert.equal(st.shouldAsk, true)
  assert.ok(st.evidence.cards >= ASK_MIN_CARDS)
  assert.ok(st.evidence.recalls >= 0)
})
