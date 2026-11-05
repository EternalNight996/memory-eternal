// 星球分层视图回归守卫：根层 kind 折叠 / 超限合并「其他」 / 语义簇 ≤20 / 逐层下钻 ≤1000。
//
// 三档数据都在这里锁定：
//   ① 真实库 2049 的 kind 分布（project 944 / content 322 / knowledge 300 / mistake 257 /
//      skill 125 / tool 81 / prompt 15 / business 4 / core 1）—— 必须折叠成 4 颗大星球 + 226 颗小星球；
//   ② 合成 3000 / 10000：根层图元 ≤500（超限时最小 kind 合并「其他」），
//      任一集合 >1000 按语义簇分 ≤20 颗大星球，逐级下钻每层 ≤1000 图元，≤3 次点击到卡片；
//   ③ 每层 payload ≤1MB、层边有上限；宿主缓存命中；非法路径显式报错（不静默空图）。
// 另外把客户端纯函数（半径映射 / 超时归类 / 层级缓存 / 资源账本）一起单测：
// 资源账本是「20 轮下钻/返回后 rAF/定时器/监听器不增长」的可验证核心。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LEVEL_MAX_ITEMS, ROOT_BIG_KIND_MIN, ROOT_MAX_ITEMS, MAX_CLUSTERS, LEVEL_EDGE_LIMIT, LEVEL_PAYLOAD_LIMIT,
  LEVEL_ERR_PATH, LEVEL_ERR_STALE,
  parseLevelPath, planRootLevel, planClusters, planGraphLevel, graphLevel, ensureVault, writeCard,
  resetLevelCache, levelCacheStats, setLevelCacheLimits,
} from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'
import { levelErrorResponse } from '../lib/api.js'
import {
  LEVEL_TIMEOUT_MS, LEVEL_MAX_ITEMS as CLIENT_MAX_ITEMS, LEVEL_PAYLOAD_LIMIT as CLIENT_PAYLOAD_LIMIT,
  PLANET_MIN_RADIUS, PLANET_MAX_RADIUS,
  planetRadius, cardRadius, levelItemToNode, planetLayerParams, describeLevelError, formatCount,
  createLevelCache, createResourceTracker, validateLevelPayload, segmentsOf, pathKey, urlForLevel,
} from '../src/client/graph-planet.js'

// ---- 合成数据工具 -----------------------------------------------------------
// 真实库的 kind 分布（2049 张，2026-11 实测 overview）
const REAL_DISTRIBUTION = { project: 944, content: 322, knowledge: 300, mistake: 257, skill: 125, tool: 81, prompt: 15, business: 4, core: 1 }

const DAY = 86400000
function makeCard(kind, i, tags = []) {
  const ts = Date.UTC(2024, 0, 1) + i * 60000
  return {
    id: `${kind}/${i}.md`,
    path: `${kind}/${i}.md`,
    title: `${kind} 卡片 ${i}`,
    kind,
    tags,
    updated: new Date(ts).toISOString(),
    mtime: ts,
  }
}

/** 按 {kind: 数量} 造卡；tagCount>0 时给每张卡 3 个确定性标签（用于语义聚类）。 */
function synthCards(spec, { tagCount = 0 } = {}) {
  const cards = []
  for (const [kind, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i++) {
      const tags = tagCount > 0 ? Array.from({ length: 3 }, (_, k) => `${kind}-t${(i * 7 + k * 13) % tagCount}`) : []
      cards.push(makeCard(kind, i, tags))
    }
  }
  return cards
}

const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v))
const planetItems = (items) => items.filter((it) => it.type === 'planet')
const cardItems = (items) => items.filter((it) => it.type === 'card')

// ---- 根层：kind 折叠 --------------------------------------------------------

test('真实库 2049 分布：根层折叠成 4 颗大星球 + 226 颗小星球（≤500 图元）', () => {
  const cards = synthCards(REAL_DISTRIBUTION)
  assert.equal(cards.length, 2049)
  const level = planRootLevel(cards)
  const planets = planetItems(level.items)
  const smalls = cardItems(level.items)
  assert.equal(level.items.length, 230, '根层图元 = 4 大 + 226 小')
  assert.ok(level.items.length <= ROOT_MAX_ITEMS, '根层图元必须 ≤500')
  assert.equal(planets.length, 4, '>200 的 4 类各合成一颗大星球')
  assert.deepEqual(planets.map((p) => p.count), [944, 322, 300, 257], '大星球按卡数排序展示项目/内容/知识/教训')
  assert.deepEqual(planets.map((p) => p.label), ['项目', '内容', '知识', '教训'])
  assert.equal(smalls.length, 226, '其余 5 类逐颗小星球：125+81+15+4+1')
  assert.equal(level.mergedKinds.length, 0, '没超限就不该合并「其他」')
  assert.ok(planets.every((p) => p.labelKey && p.id.startsWith('k:')), '大星球带 labelKey + 可下钻路径段')
})

