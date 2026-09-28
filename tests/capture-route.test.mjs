// issue #3 / #4 回归：多 provider 路由（不再写死 providers[0]）+ 流末尾 finish 的失败可见性。
// 背景：适配器错误（缺凭证等）不会抛给调用方，而是以 finish{kind:'error'} 终结流；
// 旧实现只看 text 块，于是被误报成「蒸馏无输出」，管线 100% 静默失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeCandidates, resolveRoute, summarizeTurn, summarizeTurnDetailed } from '../lib/capture.js'

const CONV = [
  '用户：帮我梳理一下 SQLite 图谱缓存的失效策略',
  '助手：可以分三步：',
  '- 第一步：写卡或审核后立即让指纹失效，避免读到陈旧图谱',
  '- 第二步：服务端做 60 秒 TTL 兜底，防止极端情况下反复重建',
  '- 第三步：冷启动时用 brotli 压缩传输，把 3.5MB 的载荷压到 160KB 左右',
  '另外要注意 pending 卡不能进缓存，审核状态翻转会让缓存永久失真，必须排除。',
].join('\n')

const fakeLlm = ({ providers = [], models = {}, chunks = [] }) => ({
  listProviders: () => providers,
  listModels: async (id) => models[id] || [],
  async *stream() { for (const c of chunks) yield c },
})
const textChunks = (json) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: json },
  // 不给 block-end：0.1.0 版装配器要求 chunk.block，0.1.7 版才只看 index —— 省略即两边都安全
  { type: 'finish', reason: { kind: 'stop' } },
]
const errorChunks = (code, message) => [{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }]

test('routeCandidates：显式配置优先，其余按注册顺序兜底（不再写死 providers[0]）', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'deepseek-official' }, { id: 'api中转' }],
    models: { 'deepseek-official': [{ id: 'deepseek-flash' }], 'api中转': [{ id: 'glm-4.5' }] },
  })
  const auto = await routeCandidates(llm)
  assert.deepEqual(auto[0], { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(auto[1], { provider: 'api中转', model: 'glm-4.5' }, '应给出第二个 provider 作为兜底')

  assert.deepEqual((await routeCandidates(llm, { provider: 'api中转' }))[0], { provider: 'api中转', model: 'glm-4.5' })
  assert.deepEqual((await routeCandidates(llm, { provider: 'api中转', model: 'glm-4.6' }))[0], { provider: 'api中转', model: 'glm-4.6' }, '显式 model 必须被尊重')
  assert.equal(await resolveRoute(fakeLlm({})), null, '无 provider 时返回 null')
})

test('finish 里的适配器错误必须暴露成 failure，而不是「蒸馏无输出」', async () => {
  const llm = fakeLlm({ providers: [{ id: 'deepseek-official' }], models: { 'deepseek-official': [{ id: 'deepseek-flash' }] }, chunks: errorChunks('MISSING_CREDENTIAL', '缺少 DEEPSEEK_API_KEY') })
  const r = await summarizeTurnDetailed(llm, { provider: 'deepseek-official', model: 'deepseek-flash' }, CONV)
  assert.equal(r.card, undefined)
  assert.equal(r.failure.code, 'MISSING_CREDENTIAL')
  assert.ok(r.failure.message.includes('DEEPSEEK_API_KEY'), '失败原因要带出原始 message')
  assert.equal(await summarizeTurn(llm, { provider: 'p', model: 'm' }, CONV), null, '兼容包装仍返回 null')
})

test('正常输出解析成卡；空输出 / 非 JSON 归为 UNPARSEABLE_OUTPUT', async () => {
  const ok = fakeLlm({ providers: [{ id: 'p' }], models: { p: [{ id: 'm' }] }, chunks: textChunks('{"save":true,"title":"缓存失效策略","kind":"knowledge","tags":["sqlite"],"body":"# 缓存失效策略：写卡或审核后立即失效指纹，服务端再加 60 秒 TTL 兜底"}') })
  const good = await summarizeTurnDetailed(ok, { provider: 'p', model: 'm' }, CONV)
  assert.equal(good.failure, undefined)
  assert.equal(good.card.save, true)
  assert.equal(good.card.title, '缓存失效策略')

  const empty = fakeLlm({ providers: [{ id: 'p' }], models: { p: [{ id: 'm' }] }, chunks: textChunks('') })
  const bad = await summarizeTurnDetailed(empty, { provider: 'p', model: 'm' }, CONV)
  assert.equal(bad.card, undefined)
  assert.equal(bad.failure.code, 'UNPARSEABLE_OUTPUT')
})

test('「跳过」与「失败」分开：太短 / 不值得保存不算 failure（不该亮红）', async () => {
  const llm = fakeLlm({ providers: [{ id: 'p' }], models: { p: [{ id: 'm' }] } })
  const short = await summarizeTurnDetailed(llm, { provider: 'p', model: 'm' }, '太短')
  assert.equal(short.skip, 'too-short')
  assert.equal(short.failure, undefined)
  const chat = await summarizeTurnDetailed(llm, { provider: 'p', model: 'm' }, '你好呀，今天天气不错，我们随便聊聊吧。'.repeat(8))
  assert.equal(chat.skip, 'not-durable')
  assert.equal(chat.failure, undefined)
})
