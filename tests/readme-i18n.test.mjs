// README 双语守卫（v0.17 起：英文默认、中文镜像；完整手册/更新日志已移到 docs/）
//
// 目的：README 是「30 秒落地页」，结构必须精简且中英一一对应；
// 完整内容在 docs/GUIDE*.md，更新日志在 docs/CHANGELOG.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const en = read('README.md')
const zh = read('README.zh-CN.md')
const pkg = JSON.parse(read('package.json'))

const stripFences = (text) => text.replace(/\r\n/g, '\n').replace(/```[\s\S]*?```/g, '')
const headingLevels = (text) => stripFences(text)
  .split('\n')
  .map((line) => /^(#{1,6})\s/.exec(line))
  .filter(Boolean)
  .map((m) => m[1].length)
const fenceCount = (text) => (text.replace(/\r\n/g, '\n').match(/^```/gm) || []).length

test('两份 README 都在随包白名单里（少一份用户就看不到）', () => {
  assert.ok(pkg.files.includes('README.md'), 'README.md 必须在 package.json files 里')
  assert.ok(pkg.files.includes('README.zh-CN.md'), 'README.zh-CN.md 必须在 package.json files 里')
})

test('默认英文：两份都标明默认语言，且互相能跳转', () => {
  assert.match(en.split('\n')[0], /^# 🧠 memory-eternal/, '英文 README 第一行应是本插件标题')
  assert.match(zh.split('\n')[0], /^# 🧠 memory-eternal/, '中文 README 第一行应是本插件标题')
  assert.ok(en.includes('English (default)'), '英文那份要标明自己是默认')
  assert.ok(zh.includes('(README.md)'), '中文那份要指向默认英文版')
  assert.ok(en.includes('(README.zh-CN.md)'), '英文那份要有中文镜像入口')
  assert.ok(zh.includes('简体中文'), '中文镜像要标明语言')
})

test('结构一一对应：标题层级序列与代码块数量必须一致', () => {
  const a = headingLevels(en)
  const b = headingLevels(zh)
  assert.ok(a.length >= 8, '英文 README 标题只有 ' + a.length + ' 个，落地页结构可能坏了')
  assert.deepEqual(a, b, '标题层级序列必须一致：新增/删除一节要两边同时改')
  assert.equal(fenceCount(en) % 2, 0, '英文 README 的围栏不成对')
  assert.equal(fenceCount(zh) % 2, 0, '中文 README 的围栏不成对')
  assert.equal(fenceCount(en), fenceCount(zh), '两份 README 的代码块数量必须一致')
})

test('落地页链到完整手册 / 私有化部署 / 更新日志，且文件真实存在', () => {
  for (const f of ['docs/GUIDE.md', 'docs/GUIDE.zh-CN.md', 'docs/DEPLOY.md', 'docs/CHANGELOG.md']) {
    assert.ok(existsSync(path.join(root, f)), '链接目标不存在：' + f)
    assert.ok(en.includes(f) || zh.includes(f), 'README 里缺少 ' + f + ' 的链接')
  }
})

test('CHANGELOG 含当前版本行（发版脚本从这里取发布说明）', () => {
  const log = read('docs/CHANGELOG.md')
  assert.ok(log.includes('| **v' + pkg.version + '**'), 'docs/CHANGELOG.md 缺少 v' + pkg.version + ' 行')
})

test('README 引用的仓库内截图都真实存在（避免英文版截图漏提交）', () => {
  const files = new Set()
  for (const text of [en, zh]) {
    for (const m of text.matchAll(/assets\/screen\/([A-Za-z0-9._-]+\.png)/g)) files.add(m[1])
  }
  assert.ok(files.size >= 4, 'README 里应当引用截图')
  for (const f of files) {
    assert.ok(existsSync(path.join(root, 'assets/screen', f)), '截图不存在：assets/screen/' + f)
  }
})
