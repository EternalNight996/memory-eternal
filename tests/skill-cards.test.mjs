// 技能卡（kind=skill）：
// - 从「实际技能」生成，不是 agent 对话沉淀；
// - 录入后强制 pending（审核中心可见），批准后才进主库；
// - 同一技能幂等更新：待审卡原地刷新，已批准卡内容变化时新开一张「技能更新」待审卡。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCard, listCards, setCardStatus, setCardKind } from '../lib/vault.js'
import { setAuditConfig } from '../lib/db.js'
import { syncSkillCards, parseSkillFile, buildSkillCardBody, collectSkillFiles } from '../lib/skill-cards.js'
import { parseCaptureJson, AGENT_CARD_KINDS, agentCardKind } from '../lib/capture.js'
import { createApi, API_PREFIX } from '../lib/api.js'

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'me-skill-'))

function fakeRegistry(content = 'Use the alpha skill carefully.') {
  const summaries = [{ name: 'alpha', description: 'Alpha skill', source: 'user-dsh', provider: 'filesystem', path: '/skills/alpha/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } }]
  return {
    list: async () => summaries,
    get: async (name) => ({ ...summaries[0], name, content }),
  }
}

test('skill 卡强制待审且落在 10-Skills 目录（auditMode=none 也不能免审）', async () => {
  const root = makeRoot()
  setAuditConfig(root, { auditMode: 'none', auditExemptAgents: ['__all__'], auditExemptKinds: ['__all__'] })
  const r = await writeCard(root, { kind: 'skill', title: 'alpha', body: '技能正文：这是一段足够长的技能说明。', source: 'skill:alpha', submittedBy: 'skill-sync' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.status, 'pending', '技能卡必须强制待审')
  assert.equal(r.store, 'quarantine')
  assert.match(r.path, /^10-Skills\//, '技能卡目录应为 10-Skills: ' + r.path)
})

test('agent 自动沉淀不能产出 skill：模型输出 kind=skill 会被收敛成 knowledge', () => {
  assert.ok(!AGENT_CARD_KINDS.includes('skill'), 'AGENT_CARD_KINDS 不能包含 skill')
  assert.equal(agentCardKind('skill'), 'knowledge')
  const card = parseCaptureJson(JSON.stringify({
    save: true,
    title: '技能沉淀测试',
    kind: 'skill',
    tags: ['x'],
    body: '这是一段足够长的正文，用来验证 agent 不能把内容写成技能卡。',
  }))
  assert.ok(card, '解析应成功')
  assert.equal(card.kind, 'knowledge', 'skill 必须被改写为 knowledge')
})

test('从技能注册表生成待审技能卡；再次同步幂等不重复', async () => {
  const root = makeRoot()
  const first = await syncSkillCards(root, { skills: fakeRegistry(), includeFilesystem: false })
  assert.equal(first.ok, true)
  assert.equal(first.source, 'registry')
  assert.equal(first.total, 1)
  assert.equal(first.created, 1)

  let cards = await listCards(root, { status: ['pending'], kind: 'skill' })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].title, 'alpha')
  assert.equal(cards[0].status, 'pending')
  assert.match(cards[0].path, /^10-Skills\/alpha\.md$/)

  const second = await syncSkillCards(root, { skills: fakeRegistry(), includeFilesystem: false })
  assert.equal(second.created, 0)
  assert.equal(second.unchanged, 1)
  cards = await listCards(root, { status: ['pending'], kind: 'skill' })
  assert.equal(cards.length, 1, '重复同步不能新增待审卡')
})

test('技能正文变化：待审卡原地刷新，不新增第二张', async () => {
  const root = makeRoot()
  await syncSkillCards(root, { skills: fakeRegistry('第一版技能正文。'), includeFilesystem: false })
  const second = await syncSkillCards(root, { skills: fakeRegistry('第二版技能正文，内容已经更新。'), includeFilesystem: false })
  assert.equal(second.updated, 1, JSON.stringify(second))
  assert.equal(second.created, 0)
  const cards = await listCards(root, { status: ['pending'], kind: 'skill' })
  assert.equal(cards.length, 1)
  const text = JSON.stringify(cards[0])
  assert.match(text, /第二版技能正文/)
})

test('已批准技能内容变化：新开一张「技能更新」待审卡，旧卡保持可用', async () => {
  const root = makeRoot()
  await syncSkillCards(root, { skills: fakeRegistry('第一版技能正文。'), includeFilesystem: false })
  const [base] = await listCards(root, { status: ['pending'], kind: 'skill' })
  await setCardStatus(root, base.path, 'approved')

  const second = await syncSkillCards(root, { skills: fakeRegistry('第二版技能正文，内容已经更新。'), includeFilesystem: false })
  assert.equal(second.pendingUpdates, 1, JSON.stringify(second))
  const pending = await listCards(root, { status: ['pending'], kind: 'skill' })
  assert.equal(pending.length, 1)
  assert.match(pending[0].title, /技能更新/)
  const approved = await listCards(root, { status: ['approved'], kind: 'skill' })
  assert.equal(approved.length, 1, '旧卡必须继续可用')
  assert.equal(approved[0].path, base.path)
})

test('已驳回的技能不会被同步复活', async () => {
  const root = makeRoot()
  await syncSkillCards(root, { skills: fakeRegistry(), includeFilesystem: false })
  const [base] = await listCards(root, { status: ['pending'], kind: 'skill' })
  await setCardStatus(root, base.path, 'rejected')
  const second = await syncSkillCards(root, { skills: fakeRegistry(), includeFilesystem: false })
  assert.equal(second.created, 0)
  assert.equal(second.skipped, 1, JSON.stringify(second))
  const pending = await listCards(root, { status: ['pending'], kind: 'skill' })
  assert.equal(pending.length, 0)
})

test('注册表与磁盘技能合并：不会因为全局层只有少数技能就漏掉用户/项目技能', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-skill-merge-home-'))
  const skillDir = path.join(home, '.agents', 'skills', 'disk-only')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: disk-only\ndescription: Disk only skill\n---\n\n# Disk only\n\nBody.\n', 'utf8')
  const root = makeRoot()
  const noHome = path.join(home, 'no-such-home')
  const env = {
    ...process.env,
    DSH_HOME: path.join(home, '.dsh'),
    DSH_AGENTS_HOME: path.join(home, '.agents'),
    CLAUDE_CONFIG_DIR: path.join(noHome, '.claude'),
    CODEX_HOME: path.join(noHome, '.codex'),
    CURSOR_HOME: path.join(noHome, '.cursor'),
    GEMINI_HOME: path.join(noHome, '.gemini'),
    XDG_CONFIG_HOME: path.join(noHome, '.config'),
    MEMORY_SKILL_DIRS: '',
    DSH_BUNDLED_SKILL_DIR: '',
  }
  const out = await syncSkillCards(root, { skills: fakeRegistry(), env, cwd: home, packageRoot: '' })
  assert.equal(out.source, 'registry+filesystem')
  assert.equal(out.total, 2, JSON.stringify(out))
  const cards = await listCards(root, { status: ['pending'], kind: 'skill' })
  assert.deepEqual(cards.map((c) => c.title).sort(), ['alpha', 'disk-only'])
})

test('没有宿主技能服务时走文件系统兜底（DSH_HOME/skills）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-skill-home-'))
  const skillDir = path.join(home, 'skills', 'beta')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: beta\ndescription: Beta skill from disk\n---\n\n# Beta\n\nDisk skill body.\n', 'utf8')
  const root = makeRoot()
  // 隔离所有 agent 家目录：否则会扫到开发机真实的 ~/.agents / ~/.claude / ~/.codex 技能。
  const noHome = path.join(home, 'no-such-home')
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_AGENTS_HOME: path.join(noHome, '.agents'),
    CLAUDE_CONFIG_DIR: path.join(noHome, '.claude'),
    CODEX_HOME: path.join(noHome, '.codex'),
    CURSOR_HOME: path.join(noHome, '.cursor'),
    GEMINI_HOME: path.join(noHome, '.gemini'),
    XDG_CONFIG_HOME: path.join(noHome, '.config'),
    MEMORY_SKILL_DIRS: '',
    DSH_BUNDLED_SKILL_DIR: '',
  }
  const out = await syncSkillCards(root, { env, cwd: home, packageRoot: '' })
  assert.equal(out.source, 'filesystem')
  assert.equal(out.created, 1, JSON.stringify(out))
  const cards = await listCards(root, { status: ['pending'], kind: 'skill' })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].title, 'beta')
})

