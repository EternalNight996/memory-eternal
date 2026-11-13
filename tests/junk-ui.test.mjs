// 垃圾清理面板（设置 → 记忆 → 🧹 垃圾清理）。
//
// 守五件事 —— 每一条都对应一个真实踩过的坑：
//   ① `sec-junk` 必须出现在 PAGE_OF 里，否则 CfgSection 的 hidden 永远为 true（面板整个不渲染）
//   ② 新增的 i18n key 不能与既有 key 撞名（`junkScan`/`junkHint`/`junkDone` 已被"注入卡清理"占用，
//      后定义的会覆盖先定义的 → 界面上显示成完全不相关的文案）
//   ③ 面板必须真的调 /junk/scan 与 /cards/bulk
//   ④ 真执行必须显式传 dryRun:false（后端默认 dryRun=true，漏传等于什么都没做）
//   ⑤ 确认弹窗必须存在（误删记忆的代价远高于多点一次）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync('src/client/index.tsx', 'utf8')

/** 取某个 i18n 字典（按出现顺序全部 key → 值），用于检测撞名。 */
function i18nKeys(text) {
  return [...text.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*):\s*(?:'([^']*)'|"([^"]*)"),?$/gm)]
    .map((m) => ({ key: m[1], value: m[2] ?? m[3] }))
}

test('sec-junk 必须挂在 PAGE_OF 里（否则永远 hidden）', () => {
  assert.match(src, /'sec-junk':\s*'memory'/, "PAGE_OF 要有 'sec-junk': 'memory'")
  assert.match(src, /secProps\('sec-junk'\)/, 'CfgSection 要用 secProps 包')
  assert.match(src, /id="sec-junk"/, '要有 id="sec-junk"')
})

test('新增的 junk* i18n key 不与既有 key 撞名', () => {
  const keys = i18nKeys(src)
  const mine = new Set([
    'junkSection', 'junkSectionSub', 'junkScanBtn', 'junkScanned',
    'junkDuplicate', 'junkDuplicateHint', 'junkTooShort', 'junkTooShortHint',
    'junkNeverRecalled', 'junkNeverRecalledHint', 'junkStale', 'junkStaleHint',
    'junkBlankTitle', 'junkBlankTitleHint', 'junkQuarantineStale', 'junkQuarantineStaleHint',
    'junkActionDelete', 'junkActionArchive', 'junkActionReject',
    'junkCandidateList', 'junkMore', 'junkBulkDone', 'junkFailed', 'junkCleanHint',
    'junkConfirmTitle', 'junkConfirmBody', 'junkConfirmTip', 'junkConfirmOk',
  ])
  const counts = new Map()
  for (const k of keys) counts.set(k.key, (counts.get(k.key) || 0) + 1)
  // 中英各一份 → 每个 key 恰好 2 次；超过 2 次说明还有别处定义（撞名）
  for (const key of mine) {
    const n = counts.get(key) || 0
    assert.ok(n >= 2, `key ${key} 应在中英文各定义一次，实际 ${n}`)
    assert.ok(n <= 2, `key ${key} 被定义了 ${n} 次 —— 有撞名，后定义的会覆盖（这是真事故）`)
  }
})

test('面板真的调了扫描与批量处置接口', () => {
  assert.match(src, /fetch\(API \+ '\/junk\/scan/, '要调 /junk/scan')
  assert.match(src, /fetch\(API \+ '\/cards\/bulk'/, '要调 /cards/bulk')
})

test('真执行必须显式 dryRun:false（后端默认 true，漏传等于没做）', () => {
  assert.match(src, /dryRun:\s*false/, 'runJunkAction 必须传 dryRun:false')
})

test('确认弹窗存在，且写出影响条数与动作', () => {
  assert.match(src, /junkConfirm &&/, '要有确认弹窗的渲染条件')
  assert.match(src, /t\('junkConfirmTitle'\)/, '弹窗要有标题')
  assert.match(src, /replace\('\{n\}', String\(junkConfirm\.paths\.length\)\)/, '要显示影响条数')
  assert.match(src, /t\('junkConfirmOk'\)/, '要有确认按钮')
})

test('弹窗背景跟随皮肤变量（不要写死深色，浅色皮肤会黑底黑字）', () => {
  // 检查的是**实际 style 属性**，不是注释里提到的字符串
  assert.doesNotMatch(src, /background:\s*'var\(--mc-panel/, '不要用写死深色兜底的 background')
  assert.doesNotMatch(src, /background:\s*'#[0-9a-fA-F]{3,6}'[\s\S]{0,80}junkConfirm/, '弹窗不要硬编码背景色')
  const idx = src.indexOf('junkConfirm &&')
  assert.ok(idx > 0, '找不到确认弹窗')
  const block = src.slice(idx, idx + 1200)
  assert.match(block, /className="mc-card"/, '弹窗容器应复用 mc-card（跟随皮肤变量）')
})

test('执行完自动重扫（界面立刻反映真实状态）', () => {
  assert.match(src, /await scanJunkNow\(\)/, 'runJunkAction 结束后要重扫')
})

test('危险动作（delete）用 primary，其余用 secondary', () => {
  assert.match(src, /junkConfirm\.action === 'delete' \? 'primary' : 'secondary'/, '删除要给更强的视觉权重')
})
