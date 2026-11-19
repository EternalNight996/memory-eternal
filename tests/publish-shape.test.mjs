// 发布形态守卫：npm 包只带 files 白名单内的文件，私有模块（cloud-server/billing/…）会被剔除。
// 一旦公开模块（index.js / api.js / vault.js …）静态 import 了私有模块，装包用户启动就会
// ERR_MODULE_NOT_FOUND —— 仓库里因为全文件都在，测试全绿也发现不了。
//
// 这条守卫把「发布形态」真的构造出来再加载一次，是唯一能提前发现该问题的方式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, rmSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const SRC = process.cwd()
const pkg = JSON.parse(readFileSync(path.join(SRC, 'package.json'), 'utf8'))
const excluded = (pkg.files || []).filter((f) => f.startsWith('!')).map((f) => f.slice(1))
const privateNames = new Set(excluded.map((e) => path.basename(e)))

test('公开模块不得 import 私有模块（发布态会缺文件）', () => {
  const bad = []
  for (const f of readdirSync(path.join(SRC, 'lib'))) {
    if (!f.endsWith('.js')) continue
    // 私有模块之间互相依赖是允许的（它们会被整体剔除）；只查公开 → 私有这一种
    if (privateNames.has(f)) continue
    const src = readFileSync(path.join(SRC, 'lib', f), 'utf8')
    for (const m of src.matchAll(/from '\.\/([\w.-]+\.js)'/g)) {
      if (privateNames.has(m[1])) bad.push(f + ' -> ' + m[1])
    }
  }
  assert.deepEqual(bad, [], '这些公开模块引用了会被 npm 剔除的私有模块：' + bad.join(', '))
})

test('按 files 白名单构造发布态后，index.js 与 api.js 仍能加载', async () => {
  // 必须放在仓库内：index.js 静态 import @deepseek-ai/schemastery 等依赖，
  // 放 os.tmpdir() 时向上找不到 node_modules，CI（Linux）会直接 ERR_MODULE_NOT_FOUND。
  const DST = mkdtempSync(path.join(SRC, '.tmp-publish-shape-'))
  mkdirSync(DST, { recursive: true })
  try {
    for (const f of ['index.js', 'package.json']) cpSync(path.join(SRC, f), path.join(DST, f))
    cpSync(path.join(SRC, 'lib'), path.join(DST, 'lib'), { recursive: true })
    for (const rel of excluded) {
      const p = path.join(DST, rel)
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }
    await import('file:///' + DST + '/index.js')
    await import('file:///' + DST + '/lib/api.js')
  } finally {
    rmSync(DST, { recursive: true, force: true })
  }
})
