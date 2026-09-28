// 卡片正文排版（src/client/markdown.js）单测：安全边界 + 新排版规则。
// 排版直接决定「像人写的还是像机器吐的」，规则回归必须有测试兜住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMd, renderInline, splitFrontmatter, parseTags } from '../src/client/markdown.js'

test('安全：正文里的 HTML/脚本一律转义，链接只放行 http(s)/相对/锚点', () => {
  const html = renderMd('<img src=x onerror=alert(1)>\n<script>alert(2)</script>')
  assert.ok(!html.includes('<img'), '不得原样输出 <img>')
  assert.ok(!html.includes('<script'), '不得原样输出 <script>')
  assert.ok(html.includes('&lt;img'), '应转义为实体')
  const bad = renderInline('[x](javascript:alert(1))')
  assert.ok(!bad.includes('javascript:'), 'javascript: 协议必须被拦掉')
  assert.ok(!bad.includes('href'), '被拦的链接不得生成 href，只留文字')
  const ok = renderInline('[文档](https://example.com/a?b=1)')
  assert.ok(ok.includes('href="https://example.com/a?b=1"'))
  assert.ok(ok.includes('rel="noopener noreferrer"'))
})

test('小标题：按语义自动配 emoji + 颜色分组', () => {
  const cases = [
    ['## 结论', '✅', 'md-c-ok'],
    ['## 风险与坑', '⚠️', 'md-c-warn'],
    ['### 根因定位', '🔍', 'md-c-info'],
    ['## 方案设计', '🛠️', 'md-c-plan'],
    ['## 示例', '💡', 'md-c-idea'],
    ['## 随便写写', '✨', 'md-c-info'],
  ]
  for (const [src, ico, tone] of cases) {
    const html = renderMd(src)
    assert.ok(html.includes('md-h'), src + ' 应是标题块')
    assert.ok(html.includes(ico), src + ' 应带 emoji ' + ico)
    assert.ok(html.includes(tone), src + ' 应用色组 ' + tone)
  }
})

test('列表：连续 - 行合成一个 <ul>，有序行合成 <ol>，任务行变复选框', () => {
  const ul = renderMd('- 甲\n- 乙\n- 丙')
  assert.equal((ul.match(/<ul class="md-ul">/g) || []).length, 1, '应只生成一个 ul')
  assert.equal((ul.match(/<li>/g) || []).length, 3)
  const ol = renderMd('1. 第一步\n2. 第二步')
  assert.ok(ol.includes('<ol class="md-ol">'))
  const tasks = renderMd('- [x] 已完成\n- [ ] 待办')
  assert.ok(tasks.includes('☑') && tasks.includes('☐'))
})

test('引用 → callout（按内容配 emoji）；--- → 分隔线；行首「键：值」→ 对齐样式', () => {
  const warn = renderMd('> 注意：不要这样做')
  assert.ok(warn.includes('md-callout') && warn.includes('md-c-warn') && warn.includes('⚠️'))
  assert.ok(renderMd('> 普通引用').includes('📌'))
  assert.ok(renderMd('---').includes('md-hr'))
  const kv = renderMd('- 端口：7999')
  assert.ok(kv.includes('md-k') && kv.includes('md-v') && kv.includes('7999'))
  assert.ok(renderMd('结论：可以这样做').includes('md-kv'), '短键应识别为 key/value')
  // 中文散文里的冒号不得被误判成 key/value（否则正常段落会变成表单字段）
  assert.ok(!renderMd('593 张卡时打开图谱会卡：边有 2.4 万条').includes('md-kv'), '含空格的散文行不得当 KV')
  assert.ok(!renderMd('我的看法是：这个方案更好').includes('md-kv'), '以「是」结尾的伪键不得当 KV')
})

test('加粗/行内代码/围栏代码：加粗高亮，围栏内的 # 与 - 不得被当语法', () => {
  assert.ok(renderMd('**重点**').includes('md-b'))
  assert.ok(renderMd('`npm i`').includes('md-code'))
  const fence = renderMd('```bash\n# 注释\n- 不是列表\n```')
  assert.ok(fence.includes('md-pre'), '围栏应保留为 pre')
  assert.ok(!fence.includes('<ul'), '围栏内的 - 不得变列表')
  assert.ok(fence.includes('# 注释'))
})

test('frontmatter：拆成 meta 且不进正文；tags 兼容三种写法', () => {
  const card = '---\ntitle: 甲\nkind: knowledge\ntags: [a, b]\nstatus: pending\n---\n## 结论\n正文'
  const { meta, body } = splitFrontmatter(card)
  assert.equal(meta.find(([k]) => k === 'kind')[1], 'knowledge')
  assert.ok(!body.includes('title:'), '正文不得残留 YAML')
  assert.ok(renderMd(card).includes('md-c-ok'), '正文的小标题仍要渲染')
  assert.deepEqual(parseTags('[a, b]'), ['a', 'b'])
  assert.deepEqual(parseTags('["x","y"]'), ['x', 'y'])
  assert.deepEqual(parseTags('z'), ['z'])
  assert.deepEqual(parseTags(''), [])
})

test('空输入 / 异常输入安全', () => {
  assert.equal(renderMd(''), '')
  assert.equal(renderMd(null), '')
  assert.equal(renderMd(undefined), '')
  assert.deepEqual(splitFrontmatter('').meta, [])
  assert.equal(splitFrontmatter(null).body, '')
})
