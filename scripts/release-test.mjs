#!/usr/bin/env node
// 记忆核心 · 测试版发布（只发 GitHub Pre-release）
//
// 发布通道（2026-11-19 用户指令，强制）：
//   Alpha（α） x.y.z-alpha.N  内部测试版：功能可能不完整、稳定性差
//   Beta（β）  x.y.z-beta.N   公开测试版：功能基本完成，仍有缺陷
//   RC         x.y.z-rc.N     候选发布版：接近正式版，只修 bug / 提稳定性
//
// 测试版**只建 GitHub Pre-release**：不 npm publish、不发 Gitee Release。
// 正式版 / 补丁版走 scripts/release.mjs（必须先在对话里得到用户批准，再加 --approved）。
//
// 用法：
//   node scripts/release-test.mjs --dry-run              # 只检查与打印
//   node scripts/release-test.mjs                        # 建 GitHub Pre-release（推 tag）
//   node scripts/release-test.mjs --skip-tests           # 跳过本地 npm test（CI 仍会跑）
//   node scripts/release-test.mjs --allow-dirty          # 允许未提交改动（默认拒绝）
//   node scripts/release-test.mjs --notes-file=notes.md  # 自定义发布说明
//
// 前置：
//   1. package.json 版本是 x.y.z-alpha.N / -beta.N / -rc.N，且已提交（HEAD 里的版本必须一致）
//   2. lib/client.js 与 web/app.js 已经用这个版本号构建并提交（否则先 npm run build 再提交）
//   3. gh CLI 已安装并登录（gh auth status）
//   4. 远端还没有同名 tag（测试版 tag 不覆盖）

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'EternalNight996/memory-eternal'
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, def = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const DRY = flag('dry-run')
const SKIP_TESTS = flag('skip-tests')

const say = (msg) => console.log(msg)
const step = (n, msg) => console.log(`\n=== [${n}] ${msg}`)
const problems = []

// 跨平台「怎么调用 npm」：Windows 上 execFileSync('npm') 会 ENOENT，走 node + npm-cli.js。
const NPM = (() => {
  if (process.platform !== 'win32') return { cmd: 'npm', args: [] }
  const nodeDir = path.dirname(process.execPath)
  const hit = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((p) => fs.existsSync(p))
  return hit ? { cmd: process.execPath, args: [hit] } : { cmd: 'npm.cmd', args: [] }
})()

const run = (cmd, argv, { allowFail = false } = {}) => {
  const [realCmd, realArgv] = cmd === 'npm' ? [NPM.cmd, [...NPM.args, ...argv]] : [cmd, argv]
  try {
    return { ok: true, out: execFileSync(realCmd, realArgv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim() || String(e.message || e)
    if (!allowFail) throw new Error(`${cmd} ${argv.join(' ')} 失败：\n${out}`)
    return { ok: false, out }
  }
}

// ---- 1. 版本与通道 ---------------------------------------------------------
step(1, '读取版本与发布通道')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = String(pkg.version || '').trim()
const tag = `v${version}`
const m = /-(alpha|beta|rc)\.(\d+)$/i.exec(version)
if (!m) {
  throw new Error(
    `package.json 版本 ${version} 不是测试版（应为 x.y.z-alpha.N / -beta.N / -rc.N）。\n` +
    '正式版 / 补丁版请走：node scripts/release.mjs --approved（需用户批准）',
  )
}
const channelKey = m[1].toLowerCase()
const channel = {
  alpha: { label: 'Alpha（α）', hint: '内部测试版：功能可能不完整、稳定性差，仅供内部验证' },
  beta: { label: 'Beta（β）', hint: '公开测试版：功能基本完成，仍可能存在缺陷' },
  rc: { label: 'RC（候选发布）', hint: '候选发布版：接近正式版，只做 bug 修复与稳定性提升' },
}[channelKey]
say(`版本 ${version} → tag ${tag} → 通道 ${channel.label}`)

// ---- 2. 前置检查 -----------------------------------------------------------
step(2, '前置检查')
const headPkg = JSON.parse(run('git', ['show', 'HEAD:package.json']).out)
if (String(headPkg.version) !== version) {
  throw new Error(
    `HEAD 里的 package.json 版本是 ${headPkg.version}，工作区是 ${version}。\n` +
    '测试版 tag 必须指向“版本号已经提交”的提交：先提交版本号/build 产物，再重跑。',
  )
}
say('HEAD 版本号一致 ✓')

const dirty = run('git', ['status', '--porcelain']).out
if (dirty && !flag('allow-dirty')) {
  throw new Error(`工作区有未提交改动，拒绝发布（先 commit，或加 --allow-dirty）：\n${dirty}`)
}
say('工作区干净 ✓')

// 构建产物必须已经用这个版本号构建过（否则 tag 里的 bundle 嵌的是旧版本号）
for (const f of ['lib/client.js', 'web/app.js']) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
  if (!text.includes(`"${version}"`)) {
    throw new Error(`${f} 里没有内嵌版本号 ${version} —— 先 npm run build 并把产物一起提交，再重跑测试版发布`)
  }
}
say('构建产物版本号一致 ✓')

const remoteTag = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { allowFail: true })
if (remoteTag.ok && remoteTag.out) {
  throw new Error(`远端已存在 tag ${tag}（测试版 tag 不覆盖）→ 换一个版本号（例如 ${channelKey}.N+1）`)
}
say('远端 tag 不存在 ✓')

