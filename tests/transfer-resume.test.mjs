// 传输健壮性测试：断点续传、分片重试、401 保留进度
// 这些行为都在客户端 uploadVaultToCloud 里，这里用一个最小的模拟器复刻同一套逻辑，
// 确保规则本身成立（真浏览器里再跑一次端到端）。
import assert from 'node:assert/strict'
import test from 'node:test'

const CHUNK = 200

/** 复刻 uploadVaultToCloud 的分片循环：重试 + 断点 + 401 */
function makeUploader({ cards, post, store }) {
  return async function upload() {
    let startOff = 0
    const rs = JSON.parse(store.get('me-xfer-resume') || 'null')
    if (rs && rs.src === 'L' && rs.total === cards.length && rs.done > 0 && rs.done < cards.length) {
      startOff = Math.floor(rs.done / CHUNK) * CHUNK
    }
    let imported = 0, duplicate = 0, failed = 0
    for (let off = startOff; off < cards.length; off += CHUNK) {
      const slice = cards.slice(off, off + CHUNK)
      let ok = false
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const d = await post({ cards: slice, offset: off, total: cards.length }, attempt)
          imported += d.imported || 0
          duplicate += d.duplicate || 0
          ok = true
        } catch (e) {
          if (String(e.message) === '__AUTH__') {
            // 保留断点后抛出
            store.set('me-xfer-resume', JSON.stringify({ src: 'L', total: cards.length, done: off }))
            throw new Error('AUTH_EXPIRED')
          }
          if (attempt === 3) failed += slice.length
          else await new Promise((r) => setTimeout(r, 1))
        }
      }
      store.set('me-xfer-resume', JSON.stringify({ src: 'L', total: cards.length, done: Math.min(off + slice.length, cards.length) }))
    }
    if (!failed) store.del('me-xfer-resume')
    return { imported, duplicate, failed }
  }
}

const mkStore = () => {
  const m = new Map()
  return { get: (k) => m.get(k) || null, set: (k, v) => m.set(k, v), del: (k) => m.delete(k) }
}

const cards = (n) => Array.from({ length: n }, (_, i) => ({ title: 'c' + i, text: 'x' }))

test('全量上传：5 片 × 200 = 1000 张，完成后断点被清掉', async () => {
  const store = mkStore()
  const post = async ({ cards: s }) => ({ imported: s.length, duplicate: 0 })
  const r = await makeUploader({ cards: cards(1000), post, store })()
  assert.equal(r.imported, 1000)
  assert.equal(r.failed, 0)
  assert.equal(store.get('me-xfer-resume'), null, '完成后必须清断点')
})

test('断点续传：上次停在 400，这次从 400 开始，不重传前 400', async () => {
  const store = mkStore()
  store.set('me-xfer-resume', JSON.stringify({ src: 'L', total: 1000, done: 400 }))
  const offsets = []
  const post = async ({ cards: s, offset }) => { offsets.push(offset); return { imported: s.length, duplicate: 0 } }
  const r = await makeUploader({ cards: cards(1000), post, store })()
  assert.equal(offsets[0], 400, '第一片应从 offset=400 开始')
  assert.equal(r.imported, 600, '只传后面 600 张')
})

test('断点对齐分片边界：done=450 → 从 400 重传该片（保守，不会漏卡）', async () => {
  const store = mkStore()
  store.set('me-xfer-resume', JSON.stringify({ src: 'L', total: 1000, done: 450 }))
  const offsets = []
  const post = async ({ cards: s, offset }) => { offsets.push(offset); return { imported: s.length, duplicate: 0 } }
  await makeUploader({ cards: cards(1000), post, store })()
  assert.equal(offsets[0], 400)
})

test('分片抖动：第 1 次失败、第 2 次成功 → 不记失败', async () => {
  const store = mkStore()
  let calls = 0
  const post = async ({ cards: s }) => {
    calls++
    if (calls === 1) throw new Error('network')
    return { imported: s.length, duplicate: 0 }
  }
  const r = await makeUploader({ cards: cards(200), post, store })()
  assert.equal(r.failed, 0, '重试成功不该记失败')
  assert.equal(r.imported, 200)
})

test('分片彻底失败：3 次都错 → 记进 failed，但继续下一片', async () => {
  const store = mkStore()
  let n = 0
  const post = async ({ cards: s }) => {
    n++
    if (n <= 3) throw new Error('boom')
    return { imported: s.length, duplicate: 0 }
  }
  const r = await makeUploader({ cards: cards(400), post, store })()
  assert.equal(r.failed, 200, '第一片全失败')
  assert.equal(r.imported, 200, '第二片照常成功')
})

test('401：抛 AUTH_EXPIRED，并把当前 offset 留在断点里', async () => {
  const store = mkStore()
  const post = async ({ offset }) => {
    if (offset >= 200) throw new Error('__AUTH__')
    return { imported: 200, duplicate: 0 }
  }
  await assert.rejects(() => makeUploader({ cards: cards(600), post, store })(), /AUTH_EXPIRED/)
  const rs = JSON.parse(store.get('me-xfer-resume'))
  assert.equal(rs.done, 200, '断点应停在 200（下一片的位置）')
})

test('源库或总数变了 → 断点作废，从头传', async () => {
  const store = mkStore()
  store.set('me-xfer-resume', JSON.stringify({ src: 'OTHER', total: 1000, done: 600 }))
  const offsets = []
  const post = async ({ cards: s, offset }) => { offsets.push(offset); return { imported: s.length, duplicate: 0 } }
  await makeUploader({ cards: cards(1000), post, store })()
  assert.equal(offsets[0], 0, '换了源库就不能复用断点')
})
