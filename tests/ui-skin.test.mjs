// 皮肤覆盖守卫：**暗底写死的容器，浅底皮肤必须覆盖**
//
// 背景：`.me-v5` 里有一批写死深色的容器（#21252c / #262b33 等）。spider / light / pop 是浅底，
// 这些深色块就成了「黑板嵌在白纸上」，里面的深色字直接看不见 —— 用户报的
// 「审核中心看不清」「布局大小选中块颜色突兀」都是这一类。
//
// 这条测试把「深色底 × 皮肤覆盖」做差集：新增一条 `.me-v5 .xxx { background:#1x1x1x }`
// 却没给兄弟皮肤补覆盖，这里立刻红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = 'src/client/index.tsx'
const src = fs.readFileSync(SRC, 'utf8')
const norm = (s) => s.trim().replace(/\s+/g, ' ').replace(/\s*>\s*/g, ' > ')

function darkTargets() {
  const map = new Map()
  const reRule = /([^{}\n][^{}]*?)\{([^{}]*)\}/g
  let m
  while ((m = reRule.exec(src))) {
    const selRaw = m[1]
    const body = m[2]
    if (!selRaw.includes('.me-v5 ')) continue
    if (!/background(?:-color)?:/.test(body)) continue
    const bg = body.match(/background(?:-color)?:\s*([^;]+)/)[1].trim()
    const hex = bg.match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/)
    if (!hex) continue
    let h = hex[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    if (r * 0.299 + g * 0.587 + b * 0.114 >= 90) continue // 不是深色
    for (const part of selRaw.split(',')) {
      const p = norm(part)
      const i = p.indexOf('.me-v5 ')
      if (i < 0) continue
      const target = norm(p.slice(i + '.me-v5 '.length))
      if (target && target !== '.me-v5') map.set(target, bg)
    }
  }
  return map
}

function skinCovered(skin) {
  const tag = `[data-skin="${skin}"] `
  const set = new Set()
  const re = /([^{}\n][^{}]*?)\{/g
  let s
  while ((s = re.exec(src))) {
    const sel = s[1]
    if (!sel.includes(tag)) continue
    for (const part of sel.split(',')) {
      const p = norm(part)
      const i = p.indexOf(tag)
      if (i < 0) continue
      set.add(norm(p.slice(i + tag.length)))
    }
  }
  return set
}

test('浅底皮肤（spider / light / pop）覆盖了所有写死深色的容器', () => {
  const targets = darkTargets()
  assert.ok(targets.size > 0, '扫描应当能找出深色容器（否则说明正则失效，守卫形同虚设）')
  const problems = []
  for (const skin of ['spider', 'light', 'pop']) {
    const covered = skinCovered(skin)
    for (const [t, bg] of targets) {
      if (!covered.has(t)) problems.push(`${skin} 未覆盖 ${t}（${bg}）`)
    }
  }
  assert.deepEqual(problems, [], '这些容器在浅底皮肤下会显示成深色块：\n' + problems.join('\n'))
})

test('分段控件（mc-seg）在浅底皮肤里有明确选中色', () => {
  for (const skin of ['spider', 'light', 'resident']) {
    assert.ok(
      src.includes(`[data-skin="${skin}"] .mc-seg button.on`),
      `${skin} 皮肤缺少 .mc-seg button.on 覆盖（选中块会是暗色 #2b3038）`
    )
  }
})

test('浅底皮肤把设计令牌文字色改成深色（组件层不会白字白底）', () => {
  const block = src.slice(src.indexOf('[data-skin="spider"], [data-skin="light"], [data-skin="pop"]'))
  const head = block.slice(0, block.indexOf('}'))
  assert.match(head, /--me-c-text:\s*#1c1c1e/, '浅底皮肤要把 --me-c-text 覆盖成深色')
  assert.match(head, /--me-c-text-dim:/, '次要文字也要覆盖')
})

test('全页形态（data-modal="0"）没有弹窗内边距 —— 否则四周一圈留白', () => {
  // .me-modal-body 自带 padding:18px 20px + 一个底色容器；独立页/内嵌整页也会套上它，
  // 于是内容四周出现一圈白边（实测：mc-main 被推成 x=285,y=79，右侧/底部各空 20px）。
  assert.match(
    src,
    /\.memory-eternal-root\[data-modal="0"\] \.me-modal-body\s*\{[^}]*padding:\s*0/,
    '全页形态必须把 me-modal-body 的 padding 归零'
  )
  assert.match(
    src,
    /\.memory-eternal-root\[data-modal="0"\] \.me-modal-body\s*\{[^}]*background:\s*transparent/,
    '全页形态还要把它的底色设成透明（米色底由 .mc-main 提供）'
  )
  assert.match(src, /data-modal=\{inModal \? '1' : '0'\}/, '根节点要带形态标记')
})

test('迁移类按钮只在备份分区：首页工具栏不放导入 / 导出 MD / 导出 JSON', () => {
  // 首页工具栏里同时塞「导入 / 导出 MD / 导出 JSON / 新建 / 同步 / 刷新」，用户说「太乱」；
  // 迁移是低频动作，统一收到「设置 → 备份」。
  const i = src.indexOf('className="mc-toolbar"')
  assert.ok(i > 0, '应当能找到首页工具栏')
  const block = src.slice(i, i + 1600)
  assert.doesNotMatch(block, /exportVault\('md'\)/, '工具栏不应再有「导出 MD」')
  assert.doesNotMatch(block, /exportVault\('json'\)/, '工具栏不应再有「导出 JSON」')
  assert.doesNotMatch(block, /importVault\}/, '工具栏不应再有「导入」')
  assert.match(block, /openBackupSettings/, '工具栏要留一个「备份与迁移」入口')
})

test('首页筛选区按 类型 / 筛选 / 排序 分栏（带小标题）', () => {
  assert.match(src, /\.mc-chip-groups\s*\{/, '要有分栏容器的样式')
  assert.match(src, /\.mc-chip-group-label\s*\{/, '每一栏要有左侧小标题的样式')
  // 定位 JSX 用法（CSS 里也出现同名类，必须用 className 形式）
  const i = src.indexOf('className="mc-chip-groups"')
  assert.ok(i > 0, '筛选区要用分栏容器包起来')
  const block = src.slice(i, i + 3000)
  for (const key of ['chipGroupKind', 'chipGroupFilter', 'chipGroupSort']) {
    assert.match(block, new RegExp(key), `分栏缺少 ${key}`)
  }
})

test('备份分区有导出 / 导入还原两个入口（走 /backup/export 与 /backup/import）', () => {
  assert.match(src, /API \+ '\/backup\/export'/, '导出要走下载流接口')
  assert.match(src, /API \+ '\/backup\/import'/, '导入要走导入接口')
  assert.match(src, /SQLite format 3/, '导入前前端也要挡一次文件头')
  assert.match(src, /importDbRef/, '导入要有隐藏的文件选择器')
})
