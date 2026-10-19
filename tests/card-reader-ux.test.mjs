// 使用体验（界面）第一批：读卡体验 —— 复制、进度、j/k 翻页、阅读宽度。
// 全部是客户端改动，不动后端/存储；这里锁死行为，防止以后重构时悄悄退化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

test('复制正文 / 复制路径：两个按钮都走 copyToClipboard，并有 1.5s 反馈', () => {
  assert.match(src, /onClick=\{\(\) => copyText\(body, t\('copyBody'\)\)\}/)
  assert.match(src, /onClick=\{\(\) => copyText\(card\.path, t\('copyPath'\)\)\}/)
  assert.match(src, /const copyText = async \(text, label\) => \{/, '要有一个统一的复制函数')
  assert.match(src, /await copyToClipboard\(String\(text \|\| ''\)\)/, '复用已有的剪贴板工具（带兜底）')
  assert.match(src, /setTimeout\(\(\) => setCopyTip\(''\), 1500\)/, '反馈要自动消失')
})

test('阅读进度：头部下沿 2px 细条，随正文滚动推进', () => {
  assert.match(src, /\.me-read-progress > i \{[^}]*transition: width/, 'CSS 要有进度条')
  assert.match(src, /<div className="me-read-progress" aria-hidden="true"><i style=\{\{ width: progress \+ '%' \}\} \/><\/div>/)
  assert.match(src, /setProgress\(max <= 0 \? 100 : Math\.min\(100, Math\.max\(0, \(el\.scrollTop \/ max\) \* 100\)\)\)/, '短卡应显示 100%（没有可滚动区域）')
})

test('j/k 翻页：只在阅读器里生效，且不抢输入框/正文滚动', () => {
  assert.match(src, /if \(e\.key === 'j' && onNavigate\) \{ e\.preventDefault\(\); onNavigate\(1\) \}/)
  assert.match(src, /else if \(e\.key === 'k' && onNavigate\) \{ e\.preventDefault\(\); onNavigate\(-1\) \}/)
  assert.match(src, /if \(tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select'/, '输入框里不许触发翻页')
  assert.match(src, /onNavigate=\{\(d\) => \{ const i = sortedCards\.findIndex/, '翻页要基于列表顺序（上一张/下一张）')
})

test('阅读宽度：窄/中/宽三档，记住偏好（localStorage），窄屏不溢出', () => {
  assert.match(src, /const WIDTH_PX = \{ narrow: 720, mid: 900, wide: 1180 \}/)
  assert.match(src, /localStorage\.getItem\('me-read-width'\)/);
  assert.match(src, /localStorage\.setItem\('me-read-width', next\)/);
  assert.match(src, /maxWidth: WIDTH_PX\[widthMode\], margin: '0 auto', width: '100%'/, '宽度要可切换且不撑破容器')
  // 中英词条各一条（缺一个就会在另一种语言下露 key）
  assert.equal((src.match(/widthNarrow:/g) || []).length, 2)
  assert.equal((src.match(/copyBody:/g) || []).length, 2)
})
