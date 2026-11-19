// 发布通道守卫（2026-11-19 用户指令）：
//   · 测试版（alpha/beta/rc）只发 GitHub Pre-release，绝不 npm publish / Gitee；
//   · 正式版 / 补丁版必须经用户批准（release.mjs 需 --approved）；
//   · publish.yml 对测试版 tag 只跑 build+tests，不发布 npm。
// 这里守住三份入口，防止以后改回去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('publish.yml 是合法 YAML 开头，且测试版 tag 不发布 npm', () => {
  const wf = read('.github/workflows/publish.yml')
  assert.ok(!/^>/.test(wf), '第一行不能是 Markdown 引用块 —— 那会让整个 workflow 变成非法 YAML（v0.49.22 实测）')
  assert.match(wf, /^name: /m, 'workflow 必须有 name 键')
  assert.match(wf, /prerelease=true/, '要按 package.json 版本识别测试版')
  assert.match(wf, /steps\.channel\.outputs\.prerelease != 'true'/, 'npm 发布步骤必须带通道守卫')
  assert.match(wf, /steps\.npmcheck\.outputs\.exists != 'true'/, '已发布版本要幂等跳过（release.mjs 先发 npm 再推 tag）')
  assert.match(wf, /Detect release channel/, '要有通道识别步骤')
  assert.match(wf, /startsWith\(github\.ref, 'refs\/tags\/'\)/, 'tag 校验只在 tag 事件上跑（手动 dispatch 的 ref 是分支）')
})

test('正式版发布脚本：必须 --approved，且拒绝测试版版本', () => {
  const src = read('scripts/release.mjs')
  assert.match(src, /flag\('approved'\)/, '要读取 --approved')
  assert.match(src, /正式版发布必须经用户批准/, '未批准要给出明确报错')
  assert.match(src, /测试版只发 GitHub Pre-release/, '测试版要指向 release-test.mjs')
  assert.match(src, /if \(\/-\/\.test\(String\(pkg\.version\)\)\)/, '要拦截带预发布后缀的版本')
})

test('测试版脚本：只建 GitHub Pre-release，不碰 npm / Gitee', () => {
  const src = read('scripts/release-test.mjs')
  assert.match(src, /--prerelease/, '必须建 pre-release')
  assert.match(src, /gh release create/, '通过 gh 建 Release')
  assert.doesNotMatch(src, /run\('npm', \['publish'/, '测试版不得 npm publish')
  assert.doesNotMatch(src, /gitee\.com\/api/, '测试版不得调 Gitee Release API')
  assert.match(src, /-alpha|alpha\|beta\|rc/i, '要识别 alpha/beta/rc 通道')
})

test('package.json 暴露测试版/批准发布入口', () => {
  assert.equal(pkg.scripts['release:test'], 'node scripts/release-test.mjs')
  assert.equal(pkg.scripts['release:approved'], 'node scripts/release.mjs --approved')
  assert.equal(pkg.scripts.release, 'node scripts/release.mjs', 'release 仍走同一脚本（内部再拦未批准）')
})
