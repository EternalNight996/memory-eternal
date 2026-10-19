// issue #47：桌面版的「记忆」弹窗是 iframe 里的**独立页**，没有 DSH 的 llm 服务 →
// /llm-routes 恒失败 → 蒸馏 provider/model 只能手填（用户：「无法选择蒸馏记忆的模型」）。
// 修法：独立页通过宿主心跳里的端口，把这两个路由**代理给宿主**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from '../lib/api.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const fakeRes = () => { const rec = { status: 0, body: '' }; return { rec, res: { writeHead(s) { rec.status = s }, end(b) { rec.body = b ? String(b) : '' }, setHeader() {}, on() {}, once() {}, emit() {} } } }
const bodyOf = (rec) => { try { return JSON.parse(rec.body) } catch { return null } }

test('独立页（无 llm）→ /llm-routes 代理给宿主，并标记 proxied', async () => {
  const api = createApi({
    vaultDir: () => process.env.TEMP,
    getSettings: () => ({}),
    currentPkgVersion: () => '0.10.49',
    getLlm: () => null,
    proxyHost: async (route) => {
      assert.equal(route, '/memory-eternal/api/llm-routes')
      return { ok: true, proxied: true, providers: [{ id: 'stepfun', label: 'StepFun', models: [{ id: 'step-5-preview', label: 'step-5-preview' }] }], current: {} }
    },
  })
  const { rec, res } = fakeRes()
  await api({ method: 'GET', url: '/memory-eternal/api/llm-routes' }, res)
  const d = bodyOf(rec)
  assert.equal(d.ok, true)
  assert.equal(d.proxied, true)
  assert.equal(d.providers[0].id, 'stepfun', '下拉要拿到宿主的真实 provider 列表')
})

test('代理失败 → 明确报错（面板会显示原因，而不是静默回退）', async () => {
  const api = createApi({
    vaultDir: () => process.env.TEMP, getSettings: () => ({}), currentPkgVersion: () => '0.10.49', getLlm: () => null,
    proxyHost: async () => ({ ok: false, error: '宿主不在线' }),
  })
  const { rec, res } = fakeRes()
  await api({ method: 'GET', url: '/memory-eternal/api/llm-routes' }, res)
  const d = bodyOf(rec)
  assert.equal(d.ok, false)
  assert.match(d.error, /宿主不在线/)
})

test('本地有 llm（宿主页）时不代理，直接列出来', async () => {
  let proxied = false
  const api = createApi({
    vaultDir: () => process.env.TEMP, getSettings: () => ({}), currentPkgVersion: () => '0.10.49',
    getLlm: () => ({ listProviders: () => [{ id: 'p1', label: 'P1' }], listModels: async () => [{ id: 'm1' }] }),
    proxyHost: async () => { proxied = true; return { ok: true, providers: [] } },
  })
  const { rec, res } = fakeRes()
  await api({ method: 'GET', url: '/memory-eternal/api/llm-routes' }, res)
  const d = bodyOf(rec)
  assert.equal(d.providers[0].id, 'p1')
  assert.equal(proxied, false, '本地能列就不该绕宿主')
})

test('接线守卫：代理只走 127.0.0.1 + 心跳过期即放弃 + 面板显示失败原因', () => {
  const api = read('lib/api.js')
  assert.match(api, /readHostMarker\(process\.env\)/)
  assert.match(api, /Date\.now\(\) - marker\.at > 120000/, '心跳过期（宿主退出）就不代理')
  assert.match(api, /'http:\/\/127\.0\.0\.1:' \+ marker\.port/, '只连本机')
  assert.match(api, /proxyHost\('\/memory-eternal\/api\/llm-routes'\)/)
  assert.match(api, /proxyHost\('\/memory-eternal\/api\/llm-test', \{ method: 'POST'/, '测试按钮也要能代理')
  const client = read('src/client/index.tsx')
  assert.match(client, /routes\.ok === false/, '面板要显示取不到列表的原因')
  assert.equal((client.match(/routeListFail:/g) || []).length, 2, '中英各一条')
})
