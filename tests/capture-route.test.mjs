// issue #3 / #4 回归：多 provider 路由（不再写死 providers[0]）+ 流末尾 finish 的失败可见性。
// 背景：适配器错误（缺凭证等）不会抛给调用方，而是以 finish{kind:'error'} 终结流；
// 旧实现只看 text 块，于是被误报成「蒸馏无输出」，管线 100% 静默失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeCandidates, resolveRoute, summarizeTurn, summarizeTurnDetailed, supportsReasoningEffort, looksTruncatedJson } from '../lib/capture.js'

const CONV = [
  '用户：帮我梳理一下 SQLite 图谱缓存的失效策略',
  '助手：可以分三步：',
  '- 第一步：写卡或审核后立即让指纹失效，避免读到陈旧图谱',
  '- 第二步：服务端做 60 秒 TTL 兜底，防止极端情况下反复重建',
  '- 第三步：冷启动时用 brotli 压缩传输，把 3.5MB 的载荷压到 160KB 左右',
  '另外要注意 pending 卡不能进缓存，审核状态翻转会让缓存永久失真，必须排除。',
].join('\n')

let lastStreamOptions = null
const fakeLlm = ({ providers = [], models = {}, chunks = [] }) => ({
  listProviders: () => providers,
  listModels: async (id) => models[id] || [],
  async *stream(options) { lastStreamOptions = options; for (const c of chunks) yield c },
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

// -- issue #18：输出被 max-tokens 截断不该伪装成「解析失败」 ----------------------
test('finish.kind=max-tokens → 独立错误码 MAX_TOKENS（不是 UNPARSEABLE_OUTPUT），且带上实际上限', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'p' }], models: { p: [{ id: 'm' }] },
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '{"save": true, "titl' }, // 被截断的半截 JSON
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ],
  })
  const r = await summarizeTurnDetailed(llm, { provider: 'p', model: 'm' }, CONV, { maxTokens: 1234 })
  assert.equal(r.card, undefined)
  assert.equal(r.failure.code, 'MAX_TOKENS')
  assert.match(r.failure.message, /1234/, 'message 要带上实际 maxTokens，便于用户调大「蒸馏输出上限」')
  assert.doesNotMatch(r.failure.message, /UNPARSEABLE/, '不得再伪装成解析失败')
})

test('没给 finish 的截断输出 → 仍报 UNPARSEABLE_OUTPUT，但提示「疑似被截断」', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'p' }], models: { p: [{ id: 'm' }] },
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '{"save": true, "title": "半截' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const r = await summarizeTurnDetailed(llm, { provider: 'p', model: 'm' }, CONV)
  assert.equal(r.failure.code, 'UNPARSEABLE_OUTPUT')
  assert.match(r.failure.message, /疑似输出被截断/)
  assert.equal(looksTruncatedJson('{"a": 1}'), false)
  assert.equal(looksTruncatedJson('{"a": [1, 2'), true)
  assert.equal(looksTruncatedJson('{"a": "未闭合'), true)
})

// -- issue #15 问题 2：不支持 reasoning effort 的 provider 不该被白烧 -------------
test('supportsReasoningEffort：三种声明位置都认，未知按「支持」处理', () => {
  assert.equal(supportsReasoningEffort({ id: 'a' }), true, '不声明 = 支持（不能把未知当不支持）')
  assert.equal(supportsReasoningEffort({ id: 'a', compat: { supportsReasoningEffort: false } }), false)
  assert.equal(supportsReasoningEffort({ id: 'a', supportsReasoningEffort: false }), false)
  assert.equal(supportsReasoningEffort({ id: 'a' }, { id: 'm', capabilities: { supportsReasoningEffort: false } }), false)
  assert.equal(supportsReasoningEffort({ id: 'a' }, { id: 'm', reasoning: { efforts: [] } }), false)
  assert.equal(supportsReasoningEffort({ id: 'a' }, { id: 'm', reasoning: { efforts: [{ id: 'off' }] } }), true)
})

test('routeCandidates：不支持的候选标记 reasoningEffort=null 并排到支持者后面（不删除）', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'gw-bad', compat: { supportsReasoningEffort: false } }, { id: 'official' }],
    models: { 'gw-bad': [{ id: 'gw-1' }], official: [{ id: 'deepseek-flash' }] },
  })
  const routes = await routeCandidates(llm)
  assert.equal(routes.length, 2, '不支持的候选必须保留（否则兜底全无）')
  assert.deepEqual(routes[0], { provider: 'official', model: 'deepseek-flash' }, '支持的排前面')
  assert.deepEqual(routes[1], { provider: 'gw-bad', model: 'gw-1', reasoningEffort: null })
  // 显式配置的 provider 永远第一（用户选择优先），但同样不再传 reasoningEffort
  const explicit = await routeCandidates(llm, { provider: 'gw-bad' })
  assert.deepEqual(explicit[0], { provider: 'gw-bad', model: 'gw-1', reasoningEffort: null })
})

test('reasoningEffort=null 的候选：请求里确实不带该字段（#15 的失败根因）', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'p' }], models: { p: [{ id: 'm' }] },
    chunks: textChunks('{"save":false}'),
  })
  await summarizeTurnDetailed(llm, { provider: 'p', model: 'm', reasoningEffort: null }, CONV)
  assert.equal('reasoningEffort' in lastStreamOptions, false, '不支持时不得传 reasoningEffort')
  await summarizeTurnDetailed(llm, { provider: 'p', model: 'm' }, CONV)
  assert.equal(lastStreamOptions.reasoningEffort, 'off', '未声明不支持时保持原行为')
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
