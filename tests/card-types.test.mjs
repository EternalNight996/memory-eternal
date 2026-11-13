// 知识类型识别（lib/card-types.js）：纯函数、可复现，所以这里守的是「口径」不是实现细节。
// 重点：① 红队导入卡一律「漏洞模板」（不吃正文里的偶发词）；② 技能卡走技能侧那套，不重复判；
//       ③ 标题优先于 tags 优先于正文；④ mergeTypeTags 幂等且不丢原有标签。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { knowledgeTypeOf, mergeTypeTags, KNOWLEDGE_TYPE_LABELS, KNOWLEDGE_TYPE_ORDER } from '../lib/card-types.js'

test('标题关键词优先：决策/根因/踩坑/部署/配置/接口 各自归位', () => {
  const cases = [
    ['数据库选型的决策结论', 'decision'],
    ['发布流水线踩坑：Windows 路径', 'pitfall'],
    ['为什么 7999 端口会被占用（根因）', 'root-cause'],
    ['生产部署 runbook', 'deploy'],
    ['memory-eternal-config 里的参数说明', 'config'],
    ['开放平台 API 对接与回调验签', 'api-integration'],
    ['性能优化：图谱渲染 60fps', 'performance'],
    ['接口压测与回归用例', 'testing'],
  ]
  for (const [title, want] of cases) {
    const got = knowledgeTypeOf({ kind: 'knowledge', title, tags: [], body: '' })
    assert.equal(got.code, want, title + ' 应判为 ' + want + '，实际 ' + got.code)
  }
})

test('标题没线索时退到 tags，再退到正文，都不中给 other', () => {
  assert.equal(knowledgeTypeOf({ kind: 'knowledge', title: '一些记录', tags: ['踩坑', 'windows'], body: '' }).code, 'pitfall')
  assert.equal(knowledgeTypeOf({ kind: 'knowledge', title: '一些记录', tags: ['杂项'], body: '这里是根因分析：句柄没释放。' }).code, 'root-cause')
  assert.equal(knowledgeTypeOf({ kind: 'knowledge', title: '随手一记', tags: ['杂项'], body: '今天天气不错。' }).code, 'other')
})

test('红队知识库导入的卡一律「漏洞模板」，不被正文关键词带偏', () => {
  const c = { kind: 'knowledge', title: '[sqli] 某系统 SQL 注入', tags: ['redteam-kb', 'poc', 'type:sqli'], body: '请求示例：union select 1,2,3', source: 'poc:redteam:cve-2025-22214' }
  const t = knowledgeTypeOf(c)
  assert.equal(t.code, 'vuln-template')
  assert.equal(t.label, '漏洞模板')
  assert.deepEqual(t.tags, ['知识类型:漏洞模板', 'knowledge-type:vuln-template'])
})

test('技能卡不判知识类型（避免两套类型维度打架）', () => {
  assert.equal(knowledgeTypeOf({ kind: 'skill', title: 'suo5-tunnel 隧道', tags: ['技能类型:隧道代理'], body: '' }).code, '')
})

test('kind 兜底：mistake → 经验教训，prompt → 概念解释，会议卡 → 会议记录', () => {
  assert.equal(knowledgeTypeOf({ kind: 'mistake', title: '一个失误', tags: [], body: '' }).code, 'lesson')
  assert.equal(knowledgeTypeOf({ kind: 'prompt', title: '提示词', tags: [], body: '' }).code, 'concept')
  assert.equal(knowledgeTypeOf({ kind: 'meeting', title: '周会', tags: [], body: '' }).code, 'meeting')
})

test('类型表自洽：每个类型都有中文/英文标签，order 覆盖全部 code', () => {
  for (const code of KNOWLEDGE_TYPE_ORDER) {
    assert.ok(KNOWLEDGE_TYPE_LABELS[code], code + ' 缺中文标签')
  }
  const labels = Object.values(KNOWLEDGE_TYPE_LABELS)
  assert.equal(new Set(labels).size, labels.length, '中文标签不应重复')
})

test('mergeTypeTags：幂等、剔除旧类型标签、保留原有标签、有上限', () => {
  const old = ['memory-eternal', '技能类型:侦察', 'knowledge-type:other', '备份']
  const merged = mergeTypeTags(old, ['知识类型:决策结论', 'knowledge-type:decision'])
  assert.ok(merged.includes('知识类型:决策结论'))
  assert.ok(!merged.includes('知识类型:其它'), '旧的 knowledge-type 应当被剔除')
  assert.ok(!merged.includes('技能类型:侦察'), '技能类型标签也归类型维度，一起剔除后重排')
  assert.ok(merged.includes('memory-eternal') && merged.includes('备份'), '普通标签必须保留')
  const again = mergeTypeTags(merged, ['知识类型:决策结论', 'knowledge-type:decision'])
  assert.deepEqual(again, merged, '重复合并必须完全一致（幂等）')

  const many = Array.from({ length: 40 }, (_, i) => 'tag' + i)
  const capped = mergeTypeTags(many, ['知识类型:其它', 'knowledge-type:other'], { max: 12 })
  assert.equal(capped.length, 12)
  assert.equal(capped[0], '知识类型:其它', '类型标签要排在最前，便于 UI 取第一条')
})
