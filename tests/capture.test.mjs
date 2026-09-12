// 记忆核心 · capture 层单元测试（llm 用假对象注入，不联网）
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, listCards, readCard } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'
import { summarizeTurn, extractLastTurn, sliceNewEvents, sessionEvents, sessionEventApi, createCaptureHealth, parseCaptureJson, captureCard, captureUpdate, makeDedupChecker, pickNeighbors, DEDUP_THRESHOLD, compressExcerpt } from '../lib/capture.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cap-'))
const root = path.join(tmpRoot, 'vault')
after(async () => {
  closeAllDb()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

/** 假 llm：按 BlockAssembler 期望的 StreamChunk 格式输出文本块。 */
function fakeLlm(responseText) {
  return {
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      const chunks = responseText.match(/.{1,50}/gs) || []
      for (const text of chunks) yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: responseText } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

test('DEDUP_THRESHOLD matches boujoy default', () => {
  assert.equal(DEDUP_THRESHOLD, 0.62)
})

test('summarizeTurn returns parsed card from model JSON', async () => {
  const llm = fakeLlm(JSON.stringify({
    save: true,
    title: 'React 性能优化要点',
    kind: 'knowledge',
    tags: ['react', '性能'],
    body: '# React 性能优化要点\n\n- 使用 memo 减少重渲染\n- 用 useMemo 缓存计算',
  }))
  const talk = [
    '用户：我的React应用列表滚动很卡，怎么优化？',
    '助手：可以用React.memo包裹子组件减少不必要的重渲染，用useMemo缓存昂贵的计算结果，虚拟滚动可以大幅减少DOM节点数量，还应该检查是否在渲染循环里创建了新的内联对象。',
    '用户：虚拟滚动怎么选？',
    '助手：react-window轻量适合简单列表，react-virtualized功能全但包大；数据量上万且行高固定时优先react-window。',
  ].join('\n')
  const result = await summarizeTurn(llm, { provider: 'p', model: 'm' }, talk)
  assert.equal(result.save, true)
  assert.equal(result.title, 'React 性能优化要点')
  assert.equal(result.kind, 'knowledge')
  assert.deepEqual(result.tags, ['react', '性能'])
})

test('summarizeTurn skips trivial talk (heuristic prefilter, no LLM call)', async () => {
  const llm = fakeLlm(JSON.stringify({ save: false }))
  const talk = '用户：你好，在吗？\n助手：你好，我在的，请问有什么可以帮你？\n用户：没什么，随便问问。\n助手：好的，有需要随时找我。'
  // 纯寒暄无「可复用信号」：预筛直接跳过，不触发 LLM，返回 null（省 token）
  const result = await summarizeTurn(llm, { provider: 'p', model: 'm' }, talk.repeat(3))
  assert.equal(result, null)
})

test('summarizeTurn rejects too-short conversation', async () => {
  const result = await summarizeTurn(fakeLlm('{}'), { provider: 'p', model: 'm' }, 'hi')
  assert.equal(result, null)
})

test('parseCaptureJson tolerates code fences and garbage', () => {
  const good = parseCaptureJson('```json\n{"save":true,"title":"T","kind":"knowledge","tags":[],"body":"# T\\n\\n这是一段足够长的正文内容，用于验证解析逻辑能够正确处理带代码围栏的模型输出。"}```')
  assert.equal(good.save, true)
  const bad = parseCaptureJson('这里没有 JSON')
  assert.equal(bad, null)
})

test('parseCaptureJson handles append_to form', () => {
  const append = parseCaptureJson('{"append_to": "03-Knowledge/缓存策略.md", "update": "补充：增加随机过期防止雪崩。"}')
  assert.equal(append.append_to, '03-Knowledge/缓存策略.md')
  assert.ok(append.update.includes('随机过期'))
  // append_to 但没有 update 文本 → 无效
  assert.equal(parseCaptureJson('{"append_to": "x.md", "update": "短"}'), null)
})

test('compressExcerpt keeps structured lines and caps length', () => {
  const src = '# 标题\n- 要点一：数据库索引\n- 要点二：B+树加速\n普通的一句话，不讲结论。'
  const out = compressExcerpt(src, 400)
  assert.ok(out.includes('要点一'))
  assert.ok(out.length <= 410)
  const big = compressExcerpt('x'.repeat(5000), 100)
  assert.ok(big.length <= 120)
  assert.ok(big.includes('已压缩'))
})

test('pickNeighbors ranks existing cards by keyword overlap', async () => {
  const freshRoot = path.join(tmpRoot, 'vault-neighbors')
  await ensureVault(freshRoot)
  await captureCard(freshRoot, { kind: 'knowledge', title: 'Redis缓存策略', tags: ['redis'], body: 'Redis缓存热点数据，TTL设置，缓存穿透与雪崩处理。', status: 'approved' })
  await captureCard(freshRoot, { kind: 'knowledge', title: '前端构建工具', tags: ['vite'], body: 'Vite 基于 esbuild 与 Rollup。', status: 'approved' })
  const draft = { title: '缓存策略补充', body: 'Redis缓存TTL雪崩穿透问题再讨论' }
  const neighbors = await pickNeighbors(freshRoot, draft, 8)
  assert.ok(neighbors.length >= 1)
  assert.ok(neighbors[0].title.includes('缓存'), '缓存相关卡应排第一')
})

test('summarizeTurn with existing index can decide append_to', async () => {
  const llm = fakeLlm(JSON.stringify({
    append_to: '03-Knowledge/缓存策略.md',
    update: '补充：增加随机过期防止缓存雪崩，大key用分段缓存降低序列化开销。',
  }))
  const talk = [
    '用户：缓存雪崩怎么解决？',
    '助手：可以在TTL上增加随机过期时间，避免大量key同时失效；另外用互斥锁重建缓存，或者加一层兜底限流；大key用分段缓存降低序列化开销。',
    '用户：和缓存穿透是一回事吗？',
    '助手：不是，穿透是查不存在的数据，用空值缓存或布隆过滤器解决；雪崩是大量key同时过期。',
  ].join('\n')
  const result = await summarizeTurn(llm, { provider: 'p', model: 'm' }, talk, {
    existing: [{ path: '03-Knowledge/缓存策略.md', title: 'Redis缓存策略', summary: 'Redis缓存热点数据TTL与穿透处理' }],
  })
  assert.equal(result.append_to, '03-Knowledge/缓存策略.md')
})

test('extractLastTurn pulls all user + assistant text in the given slice', () => {
  const events = [
    { type: 'user/message', data: { turn: 1, role: 'user', content: [{ type: 'text', text: '第一轮问题' }] } },
    { type: 'assistant/message', data: { turn: 1, role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第一轮回答' }] } } },
    { type: 'user/message', data: { turn: 2, role: 'user', content: [{ type: 'text', text: '第二轮问题' }] } },
    { type: 'assistant/message', data: { turn: 2, role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第二轮回答' }] } } },
  ]
  const text = extractLastTurn(events)
  assert.ok(text.includes('第一轮问题'))
  assert.ok(text.includes('第一轮回答'))
  assert.ok(text.includes('第二轮问题'))
  assert.ok(text.includes('第二轮回答'))
  // 工具结果等非消息事件不进入文本
  const withTool = [
    ...events,
    { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: '工具输出' }] } } },
  ]
  const text2 = extractLastTurn(withTool)
  assert.ok(!text2.includes('工具输出'))
})

test('sliceNewEvents returns only user/assistant events after lastSeq', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 }, seq: 0 },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '问题1' }] }, seq: 1 },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } }, seq: 2 },
    { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: '结果' }] } }, seq: 3 },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '问题2' }] }, seq: 4 },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '回答2' }] } }, seq: 5 },
  ]
  const fresh = sliceNewEvents(events, 0)
  assert.equal(fresh.length, 4) // 4 条消息事件（1,2,4,5）
  const incremental = sliceNewEvents(events, 2)
  assert.equal(incremental.length, 2) // 只含 4,5
  assert.ok(incremental[0].data.content[0].text.includes('问题2'))
  // 空增量
  assert.equal(sliceNewEvents(events, 99).length, 0)
})