test('折叠阈值严格大于 200：200 张仍是小星球，201 张才是大星球', () => {
  const cards = [...synthCards({ alpha: 200 }), ...synthCards({ beta: 201 })]
  const level = planRootLevel(cards)
  const planets = planetItems(level.items)
  assert.equal(planets.length, 1)
  assert.equal(planets[0].kind, 'beta')
  assert.equal(planets[0].count, 201)
  assert.equal(cardItems(level.items).filter((it) => it.kind === 'alpha').length, 200, '200 张逐颗展开')
  assert.equal(level.items.length, 201, '200 颗小星球 + 1 颗大星球')
})

test('根层超 500 图元：把「最小的 kind」并进「其他」桶，直到 ≤500', () => {
  // 600 个 kind × 17 张 = 10200 张：逐颗展开会是 600 个图元 → 必须合并
  const spec = {}
  for (let k = 0; k < 600; k++) spec['k' + String(k).padStart(3, '0')] = 17
  const cards = synthCards(spec)
  const level = planRootLevel(cards)
  assert.ok(level.items.length <= ROOT_MAX_ITEMS, '根层图元 ' + level.items.length + ' 必须 ≤' + ROOT_MAX_ITEMS)
  const merged = level.items.filter((it) => it.type === 'planet')
  assert.equal(merged.length, 1, '只留一颗「其他」大星球（这些 kind 都 ≤200，不出现单类大星球）')
  assert.equal(merged[0].labelKey, 'graphOther')
  assert.equal(merged[0].kind, 'other')
  assert.ok(level.mergedKinds.length >= 1, '至少要合并一个 kind')
  // 合并进来的必须是「最小的那些」：被合并的最大 kind 不能大于未合并的最小 kind
  const mergedSet = new Set(level.mergedKinds)
  const mergedSizes = level.mergedKinds.map((k) => spec[k])
  const kept = Object.keys(spec).filter((k) => !mergedSet.has(k))
  const keptSizes = kept.map((k) => spec[k])
  assert.ok(kept.length > 0, '只需合并到 ≤500 为止，不能把整层并成一颗')
  assert.ok(Math.max(...mergedSizes) <= Math.min(...keptSizes), '合并的必须是最小的 kind')
  assert.equal(merged[0].count, level.mergedKinds.length * 17, '「其他」桶的卡数 = 被合并 kind 的卡数之和')
  assert.equal(level.items.length, kept.length * 17 + 1, '剩下的 kind 逐颗展开 + 1 颗「其他」')
  assert.ok(level.items.length <= ROOT_MAX_ITEMS)
  // 合并桶本身可下钻：路径段是 k:<kind1>,<kind2>…
  const seg = parseLevelPath(merged[0].id)
  assert.equal(seg.length, 1)
  assert.equal(seg[0].type, 'kind')
  assert.equal(seg[0].kinds.length, level.mergedKinds.length)
  const drilled = planGraphLevel(cards, seg)
  assert.equal(drilled.level.total, level.mergedKinds.length * 17, '「其他」桶可下钻，卡数与桶一致')
  assert.ok(drilled.level.items.length <= LEVEL_MAX_ITEMS)
})

// ---- 语义簇 / 逐层下钻 ------------------------------------------------------

const SPEC_10K = { project: 5000, content: 1500, knowledge: 1000, mistake: 900, skill: 600, tool: 500, prompt: 500 }

