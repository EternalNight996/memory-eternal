// 云端服务端契约：服务端**不含客户端代码**，只做「连接协商 + 客户端清单」。
// 守四件事：
//   ① /cloud/connect 必须带 apiBase / vault / limits / features / client 清单；
//   ② 没有令牌 → 401；
//   ③ 未配置客户端渠道时 manifest 给明确原因（不是空 200）；
//   ④ 服务端不得引用客户端 UI 代码（src/client 或 web/）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync('lib/cloud-server.js', 'utf8')

test('/cloud/connect 返回完整连接信息（连接协商，不是下发代码）', () => {
  for (const field of ['apiBase', 'vault', 'limits', 'features', 'client']) {
    assert.ok(new RegExp(field + ':').test(src), `connect 响应缺少 ${field}`)
  }
  assert.match(src, /connect:\s*\{/, '要有 connect 对象')
})

test('connect 需要令牌（无令牌 401，不泄露任何租户信息）', () => {
  const i = src.indexOf("sub === '/cloud/connect'")
  const block = src.slice(i, i + 900)
  assert.match(block, /resolveTenant/, '必须解析令牌')
  assert.match(block, /401/, '无令牌要 401')
})

test('客户端清单：未配置渠道时给明确原因，不返回空 200', () => {
  assert.match(src, /MEMORY_CLIENT_URL/, '支持外部下载地址')
  assert.match(src, /MEMORY_CLIENT_PKG/, '支持临时自托管')
  assert.match(src, /未配置客户端下载地址/, '未配置要有可读原因')
})

test('服务端不引用客户端 UI 代码（剥离干净）', () => {
  assert.doesNotMatch(src, /from '\.\.\/src\/client/, '不允许 import 客户端源码')
  assert.doesNotMatch(src, /web\/app\.js|web\/index\.html/, '不允许引用客户端静态资源')
  // 云端只依赖 api.js（数据层出口）与 cloud-auth.js（鉴权）
  const deps = [...src.matchAll(/from '\.\/([\w.-]+\.js)'/g)].map((m) => m[1])
  assert.deepEqual(deps.sort(), ['api.js', 'cloud-auth.js', 'entitlement.js', 'license.js'], '云端模块只应依赖 api.js / cloud-auth.js / license.js / entitlement.js')
})

test('版本统一：没传 version 时读 package.json（客户端兼容判断要用）', () => {
  assert.match(src, /pkgVersion/, '要有 package.json 版本兜底')
  assert.match(src, /version: VERSION/, '响应里要用统一后的 VERSION')
  assert.doesNotMatch(src, /^\s*version,$/m, '不允许残留裸 version 字段')
})
