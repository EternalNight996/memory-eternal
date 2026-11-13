// 内置语义（零安装）向量：守三件事
//   ① 近义文本的相似度要明显高于无关文本（否则「内置语义」名不副实）；
//   ② 维度固定、L2 归一化（能直接 cosine，也能与外部模型的向量共存于 card_vec）；
//   ③ 空文本/纯标点不炸，返回全零向量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { embedBuiltin, builtinSimilarity, featuresOf, BUILTIN_DIM, BUILTIN_MODEL } from '../lib/builtin-embed.js'

const sim = (a, b) => builtinSimilarity(embedBuiltin(a), embedBuiltin(b))

test('近义文本相似度显著高于无关文本', () => {
  const near = sim('脚本跑久了会被卡住，怎么排查', '任务挂住不动，怀疑死锁')
  const wordForm = sim('脚本跑久了会被卡住，怎么排查', '脚本  卡住  排查')
  const far = sim('脚本跑久了会被卡住，怎么排查', '图形界面渲染性能优化')
  assert.ok(near > far + 0.1, `近义 ${near.toFixed(3)} 应当明显高于无关 ${far.toFixed(3)}`)
  assert.ok(wordForm > far, '词形接近的文本应当比无关文本更相似')
})

test('维度固定 + L2 归一化', () => {
  const v = embedBuiltin('记忆核心的卡片类型与检索')
  assert.equal(v.length, BUILTIN_DIM)
  let sum = 0
  for (const x of v) sum += x * x
  assert.ok(Math.abs(sum - 1) < 1e-4, '向量应当已 L2 归一化，实际平方和 ' + sum)
})

test('空文本 / 纯标点返回全零向量，不抛错', () => {
  for (const s of ['', '   ', '！！！', '...', null, undefined]) {
    const v = embedBuiltin(s)
    assert.equal(v.length, BUILTIN_DIM)
    assert.equal(v.some((x) => x !== 0), false, '空输入不应产生非零分量：' + JSON.stringify(s))
  }
})

test('中文按 2/3-gram 切，英文按整词（未被近义表归一的词）', () => {
  // 注意别选「卡片/检索」这类会被近义表归一掉的词（它们会变成「记忆/检索」规范形）
  const f = featuresOf('图谱 widget')
  assert.ok(f.includes('图谱'), '应当有中文 2-gram')
  assert.ok(f.includes('widget'), '应当有英文整词')
  assert.ok(f.every((x) => x.length <= 4 || /^[a-z0-9]+$/.test(x)), '中文特征不应超过 3 字')
})

test('近义表把同义说法归一（这是内置通道唯一的"语义知识"）', () => {
  // 归一后二者特征应当高度重合
  const a = featuresOf('任务挂住了')
  const b = featuresOf('任务卡住')
  const common = a.filter((x) => b.includes(x)).length
  assert.ok(common >= 3, '「挂住 / 卡住」归一后应有大量共同特征，实际 ' + common)
})

test('模型名稳定（写进 card_vec.model，换名会让旧向量失配）', () => {
  assert.equal(BUILTIN_MODEL, 'builtin-ngram-768')
})

test('同一段文本多次编码结果一致（哈希无随机性）', () => {
  const a = embedBuiltin('稳定性检查：同样的输入同样的输出')
  const b = embedBuiltin('稳定性检查：同样的输入同样的输出')
  assert.deepEqual(Array.from(a), Array.from(b))
})
