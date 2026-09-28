// dm#5 回归：独立进程（CLI / MCP / hooks / web / sweep）解析 vault 的优先级
// 必须与宿主 index.js 的 vaultDir() 一致，否则切库后数据分裂。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultVaultDir, configFilePath } from '../lib/capture-run.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'me-vaultpath-'))
const env = { DSH_HOME: tmp }
after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })
const writeCfg = (obj) => fs.writeFile(configFilePath(env), JSON.stringify(obj), 'utf8')

test('MEMORY_VAULT_DIR 优先级最高（可覆盖一切）', () => {
  assert.equal(defaultVaultDir({ DSH_HOME: tmp, MEMORY_VAULT_DIR: path.join(tmp, 'env-vault') }), path.resolve(path.join(tmp, 'env-vault')))
})

test('没有任何配置 → 回落 $DSH_HOME/memory-vault', async () => {
  await fs.rm(configFilePath(env), { force: true })
  assert.equal(defaultVaultDir(env), path.join(tmp, 'memory-vault'))
})

test('activeVault 命中 vaultProfiles → 用 profile 路径', async () => {
  await writeCfg({ vaultProfiles: [{ name: 'work', path: path.join(tmp, 'vault-work') }], activeVault: 'work', vaultDir: path.join(tmp, 'vault-plain') })
  assert.equal(defaultVaultDir(env), path.join(tmp, 'vault-work'))
})

test('未命中 activeVault → 用 vaultDir', async () => {
  await writeCfg({ vaultProfiles: [], activeVault: '', vaultDir: path.join(tmp, 'vault-plain') })
  assert.equal(defaultVaultDir(env), path.join(tmp, 'vault-plain'))
})

test('activeVault 指向不存在的 profile → 回落 vaultDir（不是默认库）', async () => {
  await writeCfg({ vaultProfiles: [{ name: 'work', path: path.join(tmp, 'vault-work') }], activeVault: 'nope', vaultDir: path.join(tmp, 'vault-plain') })
  assert.equal(defaultVaultDir(env), path.join(tmp, 'vault-plain'))
})

test('配置文件损坏 → 安全回落默认库', async () => {
  await fs.writeFile(configFilePath(env), '{ 坏掉的 json', 'utf8')
  assert.equal(defaultVaultDir(env), path.join(tmp, 'memory-vault'))
})
