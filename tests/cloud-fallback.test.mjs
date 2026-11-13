// 云端熔断：**云端失败绝不能拖垮客户端**（真事故：没有回退时整个页面空白、本地库都看不了）。
// 守七件事：阈值/判定/计数/回退/事件/探活/作用域。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync('src/client/index.tsx', 'utf8')

test('熔断常量与回退函数存在', () => {
  assert.match(src, /CLOUD_FAIL_LIMIT = 3/, '要有失败阈值')
  assert.match(src, /function fallbackToLocal\(/, '要有回退函数')
  assert.match(src, /function cloudFailureStatus\(/, '要有失败判定')
})

test('失败判定覆盖 401/403/5xx/网络错误', () => {
  assert.match(src, /status === 0 \|\| status === 401 \|\| status === 403 \|\| status >= 500/,
    '网络错误(0)、401、403、5xx 都算失败')
})

test('fetch 包装里失败累加、成功清零', () => {
  assert.match(src, /cloudFailCount \+= 1/, '失败要累加')
  assert.match(src, /cloudFailCount = 0/, '成功要清零')
  assert.match(src, /cloudFailCount >= CLOUD_FAIL_LIMIT/, '达到阈值要触发回退')
})

test('回退把配置切成 local 并派发事件', () => {
  // 注意：**不能清空 url/token**（那是真事故：一次报错就要用户重填）。
  // 正确做法是保留配置、只标记 active=false，见 tests/cloud-config-persist.test.mjs。
  assert.doesNotMatch(src, /saveCloudConn\(\{ mode: 'local', url: '', token: '' \}\)/, '不允许清空云端配置')
  assert.match(src, /saveCloudConn\(\{ \.\.\.prev, active: false/, '回退只标记 active=false')
  assert.match(src, /dispatchEvent\(new CustomEvent\('me-cloud-fallback'/, '要通知 UI')
})

test('UI 收到回退事件会提示并重载', () => {
  assert.match(src, /addEventListener\('me-cloud-fallback'/, 'UI 要监听')
  assert.match(src, /已切回本地模式/, '要给出可读提示')
  assert.match(src, /location\.reload\(\)/, '要重载（此时前缀已是本地）')
})

test('启动探活失败直接退回本地', () => {
  assert.match(src, /启动探活失败/, '探活失败分支')
  assert.match(src, /启动探活网络失败/, '网络失败分支')
})

test('只改写自家 API 前缀，不碰第三方请求', () => {
  assert.match(src, /input\.startsWith\(LOCAL_PREFIX\)/, '只处理 /memory-eternal/api 开头的请求')
})