test('10k：根层 ≤500 图元，任一 >1000 的集合按语义簇分 ≤20 颗大星球，逐级下钻每层 ≤1000', () => {
  const cards = synthCards(SPEC_10K, { tagCount: 25 })
  assert.equal(cards.length, 10000)
  const root = planGraphLevel(cards, [])
  assert.ok(root.level.items.length <= ROOT_MAX_ITEMS, '根层图元 ' + root.level.items.length)
  assert.equal(root.level.mode, 'root')
  assert.equal(bytesOf(root), bytesOf(root), '同输入必然同输出')
  assert.ok(bytesOf(root) <= LEVEL_PAYLOAD_LIMIT, '根层 payload ' + bytesOf(root))

  // 每个大类 >1000 → 语义簇层（≤20 颗大星球，且每颗都能继续下钻到卡片）
  const big = planetItems(root.level.items)
  assert.ok(big.length >= 4, '四个以上大类')
  let worstDepth = 0
  for (const p of big) {
    const second = planGraphLevel(cards, parseLevelPath(p.id))
    assert.ok(second.level.items.length <= LEVEL_MAX_ITEMS, p.label + ' 层图元 ' + second.level.items.length)
    assert.ok(bytesOf(second) <= LEVEL_PAYLOAD_LIMIT, p.label + ' 层 payload ' + bytesOf(second))
    if (p.count > LEVEL_MAX_ITEMS) {
      assert.equal(second.level.mode, 'clusters', p.label + '（' + p.count + ' 张）必须按语义簇分块')
      const clusters = planetItems(second.level.items)
      assert.ok(clusters.length <= MAX_CLUSTERS, '语义簇 ' + clusters.length + ' 必须 ≤' + MAX_CLUSTERS)
      assert.equal(clusters.reduce((n, c) => n + c.count, 0), p.count, '簇内卡数之和 = 该集合卡数')
      // 下钻一颗簇 → 卡片层（≤1000 图元），即「根层点一下大类、再点一下簇」就看见卡片
      const third = planGraphLevel(cards, parseLevelPath(second.crumbs[second.crumbs.length - 1].path + '/' + clusters[0].id))
      assert.ok(third.level.items.length <= LEVEL_MAX_ITEMS, '簇层图元 ' + third.level.items.length)
      assert.equal(third.level.mode, 'cards')
      assert.equal(third.level.items.length, clusters[0].count)
      assert.ok(third.crumbs.length === 3, '面包屑：全部 › 大类 › 簇')
      worstDepth = Math.max(worstDepth, 2)
    } else {
      assert.equal(second.level.mode, 'cards')
      worstDepth = Math.max(worstDepth, 1)
    }
  }
  assert.ok(worstDepth <= 3, '从根层到卡片 ≤3 次点击')
})

test('10k 语义簇：标签优先、id 确定性、同一份集合下钻可复算', () => {
  const cards = synthCards({ project: 3000 }, { tagCount: 12 })
  const a = planClusters(cards)
  const b = planClusters(cards)
  assert.ok(a.length >= 2 && a.length <= MAX_CLUSTERS, '簇数 ' + a.length + ' 必须在 2..20')
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id), '同一份集合的簇 id 必须确定')
  assert.deepEqual(a.map((c) => c.count), b.map((c) => c.count))
  assert.ok(a.filter((c) => c.by === 'tag').length >= 1, '有标签信号时必须真的按标签聚')
  const total = a.reduce((n, c) => n + c.count, 0)
  assert.equal(total, 3000, '不能丢卡')
  const ids = new Set(a.flatMap((c) => c.cards.map((x) => x.id)))
  assert.equal(ids.size, 3000, '不能重复归簇')
  // 宿主返回的簇图元 id 必须能被 parseLevelPath 识别（下钻路径段）
  const level = planGraphLevel(cards, ['k:project'])
  assert.equal(level.level.mode, 'clusters')
  for (const it of planetItems(level.level.items)) {
    const seg = parseLevelPath(it.id)
    assert.equal(seg.length, 1)
    assert.equal(seg[0].type, 'cluster')
  }
})

test('语义簇体量守恒：每颗都不超过 ceil(n/簇数)（不会出现吞掉全库的巨兽）', () => {
  const cards = synthCards({ project: 6500 }, { tagCount: 25 })
  const n = cards.length
  const clusters = planClusters(cards)
  const wanted = Math.min(MAX_CLUSTERS, Math.max(2, Math.ceil(n / 250)))
  const cap = Math.ceil(n / wanted)
  assert.ok(clusters.length <= MAX_CLUSTERS, '簇数 ' + clusters.length)
  for (const c of clusters) assert.ok(c.count <= cap, `簇 ${c.id} 有 ${c.count} 张，超过上限 ${cap}`)
  assert.equal(clusters.reduce((s, c) => s + c.count, 0), n, '不能丢卡')
  // 单颗簇 ≤1000 → 下钻一次就能看见卡片（10k 数据 ≤3 次点击的关键）
  assert.ok(clusters.every((c) => c.count <= LEVEL_MAX_ITEMS), '簇不能超过单层上限，否则要多点一次')
})

