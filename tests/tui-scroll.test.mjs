// TUI 列表滚动回归（dsh-tui-plugin/demo.mjs）
//
// 用户反馈：「dsh-memory tui 往下查找资源不会跟踪 / 意思是没有滚动条」。
// 旧实现把过滤后的所有卡片都拼成行，再由 frame() 的 body.slice(0, bodyH) 截断：
// 视图永远停在第一屏，↑↓ 把选择框推出屏幕后完全不可见。
//
// 本测试用 --once + --index 直接驱动 CLI（不需要交互 TTY），断言：
//   1) 列表按可视高度开窗，位置文本跟着 index 走，窗口外的卡片不渲染；
//   2) 面板右侧有滚动条（滑块 █ / 滑轨 │），且面板每行等宽（右边框没被挤掉）；
//   3) 末项、越界 index 不崩；audit 队列同样开窗；
//   4) live 可用时用真实数据验证第 900 张；live 不可用时必须回退示例数据且仍然成立。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tui = path.join(root, 'dsh-tui-plugin', 'demo.mjs')
const THUMB = '█'
const RAIL = '│'

function run(args, { cols = '120', lines = '36', env = {} } = {}) {
  const res = spawnSync(process.execPath, [tui, '--once', '--no-color', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, NO_COLOR: '1', COLUMNS: cols, LINES: lines, ...env },
  })
  assert.equal(res.error, undefined, '启动 CLI 失败：' + (res.error && res.error.message))
  assert.equal(res.status, 0, 'CLI 退出码应为 0，实际 ' + res.status + '\n' + (res.stderr || ''))
  return String(res.stdout || '').replace(/\x1b\[[0-9;]*m/g, '')
}

function charWidth(ch) {
  const cp = ch.codePointAt(0)
  if (cp === 0x200b || cp === 0xfe0f) return 0
  if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff))) return 2
  return 1
}
const displayWidth = (line) => [...line].reduce((n, ch) => n + charWidth(ch), 0)

// 面板标题里的位置文本，如「记忆库 · 897-901/1084」「队列 7 · 4-7/7」
function position(text, label) {
  const m = new RegExp(label + ' (?:\\d+ )?· (\\d+)-(\\d+)/(\\d+)').exec(text)
  assert.ok(m, '面板标题应包含「' + label + ' · 起-止/总数」位置文本；实际输出：\n' + text)
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) }
}

// 面板行（顶框 / 内容 / 底框）必须与终端宽度一致：滚动条列占内框最后一列，不能挤出右边框
function assertPanelAligned(text, width, note) {
  const rows = text.split('\n').filter((line) => /^[╭│╰]/.test(line))
  assert.ok(rows.length > 4, note + '：应能识别到面板边框行')
  for (const row of rows) {
    assert.equal(displayWidth(row), width, note + '：面板每行必须等宽 ' + width + '，实际 ' + displayWidth(row) + '：' + JSON.stringify(row.slice(0, 48)))
  }
}

const thumbRowIndexes = (text) => text.split('\n')
  .map((line, i) => (line.includes(THUMB) ? i : -1))
  .filter((i) => i >= 0)

test('记忆库：默认从第 1 张开始，列表按屏开窗、窗口外不渲染、右侧有滚动条', () => {
  const out = run(['--demo', '--screen=library'])
  assert.match(out, /● MEMORY ATLAS/, '--once 仍应是正常的一帧')
  const pos = position(out, '记忆库')
  assert.equal(pos.start, 1, 'index=0 时窗口应从第 1 张开始')
  assert.ok(pos.end > pos.start, '窗口里至少要有一张卡')
  assert.ok(pos.end <= pos.total, '窗口结束位置不能超过总数')

  // 7 张示例卡在 36 行终端上放不下一屏：必须出现开窗与滚动条
  if (pos.end < pos.total) {
    assert.ok(thumbRowIndexes(out).length >= 1, '列表超过一屏时右侧应画滚动块 ' + THUMB)
    assert.ok(out.includes(RAIL), '列表超过一屏时右侧应画滑轨 ' + RAIL)
    // 窗口外的最后一张卡（长文复盘）不应被渲染；旧实现会全量渲染，因此这里能抓住回归
    assert.doesNotMatch(out, /长文复盘：Memory Atlas 的一年/, '窗口外的卡片不应渲染')
  }
  assertPanelAligned(out, 120, '记忆库')
  assert.doesNotMatch(out, /NaN|undefined/, '输出里不应出现 NaN/undefined')
})

