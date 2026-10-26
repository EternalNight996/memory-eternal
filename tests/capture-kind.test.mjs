// 关闭蒸馏 / 蒸馏失败兜底时，原文卡也要做启发式类型判断；
// 不能所有自动沉淀都是 content。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guessRawKind } from '../lib/capture.js'

test('长期偏好/硬约束 → core（仍会被强制待审）', () => {
  assert.equal(guessRawKind({ title: '用户偏好', body: '以后所有回复都用中文，永远记住。' }), 'core')
  assert.equal(guessRawKind({ title: '硬约束', body: '这是核心记忆：不要再用英文思考。' }), 'core')
})

test('报错/根因 → mistake', () => {
  assert.equal(guessRawKind({ title: 'PowerShell 报错', body: '报错根因是缓冲区隐式转码，修复方式是设置 UTF-8。' }), 'mistake')
})

test('安装/命令/环境 → tool', () => {
  assert.equal(guessRawKind({ title: '环境配置', body: '用 pnpm 安装依赖，配置环境变量和端口。' }), 'tool')
})

test('项目/需求 → project；商业 → business；内容创作 → content', () => {
  assert.equal(guessRawKind({ title: '项目进度', body: '本周里程碑：需求评审、排期和上线计划。' }), 'project')
  assert.equal(guessRawKind({ title: '客户报价', body: '合同价格、预算和付费订阅方案。' }), 'business')
  assert.equal(guessRawKind({ title: '宣传文案', body: '文章标题、封面和视频脚本素材。' }), 'content')
})

test('普通技术知识默认 knowledge，不再默认 content', () => {
  assert.equal(guessRawKind({ title: '数组去重', body: '可以用 Set 对数组去重，时间复杂度 O(n)。' }), 'knowledge')
})
