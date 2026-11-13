// 私有组件边界守卫：云端多租户（cloud-auth / cloud-server）属于商用私有部分，
// **不允许**随开源包发布；同时插件本体不能静态依赖它（否则开源包启动即崩）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const web = fs.readFileSync('lib/web.js', 'utf8')

test('私有包命名固定为 memory-eternal-cloud，且版本跟随宿主插件', () => {
  const cloudPkgPath = 'private/memory-eternal-cloud/package.json'
  assert.ok(fs.existsSync(cloudPkgPath), '私有包目录必须在（private/memory-eternal-cloud）')
  const cloudPkg = JSON.parse(fs.readFileSync(cloudPkgPath, 'utf8'))
  assert.equal(cloudPkg.name, 'memory-eternal-cloud', '包名固定为 memory-eternal-cloud')
  assert.equal(cloudPkg.private, true, '必须是 private，防止误发公共 npm')
  assert.equal(cloudPkg.version, pkg.version, '版本跟随宿主插件（否则兼容矩阵会对不上）')
  // 打包脚本存在且能列出清单
  assert.ok(fs.existsSync('scripts/pack-cloud.mjs'), '要有私有打包脚本')
  assert.equal(pkg.scripts['cloud:pack'], 'node scripts/pack-cloud.mjs')
})

test('开源包排除 private/ 与 dist/（私有产物不进公共发布）', () => {
  for (const must of ['!private', '!dist']) {
    assert.ok(pkg.files.includes(must), `files 里缺少排除项：${must}`)
  }
})

test('package.json 的 files 显式排除私有模块', () => {
  const excluded = pkg.files.filter((f) => f.startsWith('!'))
  for (const must of ['!lib/cloud-auth.js', '!lib/cloud-server.js', '!lib/license.js', '!lib/entitlement.js', '!docs/CLOUD.md', '!docs/LICENSE.md']) {
    assert.ok(excluded.includes(must), `files 里缺少排除项：${must}`)
  }
  // 白名单目录（lib）本身在里面，排除项必须排在后面才生效（npm 按顺序应用）
  assert.ok(pkg.files.includes('lib'), 'lib 仍是白名单目录')
})

test('web.js 不静态 import 云端模块（静态依赖会让开源包启动即崩）', () => {
  assert.doesNotMatch(web, /^import\s+\{[^}]*createCloudServer[^}]*\}\s+from\s+'\.\/cloud-server\.js'/m,
    '不允许静态 import cloud-server')
  assert.match(web, /await import\('\.\/cloud-server\.js'\)/, '必须是动态 import（首次请求时加载）')
})

test('云端模块缺失时给明确提示，且本地模式不受影响', () => {
  assert.match(web, /云端模块未安装（商用私有组件）/, '缺文件要有可读日志')
  // 云端分支必须被 cloudMode 包住，默认路径完全不走它
  assert.match(web, /if \(cloudMode && p\.startsWith\(API_PREFIX\)\)/, '云端分支只在 cloudMode 下生效')
})

test('私有模块只依赖公开内部契约（api / db / capture-run）与彼此', () => {
  // 允许的依赖：公开出口 + 私有模块之间互相依赖（cloud-server ⇄ cloud-auth 是一套的）
  const ALLOWED = ['api.js', 'db.js', 'capture-run.js', 'vault.js', 'cloud-auth.js', 'cloud-server.js', 'license.js', 'entitlement.js']
  for (const f of ['lib/cloud-auth.js', 'lib/cloud-server.js']) {
    if (!fs.existsSync(f)) continue // 开源分发里没有这两个文件，跳过检查
    const src = fs.readFileSync(f, 'utf8')
    const imports = [...src.matchAll(/from '\.\/([\w.-]+\.js)'/g)].map((m) => m[1])
    for (const dep of imports) {
      assert.ok(ALLOWED.includes(dep), `${f} 依赖了非契约模块：${dep}（私有模块只允许依赖公开出口或彼此）`)
    }
  }
})
