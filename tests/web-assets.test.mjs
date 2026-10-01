// 记忆核心 · 装坏了也要说人话：web/ 静态资源缺失的兜底回归（issue #14）
//
// 背景：有人从插件市场装出来的副本里只有 package.json / lib/，`web/` 没落地 —— 侧边栏
// 「记忆」的 iframe 只会拿到一页原始 `{"ok":false,"error":"ENOENT ... web/index.html"}`。
// 这里钉死三件事：
//   ① 缺 index.html 但 app.js 还在 → 内置外壳把界面正常拉起来（自救，不回 raw JSON）；
//   ② 缺 app.js → 回一段 JS / 一页人话诊断（缺哪个文件、路径、版本、怎么重装），仍不回 raw JSON；
//   ③ 缺失会写进自动沉淀日志（app.js → fail，只有 index.html → warn），每进程每文件只写一次。
// 另附宿主启动自检用的纯函数（missingWebAssets / missingAssetsReason）单测。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWebServer, missingAssetsPanel } from '../lib/web.js'
import { missingWebAssets, missingAssetsReason } from '../lib/web-assets.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-web-assets-'))
// 日志写进临时 DSH_HOME：兜底自检绝不能污染真实 ~/.dsh
const dshHome = path.join(tmp, 'dsh-home')
await fs.mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome
const logFile = path.join(dshHome, 'memory-eternal-capture.jsonl')

const servers = []
after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r))
  await fs.rm(tmp, { recursive: true, force: true })
})

/** 造一个「包目录」：webRoot 恒为 <pkg>/web，保证启动自检与请求兜底看的是同一份资源。 */
async function makePkg(name, files = {}) {
  const pkg = path.join(tmp, name)
  const webRoot = path.join(pkg, 'web')
  await fs.mkdir(webRoot, { recursive: true })
  for (const [f, content] of Object.entries(files)) await fs.writeFile(path.join(webRoot, f), content, 'utf8')
  return { pkg, webRoot }
}

