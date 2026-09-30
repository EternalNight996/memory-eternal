#!/usr/bin/env node
// 记忆核心 · 正式版发布（npm + GitHub + Gitee Releases + tag 同步）
//
// 为什么要有这个脚本：桌面版的 profile 依赖是 `github:EternalNight996/memory-eternal`，
// dsh web 的 profile 走 npm 版本号，Gitee 是镜像 + Release 归档。三边任一漏掉，
// 就会出现「npm 上有新版、桌面版还是旧的」这类不一致（v0.9.16–0.9.23 就漏打了 tag）。
//
// 用法：
//   node scripts/release.mjs --dry-run          # 只做检查与打印，不写任何远端
//   node scripts/release.mjs                    # 正式发布（会 npm publish + push + 建 Release）
//   node scripts/release.mjs --skip-npm         # 只同步 git/GitHub/Gitee
//   node scripts/release.mjs --only-gitee       # 只补建 Gitee Release
//   node scripts/release.mjs --allow-dirty      # 允许带未提交改动发布（默认拒绝）
//   node scripts/release.mjs --tag=v0.10.0 --notes-file=notes.md
//
// Gitee 需要 token：环境变量 `GITEE_TOKEN`，或文件 `~/.config/memory-eternal/gitee-token`
// （一行 token，不要提交进仓库）。token 需要在 Gitee → 设置 → 私人令牌 生成，
// 勾选 `projects`（仓库读写）。**没有 token 就跳过、并明确打印为「未同步」，不要假装成功。**
//
// 发布前顺序：先让 `npm test` 全绿；本脚本会再跑一次（`--skip-tests` 可跳过）。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, def = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const DRY = flag('dry-run')
const SKIP_NPM = flag('skip-npm') || flag('only-gitee')
const ONLY_GITEE = flag('only-gitee')
const SKIP_TESTS = flag('skip-tests')

