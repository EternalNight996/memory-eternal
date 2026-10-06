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
const { closeAllDb } = await import('../lib/db.js')
const { MCP_TOOLS, callTool } = await import('../lib/mcp.js')

after(async () => {
  // 本文件会打开多个库（vault / vault-count），必须全部关掉再删目录，
  // 否则 Windows 上删到还开着的 .db 会 EBUSY（SQLite 句柄未释放）。
  try { closeAllDb() } catch { /* 已关闭 */ }
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

/** 用子进程跑 CLI（指定 vault），返回 { code, stdout, stderr }。 */
function runCliIn(vault, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'dsh-memory.mjs'), ...args], {
      env: { ...process.env, DSH_HOME: tmpHome, MEMORY_VAULT_DIR: vault },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }))
  })
}

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

test('#20：audit list 的总数与 --limit 解耦，默认不静默截断', async () => {
  // 单独一个库：造 12 pending + 55 rejected（55 > 0.10.2 的默认 limit=50，才能覆盖静默截断）
  const bigRoot = path.join(tmpHome, 'vault-count')
  await ensureVault(bigRoot)
  const mk = async (status, n, tag) => {
    for (let i = 1; i <= n; i++) {
      const out = await writeCard(bigRoot, {
        kind: 'knowledge', title: `${tag}卡片 ${i}`, tags: ['count'], status, submittedBy: 'test',
        body: `# ${tag} ${i}\n\n这张卡用于验证 audit list 的计数语义（issue #20），正文需要足够长才能通过写入校验。`,
      }, { dedup: false })
      assert.equal(out.ok, true)
    }
  }
  await mk('pending', 12, '待审')
  await mk('rejected', 55, '驳回')

  const cli = (args) => runCliIn(bigRoot, args)

  // 1) 默认：55 张全列出，不再截断到 50
  const all = JSON.parse((await cli(['audit', 'list', '--status', 'rejected', '--json'])).stdout)
  assert.equal(all.total, 55, '总数必须是匹配总数')
  assert.equal(all.returned, 55, '默认不截断，应全部返回')
  assert.equal(all.count, 55, 'count 必须与 total 一致（0.10.2 里它等于截断后的条数）')
  assert.equal(all.hasMore, false)
  assert.equal(all.cards.length, 55)

  // 2) --limit 只限制显示条数，不改写总数
  const one = JSON.parse((await cli(['audit', 'list', '--status', 'rejected', '--limit', '1', '--json'])).stdout)
  assert.equal(one.total, 55, '--limit 不得改写总数')
  assert.equal(one.returned, 1)
  assert.equal(one.count, 55)
  assert.equal(one.limit, 1)
  assert.equal(one.hasMore, true)
  assert.equal(one.cards.length, 1)

  // 3) 文本输出：总数 + 「显示前 N 张」+ 剩余提示
  const limited = await cli(['audit', 'list', '--status', 'pending', '--limit', '5'])
  const lines = limited.stdout.trim().split('\n')
  assert.match(lines[0], /pending 共 12 张，显示前 5 张/, '首行要同时给出总数与显示条数')
  assert.match(lines[lines.length - 1], /还有 7 张未显示/, '要提示还剩多少张')
  const plain = await cli(['audit', 'list', '--status', 'pending'])
  assert.match(plain.stdout.trim().split('\n')[0], /pending 共 12 张（/, '不截断时不出现「显示前」')

  // 4) --limit 0 = 全部（显式取消上限）
  const zero = JSON.parse((await cli(['audit', 'list', '--status', 'rejected', '--limit', '0', '--json'])).stdout)
  assert.equal(zero.returned, 55)
  assert.equal(zero.limit, null)

  // 5) --status all = 审核队列（pending + rejected），不含 approved
  const allStatus = JSON.parse((await cli(['audit', 'list', '--status', 'all', '--json'])).stdout)
  assert.equal(allStatus.total, 67, 'all = 12 pending + 55 rejected')
  assert.equal(allStatus.hasMore, false)
})

test('#20：MCP memory_audit_list 同样报匹配总数，且写明还有多少张未显示', async () => {
  const mcpRoot = path.join(tmpHome, 'vault-mcp')
  await ensureVault(mcpRoot)
  for (let i = 1; i <= 25; i++) {
    const out = await writeCard(mcpRoot, {
      kind: 'knowledge', title: `MCP 待审 ${i}`, tags: ['mcp'], status: 'pending', submittedBy: 'test',
      body: `# MCP 待审 ${i}\n\n用于验证 MCP 工具的计数语义（issue #20），正文需要足够长才能通过写入校验。`,
    }, { dedup: false })
    assert.equal(out.ok, true)
  }
  const text = (res) => res.content[0].text

  const def = await callTool('memory_audit_list', {}, mcpRoot)
  assert.match(text(def), /待处理 25 张，显示前 20 张/, '总数必须是 25，而不是默认上限 20')
  assert.match(text(def), /还有 5 张未显示/)

  const all = await callTool('memory_audit_list', { limit: 500 }, mcpRoot)
  assert.match(text(all), /待处理 25 张（/, '全部列出时不出现「显示前」')
  assert.doesNotMatch(text(all), /还有 \d+ 张未显示/)

  const empty = await callTool('memory_audit_list', { status: 'rejected' }, mcpRoot)
  assert.match(text(empty), /没有 rejected 状态的卡片/)
})

test('#17：MCP 侧只读 —— 有 memory_audit_list，没有任何 approve/reject 工具', () => {
  const names = MCP_TOOLS.map((t) => t.name)
  assert.ok(names.includes('memory_audit_list'), '要能给智能体一个「有 N 张待审」的只读入口')
  assert.ok(names.includes('memory_recall'))
  for (const n of names) {
    assert.doesNotMatch(n, /approve|reject|audit_write|audit_set/i, `MCP 不得暴露审核写入：${n}`)
  }
})
