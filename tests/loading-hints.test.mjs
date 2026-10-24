// 加载提示回归守卫（知识图谱已回退到 v0.15 版本，不再测试图谱预热/图谱加载态）
//
// 保留两项与图谱无关的加载体验：
//   ① iframe 的 app.js/首屏下载期间，web/index.html 自带的纯 CSS 不确定进度条；
//   ② DSH 弹窗 iframe 首帧之前，WebModal 的 .me-frame-boot + ProgressBar 兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')
const html = read('web/index.html')
const entry = read('src/web/index.jsx')
const src = read('src/client/index.tsx')

test('① 首屏静态进度条：#boot 自带纯 CSS 不确定进度条（不依赖 app.js）', () => {
  assert.match(html, /<div id="boot"[^>]*role="status"/, '#boot 必须在 HTML 里，且带 role=status')
  assert.match(html, /class="me-boot-bar"[^>]*role="progressbar"/, '首屏必须是一条 progressbar，不是转圈/纯文字')
  assert.match(html, /class="me-boot-bar-fill"/, '要有填充条')
  assert.match(html, /@keyframes me-boot-slide/, '流动动画必须写在 index.html 里（app.js 还没执行）')
  assert.match(html, /加载记忆中/, '要有文案')
  assert.match(html, /prefers-reduced-motion/, '要尊重系统的「减少动态效果」')
  assert.match(entry, /const dropBoot = \(\) => \{/, 'web 入口要负责撤掉 #boot')
  assert.match(entry, /rootEl\.childElementCount > 0/, '撤掉条件必须是「#root 真的有内容了」，不能用固定延时（慢机会提前撤掉又露白屏）')
  assert.match(entry, /boot\.remove\(\)/, '要真的移除节点')
})

test('② 弹窗 iframe 首帧：ProgressBar + .me-frame-boot 兜底', () => {
  assert.match(src, /function ProgressBar\(\{ value, small \}\)/, '统一进度条组件必须在')
  assert.match(src, /role="progressbar"/, '要真的 progressbar 语义（读屏/自动化可读）')
  assert.match(src, /aria-valuenow=\{determinate \? Math\.round\(pct\) : undefined\}/, '确定进度要把真值暴露给读屏')
  assert.match(src, /className=\{'me-progress'/, '进度条走统一 class')
  assert.match(src, /\.me-progress-fill \{[^}]*animation: me-prog-slide/, '不确定进度靠 CSS 动画流动（不依赖 JS 定时器）')
  assert.match(src, /function LoadingNote\(\{ text, value \}\)/, '统一加载组件必须在')
  assert.match(src, /const \[frameReady, setFrameReady\] = useState\(false\)/, 'WebModal 要记住 iframe 是否已就绪')
  assert.match(src, /onLoad=\{\(\) => setFrameReady\(true\)\}/, 'iframe onLoad 后撤掉兜底层')
  assert.match(src, /!frameReady && <div className="me-frame-boot"[^>]*><ProgressBar \/>/, 'iframe 首帧之前要有进度条兜底')
  assert.doesNotMatch(src, /me-spin/, '转圈样式已整体替换为进度条，不要再留 .me-spin')
})
