// 客户端云端对接契约（R1–R6）：服务端已上线，客户端不得再走旧路径。
// 这里守住源码里的关键接线，避免后续改动把 poll 登录 / 匹配码 / 图标 / 控制台入口改回去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('src/client/index.tsx', 'utf8')

test('R1 登录：poll/start 签票 → 系统浏览器打开带 poll_id 的登录页 → 轮询', () => {
  assert.match(src, /\/cloud\/auth\/poll\/start/, '要先 POST poll/start 拿票')
  assert.match(src, /\/login\?tab=qr&poll_id=/, '浏览器要打开带 poll_id 的登录页')
  assert.match(src, /openExternal\(loginUrl\)/, '要用系统浏览器（openExternal），不是 window.open')
  assert.match(src, /\/cloud\/auth\/poll'\)/, '要轮询同一张票')
})

test('R2 轮询处理三种结果：pending / token / needAuthorize', () => {
  assert.match(src, /d\.pending/, 'pending 继续轮询')
  assert.match(src, /d\.ok && d\.token/, 'ok + token 落盘')
  assert.match(src, /d\.needAuthorize/, 'needAuthorize 要单独提示')
  assert.match(src, /pollNeedAuthorize/, '需要补注册的文案')
})

test('R3 退出登录：POST /signout 并清本地 token', () => {
  assert.match(src, /\/memory-eternal\/api\/signout/, '退出要通知服务端注销')
  assert.match(src, /const cleared = \{[\s\S]{0,200}token: ''/, '本地 token 必须清掉')
})

test('R4 库匹配码：独立输入框 + pc_ 校验 + 直接当 Bearer', () => {
  assert.match(src, /pairCodeLabel/, '要有独立的「凭匹配码连接云端库」标签')
  assert.match(src, /pc_\[A-Za-z0-9\._-\]\{6,\}/, 'pc_ 匹配码格式校验')
  assert.match(src, /token: code/, 'pc_ 直接作为访问令牌保存（不换票）')
  assert.doesNotMatch(src, /MEM Pair 的匹配码.*云端/, '不要把 MEM Pair 与云端库匹配码混为一谈')
})

test('R5 图标：使用服务端 /memory-eternal/api/icon.png', () => {
  assert.match(src, /\/memory-eternal\/api\/icon\.png/, '图标要指向服务端官方图标')
  assert.match(src, /cloudInstanceIconUrl\(/, '要有统一的图标 URL 构造')
})

test('R6 升级/续费：打开服务端控制台，不自己拼订阅深链', () => {
  assert.match(src, /\/memory-eternal\/api\/console/, '升级入口要开 /console')
  assert.doesNotMatch(src, /\/subscribe\?/, '客户端不得再自己拼 subscribe 深链（缺 merchant 会落空白页）')
})
