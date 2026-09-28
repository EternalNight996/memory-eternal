// #10 回归：vault 解析优先级 + match.workspace（按项目选库）。
// 宿主与 CLI/MCP/hooks/独立 web/sweep 共用 lib/vault-resolve.js —— 逻辑只能有一份，
// 否则切库后独立进程仍写默认库，记忆被劈成两份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveVaultDir, matchWorkspaceProfile, defaultVaultRoot } from '../lib/vault-resolve.js'

const P = (s) => path.resolve(s)

test('优先级：MEMORY_VAULT_DIR 覆盖一切', () => {
  const out = resolveVaultDir({
    env: { MEMORY_VAULT_DIR: P('/tmp/env-vault') },
    profiles: [{ name: 'work', path: P('/tmp/work') }],
    activeVault: 'work',
    configured: P('/tmp/plain'),
  })
  assert.equal(out.source, 'env')
  assert.equal(out.root, P('/tmp/env-vault'))
})

test('activeVault 命中 profile 优先于 workspace 规则', () => {
  const out = resolveVaultDir({
    env: {},
    profiles: [
      { name: 'work', path: P('/tmp/work'), match: { workspace: P('/codes/work') } },
      { name: 'other', path: P('/tmp/other'), match: { workspace: P('/codes/other') } },
    ],
    activeVault: 'other',
    workspace: P('/codes/work'),
  })
  assert.equal(out.source, 'profile')
  assert.equal(out.name, 'other')
  assert.equal(out.root, P('/tmp/other'))
})

test('未配 activeVault（或未命中）→ 按当前 workspace 自动选库', () => {
  const profiles = [
    { name: 'llstack', path: P('/vaults/llstack'), match: { workspace: P('/codes/llstack') } },
    { name: 'nurse', path: P('/vaults/nurse'), match: { workspace: P('/codes/chs/inpnurse') } },
  ]
  const a = resolveVaultDir({ env: {}, profiles, activeVault: '', workspace: P('/codes/llstack') })
  assert.equal(a.source, 'workspace')
  assert.equal(a.name, 'llstack')
  assert.equal(a.root, P('/vaults/llstack'))
  // 子目录也应命中父规则
  const b = resolveVaultDir({ env: {}, profiles, activeVault: '', workspace: P('/codes/llstack/src/deep') })
  assert.equal(b.name, 'llstack')
  // 未命中任何规则 → 回落
  const c = resolveVaultDir({ env: {}, profiles, activeVault: '', configured: P('/vaults/main'), workspace: P('/codes/unknown') })
  assert.equal(c.source, 'vaultDir')
  assert.equal(c.root, P('/vaults/main'))
})

test('多条规则命中时取最长前缀', () => {
  const profiles = [
    { name: 'root', path: P('/v/root'), match: { workspace: P('/codes') } },
    { name: 'deep', path: P('/v/deep'), match: { workspace: P('/codes/chs/inpnurse') } },
  ]
  assert.equal(matchWorkspaceProfile(profiles, P('/codes/chs/inpnurse/ui')).name, 'deep')
  assert.equal(matchWorkspaceProfile(profiles, P('/codes/other')).name, 'root')
})

test('大小写与尾斜杠归一（Windows 路径）', () => {
  const profiles = [{ name: 'win', path: P('/v/win'), match: { workspace: 'D:\\Codes\\LLStack\\' } }]
  assert.equal(matchWorkspaceProfile(profiles, 'd:/codes/llstack').name, 'win')
})

test('缺失配置一律回落默认库，且不抛错', () => {
  assert.equal(resolveVaultDir({ env: {} }).root, defaultVaultRoot({}))
  assert.equal(resolveVaultDir({ env: {}, profiles: null, activeVault: null, configured: null }).source, 'default')
  assert.equal(matchWorkspaceProfile(null, '/x'), null)
  assert.equal(matchWorkspaceProfile([{ name: 'a', path: '/p' }], ''), null)
})

test('match.workspace 未配置 path 的规则不参与匹配', () => {
  const profiles = [{ name: 'broken', match: { workspace: '/codes/x' } }]
  assert.equal(matchWorkspaceProfile(profiles, '/codes/x'), null)
  assert.equal(resolveVaultDir({ env: {}, profiles, workspace: '/codes/x' }).source, 'default')
})
