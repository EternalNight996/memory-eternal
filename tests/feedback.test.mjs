// 「反馈异常」回归：脱敏必须真的生效（issue 是公开的），预填链接与提示词必须可用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, buildDiagnostics, buildIssueUrl, buildIssueBody, buildAgentPrompt } from '../lib/feedback.js'

const SEP = String.fromCharCode(92)
const home = 'C:' + SEP + 'Users' + SEP + 'alice'
const vault = home + SEP + '.dsh' + SEP + 'memory-vault'

test('脱敏：home 目录 → ~，key/token → ***', () => {
  const out = redactText(vault, home)
  assert.ok(out.startsWith('~'), 'home 应被替换为 ~：' + out)
  assert.ok(!out.includes(home), '不得残留 home 绝对路径')
  assert.ok(redactText('/home/bob/.dsh/x').includes('~'), 'POSIX home 也要脱敏')
  assert.ok(!redactText('/home/bob/.dsh/x').includes('/home/bob'))
  for (const secret of ['sk-abcdefghijklmnopqrst', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'api_key: "1234567890abcdef"']) {
    const r = redactText(secret, home)
    assert.ok(r.includes('***') || !r.includes(secret), '密钥必须被替换：' + secret + ' → ' + r)
  }
})

test('诊断信息：关键字段齐全、已脱敏、且限长', () => {
  const text = buildDiagnostics({
    version: '0.9.12',
    dshVersion: '0.1.7-rc.2',
    host: 'deepseek-harness',
    os: 'win32 x64 (node v24)',
    vaultDir: vault,
    vaultSource: 'default',
    cards: 598,
    health: { ok: false, reason: 'MISSING_CREDENTIAL' },
    captureLog: [{ at: '2026-09-28', action: 'fail', note: 'key sk-abcdefghijklmnopqrst 无效' }],
  }, home)
  assert.ok(text.includes('### 诊断信息'))
  assert.ok(text.includes('memory-eternal: 0.9.12'))
  assert.ok(text.includes('Cards: 598'))
  assert.ok(text.includes('FAIL'), '健康态异常要带出来')
  assert.ok(!text.includes(home), '诊断文本不得含 home 路径')
  assert.ok(!text.includes('sk-abcdefghijklmnopqrst'), '日志里的密钥也要脱敏')
  const long = buildDiagnostics({ version: 'x'.repeat(5000) }, home)
  assert.ok(long.length <= 2450, '诊断要限长（贴进 issue 不能无限膨胀）')
})

test('预填 issue 链接：标题/正文/标签都被编码，超长自动截断', () => {
  const url = buildIssueUrl({ title: '[Bug] 图谱卡顿', body: buildIssueBody({ description: '打开图谱卡 3 秒', diagnostics: '### 诊断信息', version: '0.9.12' }) })
  assert.ok(url.startsWith('https://github.com/EternalNight996/memory-eternal/issues/new?'))
  const q = new URLSearchParams(url.split('?')[1])
  assert.equal(q.get('title'), '[Bug] 图谱卡顿')
  assert.ok(q.get('body').includes('## 现象'))
  assert.ok(q.get('body').includes('打开图谱卡 3 秒'))
  assert.equal(q.get('labels'), 'bug')
  const huge = buildIssueUrl({ title: 't', body: 'x'.repeat(20000), maxLength: 1200 })
  assert.ok(huge.length <= 1300, '超长必须截断到阈值内，实测 ' + huge.length)
  assert.ok(decodeURIComponent(huge).includes('已截断'))
})

test('给 AI 的提示词：中文/英文都含仓库、流程、描述与诊断占位', () => {
  const zh = buildAgentPrompt({ description: '点开图谱卡 3 秒', diagnostics: '### 诊断信息\n- Cards: 598' })
  assert.ok(zh.includes('EternalNight996/memory-eternal'))
  assert.ok(zh.includes('gh issue create'))
  assert.ok(zh.includes('gh issue list'), '要先查重，避免重复开 issue')
  assert.ok(zh.includes('点开图谱卡 3 秒'), '用户描述要嵌进去')
  assert.ok(zh.includes('Cards: 598'), '诊断信息要嵌进去')
  assert.ok(!zh.includes('<在这里写你的问题>'), '填过占位符就不该再留占位')
  const en = buildAgentPrompt({ lang: 'en', description: 'graph is slow', diagnostics: 'diag' })
  assert.ok(en.includes('gh issue create') && en.includes('graph is slow') && en.includes('diag'))
})
