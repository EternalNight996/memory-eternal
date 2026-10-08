// 升级期两个现场问题的回归守卫（2026-10-08 实测）：
//   ① 「重启常驻实例」按钮在**服务本页的进程**是旧版时也显示 → 点了必然 404（旧宿主没这个路由），
//      用户只看到一句「未知接口」。修法：按钮只在「端口上那个常驻实例落后于磁盘」时出现，
//      并给 404 一条明确指路的话。
//   ② 独立页（新版）保存整表单 → 旧宿主按白名单丢掉它不认识的键（如 secretHint）→
//      patchApplied 回读必然对不上 → 连续失败 5 次 dropped，用户看到「HMR transactions cannot be nested」。
//      修法：应用前按宿主 schema 过滤未知键（filterKnownKeys）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const client = read('src/client/index.tsx')
const indexSrc = read('index.js')
const apiSrc = read('lib/api.js')

test('①「重启常驻实例」按钮只在常驻实例真落后时出现（否则点了是 404）', () => {
  assert.match(client, /const residentStale = Boolean\(/, '要有「常驻实例是否落后」的判据')
  assert.match(client, /residentStale \? \(/, '横幅要按该判据分岔：落后才给按钮')
  assert.match(client, /vcHostStale/, '不落后（本页进程旧）时要说清该重启桌面版/DSH')
})

test('① 旧宿主没有该路由时给明确指路，而不是「未知接口」', () => {
  assert.match(client, /raw\.status === 404/, '要显式识别 404/405（旧版宿主 / 方法不对）')
  assert.match(client, /vcRestartNoRoute/, '要有一条专门的提示词条')
  // 中英两套词典都要有，否则英文界面会显示成词条 key
  const hits = (client.match(/vcRestartNoRoute:/g) || []).length
  assert.equal(hits, 2, '中英文案各一条（实际 ' + hits + '）')
})

test('② 待应用配置按宿主 schema 过滤未知键（新独立页 + 旧宿主不再 dropped）', () => {
  assert.match(indexSrc, /filterKnownKeys\(patch, Object\.keys\(Config\.dict \|\| \{\}\)\)/, '宿主 drain 必须过滤未知键')
  assert.match(indexSrc, /本宿主不认识的键（宿主升级后生效）/, '被忽略的键要留下可查的一行日志')
})

test('② 上一份已被宿主守卫判死时，独立页不再空头承诺「会自动同步」', () => {
  assert.match(apiSrc, /const knownGuard = Boolean\(before && before\.dropped && hostGuard\)/, '要识别「已知守卫拒绝」')
  assert.match(apiSrc, /请到「DSH 设置 → 记忆」里改同一项/, '要直接告诉用户去哪儿改')
})

test('③ 配置同步失败不再冒充「自动沉淀异常」（不翻红沉淀健康状态）', () => {
  // logCapture 里 action==='fail' 会把自动沉淀健康翻红 → 配置同步必须用专用动作
  assert.match(indexSrc, /logCapture\('system', dropped \? 'config-fail' : 'config-warn', why\)/, '配置同步要用 config-fail / config-warn')
  assert.doesNotMatch(indexSrc, /logCapture\('system', dropped \? 'fail'/, '不能再把配置同步失败写成 fail')
})
