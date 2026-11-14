#!/usr/bin/env node
// 一键检查：市场 registry（awesome-dsh-plugin）是否已拾取本仓库的 screenshots.json。
//
// 背景：market 的插件卡片只认 registry 的 screenshots 字段（策展图，卡片取前 3 张）；
// 作者在自己仓库声明 screenshots.json 后，由 awesome-dsh-plugin 的 nightly 构建
// （UTC 02:23 / 北京时间 10:23）probe 成绝对 URL 写进 plugins.json。push 构建不带 probe，
// 所以推完不会立刻有图——本脚本就是用来判断"到底轮到我没有"的。
//
// 用法：
//   node scripts/check-market-shots.mjs          # 人类可读
//   node scripts/check-market-shots.mjs --json   # 机器可读
//   node scripts/check-market-shots.mjs --wait   # 每 10 分钟看一次，出现即退出
//
// 退出码：0 = 已拾取；1 = 还没拾取（或数量/顺序不一致）；2 = 网络/解析失败。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'EternalNight996'
const NAME = 'memory-eternal'
const REGISTRY = 'https://awesome-dsh-plugin.com/plugins.json'
const NIGHTLY = 'UTC 02:23（北京时间 10:23）'

const argv = new Set(process.argv.slice(2))
const asJson = argv.has('--json')
const wait = argv.has('--wait')

async function localShots() {
  const text = await fs.readFile(path.join(ROOT, 'screenshots.json'), 'utf8')
  const doc = JSON.parse(text)
  const list = Array.isArray(doc) ? doc : doc?.screenshots
  if (!Array.isArray(list)) throw new Error('screenshots.json 既不是数组也没有 screenshots 字段')
  return list
}

async function registryEntry() {
  const res = await fetch(REGISTRY, { headers: { 'user-agent': 'memory-eternal-check' } })
  if (!res.ok) throw new Error('registry ' + res.status)
  const body = await res.json()
  const plugins = Array.isArray(body) ? body : body.plugins
  return (plugins || []).find((p) => String(p?.name || '').toLowerCase() === NAME
    && String(p?.owner || '').toLowerCase() === OWNER.toLowerCase()) || null
}

function baseName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') } catch { return String(url) }
}

async function checkOnce() {
  const [local, entry] = await Promise.all([localShots(), registryEntry()])
  if (!entry) return { ok: false, reason: 'not-listed', local, remote: [] }
  const remote = Array.isArray(entry.screenshots) ? entry.screenshots : []
  const localNames = local.map((s) => String(s).split('/').pop())
  const remoteNames = remote.map(baseName)
  const same = remote.length === localNames.length && localNames.every((n, i) => remoteNames[i] === n)
  return { ok: same, reason: remote.length ? (same ? 'ok' : 'mismatch') : 'not-picked', local, remote, localNames, remoteNames, version: entry.version, updated: entry.updated }
}

function report(result) {
  if (asJson) { console.log(JSON.stringify(result, null, 2)); return }
  console.log('仓库：' + OWNER + '/' + NAME)
  console.log('本地 screenshots.json：' + result.local.length + ' 张 → ' + result.localNames.join(', '))
  if (result.reason === 'not-listed') {
    console.log('registry：没有这个条目（先确认 GitHub 打了 dsh-plugin topic、npm 已发布）')
    return
  }
  console.log('registry 版本：' + (result.version ?? '?') + '，screenshots：' + (result.remote.length || 0) + ' 张')
  for (const [i, url] of (result.remote || []).entries()) console.log('  ' + (i + 1) + '. ' + url)
  if (result.ok) console.log('\n✅ 已拾取：市场卡片（前 3 张）+ 详情页轮播会显示这些图。')
  else if (result.reason === 'not-picked') console.log('\n⏳ 还没拾取：nightly 构建跑完才有图（' + NIGHTLY + '）。push 构建不 probe，别急着反复推。')
  else console.log('\n⚠️ 数量/顺序与本地不一致：remote=' + (result.remoteNames || []).join(',') + '（推送后等下一次 nightly 覆盖）')
}

let result
for (;;) {
  try {
    result = await checkOnce()
  } catch (e) {
    if (asJson) console.log(JSON.stringify({ ok: false, reason: 'error', message: e.message }))
    else console.error('检查失败：' + e.message)
    process.exit(2)
  }
  report(result)
  if (result.ok || !wait) break
  if (!asJson) console.log('\n10 分钟后再看一次（Ctrl+C 退出）…')
  await new Promise((r) => setTimeout(r, 10 * 60 * 1000))
}
process.exit(result.ok ? 0 : 1)
