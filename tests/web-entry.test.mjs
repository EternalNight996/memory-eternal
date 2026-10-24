// 左侧栏「Web 版」入口守卫（用户需求：左侧栏加 Web 版，能直接打开浏览器）。
//
// 关键设计（防止这个入口变成任意 URL 打开器）：
//   - 端点 /open-web 只接受 http(s) + 127.0.0.1 / localhost / ::1；
//   - 地址来源不是写死 7999，而是 watchdog 锁里「真正在服务」的常驻端口；
//   - 前端先走服务端（iframe 里 window.open 常被宿主拦），失败再退回 window.open 并显示地址。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLocalWebUrl, residentWebUrl } from '../lib/api.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')
const api = read('lib/api.js')
const src = read('src/client/index.tsx')

test('① 只允许本机地址：外网/非 http(s)/仿冒域名全部拒绝', () => {
  for (const ok of ['http://127.0.0.1:7999/', 'http://localhost:8000/x?y=1', 'https://127.0.0.1/', 'http://[::1]:7999/']) {
    assert.equal(isLocalWebUrl(ok), true, '应当允许：' + ok)
  }
  const bad = [
    'https://github.com/EternalNight996/memory-eternal',
    'http://evil.com/',
    'http://127.0.0.1.evil.com/',   // 仿冒：hostname 不是 127.0.0.1
    'http://localhost.evil.com/',
    'file:///C:/Windows/System32/cmd.exe',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    '',
  ]
  for (const u of bad) assert.equal(isLocalWebUrl(u), false, '必须拒绝：' + JSON.stringify(u))
})

test('② 地址取「真正在服务的常驻端口」，不是写死 7999', () => {
  const url = residentWebUrl()
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/, '必须是本机 http 地址：' + url)
  assert.match(residentWebUrl(8123), /^http:\/\/127\.0\.0\.1:8123\/$/, '显式端口要生效（便于诊断/测试）')
  assert.match(api, /const lock = readWatchdogLock\(process\.env\)/, '端口要从 watchdog 锁里读（端口会漂移）')
  assert.match(api, /list\.find\(\(w\) => w && w\.port && \(!w\.pid \|\| isPidAlive\(w\.pid\)\)\)/, '优先挑活着的那个实例')
})

test('③ 端点接线：/open-web 只收 POST + 本地白名单；/web-info 只回地址', () => {
  assert.match(api, /case '\/open-web': \{/, '/open-web 路由必须在')
  assert.match(api, /if \(req\.method && req\.method !== 'POST'\) return json\(res, 405/, '非 POST 要拒绝（不会被 <img> 之类误触）')
  assert.match(api, /return json\(res, 200, openLocalWeb\(query\.get\('url'\)\)\)/, '走白名单校验的 openLocalWeb')
  assert.match(api, /export function openLocalWeb\(raw\)/, 'openLocalWeb 必须导出（可单测）')
  assert.match(api, /if \(!isLocalWebUrl\(url\)\) return \{ ok: false, error: 'url not allowed' \}/, 'openLocalWeb 内部再校验一次')
  assert.match(api, /case '\/web-info': \{/, '/web-info 路由必须在（前端兜底拿地址）')
  assert.match(api, /function spawnOpener\(href\)/, '打开浏览器逻辑抽成 spawnOpener（GitHub 外链与 Web 版共用）')
  assert.match(api, /rundll32', \['url\.dll,FileProtocolHandler'/, 'Windows 用系统默认浏览器打开')
})

test('④ 左侧栏入口：点一下就开浏览器，失败要能退回/给出地址', () => {
  assert.match(src, /webTab: 'Web 版'/, '中文栏目标签')
  assert.match(src, /webTab: 'Web version'/, '英文栏目标签')
  assert.match(src, /title=\{t\('webTab'\)\}[^>]*>\s*<span className="mc-rail-ico">🌐<\/span>/, '左侧栏要有 🌐 Web 版按钮')
  assert.match(src, /onClick=\{openWebVersion\}/, '按钮要绑 openWebVersion')
  assert.match(src, /const openWebVersion = useCallback\(async \(\) => \{/, '回调必须在')
  assert.match(src, /fetch\(`\$\{API\}\/open-web`, \{ method: 'POST' \}\)/, '优先走服务端打开（iframe 里 window.open 会被拦）')
  assert.match(src, /const info = await fetch\(`\$\{API\}\/web-info`\)/, '失败时先查地址')
  assert.match(src, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/, '再退回 window.open')
  assert.match(src, /t\('webOpened'\) \+ ' · ' \+ r\.url/, '成功要告诉用户开的是哪个地址')
  assert.match(src, /t\('webOpenFail'\) \+ ' · ' \+ url/, '失败要把地址亮出来（用户可手粘）')
  assert.match(src, /\|\| 'http:\/\/127\.0\.0\.1:7999\/'/, '兜底地址必须是常驻实例默认端口，不是宿主同源壳（宿主壳在外部浏览器要登录态）')
})
