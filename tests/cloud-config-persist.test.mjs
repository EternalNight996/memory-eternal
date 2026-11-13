// 云端配置持久性：**验证失败只能"不切换"，绝不能把用户填的地址/密钥清掉**。
// 这是真事故：一次报错就把配置清空，用户得从头再填一遍。
// 守四件事：
//   ① 失败 → 保留 url/token，mode 仍是 cloud，但 active=false；
//   ② 失败 → 记录 lastError 与 lastCheckAt；
//   ③ 只有 active=true 才真的把 API 前缀切到云端；
//   ④ 主动选「本地」也不清空云端字段（方便切回去）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync('src/client/index.tsx', 'utf8')

test('配置模型含 active / lastError / lastCheckAt', () => {
  assert.match(src, /active: mode === 'cloud' \? raw\.active !== false : false/, '读配置时要还原 active')
  assert.match(src, /lastError: String\(raw\.lastError \|\| ''\)/, '要还原 lastError')
  assert.match(src, /lastCheckAt: raw\.lastCheckAt \|\| null/, '要还原 lastCheckAt')
})

test('applyCloudConn 只在 active 时才切云端', () => {
  assert.match(src, /const wantCloud = c && c\.mode === 'cloud' && c\.active !== false/, 'active=false 不能切')
})

test('fallbackToLocal 保留配置（只标记 active=false）', () => {
  // 关键：不允许再出现 {mode:'local', url:'', token:''} 这种清空写法
  assert.doesNotMatch(src, /saveCloudConn\(\{ mode: 'local', url: '', token: '' \}\)/, '不允许清空配置')
  assert.match(src, /saveCloudConn\(\{ \.\.\.prev, active: false, lastError:/, '失败只标记')
})

test('markCloudFailed 保留 url/token 并置 active=false', () => {
  assert.match(src, /function markCloudFailed\(next, reason\)/, '要有 markCloudFailed')
  assert.match(src, /active: false, lastError: String\(reason \|\| '连接失败'\)/, '失败要记原因')
})

test('activateCloud 只在验证通过后调用', () => {
  assert.match(src, /function activateCloud\(next\)/, '要有 activateCloud')
  assert.match(src, /active: true, lastError: ''/, '激活时清掉错误')
  // 保存流程：probeCloud 成功才 activate
  const saveBlocks = src.match(/const saveCloud = async \(\) => \{[\s\S]{0,1400}?\n  \}/g) || []
  assert.ok(saveBlocks.length >= 2, '两处 saveCloud（顶栏 + 设置页）都要有')
  for (const b of saveBlocks) {
    const idxProbe = b.indexOf('probeCloud(')
    const idxActivate = b.indexOf('activateCloud(')
    assert.ok(idxProbe > 0, '保存前必须先探活')
    assert.ok(idxActivate > idxProbe, 'activate 必须在探活之后')
    assert.ok(b.includes('markCloudFailed('), '失败分支要 markCloudFailed')
  }
})

test('切到本地不清空云端字段（留着重连）', () => {
  assert.match(src, /url: wantCloud \? url : \(url \|\| prev\.url \|\| ''\)/, '本地模式也保留 url')
  assert.match(src, /token: wantCloud \? token : \(token \|\| prev\.token \|\| ''\)/, '本地模式也保留 token')
})

test('设置页字段常驻（不再随模式隐藏）', () => {
  // 曾经的写法是 {cloudForm.mode === 'cloud' && (<div className="mc-cloud-fields">...)}
  assert.doesNotMatch(src, /\{cloudForm\.mode === 'cloud' && \(\s*\n\s*<div className="mc-cloud-fields"/, '字段不应随模式隐藏')
  assert.match(src, /<div className="mc-cloud-fields" style=\{\{ opacity: cloudForm\.mode === 'cloud' \? 1 : 0\.55 \}\}>/, '字段常驻，本地时半透明')
  assert.match(src, /disabled=\{cloudForm\.mode !== 'cloud'\}/, '本地模式禁用输入但保留值')
})

test('状态行三种态：用云端 / 保留未激活 / 用本地', () => {
  assert.match(src, /cloudNowActive/, '要有「当前在用云端」')
  assert.match(src, /cloudKeptButInactive/, '要有「配置已保留、未切换」')
  assert.match(src, /cloudNowLocal/, '要有「当前在用本地」')
})