test('语义聚类无有效信号时：按权重等分 ≤20 块（不硬造标签簇）', () => {  const cards = synthCards({ knowledge: 2400 }) // 没有标签
  const clusters = planClusters(cards)
  assert.ok(clusters.length >= 2 && clusters.length <= MAX_CLUSTERS, '簇数 ' + clusters.length)
  assert.ok(clusters.every((c) => c.by === 'weight'), '没有标签 → 全部走权重等分')
  assert.equal(clusters.reduce((n, c) => n + c.count, 0), 2400)
})

test('语义簇的极端情况：单一巨大标签也能拆成 ≤20 颗（且每颗不超过单层上限）', () => {
  const cards = Array.from({ length: 4000 }, (_, i) => makeCard('content', i, ['唯一大标签']))
  const clusters = planClusters(cards)
  assert.ok(clusters.length <= MAX_CLUSTERS, '簇数 ' + clusters.length)
  assert.equal(clusters.reduce((n, c) => n + c.count, 0), 4000)
  assert.ok(clusters.every((c) => c.count <= Math.ceil(4000 / 2)), '单簇不能吞掉全部')
  // 拆片 id 必须互不相同
  assert.equal(new Set(clusters.map((c) => c.id)).size, clusters.length)
})

test('3000 档：根层折叠 + 下钻到卡片，全程每层 ≤1000 图元且 payload ≤1MB', () => {
  const cards = synthCards({ project: 1200, content: 900, knowledge: 600, mistake: 300 }, { tagCount: 15 })
  assert.equal(cards.length, 3000)
  const root = planGraphLevel(cards, [])
  assert.ok(root.level.items.length <= ROOT_MAX_ITEMS)
  for (const p of planetItems(root.level.items)) {
    const lv = planGraphLevel(cards, parseLevelPath(p.id))
    assert.ok(lv.level.items.length <= LEVEL_MAX_ITEMS)
    assert.ok(bytesOf(lv) <= LEVEL_PAYLOAD_LIMIT)
    if (lv.level.mode === 'clusters') {
      const c = planetItems(lv.level.items)[0]
      const leaf = planGraphLevel(cards, parseLevelPath(p.id + '/' + c.id))
      assert.ok(leaf.level.items.length <= LEVEL_MAX_ITEMS)
      assert.ok(bytesOf(leaf) <= LEVEL_PAYLOAD_LIMIT)
    }
  }
})

test('卡片层：共享标签连边有上限（payload 红线），边不会超过图元的平方级', () => {
  const cards = synthCards({ project: 900 }, { tagCount: 6 })
  const lv = planGraphLevel(cards, ['k:project'])
  assert.equal(lv.level.mode, 'cards')
  assert.equal(lv.level.items.length, 900)
  assert.ok(lv.level.edges.length <= LEVEL_EDGE_LIMIT, '边数 ' + lv.level.edges.length)
  assert.ok(lv.level.edges.length > 0, '共享标签的卡片之间必须有边（星图不是一盘散点）')
  assert.ok(bytesOf(lv) <= LEVEL_PAYLOAD_LIMIT, 'payload ' + Math.round(bytesOf(lv) / 1024) + 'KB')
  assert.ok(lv.level.edges.every((e) => e.source && e.target && e.type === 'tag'))
})

test('非法层级路径：显式抛错（不允许静默返回空层）', () => {
  assert.deepEqual(parseLevelPath(''), [])
  assert.equal(parseLevelPath('k:project/t:ui').length, 2)
  assert.throws(() => parseLevelPath('zzz:1'), /无法识别的层级路径段/)
  assert.throws(() => parseLevelPath('k:'), /缺少 kind/)
  const cards = synthCards({ project: 10 })
  assert.throws(() => planGraphLevel(cards, ['t:不存在']), /语义簇已变化/)
})

