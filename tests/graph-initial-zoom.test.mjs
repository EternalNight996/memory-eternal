// 用户要求：「知识图谱默认视图再小一些，节点多时默认别太大」。
// 图谱是 canvas + sim.zoom，滚轮每格 ×1.1 —— 所以「三个度」= ×(1/1.1)³ ≈ 0.751。
// 这里锁死三件事：① 初始 fit 应用该系数；② 滚轮与初始视图共用同一个 ZOOM_STEP（改步长不漂）；
// ③ 原有限幅（0.35–1.8）仍在，避免小图被缩成看不见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

test('初始视图缩小三个度：系数 = (1/1.1)³ ≈ 0.751，且只应用一次', () => {
  const STEP = 1.1
  const STEPS = 3
  const factor = Math.pow(1 / STEP, STEPS)
  assert.ok(Math.abs(factor - 0.751315) < 1e-5, '三格滚轮的系数应为 0.7513')
  assert.match(src, /const ZOOM_STEP = 1\.1/);
  assert.match(src, /const INITIAL_ZOOM_OUT_STEPS = 3/);
  assert.match(src, /const initialZoomOut = Math\.pow\(1 \/ ZOOM_STEP, INITIAL_ZOOM_OUT_STEPS\)/);
  assert.match(src, /sim\.zoom = Math\.max\(0\.35, Math\.min\(1\.8, z \* initialZoomOut\)\)/, '系数要乘在 fit 的缩放上，且保留限幅');
  // 只乘一次：不能同时再对 z 或 ZOOM_STEP 做别的缩放
  assert.equal((src.match(/initialZoomOut/g) || []).length, 2, 'initialZoomOut 只应出现定义 + 使用各一次');
})

test('滚轮与初始视图共用同一个「度」：onWheel 不再硬编码 1.1', () => {
  assert.match(src, /sim\.zoom \* \(e\.deltaY < 0 \? ZOOM_STEP : 1 \/ ZOOM_STEP\)/, '滚轮用 ZOOM_STEP')
  // 切片必须真的落在 onWheel 函数体内：源码里监听器用的是单引号，
  // 之前这里写成双引号 → indexOf 返回 -1 → 切片一路吃到文件末尾（注释里出现 "1.1" 就误报）。
  const wheelBlock = src.slice(src.indexOf('const onWheel'), src.indexOf("canvas.addEventListener('wheel'"))
  assert.doesNotMatch(wheelBlock, /1\.1/, 'onWheel 里不应再有硬编码的 1.1（否则改步长时初始视图会漂）')
})

test('初始全景仍由 fit() 决定（挂载 + 布局稳定后各一次，重置视图同路径）', () => {
  assert.match(src, /sim\.autoFitPending && sim\.tickCount > 45/, '布局稳定后自动 fit')
  assert.match(src, /resetRef\.current = \(\) => \{[^}]*fit\(\)/, '重置视图走同一个 fit（行为与首次打开一致）')
})
