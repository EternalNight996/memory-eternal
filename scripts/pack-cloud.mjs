// 打私有包：memory-eternal-cloud-<version>.tgz
//
// 为什么单独打：云端服务端（多租户 + 鉴权）是商用私有组件，**不随开源插件发布**。
// 授权客户拿到这个 tgz，解到 private/memory-eternal-cloud/ 再把 lib/cloud-*.js
// 放回插件 lib/ 即可启用（插件用动态 import 加载，见 docs/PRIVATE.md）。
//
// 用法：
//   node scripts/pack-cloud.mjs            打包
//   node scripts/pack-cloud.mjs --dry-run  只列清单不打包
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const NAME = 'memory-eternal-cloud'
const PKG_DIR = path.join(ROOT, 'private', NAME)
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
const dry = process.argv.includes('--dry-run')

// 私有源码常驻 lib/（插件要按相对路径加载），打包时按包内清单收集
const SOURCES = [
  // cloud-server.js 的真实依赖（0.48.6 起必须全带上）：
  // 它 import 了 billing / entitlement / license / oidc / quota / webhook，
  // 而 npm 包把这些都排除了 —— 只打 cloud-server + cloud-auth 会让授权客户的
  // 全新安装直接 ERR_MODULE_NOT_FOUND（本次云端升级就踩到了：entitlement 的
  // epoch 毫秒修复根本没被覆盖上去，配额还在按 enterprise 兜底跑）。
  ['lib/cloud-auth.js', 'lib/cloud-auth.js'],
  ['lib/cloud-server.js', 'lib/cloud-server.js'],
  ['lib/billing.js', 'lib/billing.js'],
  ['lib/entitlement.js', 'lib/entitlement.js'],
  ['lib/license.js', 'lib/license.js'],
  ['lib/oidc.js', 'lib/oidc.js'],
  ['lib/quota.js', 'lib/quota.js'],
  ['lib/webhook.js', 'lib/webhook.js'],
  ['docs/CLOUD.md', 'docs/CLOUD.md'],
  ['docs/PRIVATE.md', 'docs/PRIVATE.md'],
  ['private/memory-eternal-cloud/README.md', 'README.md'],
  ['private/memory-eternal-cloud/COMPAT.md', 'COMPAT.md'],
  ['private/memory-eternal-cloud/LICENSE-PRIVATE', 'LICENSE-PRIVATE'],
]

const missing = SOURCES.filter(([src]) => !fs.existsSync(path.join(ROOT, src)))
if (missing.length) {
  console.error('✘ 缺文件：' + missing.map((m) => m[0]).join(', '))
  process.exit(1)
}

const versionOk = String(pkg.version) === JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
console.log(`包名 ${NAME} · 版本 ${pkg.version}${versionOk ? '' : '（⚠ 与宿主插件版本不一致）'}`)
console.log('清单：')
for (const [src, dst] of SOURCES) console.log(`  ${src} → ${dst}`)

if (dry) {
  console.log('\n--dry-run：只列清单，未打包')
  process.exit(0)
}

// 组装到一个临时目录再 tar（保持包内相对路径干净）
const stage = path.join(ROOT, '.tmp-cloud-pack')
fs.rmSync(stage, { recursive: true, force: true })
for (const [src, dst] of SOURCES) {
  const to = path.join(stage, dst)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(path.join(ROOT, src), to)
}
fs.copyFileSync(path.join(PKG_DIR, 'package.json'), path.join(stage, 'package.json'))

const out = path.join(ROOT, 'dist', `${NAME}-${pkg.version}.tgz`)
fs.mkdirSync(path.dirname(out), { recursive: true })
try {
  // Windows 10+ 自带 bsdtar
  execFileSync('tar', ['-czf', out, '-C', stage, '.'], { stdio: 'inherit' })
} catch (e) {
  console.error('✘ 打包失败（需要系统有 tar）：' + ((e && e.message) || e))
  process.exit(1)
}
fs.rmSync(stage, { recursive: true, force: true })
const size = fs.statSync(out).size
console.log(`\n✔ 已生成 ${path.relative(ROOT, out)}（${Math.round(size / 1024)} KB）`)
console.log('  授权客户安装：见 private/memory-eternal-cloud/README.md')