test('文件扫描覆盖 Codex / Claude / Cursor / DSH / .agents 的项目级与用户级目录', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-skill-roots-home-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'me-skill-roots-proj-'))
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  const skill = (root, name) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + name + ' desc\n---\n\n# ' + name + '\n\nbody\n', 'utf8')
  }
  skill(path.join(home, '.dsh', 'skills'), 'from-dsh')
  skill(path.join(home, '.agents', 'skills'), 'from-agents')
  skill(path.join(home, '.cursor', 'skills'), 'from-cursor')
  skill(path.join(home, '.claude', 'skills'), 'from-claude')
  skill(path.join(home, '.codex', 'skills'), 'from-codex')
  skill(path.join(home, '.codex', 'skills', '.system'), 'internal-system')
  skill(path.join(project, '.dsh', 'skills'), 'proj-dsh')
  skill(path.join(project, '.agents', 'skills'), 'proj-agents')
  skill(path.join(project, '.cursor', 'skills'), 'proj-cursor')
  skill(path.join(project, '.claude', 'skills'), 'proj-claude')
  skill(path.join(project, '.codex', 'skills'), 'proj-codex')
  // 子目录里运行也要能向上找到项目根
  const sub = path.join(project, 'packages', 'app')
  fs.mkdirSync(sub, { recursive: true })
  const env = {
    ...process.env,
    DSH_HOME: path.join(home, '.dsh'),
    DSH_AGENTS_HOME: path.join(home, '.agents'),
    CURSOR_HOME: path.join(home, '.cursor'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    GEMINI_HOME: path.join(home, '.gemini'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    MEMORY_SKILL_DIRS: '',
    DSH_BUNDLED_SKILL_DIR: '',
  }
  const found = collectSkillFiles({ env, cwd: sub, packageRoot: '' })
  const names = new Set(found.map((s) => s.name))
  for (const n of ['from-dsh', 'from-agents', 'from-cursor', 'from-claude', 'from-codex', 'proj-dsh', 'proj-agents', 'proj-cursor', 'proj-claude', 'proj-codex']) {
    assert.ok(names.has(n), '缺少技能 ' + n + '，实际：' + [...names].join(','))
  }
  assert.ok(!names.has('internal-system'), '内部 .system 技能不应被当作用户技能')
})