const localTag = run('git', ['tag', '-l', tag]).out
if (localTag) {
  const at = run('git', ['rev-list', '-n', '1', tag]).out
  const head = run('git', ['rev-parse', 'HEAD']).out
  if (at !== head) throw new Error(`本地 tag ${tag} 已存在但指向 ${at.slice(0, 7)}（≠ HEAD ${head.slice(0, 7)}），请先删除或换版本号`)
  say('本地 tag 已存在且指向 HEAD ✓（复用）')
} else {
  say('本地 tag 不存在 ✓')
}

const gh = run('gh', ['--version'], { allowFail: true })
if (!gh.ok) throw new Error('未找到 gh CLI（https://cli.github.com/）；GitHub Pre-release 需要它')
const auth = run('gh', ['auth', 'status'], { allowFail: true })
if (!auth.ok) say('⚠ gh auth status 未通过（可能未登录）：gh release create 可能会失败')

if (!SKIP_TESTS) {
  step('2b', 'npm test')
  const t = run('npm', ['test'], { allowFail: true })
  if (!t.ok) throw new Error(`npm test 未通过，拒绝发布测试版：\n${t.out.slice(-3000)}`)
  say('npm test 全绿 ✓')
} else {
  say('（--skip-tests：跳过本地测试；CI 会在 tag 推上去后跑）')
}

// ---- 3. 发布说明 -----------------------------------------------------------
step(3, '准备发布说明')
const notesFile = opt('notes-file')
const notes = notesFile
  ? fs.readFileSync(path.resolve(ROOT, notesFile), 'utf8')
  : [
      `## ${tag} — 测试版（${channel.label}）`,
      '',
      `> ⚠️ 这是未经正式发布审批的测试版，仅用于验证，**不要用于生产环境**。`,
      '',
      `- 通道：${channel.label} —— ${channel.hint}`,
      `- 版本：${version}`,
      `- 安装：npm / Gitee 上没有这个版本；请从本 Release 的 Source code 解压后本地安装验证。`,
      `- 正式版发布需用户批准；问题请回到仓库 issue 反馈。`,
    ].join('\n')
const notesPath = path.join(os.tmpdir(), `memory-eternal-release-test-${tag}.md`)
fs.writeFileSync(notesPath, notes, 'utf8')
say(`发布说明写入 ${notesPath}`)

// ---- 4. 打 tag + push（只推 tag，不动 main / npm / Gitee）------------------
step(4, 'git tag + push')
if (DRY) {
  say(`[dry-run] 将执行：git tag -a ${tag} -m "<测试版说明>"`)
  say(`[dry-run] 将执行：git push origin ${tag}`)
} else {
  if (!localTag) {
    run('git', ['tag', '-a', tag, '-m', notes.split('\n').filter(Boolean).slice(0, 2).join(' / ')])
    say(`已创建 tag ${tag}`)
  }
  const push = run('git', ['push', 'origin', tag], { allowFail: true })
  say(push.ok ? `已推送 tag ${tag} → origin` : `tag 推送失败：${push.out.slice(0, 300)}`)
  if (!push.ok) problems.push(`git push origin ${tag} 失败 → 重试：git push origin ${tag}`)

  const head = run('git', ['rev-parse', 'HEAD']).out
  const ls = run('git', ['ls-remote', 'origin', `refs/tags/${tag}*`], { allowFail: true })
  const peeled = (ls.out.split(/\r?\n/).find((l) => l.includes('^{}')) || '').split(/\s+/)[0] || ''
  if (!peeled) problems.push(`远端找不到 tag ${tag} → 重试：git push origin ${tag}`)
  else if (peeled !== head) problems.push(`远端 tag ${tag} 指向 ${peeled.slice(0, 7)}（≠ HEAD ${head.slice(0, 7)}）→ git push --force origin ${tag}`)
  else say(`origin: tag ${tag} → ${head.slice(0, 7)} ✓`)
}

// ---- 5. GitHub Pre-release（唯一会写远端的地方）---------------------------
step(5, 'GitHub Pre-release')
const title = opt('title') || `${tag} — 测试版 ${channel.label}`
if (DRY) {
  say(`[dry-run] 将执行：gh release create ${tag} --repo ${REPO} --title "${title}" --notes-file … --prerelease`)
} else {
  const exists = run('gh', ['release', 'view', tag, '--repo', REPO], { allowFail: true })
  if (exists.ok) {
    const r = run('gh', ['release', 'edit', tag, '--repo', REPO, '--title', title, '--notes-file', notesPath, '--prerelease'], { allowFail: true })
    say(r.ok ? `GitHub Pre-release 已存在 → 已更新说明：${tag}` : `GitHub Pre-release 更新失败：${r.out.slice(0, 300)}`)
    if (!r.ok) problems.push(`GitHub Pre-release 更新失败 → 重试：gh release edit ${tag} --prerelease`)
  } else {
    const r = run('gh', ['release', 'create', tag, '--repo', REPO, '--title', title, '--notes-file', notesPath, '--prerelease', '--verify-tag'], { allowFail: true })
    say(r.ok ? `GitHub Pre-release 创建成功：${r.out}` : `GitHub Pre-release 失败：${r.out.slice(0, 300)}`)
    if (!r.ok) problems.push(`GitHub Pre-release 创建失败 → 重试：gh release create ${tag} --prerelease`)
  }
}

// ---- 6. 汇总 ---------------------------------------------------------------
step(6, `完成${DRY ? '（dry-run，未写任何远端）' : ''}`)
say(`通道 ${channel.label} | 版本 ${version} | tag ${tag}`)
say('未做（按规则）：npm publish、Gitee Release、main 分支推送')
if (problems.length) {
  say('')
  say('⚠ 有未完成的发布动作（**不要当作已发布完成**）：')
  for (const x of problems) say('  · ' + x)
  process.exitCode = 1
}
