// MCP 分发清单守卫（server.json / smithery.yaml）
//
// 为什么要有：这两个文件是"给别的生态看的门面"，版本落后或命令写错，
// 用户装到的就是跑不起来的服务。所以把契约钉在测试里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('server.json 存在且版本与 package.json 一致', () => {
  assert.ok(existsSync(path.join(root, 'server.json')), '缺少 server.json')
  const s = JSON.parse(read('server.json'))
  assert.equal(s.version, pkg.version, 'server.json version 落后于 package.json')
  assert.equal(s.packages[0].version, pkg.version, 'packages[0].version 落后')
})

test('server.json 命名空间/包名/传输方式正确', () => {
  const s = JSON.parse(read('server.json'))
  assert.equal(s.name, 'io.github.EternalNight996/memory-eternal')
  assert.equal(s.packages[0].registryType, 'npm')
  assert.equal(s.packages[0].identifier, pkg.name, 'identifier 必须是 npm 包名')
  assert.equal(s.packages[0].transport.type, 'stdio')
})

test('server.json 带上 mcp 子命令（否则装完只会打印帮助）', () => {
  const s = JSON.parse(read('server.json'))
  const args = s.packages[0].packageArguments || []
  assert.ok(args.some((a) => a.type === 'positional' && a.value === 'mcp'), JSON.stringify(args))
})

test('smithery.yaml 指向 npx + dsh-memory mcp', () => {
  assert.ok(existsSync(path.join(root, 'smithery.yaml')), '缺少 smithery.yaml')
  const y = read('smithery.yaml')
  assert.match(y, /npx/)
  assert.match(y, /memory-eternal/)
  assert.match(y, /dsh-memory/)
  assert.match(y, /mcp/)
})

test('分发材料齐全：llms-install.md / Dockerfile / 400px logo', () => {
  for (const f of ['llms-install.md', 'Dockerfile', 'assets/icon-400.png']) {
    assert.ok(existsSync(path.join(root, f)), '缺少分发材料：' + f)
  }
})