const run = (cmd, argv, { cwd = ROOT, allowFail = false } = {}) => {
  try {
    return { ok: true, out: execFileSync(cmd, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim() || String(e.message || e)
    if (!allowFail) throw new Error(`${cmd} ${argv.join(' ')} 失败：\n${out}`)
    return { ok: false, out }
  }
}
const say = (msg) => console.log(msg)
const step = (n, msg) => console.log(`\n=== [${n}] ${msg}`)

// ---- 1. 版本与前置检查 ------------------------------------------------------
step(1, '读取版本与前置检查')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const tag = opt('tag') || `v${pkg.version}`
say(`package.json version = ${pkg.version} → tag = ${tag}`)
if (tag !== `v${pkg.version}` && !flag('allow-tag-mismatch')) {
  throw new Error(`tag(${tag}) 与 package.json 版本(${pkg.version}) 不一致；确属有意请加 --allow-tag-mismatch`)
}

const dirty = run('git', ['status', '--porcelain']).out
if (dirty && !flag('allow-dirty')) {
  throw new Error(`工作区有未提交改动，拒绝发布（先 commit，或加 --allow-dirty）：\n${dirty}`)
}
say('工作区干净 ✓')

if (!SKIP_TESTS) {
  step('1b', 'npm test')
  const t = run('npm', ['test'], { allowFail: true })
  if (!t.ok) throw new Error(`npm test 未通过，拒绝发布：\n${t.out.slice(-3000)}`)
  say('npm test 全绿 ✓')
} else {
  say('（--skip-tests：跳过测试）')
}

// ---- 2. 发布说明 -----------------------------------------------------------
step(2, '准备发布说明')
const notesFile = opt('notes-file')
let notes = ''
if (notesFile) {
  notes = fs.readFileSync(path.resolve(ROOT, notesFile), 'utf8')
} else {
  // 从 README 更新日志表里取该版本那一行（| **v0.10.0** | 日期 | 说明 |）
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const row = readme.split(/\r?\n/).find((l) => l.startsWith(`| **${tag}**`))
  notes = [
    `## ${tag}`,
    '',
    `npm: https://www.npmjs.com/package/memory-eternal/v/${pkg.version}`,
    '',
    row ? row.replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/).slice(1).join(' — ') : '（README 更新日志里没有这一版，请用 --notes-file 指定）',
  ].join('\n')
}
say(notes.split('\n').slice(0, 6).join('\n') + (notes.split('\n').length > 6 ? '\n…' : ''))
const notesPath = path.join(os.tmpdir(), `memory-eternal-release-${tag}.md`)
fs.writeFileSync(notesPath, notes, 'utf8')
say(`发布说明写入 ${notesPath}`)

// ---- 3. npm publish -------------------------------------------------------
step(3, 'npm publish')
if (SKIP_NPM) {
  say('（已跳过）')
} else {
  const already = run('npm', ['view', `memory-eternal@${pkg.version}`, 'version'], { allowFail: true })
  if (already.ok && already.out.includes(pkg.version)) {
    say(`npm 上已存在 ${pkg.version}，跳过发布`)
  } else if (DRY) {
    say(`[dry-run] 将执行：npm publish --access public（${pkg.version}）`)
  } else {
    const r = run('npm', ['publish', '--access public'], { allowFail: true })
    if (!r.ok) throw new Error(`npm publish 失败（2FA / 网络 / 版本冲突？）：\n${r.out}`)
    say(`npm publish 完成：memory-eternal@${pkg.version}`)
  }
}

// ---- 4. git tag + push（GitHub + Gitee） ----------------------------------
step(4, 'git tag + push')
const hasTag = run('git', ['tag', '-l', tag]).out === tag
if (!hasTag) {
  if (DRY) say(`[dry-run] 将执行：git tag -a ${tag} -m "<发布说明首行>"`)
  else {
    run('git', ['tag', '-a', tag, '-m', notes.split('\n').filter(Boolean).slice(0, 2).join(' / ')])
    say(`已创建 tag ${tag}`)
  }
} else {
  say(`tag ${tag} 已存在`)
}
const remotes = run('git', ['remote']).out.split(/\s+/).filter(Boolean)
for (const remote of remotes) {
  if (DRY) { say(`[dry-run] 将执行：git push ${remote} main && git push ${remote} ${tag}`); continue }
  const a = run('git', ['push', remote, 'main'], { allowFail: true })
  const b = run('git', ['push', remote, tag], { allowFail: true })
  say(`${remote}: main ${a.ok ? '✓' : '✗ ' + a.out.slice(0, 200)} | tag ${b.ok ? '✓' : '✗ ' + b.out.slice(0, 200)}`)
}

// ---- 5. GitHub Release ---------------------------------------------------
step(5, 'GitHub Release')
if (DRY) say(`[dry-run] 将执行：gh release create ${tag} --title … --notes-file …`)
else {
  const exists = run('gh', ['release', 'view', tag, '--repo', 'EternalNight996/memory-eternal'], { allowFail: true })
  const title = opt('title') || `${tag} — ${notes.split('\n').find((l) => l.startsWith('## '))?.slice(3) || 'release'}`
  if (exists.ok) {
    const r = run('gh', ['release', 'edit', tag, '--repo', 'EternalNight996/memory-eternal', '--title', title, '--notes-file', notesPath], { allowFail: true })
    say(`GitHub Release 已存在 → ${r.ok ? '已更新说明' : '更新失败：' + r.out.slice(0, 200)}`)
  } else {
    const r = run('gh', ['release', 'create', tag, '--repo', 'EternalNight996/memory-eternal', '--title', title, '--notes-file', notesPath], { allowFail: true })
    say(r.ok ? `GitHub Release 创建成功：${r.out}` : `GitHub Release 失败：${r.out.slice(0, 300)}`)
  }
}

// ---- 6. Gitee Release ---------------------------------------------------
step(6, 'Gitee Release')
const giteeToken = (() => {
  if (process.env.GITEE_TOKEN) return process.env.GITEE_TOKEN.trim()
  const f = path.join(os.homedir(), '.config', 'memory-eternal', 'gitee-token')
  try { return fs.readFileSync(f, 'utf8').trim() } catch { return '' }
})()
if (!giteeToken) {
  say('⚠ 未找到 Gitee token → **Gitee Release 未同步**（不算成功）')
  say('  解决：设置环境变量 GITEE_TOKEN，或写入 ~/.config/memory-eternal/gitee-token（一行）')
  say('  token 需在 Gitee → 设置 → 私人令牌 生成，勾选 projects 权限')
} else if (DRY) {
  say('[dry-run] 将执行：POST https://gitee.com/api/v5/repos/EternalNight996/memory-eternal/releases')
} else {
  const repo = 'EternalNight996/memory-eternal'
  const list = await fetch(`https://gitee.com/api/v5/repos/${repo}/releases?access_token=${encodeURIComponent(giteeToken)}&per_page=100`)
    .then((r) => r.json()).catch(() => null)
  if (!Array.isArray(list)) {
    say('⚠ Gitee 查询失败（token 无效 / 网络）：Gitee Release 未同步')
  } else if (list.some((x) => x.tag_name === tag)) {
    say(`Gitee Release 已存在（${tag}），跳过`)
  } else {
    const body = new URLSearchParams({ access_token: giteeToken, tag_name: tag, name: `${tag} — ${pkg.description.slice(0, 40)}`, body: notes, target_commitish: 'main', prerelease: 'false' })
    const res = await fetch(`https://gitee.com/api/v5/repos/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const text = await res.text()
    if (res.ok) say(`Gitee Release 创建成功：${tag}`)
    else say(`⚠ Gitee Release 失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }
}

// ---- 7. 汇总 ------------------------------------------------------------
step(7, `完成${DRY ? '（dry-run，未写任何远端）' : ''}`)
say(`版本 ${pkg.version} | tag ${tag}`)
say('提醒：桌面版用户需 `cd ~/.dsh/profiles/desktop && pnpm update memory-eternal` 后重启 DSH；')
say('      dsh web 用户需 `cd ~/.dsh/profiles/web && pnpm add memory-eternal@' + pkg.version + '`。')
