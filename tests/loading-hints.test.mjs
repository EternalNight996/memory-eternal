// 「加载过程要看得见进度」回归守卫（用户群反馈：点开记忆/知识星图先是白屏；后要求换成进度条）。
//
// 事故形态：记忆/星图有 3 段「无提示空白」：
//   ① iframe 的 app.js（≈470KB）下载/解析/执行期间 —— 纯白块；
//   ② 图谱 /graph 数据（1084 卡 / 5k 边）返回之前；
//   ③ 大图布局预热期间。
// 现在每段都换成进度条（不是转圈/纯文字）：
//   - ① web/index.html 的静态 #boot 里一条纯 CSS 不确定进度条（app.js 挂了也照样动）；
//   - ② LoadingNote 里的 .me-progress（不确定进度，网络阶段）；
//   - ③ 布局预热有真百分比（tick 数可数 → aria-valuenow 真值），画布徽标里的迷你进度条；
//   - DSH 弹窗 iframe 首帧之前，再由 WebModal 的 .me-frame-boot 兜一层进度条。
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
  // 关键：React 挂载后必须撤掉，否则会一直盖住界面
  assert.match(entry, /const dropBoot = \(\) => \{/, 'web 入口要负责撤掉 #boot')
  assert.match(entry, /rootEl\.childElementCount > 0/, '撤掉条件必须是「#root 真的有内容了」，不能用固定延时（慢机会提前撤掉又露白屏）')
  assert.match(entry, /boot\.remove\(\)/, '要真的移除节点')
})

test('② 数据加载态：统一 ProgressBar（不确定进度条），文案不再靠 emoji', () => {
  assert.match(src, /loading: '加载中…'/, '中文加载文案（进度条已经在表达"加载中"，文案不再堆 emoji）')
  assert.match(src, /loading: 'Loading…'/, '英文同理')
  assert.match(src, /loadingGraph: '正在加载知识星图…'/, '图谱单独文案：让用户知道在等哪一份数据')
  assert.match(src, /function ProgressBar\(\{ value, small \}\)/, '统一进度条组件必须在')
  assert.match(src, /role="progressbar"/, '要真的 progressbar 语义（读屏/自动化可读）')
  assert.match(src, /aria-valuenow=\{determinate \? Math\.round\(pct\) : undefined\}/, '确定进度要把真值暴露给读屏')
  assert.match(src, /className=\{'me-progress'/, '进度条走统一 class')
  assert.match(src, /\.me-progress-fill \{[^}]*animation: me-prog-slide/, '不确定进度靠 CSS 动画流动（不依赖 JS 定时器）')
  assert.match(src, /\.me-progress\.is-determinate \.me-progress-fill \{[^}]*animation: none/, '确定进度要停掉流动动画，只按 width 走')
  assert.match(src, /function LoadingNote\(\{ text, value \}\)/, '统一加载组件必须在')
  assert.match(src, /<LoadingNote text=\{t\('loadingGraph'\)\} \/>/, '图谱加载态必须换成 LoadingNote')
  assert.match(src, /\? <LoadingNote text=\{t\('loading'\)\} \/>/, '记忆库首屏加载态同样')
  assert.doesNotMatch(src, /⏳ 加载中…/, '文案里不要再拼 emoji（进度条本身就是提示，重复堆叠会显得脏）')
})

test('③ 布局预热：真百分比 + 画布迷你进度条；iframe 首帧也有进度条', () => {
  assert.match(src, /const warmPct = \(\) => \(totalWarm > 0 \? Math\.round\(\(\(totalWarm - warmLeft\) \/ totalWarm\) \* 100\) : 100\)/, '布局百分比必须由「已跑 tick / 总 tick」算出（真进度，不是假动画）')
  assert.match(src, /const \[warming, setWarming\] = useState\(null\)/, '预热进度用 0~100 的百分比状态（null = 不在预热）')
  assert.match(src, /warming !== null && <div role="status"[^>]*>\{?/, '预热徽标要按百分比状态显示')
  assert.match(src, /<ProgressBar value=\{warming\} small \/>/, '预热徽标里要有迷你确定进度条')
  assert.match(src, /\{Math\.round\(warming\)\}%/, '要显示真实百分比')
  assert.match(src, /const \[frameReady, setFrameReady\] = useState\(false\)/, 'WebModal 要记住 iframe 是否已就绪')
  assert.match(src, /onLoad=\{\(\) => setFrameReady\(true\)\}/, 'iframe onLoad 后撤掉兜底层')
  assert.match(src, /!frameReady && <div className="me-frame-boot"[^>]*><ProgressBar \/>/, 'iframe 首帧之前要有进度条兜底')
  assert.match(src, /background: 'transparent' \}\} \/>/, 'iframe 自身背景必须透明，否则加载期间就是一块纯白')
  assert.doesNotMatch(src, /me-spin/, '转圈样式已整体替换为进度条，不要再留 .me-spin')
})
