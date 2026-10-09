// issue #27 回归守卫：**审核中心必须能看到正文再决定批/驳**。
//
// 现场（thinrflbtlm）：审核中心只列标题看不到内容；而两套存储之后待审卡物理隔离在 quarantine，
// 知识卡界面只会列出已审核卡 —— 于是「不人工确认就没法审」，审核功能形同虚设。
// 修法：审核中心每行可就地展开 frontmatter + 正文（**按需**拉 /card?status=pending|rejected，
// 服务端只放行确实在队列里的 path），展开块里直接给 ✓批准 / ✕驳回。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVault, writeCard, readCard, auditQueue, setCardStatus } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-issue27-'))
after(async () => {
  closeAllDb()
  try { await fs.rm(tmpRoot, { recursive: true, force: true }) } catch { /* Windows 句柄未释放时忽略 */ }
})

test('待审卡的正文读得到（展开视图渲染的就是它），批/驳后离开队列', async () => {
  const vault = path.join(tmpRoot, 'vault')
  await ensureVault(vault)
  const body = '这是待审卡的正文：# 结论\n\n' + '细节'.repeat(80) + '\n\n唯一标记 MARK27XYZ'
  const written = await writeCard(vault, { kind: 'knowledge', title: '待审卡（#27）', body, status: 'pending' })

  const q = await auditQueue(vault)
  assert.equal(q.pending.length, 1, '待审卡要出现在审核队列里')
  assert.equal(q.pending[0].path, written.path)

  // 客户端展开时拉的就是这份正文（allowUnapproved 只在队列校验通过后才用）
  const card = await readCard(vault, written.path, { allowUnapproved: true })
  assert.match(String(card.text || ''), /唯一标记 MARK27XYZ/, '展开视图必须能拿到完整正文')
  assert.match(String(card.text || ''), /细节细节/, '正文不能被截断成摘要')

  await setCardStatus(vault, written.path, 'approved')
  const after1 = await auditQueue(vault)
  assert.equal(after1.pending.length, 0, '批准后应离开待审队列')
  assert.equal(after1.rejected.length, 0, '批准不等于驳回')
})

test('源码守卫：审核中心可展开正文 + 就地批驳；正文按需拉取（不把整库正文塞进列表）', () => {
  const client = read('src/client/index.tsx')
  assert.match(client, /const toggleOpen = async \(c\) =>/, '要有展开/收起')
  assert.match(client, /\/card\?path=\$\{encodeURIComponent\(path\)\}&status=\$\{status\}/, '正文要按需拉 /card?status=')
  assert.match(client, /renderMd\(splitFrontmatter\(st\.text\)\.body\)/, '展开后要用同一套 Markdown 渲染（不是裸文本）')
  assert.match(client, /tab === 'pending' && \([\s\S]{0,400}?applyStatus\('approved', \[c\.path\]\)/, '展开块里要能直接批准')
  assert.equal((client.match(/auditBodyFail:/g) || []).length, 2, '中英词条各一条（否则英文界面显示 key）')
  const api = read('lib/api.js')
  assert.match(api, /const q = await auditQueue\(vaultRoot\)[\s\S]{0,200}?inQueue/, '未审核正文只能对队列里的 path 放行')
  assert.match(api, /CARD_NOT_APPROVED/, '越权读未审核正文要有明确拒绝码')
})