test('sessionEvents reads DSH Session (ownEvents/snapshotEvents fallback + legacy events)', () => {
  const a = { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: '甲' }] } }
  const b = { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: '乙' }] } } }
  // DSH 真实 Session：只有 ownEvents()/snapshotEvents()，没有 events 属性
  assert.deepEqual(sessionEvents({ ownEvents: () => [a, b] }), [a, b])
  assert.deepEqual(sessionEvents({ snapshotEvents: () => [a] }), [a])
  // 老结构（带 events 数组）仍兼容
  assert.deepEqual(sessionEvents({ events: [b] }), [b])
  // 都取不到 → 空数组（而不是抛错）
  assert.deepEqual(sessionEvents({}), [])
  assert.deepEqual(sessionEvents(undefined), [])
  // ownEvents 抛错时退回 snapshotEvents
  assert.deepEqual(sessionEvents({ ownEvents: () => { throw new Error('boom') }, snapshotEvents: () => [a] }), [a])
})

test('sessionEventApi 报出用到的接口名（供日志自证；接口不认识时为空）', () => {
  assert.equal(sessionEventApi({ ownEvents: () => [], snapshotEvents: () => [] }), 'ownEvents')
  assert.equal(sessionEventApi({ snapshotEvents: () => [] }), 'snapshotEvents')
  assert.equal(sessionEventApi({ events: [] }), 'events')
  // DSH 又改接口：既不报错也不静默，而是返回 '' 让调用方记一行 fail
  assert.equal(sessionEventApi({ nothing: 1 }), '')
  assert.equal(sessionEventApi(null), '')
})

