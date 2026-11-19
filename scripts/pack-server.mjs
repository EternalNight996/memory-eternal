#!/usr/bin/env node
// 打服务端发布产物：memory-eternal-server-<version>.tgz
//
// 为什么需要它（而不是拆分代码库）：
//   · 实测依赖闭包：服务端 lib/web.js 需要 74 个 lib 模块，客户端需要 79 个，
//     仅服务端专属 = 0 个 —— 代码层面没有可拆的东西，拆开就是同一份代码复制两份，必然漂移。
//   · 真正混的是发布产物：整仓 17.8 MB 里，client.js(1.6M) + web/app.js(1.9M)
//     + assets(7.8M) + bench(278M) 服务端一个都用不到。
//   · 所以：同一份源码，两个产物。本脚本产出只含服务端所需文件的 tgz。
//
// 用法：
//   node scripts/pack-server.mjs             打包（API-only，不含网页 UI）
//   node scripts/pack-server.mjs --dry-run   只列清单
//   node scripts/pack-server.mjs --with-web  额外带上网页 UI
import { readdirSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const withWeb = process.argv.includes('--with-web')
const dry = process.argv.includes('--dry-run')

const CLIENT_ONLY = new Set(['client.js'])
const libFiles = readdirSync(path.join(ROOT, 'lib'))
  .filter((f) => f.endsWith('.js') && !CLIENT_ONLY.has(f))
  .sort()

const extras = [
  ['bin/dsh-memory.mjs', 'bin/dsh-memory.mjs'],
  ['web/index.html', 'web/index.html'],
  ['docs/CLOUD.md', 'docs/CLOUD.md'],
  ['docs/PRIVATE.md', 'docs/PRIVATE.md'],
]
if (withWeb) extras.push(['web/app.js', 'web/app.js'], ['assets/icon.png', 'assets/icon.png'])

const entries = [...libFiles.map((f) => ['lib/' + f, 'lib/' + f]), ...extras]
  .filter(([src]) => existsSync(path.join(ROOT, src)))
const missing = extras.filter(([src]) => !existsSync(path.join(ROOT, src))).map(([src]) => src)

console.log('包名 memory-eternal-server · 版本 ' + pkg.version)
console.log('lib 模块 ' + libFiles.length + ' 个' + (withWeb ? '（含网页 UI）' : '（API-only）'))
if (missing.length) console.log('缺文件（跳过）：' + missing.join(', '))

let total = 0
for (const [src] of entries) total += statSync(path.join(ROOT, src)).size
console.log('清单合计 ' + Math.round(total / 1024) + ' KB（整仓 17.8 MB）')

if (dry) {
  for (const [src] of entries) console.log('  ' + src)
  console.log('')
  console.log('--dry-run：未打包')
  process.exit(0)
}

const stage = path.join(ROOT, '.tmp-server-pack')
rmSync(stage, { recursive: true, force: true })
for (const [src, dst] of entries) {
  const to = path.join(stage, dst)
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(path.join(ROOT, src), to)
}

const sp = { ...pkg }
sp.name = 'memory-eternal-server'
sp.private = true
delete sp.files
delete sp.devDependencies
sp.description = 'Memory Eternal 服务端（多租户记忆库 API）。由 scripts/pack-server.mjs 从主仓产出，勿手改。'
writeFileSync(path.join(stage, 'package.json'), JSON.stringify(sp, null, 2) + '\n')

const out = path.join(ROOT, 'dist', 'memory-eternal-server-' + pkg.version + '.tgz')
mkdirSync(path.dirname(out), { recursive: true })
execFileSync('tar', ['-czf', out, '-C', stage, '.'], { stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
const size = statSync(out).size
console.log('')
console.log('✔ ' + out.replace(ROOT + path.sep, '') + '（' + Math.round(size / 1024) + ' KB）')