test('SKILL.md frontmatter 解析：多行 description 与 whenToUse', () => {
  const p = parseSkillFile('---\nname: gamma\ndescription: >\n  line one\n  line two\nwhenToUse: whenever\n---\n\nbody', 'fallback')
  assert.equal(p.name, 'gamma')
  assert.match(p.description, /line one line two/)
  assert.equal(p.whenToUse, 'whenever')
  const built = buildSkillCardBody({ name: 'gamma', description: p.description, content: p.content })
  assert.match(built.body, /## 技能说明/)
  assert.match(built.body, /whenever|line one/)
})

test('UI：技能类型在筛选 / 新建卡 / 统计 / 图谱里都有入口', () => {
  const src = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(src, /const KIND_IDS = \[[^\]]*'skill'[^\]]*\]/, '类型筛选必须包含 skill')
  assert.match(src, /const FORM_KINDS = KIND_IDS\.filter/, '新建卡/统计应复用一个类型列表')
  assert.match(src, /skill: 'kindSkill'/, 'KIND_LABELS 必须包含 skill')
  assert.match(src, /skill: '#8B5CF6'/, 'KIND_COLORS 必须包含 skill')
  assert.match(src, /skill: '🧩'/, 'KIND_EMOJI 必须包含 skill')
  assert.match(src, /const kinds = FORM_KINDS/, '统计页类型分布必须包含 skill')
  assert.match(src, /\{FORM_KINDS\.map\(/, '新建卡类型下拉必须包含 skill')
  assert.match(src, /kindSkill: '技能'/, '中文词条必须包含「技能」')
  assert.match(src, /kindSkill: 'Skills'/, '英文词条必须包含 Skills')
})

test('API：POST /skills/sync 调用注入的同步器并返回统计；GET 拒绝', async () => {
  const root = makeRoot()
  let called = 0
  const api = createApi({
    vaultDir: () => root,
    getSettings: () => ({}),
    syncSkills: async (opts) => {
      called++
      return { ok: true, source: 'registry', total: 2, created: 1, updated: 0, pendingUpdates: 1, unchanged: 0, skipped: 0, removed: 0, errors: [], force: !!opts.force }
    },
  })
  const call = async (method) => {
    const out = { status: 0, body: '' }
    const res = {
      req: { headers: {} },
      writeHead(s) { out.status = s },
      end(b) { out.body = String(b || '') },
      setHeader() {}, on() {}, once() {}, emit() {},
    }
    await api({ url: API_PREFIX + '/skills/sync?force=1', method, headers: {} }, res)
    return out
  }
  const post = await call('POST')
  assert.equal(post.status, 200, post.body)
  const body = JSON.parse(post.body)
  assert.equal(body.ok, true)
  assert.equal(body.created, 1)
  assert.equal(body.force, true, 'force 查询参数要透传')
  assert.equal(called, 1)
  const get = await call('GET')
  assert.equal(get.status, 405, '同步是写操作，GET 必须拒绝')
})

test('技能卡可在批准后重新归类（setCardKind 支持 skill）', async () => {
  const root = makeRoot()
  await syncSkillCards(root, { skills: fakeRegistry(), includeFilesystem: false })
  const [base] = await listCards(root, { status: ['pending'], kind: 'skill' })
  await setCardStatus(root, base.path, 'approved')
  await setCardKind(root, base.path, 'knowledge')
  const [card] = await listCards(root, { status: ['approved'], kind: 'knowledge' })
  assert.equal(card.path, base.path)
})