test('createCaptureHealth 记录故障/复原（异常必须可被提示）', () => {
  const h = createCaptureHealth()
  assert.equal(h.snapshot().ok, true, '初始应是健康')
  h.fail('会话对象没有事件接口')
  const bad = h.snapshot()
  assert.equal(bad.ok, false)
  assert.ok(bad.reason.includes('事件接口'))
  assert.ok(bad.since > 0, '故障要有起始时间，供 UI 显示')
  h.fail('取不到模型路由')
  assert.ok(h.snapshot().reason.includes('模型路由'), '新故障覆盖旧原因')
  h.succeed()
  const good = h.snapshot()
  assert.equal(good.ok, true)
  assert.equal(good.reason, '')
  assert.ok(good.lastOkAt > 0)
})

test('端到端：真实 Session + 水位 → 只沉淀本回合新内容（自动沉淀回归）', async () => {
  const { Session } = await import('@deepseek-ai/dsh-session')
  const freshRoot = path.join(tmpRoot, 'vault-e2e')
  await ensureVault(freshRoot)
  const s = Session.create('mc-e2e')

  const turn = (n, q, a) => {
    s.append('turn/start', { turn: n }, {})
    s.append('user/message', { role: 'user', content: [{ type: 'text', text: q }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: n, step: 1, message: { id: `m${n}`, role: 'assistant', content: [{ type: 'text', text: a }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
  }
  const LONG_A = '缓存雪崩的根因是大量 key 同时过期：解决方案是给 TTL 加随机抖动、用互斥锁重建、加兜底限流；数据库索引方面 B+ 树更利于范围查询。'.repeat(3)
  turn(1, '第一轮：缓存雪崩怎么解决？', LONG_A)

  // 监听器等价逻辑：读会话事件 → 按水位切片 → 提取文本
  const all1 = sessionEvents(s)
  const text1 = extractLastTurn(sliceNewEvents(all1, 0))
  assert.ok(text1.includes('缓存雪崩'), '第一轮应含第一轮内容')

  // 第二轮：水位推进到第一轮末尾（监听器写在 lastSeqs 里的值）
  const watermark = all1[all1.length - 1].seq
  turn(2, '第二轮：那缓存穿透呢？', '缓存穿透用空值缓存或布隆过滤器解决。')
  const fresh2 = sliceNewEvents(sessionEvents(s), watermark)
  const text2 = extractLastTurn(fresh2)
  assert.ok(text2.includes('缓存穿透'))
  assert.ok(!text2.includes('缓存雪崩'), '水位生效：第二轮不应重复沉淀第一轮')

  // 走写卡路径：模型返回新卡 → 落库
  const llm = fakeLlm(JSON.stringify({
    save: true, title: '缓存三大问题处理', kind: 'knowledge', tags: ['缓存'],
    body: '# 缓存三大问题处理\n\n- 雪崩：TTL 随机抖动 + 互斥锁重建 + 限流兜底\n- 穿透：空值缓存 / 布隆过滤器',
  }))
  const result = await summarizeTurn(llm, { provider: 'p', model: 'm' }, text1)
  assert.equal(result.save, true)
  const out = await captureCard(freshRoot, { ...result, status: 'approved', submittedBy: 'deepseek-harness' }, { threshold: 0.62 })
  assert.equal(out.ok, true)
  const cards = await listCards(freshRoot)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].title, '缓存三大问题处理')
})

test('sliceNewEvents tolerates events without seq', () => {
  const events = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '无 seq 消息' }] } },
    { type: 'assistant/message', seq: 7, data: { message: { role: 'assistant', content: [{ type: 'text', text: '有 seq' }] } } },
  ]
  assert.equal(sliceNewEvents(events, 5).length, 2, '无 seq 的事件不应被水位过滤掉')
  assert.equal(sliceNewEvents(events, 7).length, 1)
})

