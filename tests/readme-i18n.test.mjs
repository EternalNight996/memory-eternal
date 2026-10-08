// README 双语守卫：中英两份**独立文件**必须同时存在、互相可跳转、结构一一对应。
//
// 为什么要有这条：README.md（简体中文，默认）与 README.en.md（English）是两个文件，靠人自觉同步，
// 最容易出的问题就是「只改一份」——中文加了新章节、英文还停在上一版，或者反过来把默认语言改掉。
// 这里只锁**结构**（标题层级序列 + 代码块数量 + 互链 + 默认语言标记），不锁具体文案：
// 翻译措辞怎么改都行，但两边章节必须对得上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const zh = read('README.md')
const en = read('README.en.md')
const pkg = JSON.parse(read('package.json'))

/** 先剥掉围栏代码块：bash 示例里的 `# 注释` 长得像标题，会把结构对比带偏。 */
const stripFences = (text) => text.replace(/\r\n/g, '\n').replace(/```[\s\S]*?```/g, '')
/** 标题层级序列，例如 [1,2,3,2,3,...]。 */
const headingLevels = (text) => stripFences(text)
  .split('\n')
  .map((line) => /^(#{1,6})\s/.exec(line))
  .filter(Boolean)
  .map((m) => m[1].length)
/** 围栏数量（成对出现 = 代码块数量 × 2）。 */
const fenceCount = (text) => (text.replace(/\r\n/g, '\n').match(/^```/gm) || []).length

test('两份 README 都在随包白名单里（少一份用户就看不到）', () => {
  assert.ok(pkg.files.includes('README.md'), 'README.md 必须在 package.json files 里')
  assert.ok(pkg.files.includes('README.en.md'), 'README.en.md 必须在 package.json files 里')
})

test('默认语言是中文：两份都标了「简体中文（默认）」，且互相能跳转', () => {
  assert.match(zh.split('\n')[0], /^# 🧠 memory-eternal/, '中文 README 第一行应是本插件标题')
  assert.match(en.split('\n')[0], /^# 🧠 memory-eternal/, '英文 README 第一行应是本插件标题')
  assert.ok(zh.includes('简体中文（默认）'), '中文那份要标明自己是默认')
  assert.ok(en.includes('简体中文（默认）'), '英文那份要指向默认的中文版')
  assert.ok(zh.includes('(README.en.md)'), '中文 README 要有英文版入口（顶部切换 + 底部）')
  assert.ok(en.includes('(README.md)'), '英文 README 要有中文版入口（顶部切换 + 底部）')
})

test('结构一一对应：标题层级序列与代码块数量必须一致', () => {
  const zhLevels = headingLevels(zh)
  const enLevels = headingLevels(en)
  assert.ok(zhLevels.length >= 25, `中文 README 标题只有 ${zhLevels.length} 个，解析可能失效`)
  assert.deepEqual(zhLevels, enLevels, '标题层级序列必须一致：新增/删除一节要两边同时改')
  assert.equal(fenceCount(zh) % 2, 0, '中文 README 的 ``` 围栏不成对')
  assert.equal(fenceCount(en) % 2, 0, '英文 README 的 ``` 围栏不成对')
  assert.equal(fenceCount(zh), fenceCount(en), '两份 README 的代码块数量必须一致')
})

test('两份都提醒「改一处要同步另一处」（给贡献者的话）', () => {
  assert.ok(zh.includes('README.en.md') && /同步/.test(zh), '中文 README 要写明中英同步要求')
  assert.ok(en.includes('README.md') && /mirror|Mirror/.test(en), '英文 README 要写明它是镜像/需同步')
})
