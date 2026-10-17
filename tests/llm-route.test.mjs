// issue #42：① 动态列出 provider/model、② 跟随当前会话、③ 仅试首选 + 测试按钮。
// 这里守服务端核心（选路与探测），UI 走源码守卫。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeCandidates, sessionRouteFrom } from '../lib/capture.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

const fakeLlm = () => ({
  listProviders: () => [{ id: 'deepseek-official', label: '官方' }, { id: 'gw-b', label: '中转 B' }, { id: 'gw-c', label: '中转 C' }],
  listModels: async (id) => (id === 'deepseek-official' ? [{ id: 'deepseek-flash' }] : id === 'gw-b' ? [{ id: 'glm-4.5' }] : [{ id: 'hy3' }]),
})

test('③ 仅试首选：只返回第一个候选（不轮换兜底），默认仍给兜底链', async () => {
  const all = await routeCandidates(fakeLlm(), {})
  assert.ok(all.length >= 2, '默认要有兜底候选（现状语义不变）')
  const first = await routeCandidates(fakeLlm(), { firstOnly: true })
  assert.equal(first.length, 1, '仅试首选只给一个')
  assert.equal(first[0].provider, 'deepseek-official', '就是注册顺序第一个（或显式配置那个）')
  // 显式配置 + 仅试首选：以配置为准
  const explicit = await routeCandidates(fakeLlm(), { provider: 'gw-b', model: 'glm-4.5', firstOnly: true })
  assert.deepEqual(explicit.map((r) => r.provider + '/' + r.model), ['gw-b/glm-4.5'])
})

test('② 会话路由探测：官方字段优先（requestHeader/agent.options），读不到返回 null 回退配置', async () => {
  // ① 官方同款：session.requestHeader().config（issue #43）
  assert.deepEqual(await sessionRouteFrom({ session: { requestHeader: async () => ({ config: { provider: 'gw-x', model: 'glm-5' } }) } }), { provider: 'gw-x', model: 'glm-5', from: 'session.requestHeader().config' })
  // ② agent.options（官方同源，系统提示词变量取的就是它）
  assert.deepEqual(await sessionRouteFrom({ options: { provider: 'gw-o', model: 'glm-o' } }), { provider: 'gw-o', model: 'glm-o', from: 'agent.options' })
  assert.deepEqual(await sessionRouteFrom({ session: { provider: 'gw-b', model: 'glm-4.5' } }), { provider: 'gw-b', model: 'glm-4.5', from: 'session' })
  assert.deepEqual(await sessionRouteFrom({ providerId: 'p1', modelId: 'm1' }), { provider: 'p1', model: 'm1', from: 'agent' })
  assert.deepEqual(await sessionRouteFrom({ session: { route: { provider: 'p2', model: 'm2' } } }), { provider: 'p2', model: 'm2', from: 'session.route' })
  assert.deepEqual(await sessionRouteFrom({ session: { options: { provider: 'p3', model: 'm3' } } }), { provider: 'p3', model: 'm3', from: 'session.options' })
  assert.equal(await sessionRouteFrom({ session: { provider: '   ' } }), null, '空白不算')
  assert.equal(await sessionRouteFrom({ session: {} }), null)
  assert.equal(await sessionRouteFrom({}), null)
  assert.equal(await sessionRouteFrom(null), null)
  assert.equal(await sessionRouteFrom('nope'), null)
  // requestHeader 抛错/返回垃圾 → 不炸，继续回退
  assert.equal(await sessionRouteFrom({ session: { requestHeader: async () => { throw new Error('x') } } }), null)
  assert.deepEqual(await sessionRouteFrom({ session: { requestHeader: async () => ({ config: {} }) }, options: { provider: 'p9', model: 'm9' } }), { provider: 'p9', model: 'm9', from: 'agent.options' }, 'requestHeader 拿不到就回退 agent.options')
})

test('接线守卫：配置项 / 宿主选路 / API / 面板四处都要到位', () => {
  const index = read('index.js')
  assert.match(index, /captureFollowSession: z\.boolean\(\)\.default\(false\)/, '配置要有「跟随当前会话」')
  assert.match(index, /captureFirstOnly: z\.boolean\(\)\.default\(false\)/, '配置要有「仅试首选」')
  assert.match(index, /sessionRouteFrom\(agent\)/, '宿主要从 agent 探测会话路由')
  assert.match(index, /firstOnly: cfg\.captureFirstOnly === true/, '选路要透传 firstOnly')
  assert.match(index, /跟随当前会话：/, '跟随生效时要留日志（可核对）')
  assert.match(index, /读不到 provider\/model/, '读不到时要如实提示（并能据此补适配）')
  const api = read('lib/api.js')
  assert.match(api, /case '\/llm-routes'/, '要有动态路由列表接口')
  assert.match(api, /case '\/llm-test'/, '要有测试接口')
  assert.match(api, /purpose: 'memory-llm-test'/, '测试要走真实调用路径')
  const client = read('src/client/index.tsx')
  assert.match(client, /fetch\(`\$\{API\}\/llm-routes`\)/, '面板要拉动态选项')
  assert.match(client, /<Bool k="captureFollowSession"/, '面板要有跟随开关')
  assert.match(client, /<Bool k="captureFirstOnly"/, '面板要有仅试首选开关')
  assert.match(client, /API \+ '\/llm-test'/, '面板要有测试按钮的请求')
  assert.equal((client.match(/llmTestOk:/g) || []).length, 2, '测试结果文案中英各一条')
})
