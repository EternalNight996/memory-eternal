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

// 跨平台「怎么调用 npm」（见下方 run() 的说明）：Windows 走 node + npm-cli.js。
const NPM = (() => {
  if (process.platform !== 'win32') return { cmd: 'npm', args: [] }
  const nodeDir = path.dirname(process.execPath)
  const hit = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((p) => fs.existsSync(p))
  return hit ? { cmd: process.execPath, args: [hit] } : { cmd: 'npm.cmd', args: [] }
})()

/** 未完成的发布动作（推送失败 / Release 失败）：最后汇总，并让退出码非零 —— 绝不淹没在"完成"里。 */
const problems = []

/**
 * npm 上真的存在这个版本吗？**只信 version 端点**。
 * 教训（0.10.21 实测）：本地 packument 缓存会说"没有"（`npm view` 404），边缘缓存又会说"有"
 * （`GET /memory-eternal` 的 versions 里查不到）—— 只有 `/memory-eternal/<版本>` 与 tarball URL 靠谱。
 */
const npmHasVersion = async (v) => {
  try {
    const r = await fetch(`https://registry.npmjs.org/memory-eternal/${v}`, { cache: 'no-store' })
    return r.status === 200
  } catch { return false }
}
// 实测：这个 registry 的 version 端点偶尔要 2 分钟才可见（0.10.22 就因为 60s 超时中断过一次发布）→ 给足 3 分钟
const waitNpmVersion = async (v, { tries = 36, delayMs = 5000 } = {}) => {
  for (let i = 0; i < tries; i++) {
    if (await npmHasVersion(v)) return true
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return false
}

const run = (cmd, argv, { cwd = ROOT, allowFail = false } = {}) => {
  // Windows 上 npm 只是 .cmd 垫片：execFileSync('npm', …) 直接 ENOENT（Node ≥18 起 spawn
  // .cmd 还要 shell:true，而 shell 拼参数对含空格/中文的 tag 与说明不安全）。所以优先用
  // 「当前 node + npm-cli.js」这两个真实文件，找不到才退回 npm.cmd。git / gh 是真实 exe，不受影响。
  const [realCmd, realArgv] = cmd === 'npm' ? [NPM.cmd, [...NPM.args, ...argv]] : [cmd, argv]
  try {
    return { ok: true, out: execFileSync(realCmd, realArgv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
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

// 构建产物一致性闸门（v0.10.3 踩过的坑）：
// npm test 会跑 build.mjs 重新生成 lib/client.js 与 web/app.js，而这两个 bundle 内嵌了
// package.json 的版本号（__ME_CLIENT_VERSION__）。如果改完版本号忘了先 npm run build 就提交，
// 这一步会把工作区弄脏 —— 结果是 tag/仓库里的 bundle 嵌的是旧版本号，而 npm 上的却是新的。
// 一旦 tag 与 npm 都发出去就很难收回，所以在打 tag、发布**之前**直接拦住。
const dirtyAfter = run('git', ['status', '--porcelain']).out
if (dirtyAfter && !flag('allow-dirty')) {
  throw new Error(
    '测试/构建后工作区变脏 —— 多半是改了版本号却没先 npm run build：\n' + dirtyAfter +
    '\n处理：npm run build 后把产物一起提交，再重新跑发布。\n（确属有意请加 --allow-dirty）',
  )
}
say('构建产物与提交一致 ✓')

// ---- 2. 发布说明 -----------------------------------------------------------
step(2, '准备发布说明')
const notesFile = opt('notes-file')
let notes = ''
if (notesFile) {
  notes = fs.readFileSync(path.resolve(ROOT, notesFile), 'utf8')
} else {
  // 从 docs/CHANGELOG.md 取该版本那一行（| **v0.10.0** | 日期 | 说明 |）；README 精简为落地页后兼容旧位置
  const logFile = ['docs/CHANGELOG.md', 'README.md'].map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f))
  const logText = logFile ? fs.readFileSync(logFile, 'utf8') : ''
  const row = logText.split(/\r?\n/).find((l) => l.startsWith(`| **${tag}**`))
  notes = [
    `## ${tag}`,
    '',
    `npm: https://www.npmjs.com/package/memory-eternal/v/${pkg.version}`,
    '',
    row ? row.replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/).slice(1).join(' — ') : '（CHANGELOG 里没有这一版，请用 --notes-file 指定）',
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
  if (DRY) {
    say(`[dry-run] 将执行：npm publish --access public（${pkg.version}）`)
  } else {
    const published = await npmHasVersion(pkg.version)
    if (published) {
      say(`npm 上已存在 ${pkg.version}，跳过发布`)
    } else {
      const r = run('npm', ['publish', '--access public'], { allowFail: true })
      if (!r.ok) throw new Error(`npm publish 失败（2FA / 网络 / 版本冲突？）：\n${r.out}`)
      say(`npm publish 已执行：memory-eternal@${pkg.version}（等待 registry 可见…）`)
    }
    // **不信 stdout，只信 registry**：publish 返回 0 不代表包真的上去了（0.10.21 实测：
    // 本地 packument/npm view 缓存会假装没有，边缘缓存又会假装有）—— 用 version 端点实证。
    // 端点滞后（实测可达数分钟）不该中断后面的 tag/push/Release —— 但也**绝不能**当成已发布：
    // 记进问题清单，继续跑完，最后汇总 + 非零退出（0.10.22 / 0.10.26 都因这里超时中断过一次发布）。
    if (!(await waitNpmVersion(pkg.version))) {
      // 端点滞后可能有几分钟（实测 0.10.26：publish 先"暂存"、稍后才落地）。再打一次 publish 探针：
      // npm 若回「previously staged / previously published / 409」——那**恰好证明版本确实进去了**。
      const probe = run('npm', ['publish', '--access', 'public'], { allowFail: true })
      const txt = String(probe.out || '')
      if (/previously staged version|previously published version|EPUBLISHCONFLICT|409/i.test(txt)) {
        say('npm version 端点滞后，但 publish 探针回报「版本已存在 / 已暂存」→ 视为**已发布**')
      } else {
        say(`⚠ npm version 端点仍未可见：https://registry.npmjs.org/memory-eternal/${pkg.version}（可能只是 CDN 滞后）`)
        problems.push(`npm 上暂时查不到 ${pkg.version} → 稍后复核（200 才算真的发布成功）：https://registry.npmjs.org/memory-eternal/${pkg.version}`)
      }
    } else {
      say(`npm 校验通过：https://registry.npmjs.org/memory-eternal/${pkg.version} → 200`)
    }
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
  // 推失败绝不能被"完成"淹没（0.10.18 实测：origin main 没上去、只有 tag 上去了，
  // 而脚本照样打印完成 —— 用户按 GitHub main 安装就会拿到旧版）。记进问题清单。
  if (!a.ok) problems.push(`${remote} main 未推送成功（${a.out.slice(0, 120)}）→ 重试：git push ${remote} main`)
  if (!b.ok) problems.push(`${remote} tag ${tag} 未推送成功（${b.out.slice(0, 120)}）→ 重试：git push ${remote} ${tag}`)
}

// 推完再**实证**每个远端的 tag 指向：Gitee / GitHub 的 Release API 会在 main 还没推上去时
// 把 tag 建在"当时的 main"上（实测踩过三次：gitee v0.10.19/20/21、origin v0.10.22 —— 都是
// "Release 创建成功"但其实指向旧提交）。这里逐个核对 peeled 提交，不一致就强制修正并如实报告。
const headSha = run('git', ['rev-parse', 'HEAD']).out
for (const remote of remotes) {
  if (DRY) continue
  const ls = run('git', ['ls-remote', remote, `refs/tags/${tag}*`], { allowFail: true })
  if (!ls.ok) { problems.push(`${remote} tag ${tag} 无法核对（${ls.out.slice(0, 120)}）`); continue }
  const peeled = (ls.out.split(/\r?\n/).find((l) => l.includes('^{}')) || '').split(/\s+/)[0] || ''
  if (!peeled) { problems.push(`${remote} 上找不到 tag ${tag} → 重试：git push ${remote} ${tag}`); continue }
  if (peeled !== headSha) {
    const fix = run('git', ['push', '--force', remote, tag], { allowFail: true })
    say(`${remote}: tag ${tag} 原指向 ${peeled.slice(0, 7)}（≠ HEAD ${headSha.slice(0, 7)}）→ ${fix.ok ? '已强制修正' : '修正失败：' + fix.out.slice(0, 120)}`)
    if (!fix.ok) problems.push(`${remote} tag ${tag} 指向错误且修正失败 → 重试：git push --force ${remote} ${tag}`)
  } else {
    say(`${remote}: tag ${tag} → ${headSha.slice(0, 7)} ✓`)
  }
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
    if (!r.ok) problems.push('GitHub Release 创建失败 → 重试：gh release create ' + tag)
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
    else { say(`⚠ Gitee Release 失败（HTTP ${res.status}）：${text.slice(0, 300)}`); problems.push('Gitee Release 创建失败（HTTP ' + res.status + '）') }
  }
}

// ---- 7. 汇总 ------------------------------------------------------------
step(7, `完成${DRY ? '（dry-run，未写任何远端）' : ''}`)
say(`版本 ${pkg.version} | tag ${tag}`)
if (problems.length) {
  say('')
  say('⚠ 有未完成的发布动作（**不要当作已发布完成**）：')
  for (const x of problems) say('  · ' + x)
  process.exitCode = 1   // 让脚本/CI 能发现"三端没齐"
}
say('提醒：桌面版用户需 `cd ~/.dsh/profiles/desktop && pnpm update memory-eternal` 后重启 DSH；')
say('      dsh web 用户需 `cd ~/.dsh/profiles/web && pnpm add memory-eternal@' + pkg.version + '`。')
