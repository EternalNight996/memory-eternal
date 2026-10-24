// 记忆账本：记录召回注入 / 蒸馏调用，并汇总出「花了多少 token」的第一手数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { recordLedger, ledgerSummary } from '../lib/ledger.js'
import { addFeedback } from '../lib/vault.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ledger-'))

test('记录召回/沉淀并汇总（含 7 日窗口）', () => {
  recordLedger(root, { kind: 'recall', results: 3, chars: 600, note: '数据库选型' })
  recordLedger(root, { kind: 'capture', charsIn: 2000, chars: 800, llmCalls: 1, provider: 'p', model: 'm', ok: true })
  const s = ledgerSummary(root, { days: 7 })
  assert.equal(s.ok, true)
  assert.equal(s.totals.recalls, 1)
  assert.equal(s.totals.injectedChars, 600)
  assert.equal(s.totals.captures, 1)
  assert.equal(s.totals.llmCalls, 1)
  assert.equal(s.totals.captureInChars, 2000)
  assert.equal(s.totals.captureOutChars, 800)
  assert.equal(s.totals.estTokens, Math.round((600 + 2000 + 800) / 2))
  assert.equal(s.byDay.length, 7)
  assert.equal(s.byDay[s.byDay.length - 1].recalls, 1)
})

test('窗口之外的不计入（30 天前的那条）', () => {
  recordLedger(root, { kind: 'recall', ts: Date.now() - 30 * 86400000, chars: 9999 })
  const s = ledgerSummary(root, { days: 7 })
  assert.equal(s.totals.injectedChars, 600)
})

test('召回有用率来自 feedback；没有反馈时 rate=null（不要假装 0%）', async () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ledger2-'))
  assert.equal(ledgerSummary(r2).feedback.rate, null)
  await addFeedback(r2, { query: 'q', path: '03/x.md', useful: true })
  await addFeedback(r2, { query: 'q', path: '03/y.md', useful: false })
  const s = ledgerSummary(r2)
  assert.equal(s.feedback.useful, 1)
  assert.equal(s.feedback.useless, 1)
  assert.equal(s.feedback.rate, 0.5)
})

test('账本写入失败不影响调用方（非法 root 也不抛）', () => {
  assert.doesNotThrow(() => recordLedger('\u0000bad-root', { kind: 'recall' }))
})

test('CLI dsh-memory ledger 输出 JSON 与人类可读摘要', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ledger-cli-'))
  recordLedger(v, { kind: 'recall', results: 2, chars: 400 })
  recordLedger(v, { kind: 'capture', charsIn: 1000, chars: 300, llmCalls: 1 })
  const bin = path.join(repoRoot, 'bin', 'dsh-memory.mjs')
  const json = execFileSync(process.execPath, [bin, 'ledger', '--vault', v, '--days', '7', '--json'], { encoding: 'utf8' })
  const j = JSON.parse(json)
  assert.equal(j.totals.recalls, 1)
  assert.equal(j.totals.injectedChars, 400)
  assert.equal(j.totals.estTokens, Math.round((400 + 1000 + 300) / 2))
  const text = execFileSync(process.execPath, [bin, 'ledger', '--vault', v, '--days', '7'], { encoding: 'utf8' })
  assert.match(text, /记忆账本/)
  assert.match(text, /召回/)
  assert.match(text, /--json/)
})
