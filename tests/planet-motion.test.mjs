// 星球层的「大球公转 + 护城河排斥」纯函数与接线守卫。
// 用户反馈原话：大的球不动、小的球数量多紧贴着大的丑 —— 这两条规则分别由
// orbitPlanets（大球绕质心缓慢公转）和 planetMoat（大球把小球推开）落地。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planetMoat, orbitPlanets, assignOrbitRandom } from '../src/client/graph-planet.js'

const angleOf = (p) => Math.atan2(p.y, p.x)
const delta = (a, b) => {
  let d = Math.abs(a - b) % (Math.PI * 2)
  if (d > Math.PI) d = Math.PI * 2 - d
  return d
}

test('planetMoat：护城河随半径单调增大（大球推得更远）', () => {
  assert.ok(planetMoat(0) >= 12)
  assert.ok(planetMoat(60) < planetMoat(140))
  assert.ok(planetMoat(140) < planetMoat(320))
  assert.equal(planetMoat(-10), planetMoat(0))
  assert.ok(Number.isFinite(planetMoat(undefined)))
})

test('orbitPlanets：只改角度不改半径，并绕质心旋转', () => {
  const planets = [
    { planet: true, x: -100, y: 0, r: 100 },
    { planet: true, x: 100, y: 0, r: 100 },
  ]
  const radii = planets.map((p) => Math.hypot(p.x, p.y))
  const angles = planets.map(angleOf)
  const center = orbitPlanets(planets, { speed: 0.01 })
  assert.ok(center)
  assert.equal(center.cx, 0)
  planets.forEach((p, i) => {
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - radii[i]) < 1e-9, '半径必须保持不变')
    assert.ok(delta(angleOf(p), angles[i]) > 0.005, '必须真的转起来（默认方向各自随机）')
  })
})

test('orbitPlanets：大球角速度更小（有质量感）', () => {
  const big = { planet: true, x: 160, y: 0, r: 240 }
  const small = { planet: true, x: -160, y: 0, r: 50 }
  const a0 = angleOf(big)
  const b0 = angleOf(small)
  orbitPlanets([big, small], { speed: 0.01, random: false })
  assert.ok(delta(angleOf(small), b0) > delta(angleOf(big), a0))
})

test('assignOrbitRandom：方向正反各半（洗牌），速度/相位在范围内', () => {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const planets = Array.from({ length: 4 }, (_, i) => ({ planet: true, id: 'k' + i, x: i * 10, y: 0, r: 100 }))
  assignOrbitRandom(planets, rand)
  assert.equal(planets.filter((p) => p.orbitDir === 1).length, 2)
  assert.equal(planets.filter((p) => p.orbitDir === -1).length, 2)
  for (const p of planets) {
    assert.ok(p.orbitScale >= 0.55 && p.orbitScale <= 1.65)
    assert.ok(p.orbitPhase >= 0 && p.orbitPhase <= Math.PI * 2)
  }
})

test('orbitPlanets：使用 assignOrbitRandom 的方向/速度/相位', () => {
  const cw = { planet: true, id: 'a', x: 100, y: 0, r: 100, orbitDir: 1, orbitScale: 1, orbitPhase: 0 }
  const ccw = { planet: true, id: 'b', x: -100, y: 0, r: 100, orbitDir: -1, orbitScale: 1, orbitPhase: 0 }
  const a0 = angleOf(cw)
  const b0 = angleOf(ccw)
  orbitPlanets([cw, ccw], { speed: 0.01, tick: 0 })
  const signed = (after, before) => Math.atan2(Math.sin(after - before), Math.cos(after - before))
  assert.ok(signed(angleOf(cw), a0) > 0.005, '顺时针那颗要正向转')
  assert.ok(signed(angleOf(ccw), b0) < -0.005, '逆时针那颗必须反向转')
})

