// 前端作用域守卫：组件内的 useState/const 声明之前不能用它。
// 真实故障：域名改造时把 `const memUrl = …` 写在组件中部（9559 行），
// 而 placeholder / 提示文案在 7722 行就用了 —— 同一函数作用域内的 TDZ，
// 运行时抛 ReferenceError: memUrl is not defined，整个记忆面板被 ErrorBoundary 兜住（白屏）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('src/client/index.tsx', 'utf8')
const lines = src.split(/\r?\n/)

test('不得在声明前裸用 memUrl（会踩 TDZ）', () => {
  const declAt = lines.findIndex((l) => /const memUrl\s*=/.test(l))
  assert.ok(declAt > 0, '应存在 const memUrl 声明')
  const early = []
  lines.forEach((l, i) => {
    if (i >= declAt) return
    const t = l.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return   // 注释不算
    if (/\bmemUrl\b/.test(l) && !/cloudDomainsRef\.memUrl/.test(l) && !/CLOUD_DOMAINS_FALLBACK/.test(l)) {
      early.push((i + 1) + ': ' + t.slice(0, 80))
    }
  })
  assert.deepEqual(early, [], '声明前不能裸用 memUrl，改用 cloudDomainsRef.memUrl：\n' + early.join('\n'))
})

test('域名基座在组件外有模块级引用（供声明前的 JSX 使用）', () => {
  assert.match(src, /let cloudDomainsRef\s*=/, '缺少模块级 cloudDomainsRef')
  assert.match(src, /CLOUD_DOMAINS_FALLBACK\s*=/, '缺少兜底常量')
})

test('placeholder 若在声明之前出现，必须走模块级引用', () => {
  const declAt = lines.findIndex((l) => /const memUrl\s*=/.test(l))
  const bad = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i < declAt && /placeholder=\{memUrl\}|placeholder=\{accountsUrl\}/.test(l))
    .map(({ l, i }) => (i + 1) + ': ' + l.trim().slice(0, 70))
  assert.deepEqual(bad, [], '声明前的 placeholder 必须用 cloudDomainsRef.memUrl：\n' + bad.join('\n'))
})