test('记忆库：--index 把窗口带到中间/末尾，选中项始终可见', () => {
  const base = position(run(['--demo', '--screen=library']), '记忆库')
  const scrollable = base.end - base.start + 1 < base.total

  const mid = run(['--demo', '--screen=library', '--index=5'])
  const midPos = position(mid, '记忆库')
  assert.ok(5 >= midPos.start && 5 <= midPos.end, '--index=5 选中项必须落在可视窗口内')
  assert.match(mid, /▌.*README 平台支持表/, '--index=5 时第 6 张卡（README）应被选中并可见')
  if (scrollable) assert.ok(midPos.start > 1, '窗口应跟随 index 下移，而不是永远从 1 开始')

  const last = run(['--demo', '--screen=library', '--index=6'])
  const lastPos = position(last, '记忆库')
  assert.equal(lastPos.end, lastPos.total, 'index 指向末项时窗口必须贴到底')
  assert.match(last, /▌.*长文复盘：Memory Atlas 的一年/, '末项应被选中并可见')
  if (scrollable) {
    assert.ok(lastPos.start > base.start, '末项窗口应从中间某张开始，而不是第 1 张')
    assert.ok(thumbRowIndexes(last).length >= 1, '滚到底部时仍应有滚动块')
  }

  // 越界 index 夹到最后一张，不能崩、不能空窗口
  const over = position(run(['--demo', '--screen=library', '--index=999']), '记忆库')
  assert.deepEqual(over, lastPos, '--index 越界应夹到最后一张的窗口')
})

test('记忆库：live 不可用时回退示例数据，--index 仍然生效（不依赖网络）', () => {
  // 指向一个必然连不上的端口，强制走 loadLive 的 catch 分支
  const out = run(['--live', '--screen=library', '--index=5'], {
    env: { MEMORY_ETERNAL_API: 'http://127.0.0.1:1/memory-eternal/api' },
  })
  assert.match(out, /LOCAL MEMORY/, 'API 不可用时应回退示例数据')
  const pos = position(out, '记忆库')
  assert.ok(5 >= pos.start && 5 <= pos.end, '回退后 --index=5 仍应把窗口带到第 6 张')
  assert.match(out, /▌.*README 平台支持表/, '回退后选中项依旧可见')
})

test('待审队列：窄终端下同样开窗 + 滚动条，右侧判词跟随选中项', () => {
  const out = run(['--demo', '--screen=audit', '--index=6'], { cols: '80', lines: '24' })
  const pos = position(out, '队列')
  assert.equal(pos.total, 7)
  assert.equal(pos.end, pos.total, 'index 指向末项时队列窗口必须贴到底')
  assert.ok(pos.start > 1, '队列超过一屏时应从中间开窗')
  assert.match(out, /▌.*长文复盘/, '队列选中项应可见（窄终端下标题可能被截断）')
  assert.match(out, /判词/, '右侧判词面板应仍然存在')
  assert.ok(thumbRowIndexes(out).length >= 1, '队列面板应画滚动块 ' + THUMB)
  assertPanelAligned(out, 80, '待审队列')
})

test('live：--index=900 用真实数据验证窗口跟随（7999 不可用时跳过，不算失败）', () => {
  const out = run(['--live', '--screen=library', '--index=900'])
  if (!/LIVE \/ READONLY/.test(out)) {
    console.log('跳过 live 断言：7999 常驻 API 不可用，CLI 已回退示例数据（上面那条测试覆盖了回退路径）')
    return
  }
  const pos = position(out, '记忆库')
  assert.ok(pos.total > 50, 'live 数据量应足以验证滚动（实际 ' + pos.total + ' 张）')
  const idx = Math.min(900, pos.total - 1)
  assert.ok(idx >= pos.start && idx <= pos.end, '第 900 张（或夹到末项）必须落在可视窗口内')
  assert.ok(pos.start > 1, 'live 大列表的窗口不应从第 1 张开始')
  assert.ok(thumbRowIndexes(out).length >= 1, 'live 大列表应画滚动块')
  assert.ok(pos.end <= pos.total)
})

test('其他视图：--index 参数与开窗改动不影响原有页面', () => {
  const expects = [
    ['--screen=status', /╭─ 运行状态/],
    ['--screen=graph', /╭─ 知识星图/],
    ['--screen=recycle', /╭─ 回收站/],
    ['--screen=settings', /╭─ 设置/],
    ['--screen=reader', /╭─ 读卡器/],
    ['--screen=help', /╭─ 帮助/],
  ]
  for (const [arg, pattern] of expects) {
    const out = run([arg, '--index=3'])
    assert.match(out, pattern, arg + ' 应仍然渲染出面板')
    assert.doesNotMatch(out, /NaN|undefined/, arg + ' 输出不应出现 NaN/undefined')
  }
})
