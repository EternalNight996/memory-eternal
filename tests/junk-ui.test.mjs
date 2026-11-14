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
  // 先放「实验性」页，等稳定了再下放到「记忆」页
  assert.match(src, /'sec-junk':\s*'experimental'/, "PAGE_OF 要有 'sec-junk': 'experimental'")
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

test('确认弹窗存在，且按步骤写出动作与条数', () => {
  assert.match(src, /junkConfirm &&/, '要有确认弹窗的渲染条件')
  assert.match(src, /t\('junkConfirmTitle'\)/, '弹窗要有标题')
  // 「立即清理」会一次做两件事（归档 + 清到回收站），所以弹窗按 steps 渲染
  assert.match(src, /junkConfirm\.steps \|\|/, '要支持 steps（多步）')
  assert.match(src, /st\.paths\.length/, '每步要显示影响条数')
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
  assert.match(src, /some\(\(x\) => x\.action === 'delete'\) \? 'primary' : 'secondary'/, '只要有 delete 步骤就给更强的视觉权重')
})

test('归档管理：有查看/全部恢复入口，且调对了接口', () => {
  // 「归档 = 藏起来」但不能是"找不回来"，否则用户不敢用归档
  assert.match(src, /junkLoadArchived/, '要有「查看归档」文案')
  assert.match(src, /junkRestoreAll/, '要有「全部恢复」文案')
  assert.match(src, /fetch\(API \+ '\/cards\?status=archived/, '要拉归档列表')
  assert.match(src, /action: 'restore', paths: list/, '全部恢复要复用批量处置')
})

test('/cards 支持 status=archived（白名单 + appliedStatus 都要认）', () => {
  const api = fs.readFileSync('lib/api.js', 'utf8')
  assert.match(api, /KNOWN_STATUS = \[[^\]]*'archived'\]/, 'KNOWN_STATUS 要含 archived')
  assert.match(api, /status === 'archived' \? \['archived'\]/, 'want 映射要含 archived')
  assert.match(api, /status === 'archived' \? 'archived'/, 'appliedStatus 要回显 archived')
})


test('「清理到回收站」文案正确（delete 是软删，不是永久删）', () => {
  assert.match(src, /junkActionDelete: '清理到回收站'/, '按钮必须写清是"清理到回收站"')
  // 后端：/cards/bulk 的 delete 走 deleteCard 默认参数 = 软删
  const api = fs.readFileSync('lib/api.js', 'utf8')
  assert.match(api, /action === 'delete'\) r = await deleteCard\(vaultRoot, p\)/, '批量删除不传 permanent = 软删进回收站')
})

test('有「立即清理」按钮（一键扫+清，不是只能一类一类点）', () => {
  assert.match(src, /junkCleanNow/, '要有「立即清理」文案')
  assert.match(src, /const cleanNow = async/, '要有 cleanNow 实现')
  // 清理动作必须是 delete（进回收站）而不是永久删
  assert.match(src, /action: 'delete', paths: recycle/, '可回收类走 delete（软删）')
})