// ---- 宿主 graphLevel（真实 SQLite + 缓存）------------------------------------

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'me-graph-planet-'))
const vault = path.join(tmpRoot, 'vault')
after(async () => {
  closeAllDb()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('graphLevel：根层折叠 / 点大星球进层 / 面包屑路径 / 命中缓存', async () => {
  await ensureVault(vault)
  for (let i = 0; i < 250; i++) {
    await writeCard(vault, { kind: 'project', title: '层级项目 ' + i, tags: ['层' + (i % 5)], body: '项目内容 ' + i + ' 用于分层测试的正文，保证每条都不同。', status: 'approved' }, { dedup: false })
  }
  for (let i = 0; i < 40; i++) {
    await writeCard(vault, { kind: 'knowledge', title: '层级知识 ' + i, tags: ['共'], body: '知识内容 ' + i + ' 用于分层测试的正文，保证每条都不同。', status: 'approved' }, { dedup: false })
  }
  for (let i = 0; i < 10; i++) {
    await writeCard(vault, { kind: 'mistake', title: '层级教训 ' + i, tags: [], body: '教训内容 ' + i + ' 用于分层测试的正文，保证每条都不同。', status: 'approved' }, { dedup: false })
  }
  const root = await graphLevel(vault, { path: '' })
  assert.equal(root.level.mode, 'root')
  assert.equal(root.level.total, 300)
  const planets = planetItems(root.level.items)
  assert.equal(planets.length, 1, '250 张的 project 合成一颗大星球')
  assert.equal(planets[0].count, 250)
  assert.equal(cardItems(root.level.items).length, 50, 'knowledge 40 + mistake 10 逐颗小星球')
  assert.ok(root.stats.bytes <= LEVEL_PAYLOAD_LIMIT)
  assert.deepEqual(root.crumbs.map((c) => c.labelKey || c.label), ['graphAllCrumb'])

  const proj = await graphLevel(vault, { path: 'k:project' })
  assert.equal(proj.level.mode, 'cards')
  assert.equal(proj.level.items.length, 250, '250 ≤1000 → 直接铺卡片')
  assert.deepEqual(proj.crumbs.map((c) => c.label), ['全部', '项目'], '面包屑「全部 › 项目」')
  assert.equal(proj.stats.cached, false)

  // 第二次同路径：宿主缓存命中（同一指纹），ms 更短；路径/内容一致
  const again = await graphLevel(vault, { path: 'k:project' })
  assert.equal(again.stats.cached, true)
  assert.deepEqual(again.level.items.map((i) => i.id), proj.level.items.map((i) => i.id))

  // 非法路径：明确报错，且错误带可归类的 code（api 层据此回 400 而不是 500）
  await assert.rejects(() => graphLevel(vault, { path: 'nope:1' }), (e) => e.code === LEVEL_ERR_PATH && /无法识别的层级路径段/.test(e.message))
})

// ---- 缓存上界（repair-round-2 回归）-----------------------------------------

test('levelCardsCache 按 root 为键 + 比对指纹：反复写卡不会堆出一堆全库快照', async () => {
  const v = path.join(tmpRoot, 'cache-cards')
  await ensureVault(v)
  resetLevelCache()
  assert.equal(levelCacheStats().cardsRoots, 0)
  for (let i = 0; i < 10; i++) {
    await writeCard(v, {
      kind: 'project',
      title: '缓存轮次卡 ' + i,
      body: '缓存轮次正文 ' + i + ' —— 每次写卡都会改变图谱指纹，旧实现会因此多留一份全库快照。',
      status: 'approved',
    }, { dedup: false })
    await graphLevel(v, { path: '' })
    await graphLevel(v, { path: 'k:project' })
    const s = levelCacheStats()
    // 关键断言：库只有一个 → 卡片快照只能有 1 份（旧实现是「每轮 +1」，10 轮就是 10 份全库卡片）
    assert.equal(s.cardsRoots, 1, '第 ' + (i + 1) + ' 轮后 cardsRoots 必须是 1')
    assert.ok(s.cardsRoots <= s.cardsMaxRoots)
    assert.ok(s.levelEntries <= s.levelMaxEntries, '层缓存条数 ' + s.levelEntries + ' 必须 ≤' + s.levelMaxEntries)
    assert.ok(s.levelBytes <= s.levelMaxBytes, '层缓存字节 ' + s.levelBytes + ' 必须 ≤' + s.levelMaxBytes)
  }
  // 指纹每轮都变 → 旧指纹的层缓存会自然被淘汰，条目数不会随轮次线性增长
  assert.ok(levelCacheStats().levelEntries <= 10 * 2, '层缓存条目应与「最近路径数」同阶，而不是随写卡次数增长')
})

test('levelCache 字节上限会触发淘汰（用很小的预算验证，不必真灌满 16MB）', async () => {
  const v = path.join(tmpRoot, 'cache-bytes')
  await ensureVault(v)
  resetLevelCache()
  for (let i = 0; i < 120; i++) {
    await writeCard(v, {
      kind: 'project',
      title: '字节上限卡 ' + i,
      tags: ['t' + (i % 6)],
      body: '字节上限正文 ' + i + ' 用于制造一个较大的卡片层 payload，验证字节预算淘汰。',
      status: 'approved',
    }, { dedup: false })
  }
  const limits = setLevelCacheLimits({ maxEntries: 64, maxBytes: 4096 })
  assert.equal(limits.maxBytes, 4096)
  try {
    // 每层 payload 都远超 4KB → 预算内一条都留不住（响应照常返回，只是不入缓存）
    for (let i = 0; i < 6; i++) {
      resetLevelCache()
      setLevelCacheLimits({ maxEntries: 64, maxBytes: 4096 })
      const one = await graphLevel(v, { path: '' })
      await graphLevel(v, { path: 'k:project' })
      const s = levelCacheStats()
      assert.ok(one.stats.bytes > 4096, '这一层的 payload 本身必须超过 4KB 预算（否则这条用例没意义）')
      assert.ok(s.levelBytes <= 4096, '第 ' + (i + 1) + ' 轮：字节账 ' + s.levelBytes + ' 超过预算 4096')
      assert.ok(s.levelEntries <= 1, '超预算时最多留 1 条，实际 ' + s.levelEntries)
    }
  } finally {
    setLevelCacheLimits({ maxEntries: 48, maxBytes: 16 * 1024 * 1024 })
  }
  assert.equal(levelCacheStats().levelMaxBytes, 16 * 1024 * 1024, '恢复默认预算')
})

// ---- 错误分类（repair-round-2）----------------------------------------------

test('错误分类：路径/簇失效 → 400 原文案；未知异常 → 500 通用文案且细节只进日志', () => {
  const pathErr = Object.assign(new Error('无法识别的层级路径段：zzz:1'), { code: LEVEL_ERR_PATH })
  const r1 = levelErrorResponse(pathErr)
  assert.equal(r1.status, 400)
  assert.match(r1.body.error, /无法识别/)

  const stale = Object.assign(new Error('语义簇已变化，请返回上一层重试：t:ui'), { code: LEVEL_ERR_STALE })
  const r2 = levelErrorResponse(stale)
  assert.equal(r2.status, 400)
  assert.equal(r2.body.code, LEVEL_ERR_STALE)

  // 未知异常：500 + 通用文案（不能把 SQL/堆栈原文回给浏览器），并且 console.error 留档
  const logged = []
  const origError = console.error
  console.error = (...args) => { logged.push(args) }
  try {
    const r3 = levelErrorResponse(new Error('SQLITE_BUSY: database is locked'), 'path=k:project')
    assert.equal(r3.status, 500)
    assert.equal(r3.body.code, 'LEVEL_FAILED')
    assert.doesNotMatch(r3.body.error, /SQLITE_BUSY|database/, '内部细节不能出现在响应里')
    assert.equal(logged.length, 1, '未知异常必须 console.error 留档')
    assert.ok(String(logged[0][1] && logged[0][1].message).includes('SQLITE_BUSY'), '日志里要带原始错误')
    assert.ok(String(logged[0][0]).includes('k:project'), '日志里要带上下文（哪个 path 出错）')
  } finally {
    console.error = origError
  }
})

test('错误码从解析/聚类处一路带上：parseLevelPath 与「簇已变化」都带 code', () => {
  assert.throws(() => parseLevelPath('zzz:1'), (e) => e.code === LEVEL_ERR_PATH)
  assert.throws(() => parseLevelPath('k:'), (e) => e.code === LEVEL_ERR_PATH)
  const cards = synthCards({ project: 20 })
  assert.throws(() => planGraphLevel(cards, ['t:不存在']), (e) => e.code === LEVEL_ERR_STALE)
})

// ---- 客户端纯函数 -----------------------------------------------------------

test('客户端：图元 → 画布节点（星球半径随卡数对数增长且有上下界，卡片沿用度数规则）', () => {
  assert.equal(LEVEL_MAX_ITEMS, CLIENT_MAX_ITEMS, '客户端与宿主的单层上限必须一致')
  assert.equal(LEVEL_PAYLOAD_LIMIT, CLIENT_PAYLOAD_LIMIT, '客户端与宿主的 payload 上限必须一致')
  assert.ok(planetRadius(1) >= PLANET_MIN_RADIUS, '小星球也要看得见（有下限）')
  assert.ok(planetRadius(250) > planetRadius(50), '卡数越多球越大')
  assert.ok(planetRadius(50000) <= PLANET_MAX_RADIUS, '半径有上限，不能撑爆视口')
  assert.equal(planetRadius(1e9), PLANET_MAX_RADIUS, '再夸张的卡数也夹在上限')
  assert.equal(planetRadius(0), PLANET_MIN_RADIUS)
  assert.ok(planetRadius(944) > planetRadius(300))
  assert.equal(cardRadius({ kind: 'knowledge', degree: 0, maxDegree: 5 }), 9)
  assert.ok(cardRadius({ kind: 'knowledge', degree: 5, maxDegree: 5 }) > 9)
  assert.equal(cardRadius({ kind: 'core', degree: 0, maxDegree: 5 }), 12)

  const planet = levelItemToNode({ id: 'k:project', type: 'planet', label: '项目', kind: 'project', count: 944 })
  assert.equal(planet.planet, true)
  assert.equal(planet.count, 944)
  assert.equal(planet.r, planetRadius(944))
  assert.equal(planet.title, '项目')
  const card = levelItemToNode({ id: 'a.md', type: 'card', label: '卡片 A', kind: 'knowledge', tags: ['x'], updated: '2026-01-01' }, { degree: 2, maxDegree: 10 })
  assert.equal(card.planet, false)
  assert.equal(card.count, 0)
  assert.deepEqual(card.tags, ['x'])
  assert.ok(card.r >= 9 && card.r <= 22)

  const params = planetLayerParams({ repulsion: 800, centerGravity: 0.01, attraction: 0.002 })
  assert.ok(params.repulsion > 800, '星球层斥力必须更大（大圆才分得开）')
  assert.ok(params.centerGravity < 0.01, '星球层向心更弱')
  assert.equal(params.attraction, 0.002, '其余力常数保持不变')
})

test('客户端：星球球心数字按语言紧凑（中文「万」/ 英文 K/M），2049 与 10k 的现有显示不变', () => {
  const zh = { unit: '万', locale: 'zh-CN' }
  const en = { unit: 'K', locale: 'en-US' }
  // ① 现有 2049 / 10k 真实看到的卡数：全部 <10000，必须原样
  for (const v of [944, 322, 300, 257, 2049, 6500, 1500, 900, 600, 6, 9999]) {
    assert.equal(formatCount(v, zh), String(v), '中文界面 ' + v + ' 必须原样显示')
    assert.equal(formatCount(v, en), String(v), '英文界面 ' + v + ' 也必须原样（<1 万不压缩）')
  }
  // ② ≥10000：中文「万」、英文 K/M（Intl 紧凑写法）
  assert.equal(formatCount(10000, zh), '1万')
  assert.equal(formatCount(12000, zh), '1.2万')
  assert.equal(formatCount(12000, en), '12K')
  assert.equal(formatCount(1250000, en), '1.3M')
  // ③ Intl 不可用时的回退分支也必须按语言给单位
  assert.equal(formatCount(12000, { ...zh, intl: false }), '1.2万')
  assert.equal(formatCount(12000, { ...en, intl: false }), '12K')
  assert.equal(formatCount(1250000, { ...en, intl: false }), '1.3M')
  assert.equal(formatCount(1250000, { ...zh, intl: false }), '125万')
  // ④ 脏数据兜底
  assert.equal(formatCount(undefined, zh), '0')
  assert.equal(formatCount(-5, zh), '0')
})

test('客户端：层加载超时/失败归类（超时与普通失败必须分得开）', () => {
  const abort = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
  const t1 = describeLevelError(abort, { timeoutMs: LEVEL_TIMEOUT_MS })
  assert.equal(t1.timeout, true)
  assert.match(t1.message, /超时/)
  const slow = describeLevelError(new Error('socket hang up'), { timeoutMs: 1600, elapsedMs: 1700 })
  assert.equal(slow.timeout, true, '耗时越预算也算超时')
  const plain = describeLevelError(new Error('HTTP 500'), { timeoutMs: 1600, elapsedMs: 30 })
  assert.equal(plain.timeout, false)
  assert.equal(plain.message, 'HTTP 500', '普通失败的原话必须保留（不能吞成一句「失败」）')
  assert.equal(LEVEL_TIMEOUT_MS, 1600)
})

test('客户端：层级缓存（LRU）—— 面包屑返回上层命中即零新增请求', () => {
  const cache = createLevelCache(3)
  cache.set('', { level: 'root' })
  cache.set('k:project', { level: 'project' })
  cache.set('k:project/t:a', { level: 'cluster' })
  assert.equal(cache.get('') && cache.get('').level, 'root')
  cache.set('k:content', { level: 'content' }) // 淘汰最久未用（k:project 刚被 get 过 → 淘汰次序按 LRU）
  assert.equal(cache.size, 3)
  assert.equal(cache.get('k:project') !== null || cache.get('k:project/t:a') !== null, true)
  cache.clear()
  assert.equal(cache.size, 0)
  // 路径工具与缓存键一致
  assert.equal(pathKey(['k:project', 't:ui']), 'k:project/t:ui')
  assert.deepEqual(segmentsOf('k:project/t:ui'), ['k:project', 't:ui'])
  assert.deepEqual(segmentsOf(''), [])
  assert.equal(urlForLevel('/memory-eternal/api', ['k:project'], { all: true }), '/memory-eternal/api/graph/level?path=k%3Aproject&all=1')
})

test('客户端：资源账本 —— 20 轮下钻/返回后 rAF / 定时器 / 监听器不增长', () => {
  const rafs = new Set()
  const timers = new Set()
  const listeners = new Set()
  let seq = 0
  const env = {
    raf: (fn) => { const id = ++seq; rafs.add(id); return id },
    cancelRaf: (id) => { rafs.delete(id) },
    setTimeout: (fn) => { const id = ++seq; timers.add(id); return id },
    clearTimeout: (id) => { timers.delete(id) },
  }
  const target = {
    addEventListener: (type) => listeners.add(type),
    removeEventListener: (type) => listeners.delete(type),
  }
  const baseline = (() => {
    const tracker = createResourceTracker(env)
    tracker.raf(() => {})
    tracker.setTimeout(() => {}, 10)
    tracker.listen(target, 'mousemove', () => {})
    tracker.listen(target, 'mouseup', () => {})
    const snap = tracker.snapshot()
    tracker.releaseAll()
    return snap
  })()
  assert.deepEqual(baseline, { rafs: 1, timers: 1, listeners: 2 })
  assert.equal(rafs.size, 0, 'releaseAll 必须真的取消 rAF')
  assert.equal(timers.size, 0, 'releaseAll 必须真的清定时器')
  assert.equal(listeners.size, 0, 'releaseAll 必须真的移除监听器')

  for (let round = 0; round < 20; round++) {
    const tracker = createResourceTracker(env)
    tracker.raf(() => {})
    tracker.raf(() => {})
    tracker.setTimeout(() => {}, 10)
    tracker.listen(target, 'mousemove', () => {})
    tracker.listen(target, 'mouseup', () => {})
    const live = tracker.snapshot()
    assert.deepEqual(live, { rafs: 2, timers: 1, listeners: 2 }, '第 ' + (round + 1) + ' 轮：单层实例的资源量必须恒定')
    tracker.releaseAll()
    assert.deepEqual(tracker.snapshot(), { rafs: 0, timers: 0, listeners: 0 }, '第 ' + (round + 1) + ' 轮卸载后必须归零')
  }
  assert.equal(rafs.size + timers.size + listeners.size, 0, '20 轮之后全局没有残留')
})

test('客户端：分层响应越界检测（宿主回归时立刻可见，不静默截断）', () => {
  const ok = validateLevelPayload({ level: { items: new Array(900).fill({}) }, stats: { bytes: 1000 } })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.problems, [])
  const tooMany = validateLevelPayload({ level: { items: new Array(LEVEL_MAX_ITEMS + 1).fill({}) }, stats: { bytes: 1000 } })
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.problems.join('；'), /单层图元/)
  const tooBig = validateLevelPayload({ level: { items: [{}] }, stats: { bytes: LEVEL_PAYLOAD_LIMIT + 1 } })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.problems.join('；'), /payload/)
})
