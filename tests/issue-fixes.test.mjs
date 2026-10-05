// issue #15 / #17 / #18 回归：会话工作区路由、蒸馏失败归因、审核 CLI + MCP 只读边界。
//
// 这些点都在「宿主装配层」（index.js / bin / mcp），所以单独一个文件真跑一遍：
//   #15  sessionWorkspaceOf：宿主侧 match.workspace 必须拿到**会话目录**，不是进程 cwd
//   #18  describeDistillFailure：主因（第一个候选）不得被兜底候选的错误覆盖
//   #17  dsh-memory audit list/approve/reject 真的能跑，且 MCP 侧只读（没有 approve/reject 工具）
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'me-issuefix-'))
process.env.DSH_HOME = tmpHome

const { sessionWorkspaceOf, describeDistillFailure } = await import('../index.js')
const { writeCard, listCards, ensureVault } = await import('../lib/vault.js')
const { closeDb } = await import('../lib/db.js')
const { MCP_TOOLS } = await import('../lib/mcp.js')

after(async () => {
  try { closeDb(vaultRoot) } catch { /* 已关闭 */ }
  await fs.rm(tmpHome, { recursive: true, force: true })
})

const vaultRoot = path.join(tmpHome, 'vault')

test('#15：sessionWorkspaceOf 取会话自己的 cwd，MEMORY_WORKSPACE 仍可显式覆盖', () => {
  const agent = { session: { id: 's1', header: { cwd: 'E:\\proj\\alpha' } } }
  assert.equal(sessionWorkspaceOf(agent, {}), 'E:\\proj\\alpha', '宿主必须能拿到会话工作区')
  assert.equal(sessionWorkspaceOf(agent, { MEMORY_WORKSPACE: '/explicit' }), '/explicit', '显式覆盖优先')
  assert.equal(sessionWorkspaceOf({ session: { header: {} } }, {}), undefined, '没有 cwd → undefined（回落进程 cwd）')
  assert.equal(sessionWorkspaceOf(null, {}), undefined)
  assert.equal(sessionWorkspaceOf({ session: { header: { cwd: '   ' } } }, {}), undefined, '空白 cwd 不算')
})

test('#18：主因 = 第一个候选的失败，兜底候选只做汇总（不再覆盖）', () => {
  const primary = { code: 'UNPARSEABLE_OUTPUT', message: '模型输出无法解析（疑似输出被截断）', provider: 'deepseek-official' }
  assert.equal(describeDistillFailure(primary, [primary]), 'UNPARSEABLE_OUTPUT 模型输出无法解析（疑似输出被截断）')
  const all = [
    primary,
    { code: 'UNSUPPORTED_REASONING_EFFORT', provider: 'yundou' },
    { code: 'UNSUPPORTED_REASONING_EFFORT', provider: 'tokenha-gpt' },
    { code: 'UNSUPPORTED_REASONING_EFFORT', provider: 'tokenha-claude' },
  ]
  const why = describeDistillFailure(primary, all)
  assert.match(why, /^UNPARSEABLE_OUTPUT/, '第一候选的主因必须在最前面')
  assert.match(why, /另有 3 个兜底候选失败：UNSUPPORTED_REASONING_EFFORT×3/)
  assert.equal(describeDistillFailure(primary, []), 'UNPARSEABLE_OUTPUT 模型输出无法解析（疑似输出被截断）')
})

/** 用子进程跑 CLI，返回 { code, stdout, stderr }。 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'dsh-memory.mjs'), ...args], {
      env: { ...process.env, DSH_HOME: tmpHome, MEMORY_VAULT_DIR: vaultRoot },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }))
  })
}

test('#17：CLI audit list / approve / reject 真能跑，且写的是同一份 audit_log', async () => {
  await ensureVault(vaultRoot)
  const a = await writeCard(vaultRoot, {
    kind: 'knowledge', title: 'CLI 待审甲', tags: ['cli'], status: 'pending', submittedBy: 'test',
    body: '这张卡用于验证 CLI 批量审批路径，正文需要足够长以便通过写入校验，内容本身无意义。',
  }, { dedup: false })
  const b = await writeCard(vaultRoot, {
    kind: 'knowledge', title: 'CLI 待审乙', tags: ['cli'], status: 'pending', submittedBy: 'test',
    body: '第二张待审卡，用于验证 reject 分支与 --reason 会被记进 audit_log，同样要求足够长的正文。',
  }, { dedup: false })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)

  const listed = await runCli(['audit', 'list', '--status', 'pending', '--json'])
  assert.equal(listed.code, 0, listed.stderr)
  const parsed = JSON.parse(listed.stdout)
  const paths = parsed.cards.map((c) => c.path)
  assert.ok(paths.includes(a.path) && paths.includes(b.path), '两张待审卡都要被列出来')

  const approved = await runCli(['audit', 'approve', a.path])
  assert.equal(approved.code, 0, approved.stderr)
  assert.match(approved.stdout, /✓ approved/)

  const rejected = await runCli(['audit', 'reject', b.path, '--reason', 'CLI 测试驳回'])
  assert.equal(rejected.code, 0, rejected.stderr)

  const main = await listCards(vaultRoot, { status: ['approved'] })
  assert.ok(main.some((c) => c.path === a.path), '批准的卡应进主库（可被召回）')
  const quarantined = await listCards(vaultRoot, { status: ['rejected'] })
  assert.ok(quarantined.some((c) => c.path === b.path), '驳回的卡应留在隔离区')

  // 不存在的路径 → 非 0 退出码，不能静默「成功」
  const bad = await runCli(['audit', 'approve', 'knowledge/不存在.md'])
  assert.equal(bad.code, 1)
})

test('#17：MCP 侧只读 —— 有 memory_audit_list，没有任何 approve/reject 工具', () => {
  const names = MCP_TOOLS.map((t) => t.name)
  assert.ok(names.includes('memory_audit_list'), '要能给智能体一个「有 N 张待审」的只读入口')
  assert.ok(names.includes('memory_recall'))
  for (const n of names) {
    assert.doesNotMatch(n, /approve|reject|audit_write|audit_set/i, `MCP 不得暴露审核写入：${n}`)
  }
})