test('初始化总览：根层直接缩到最小视图 0.3', () => {
  const src = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(src, /const MIN_VIEW_ZOOM = 0\.3/, '滚轮下限 = 初始化最小视图')
  assert.match(src, /const rootLevel = !\(Array\.isArray\(crumbs\) && crumbs\.length > 1\)/, '只有根层用最小视图')
  assert.match(src, /sim\.zoom = Math\.max\(0\.12, Math\.min\(MIN_VIEW_ZOOM, z\)\)/, '根层初始化取 min(最小视图, fit)')
})
test('orbitPlanets：默认方向/速度各自随机，不是整盘同向', () => {
  const planets = Array.from({ length: 8 }, (_, i) => ({
    planet: true,
    id: 'p' + i,
    x: 100 * Math.cos(i),
    y: 100 * Math.sin(i),
    r: 100,
  }))
  const before = planets.map(angleOf)
  orbitPlanets(planets, { speed: 0.01, tick: 120 })
  const deltas = planets
    .map((p, i) => angleOf(p) - before[i])
    .map((d) => Math.atan2(Math.sin(d), Math.cos(d)))
  assert.ok(deltas.some((d) => d > 0), '至少一颗顺时针')
  assert.ok(deltas.some((d) => d < 0), '至少一颗逆时针（不能整盘同向）')

  // orbitDir 可显式覆盖随机方向（拖拽/调试用）
  const forced = { planet: true, id: 'x', x: 100, y: 0, r: 100, orbitDir: -1 }
  const other = { planet: true, id: 'y', x: -100, y: 0, r: 100, orbitDir: 1 }
  const b0 = angleOf(forced)
  orbitPlanets([forced, other], { speed: 0.01 })
  assert.ok(angleOf(forced) < b0, 'orbitDir=-1 必须反向')
})

test('orbitPlanets：少于两颗 / speed=0 / 拖拽中的球不动', () => {
  const one = { planet: true, x: 50, y: 20, r: 120 }
  orbitPlanets([one], { speed: 0.01 })
  assert.deepEqual([one.x, one.y], [50, 20])

  const two = [{ planet: true, x: 10, y: 0, r: 100 }, { planet: true, x: -10, y: 0, r: 100 }]
  orbitPlanets(two, { speed: 0 })
  assert.deepEqual(two.map((p) => [p.x, p.y]), [[10, 0], [-10, 0]])

  const dragged = [{ planet: true, x: 10, y: 0, r: 100 }, { planet: true, x: -10, y: 0, r: 100 }]
  orbitPlanets(dragged, { speed: 0.01, skip: (p) => p === dragged[0] })
  assert.deepEqual([dragged[0].x, dragged[0].y], [10, 0])
  assert.notDeepEqual([dragged[1].x, dragged[1].y], [-10, 0])
})

test('orbitPlanets：卡片/空列表不参与、不抛异常', () => {
  assert.equal(orbitPlanets([]), null)
  assert.equal(orbitPlanets([{ planet: false, x: 1, y: 2, r: 9 }]), null)
  assert.equal(orbitPlanets(null), null)
})

test('接线守卫：漂移阶段调用公转；卡片排斥走 planetMoat', () => {
  const src = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(src, /planetLayer && sim\.orbitOn/, '大球公转必须由预热结束后的开关驱动')
  assert.match(src, /orbitPlanets\(sim\.nodes/, '大球公转必须接在 tick 里')
  assert.match(src, /const moat = planetMoat\(p\.r\)/, '大球排斥小球必须按半径取护城河')
  assert.match(src, /const hard = p\.r \+ c\.r \+ 30/, '卡片不允许和大球视觉重叠（硬边界 +30）')
  assert.match(src, /sim\.orbitOn = true/, '预热结束/无预热时要打开公转')
  assert.match(src, /assignOrbitRandom\(sim\.nodes/, '每颗大球要各自分配方向/速度')
  assert.match(src, /tick: sim\.tickCount/, '公转要拿到 tick 才能做每颗球各自的慢摆')
  assert.doesNotMatch(src, /driftFrame % 2/, '不再用 30fps 降帧（改成自适应画质）')
  assert.match(src, /sim\.frameEma > 17\.8/, '掉帧要能触发自适应降档')
  assert.match(src, /const edgeStride = quality <= 0 \? 1 : quality === 1 \? 2 : quality === 2 \? 4 : 8/, '自适应画质按档位抽稀连线')
  assert.match(src, /if \(focusId\) \{ if \(!focused\) return \}/, '聚焦时只画焦点相关的边（全部）')
  assert.match(src, /pushA = pen \* \(mb \/ mt\)/, '球球排斥按面积分配：大球位移小、小球被推开')
})