/** 起一个指向该包目录的真实服务。 */
async function serve({ pkg, webRoot }) {
  const info = await startWebServer({ port: 0, vaultRoot: path.join(tmp, 'vault'), packageRoot: pkg, webRoot })
  servers.push(info.server)
  return { base: `http://127.0.0.1:${info.server.address().port}`, info }
}
const get = async (url) => {
  const r = await fetch(url)
  return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }
}
/** 读日志（启动自检是 fire-and-forget，等一拍再读，避免竞态）。 */
const readLog = async (marker = '') => {
  await new Promise((r) => setTimeout(r, 80))
  try {
    const rows = (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    return marker ? rows.filter((e) => String(e.reason || '').includes(marker)) : rows
  } catch { return [] }
}

test('缺 index.html 但 app.js 在：内置外壳兜底并引用 app.js（界面仍能起来）', async () => {
  const target = await makePkg('only-app', { 'app.js': 'window.__ME_STUB__=1' })
  const { base } = await serve(target)

  const home = await get(base + '/')
  assert.equal(home.status, 200)
  assert.match(home.type, /text\/html/)
  assert.match(home.text, /插件安装不完整/, '要给人话说明，而不是 raw JSON')
  assert.doesNotMatch(home.text, /ENOENT/, '不能把 Node 的原始错误抛给用户')
  assert.match(home.text, /createElement\('script'\)/, '外壳要尝试加载 app.js 完成自救')
  assert.match(home.text, /s\.src = 'app\.js'/)
  assert.equal((await get(base + '/app.js')).text, 'window.__ME_STUB__=1', 'app.js 仍按原样服务')
})

test('缺 app.js：回一段 JS 诊断，页面里能看到人话（不是 raw JSON）', async () => {
  const target = await makePkg('only-index', { 'index.html': '<div id="root"></div><script src="app.js"></script>' })
  const { base } = await serve(target)

  const js = await get(base + '/app.js')
  assert.equal(js.status, 200, '200 才能让浏览器执行这段诊断脚本')
  assert.match(js.type, /javascript/)
  assert.match(js.text, /插件安装不完整/)
  assert.match(js.text, /web\/app\.js/)
  assert.doesNotMatch(js.text, /ENOENT/)
  assert.match(js.text, /getElementById\('root'\)/, '兜底脚本要把内容画进 #root')

  // index.html 本身还在，照原样服务（只坏 app.js 时不要连首页也换掉）
  assert.match((await get(base + '/')).text, /<div id="root">/)
})

test('两个都缺：/ 给完整诊断（含修法），/app.js 给能画出来的诊断，都不外泄 ENOENT', async () => {
  const target = await makePkg('empty')
  const { base, info } = await serve(target)
  assert.deepEqual(info.missingAssets, ['index.html', 'app.js'], '启动时就该知道缺什么')

  const home = await get(base + '/')
  const js = await get(base + '/app.js')
  for (const r of [home, js]) {
    assert.equal(r.status, 200)
    assert.match(r.text, /插件安装不完整/)
    assert.match(r.text, /web\/app\.js/)
    assert.doesNotMatch(r.text, /ENOENT/)
  }
  assert.match(home.text, /web\/index\.html/)
  assert.match(home.text, /怎么修/, '要给出可照做的修法')
  assert.match(home.text, /memory-eternal/, '要指出重装哪个包')
})

test('资源齐全时行为不变（真实文件原样服务，启动自检不误报）', async () => {
  const target = await makePkg('full', { 'index.html': '<!doctype html><title>REAL-INDEX</title>', 'app.js': 'window.__ME_REAL__=1' })
  const { base, info } = await serve(target)
  assert.deepEqual(info.missingAssets, [])
  assert.equal((await get(base + '/')).text, '<!doctype html><title>REAL-INDEX</title>')
  assert.equal((await get(base + '/app.js')).text, 'window.__ME_REAL__=1')
  assert.deepEqual(await readLog(path.join(tmp, 'full')), [], '齐全时不应写任何缺资源日志')
})

test('缺失写进自动沉淀日志：app.js → fail、index.html → warn，且每进程每文件只一次', async () => {
  const target = await makePkg('log-case')
  const { base } = await serve(target)

  await get(base + '/')
  await get(base + '/')
  await get(base + '/app.js')
  await get(base + '/app.js')

  const entries = await readLog(path.join(tmp, 'log-case'))
  const fail = entries.filter((e) => e.action === 'fail')
  const warn = entries.filter((e) => e.action === 'warn')
  assert.equal(fail.length, 1, '每进程每文件只记一次，别每次请求刷屏')
  assert.equal(warn.length, 1, '只缺 index.html 是 warn（内置外壳能兜底，不该把健康态判死）')
  assert.match(fail[0].reason, /插件安装不完整/)
  assert.match(fail[0].reason, /web\/app\.js/)
  assert.match(fail[0].reason, /无法加载/)
  assert.match(warn[0].reason, /已用内置外壳兜底/)
  assert.match(fail[0].reason, /重新安装|重装/, '日志里要直接给出修法')
  assert.equal(fail[0].sessionId, 'system')
  assert.ok(fail[0].time > 0)
})

test('纯函数：missingWebAssets 判据 + missingAssetsReason 措辞 + 诊断页转义', async () => {
  const empty = await makePkg('pkg-empty')
  assert.deepEqual(missingWebAssets(empty.pkg), ['index.html', 'app.js'], '缺哪个报哪个，顺序稳定')

  const half = await makePkg('pkg-half', { 'app.js': 'x' })
  assert.deepEqual(missingWebAssets(half.pkg), ['index.html'])

  // 真实仓库（本测试文件所在包）资源齐全 —— 宿主启动自检不应误报
  const realPkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  assert.deepEqual(missingWebAssets(realPkg), [])

  assert.match(missingAssetsReason(['index.html'], half.pkg), /已用内置外壳兜底/)
  const hard = missingAssetsReason(['index.html', 'app.js'], half.pkg)
  assert.match(hard, /无法加载/)
  assert.match(hard, /删掉/)
  assert.match(hard, /memory-eternal/)

  // 诊断页里的路径必须转义，不能被目录名注入标签
  const panel = missingAssetsPanel({ missing: ['app.js'], webRoot: '/tmp/<img src=x onerror=alert(1)>', version: '0.10.1' })
  assert.match(panel, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(panel, /<img src=x/)
  assert.match(panel, /v0\.10\.1/)
})
