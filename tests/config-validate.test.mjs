// issue #35 的回归守卫：**「空字符串」只有落在 schema 声明为 number 的字段上才叫「数字没填」**。
//
// 现场：宿主面板提交的是整张表单，`secretHint` 的默认值就是空串；旧实现把任何空串都当成
// 「数字格子没填」（只豁免一份硬编码名单），于是「全新安装 + 什么都不动 + 直接点保存」必然
// HTTP 400「字段不能为空：secretHint」——**整单被拒**，用户改的数字/开关一个都存不进去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { emptyNumericFields } from '../lib/api.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

// 与真实 Config 同构的一小片 schema（放一个「不在任何豁免名单里」的新字符串字段，专门盯住这一类回归）
const DICT = {
  secretHint: z.string().default(''),
  vaultDir: z.string().default(''),
  brandNewTextField: z.string().default(''),
  recallLimit: z.number().min(1).max(20).default(5),
  sessionBudgetChars: z.number().default(80000),
}

test('空串只对 number 字段报「没填」：字符串字段（含默认值为空的）一律放行', () => {
  const full = {
    secretHint: '',            // 默认值就是空串 —— 全新安装点保存的真实形态
    vaultDir: '',
    brandNewTextField: '',     // 未来新增的可空字符串字段：不该需要谁去补豁免名单
    recallLimit: 5,
    sessionBudgetChars: 80000,
  }
  assert.deepEqual(emptyNumericFields(full, DICT), [], '整张表单原样保存不该被拒（issue #35 的核心）')

  // 真的把数字格子清空了 → 必须点出来（这是这条校验存在的理由）
  assert.deepEqual(emptyNumericFields({ ...full, recallLimit: '' }, DICT), ['recallLimit'])
  assert.deepEqual(emptyNumericFields({ sessionBudgetChars: '   ' }, DICT), ['sessionBudgetChars'], '空白串也算没填')
  // 字符串字段再怎么空都不算
  assert.deepEqual(emptyNumericFields({ secretHint: '' }, DICT), [])
  // 没声明的键不参与判定（白名单在调用方）
  assert.deepEqual(emptyNumericFields({ nope: '' }, DICT), [])
})

test('源码守卫：宿主校验必须走 schema 判定，不许再退回硬编码豁免名单', () => {
  const index = read('index.js')
  assert.match(index, /const badNum = emptyNumericFields\(clean, Config\.dict\)/, '要用 schema 派生的数字字段集')
  assert.doesNotMatch(index, /vaultDir\|captureProvider\|captureModel\|recallEmbedding\|activeVault/, '旧豁免名单不该再出现')
  assert.match(read('lib/api.js'), /export function emptyNumericFields\(/, '判定函数放在共享 api 层（宿主与独立端共用）')
})
