// 审核中心搜索框的纯函数层：标题 / 摘要 / 原因 / 路径 / 标签 / 提交者。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditMatches } from '../src/client/audit-filter.js'

const card = {
  title: '技能：create-skill 生成规范技能',
  summary: '从本机技能目录自动生成技能卡',
  reason: '根据实际技能生成',
  path: '10-Skills/create-skill.md',
  submittedBy: 'skill-sync',
  tags: ['skill', 'dsh', 'authoring'],
}

test('空搜索命中全部；按标题中文子串命中', () => {
  assert.equal(auditMatches(card, ''), true)
  assert.equal(auditMatches(card, '   '), true)
  assert.equal(auditMatches(card, '生成规范'), true)
  assert.equal(auditMatches(card, '不存在的词'), false)
})

test('标签 / 路径 / 提交者 / 原因都能搜到', () => {
  assert.equal(auditMatches(card, 'authoring'), true)
  assert.equal(auditMatches(card, '10-Skills'), true)
  assert.equal(auditMatches(card, 'skill-sync'), true)
  assert.equal(auditMatches(card, '实际技能'), true)
})

test('空格分隔多词是 AND；大小写不敏感', () => {
  assert.equal(auditMatches(card, 'SKILL dsh'), true)
  assert.equal(auditMatches(card, 'skill missing'), false)
  assert.equal(auditMatches({ ...card, title: 'Hello World' }, 'hello world'), true)
})

test('畸形卡（tags 不是数组）不抛错', () => {
  assert.equal(auditMatches({ title: '普通卡', tags: 'not-an-array' }, '普通'), true)
  assert.equal(auditMatches(null, 'x'), false)
})
