// patch 形状守卫：memory-eternal 的 bundle patch 里**不能出现 config.enabled**。
//
// 为什么：DSH 在插件条目上自己维护一个 enabled 开关，与插件 Config 的同名字段撞车，
// 会把对象塞进 `$.enabled` —— 结果是 `ValidationError: $.enabled expected boolean but got [object Object]`，
// 整条插件被拒绝激活，面板白屏。插件 Config 里保留该字段（默认 true）即可，不需要在 patch 里写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const yamlPath = path.join(root, 'cordis.patch.yml')

test('bundle patch 存在且是 insert 形式', () => {
  assert.ok(existsSync(yamlPath), 'cordis.patch.yml 必须存在（package.json 的 dsh.bundle.patch 指向它）')
  const src = readFileSync(yamlPath, 'utf8')
  assert.match(src, /- insert:/, '必须是 insert 形式：插件由 bundle 层注册，profile 层按 id 覆盖')
  assert.match(src, /id: memory-eternal/, '必须注册 memory-eternal 条目')
})

test('patch 的 config 里不得出现 enabled（与 DSH 启停开关同名，会白屏）', () => {
  const src = readFileSync(yamlPath, 'utf8')
  // 只看 memory-eternal 条目里 config: 之后的缩进块
  const block = src.split('id: memory-eternal')[1] || ''
  const configPart = block.split(/\n\s*-\s/)[0]         // 到下一个条目为止
  const hit = /^\s+enabled\s*:/m.test(configPart)
  assert.equal(hit, false, 'config 下不能写 enabled —— 改用插件 Config 的默认值（true）')
})

test('插件 Config 仍保留 enabled 字段（默认 true，供设置页/开关使用）', () => {
  const idx = readFileSync(path.join(root, 'index.js'), 'utf8')
  assert.match(idx, /enabled:\s*z\.boolean\(\)\.default\(true\)/, 'Config.enabled 必须保留为 boolean')
})
