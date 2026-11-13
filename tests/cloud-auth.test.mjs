// 云端多租户鉴权：**每人一把密钥 → 每人一个独立 SQLite**。
// 守四件事：
//   ① 密钥只存哈希，明文只在签发时出现一次；
//   ② 吊销即时生效；
//   ③ 每个 owner 的 vault 目录互相隔离，且 owner 不能拼出路径穿越；
//   ④ MengBot 授权登录：未配置端点要明确报错，配置好后能换出令牌并解析回租户。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  issueKey, resolveTenant, listKeys, revokeKey, tenantVault, publicCloudConfig, verifyMengbotLogin, cloudRoot,
} from '../lib/cloud-auth.js'

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-cloud-'))
  const env = { ...process.env, DSH_HOME: home }
  return Promise.resolve(fn(env, home)).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

test('签发密钥：明文只出现一次，台账只有哈希', () => withHome((env, home) => {
  const { token, key } = issueKey({ owner: 'alice', note: 'laptop' }, env)
  assert.match(token, /^me_[\w-]{20,}$/, '明文形如 me_xxx')
  assert.equal(key.owner, 'alice')
  const store = JSON.parse(fs.readFileSync(path.join(home, 'cloud-keys.json'), 'utf8'))
  assert.equal(store.keys.length, 1)
  assert.doesNotMatch(JSON.stringify(store), new RegExp(token), '台账里不允许出现明文')
  assert.match(store.keys[0].hash, /^[0-9a-f]{64}$/, '存的是 sha256')
  // 列表接口也不返回哈希
  const listed = listKeys(env)
  assert.equal(listed.length, 1)
  assert.equal('hash' in listed[0], false)
}))

test('解析租户：正确密钥 → owner + 独立 vault 目录', () => withHome((env) => {
  const { token } = issueKey({ owner: 'alice' }, env)
  const r = resolveTenant('Bearer ' + token, env)
  assert.equal(r.ok, true)
  assert.equal(r.owner, 'alice')
  assert.equal(r.via, 'key')
  assert.ok(r.vaultRoot.endsWith(path.join('cloud-vaults', 'alice')), 'vault 落在 cloud-vaults/<owner>')
}))

test('没有令牌 / 密钥错误 / 已吊销 → 明确拒绝', () => withHome((env) => {
  assert.match(resolveTenant('', env).error, /Authorization/)
  assert.match(resolveTenant('Bearer me_bogus', env).error, /无效|吊销/)
  const { token, key } = issueKey({ owner: 'bob' }, env)
  assert.equal(resolveTenant('Bearer ' + token, env).ok, true)
  assert.equal(revokeKey(key.id, env).ok, true)
  assert.equal(resolveTenant('Bearer ' + token, env).ok, false)
}))

test('租户隔离：不同 owner 拿不到同一个目录，owner 里的路径穿越被打平', () => withHome((env) => {
  const a = tenantVault('alice', env)
  const b = tenantVault('bob', env)
  assert.notEqual(a, b)
  const evil = tenantVault('../../etc/passwd', env)
  // 判据用「是否仍在 cloudRoot 之下」比「有没有 ..」更准确：打平后名字里带 `..` 但路径没跳出去
  assert.ok(evil.startsWith(cloudRoot(env) + path.sep), '不允许跳出 cloud-vaults')
  assert.equal(path.dirname(evil), cloudRoot(env), '父目录必须还是 cloud-vaults')
}))