test('captureCard writes with dedup; duplicate appends update instead', async () => {
  const freshRoot = path.join(tmpRoot, 'vault-dedup')
  await ensureVault(freshRoot)
  const body = '讨论缓存策略：Redis缓存热点数据，TTL设为10分钟，缓存穿透用空值缓存解决，并增加随机过期防止雪崩。'
  const first = await captureCard(freshRoot, {
    kind: 'knowledge',
    title: '缓存策略',
    tags: ['redis'],
    body,
    status: 'approved',
  })
  assert.equal(first.ok, true)
  // 高度相似的卡 → 去重拒绝
  const dup = await captureCard(freshRoot, {
    kind: 'knowledge',
    title: '缓存策略再讨论',
    tags: ['redis'],
    body: body + '补充：大key用分段缓存，避免单次序列化过大。',
  })
  assert.equal(dup.ok, false)
  assert.ok(dup.duplicate)
  // 追加更新记录
  const upd = await captureUpdate(freshRoot, dup.duplicate.path, '补充：增加随机过期防止缓存雪崩。')
  assert.equal(upd.ok, true)
  const text = await readCard(freshRoot, dup.duplicate.path)
  assert.ok(text.includes('## 更新记录'))
  const cards = await listCards(freshRoot)
  assert.equal(cards.length, 1, '不应产生重复卡')
})

test('makeDedupChecker scans a directory', async () => {
  await ensureVault(root)
  const body = 'Redis缓存热点数据，TTL设为10分钟，缓存穿透用空值缓存解决，并增加随机过期防止雪崩，大key分段缓存。'
  await captureCard(root, { kind: 'knowledge', title: '缓存策略', tags: ['redis'], body, status: 'approved' })
  const checker = makeDedupChecker(root)
  const hit = await checker(body, 0.62)
  assert.ok(hit)
})
