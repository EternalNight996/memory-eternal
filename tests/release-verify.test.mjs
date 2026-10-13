// 发布链自身的守卫：0.10.18（origin main 静默没上去）与 0.10.21（"npm publish 完成"但其实
// 查不到版本）两次都差点让我误报"三端已同步"。教训固化在脚本里，这里盯住不许退化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'scripts/release.mjs'), 'utf8')

test('npm 发布必须用 version 端点实证（不信 publish 的 stdout，也不信 packument 缓存）', () => {
  assert.match(src, /const npmHasVersion = async/, '要有"这个版本真的在吗"的判定')
  assert.match(src, /registry\.npmjs\.org\/memory-eternal\/\$\{v\}/, '要打 version 端点（packument 会被边缘缓存骗）')
  assert.match(src, /await waitNpmVersion\(pkg\.version\)/, '发布后要等它可见')
  // 端点滞后（实测可达数分钟）不中断后续步骤，但**必须记进问题清单**（非零退出），
  // 或用 publish 探针的 409（"previously staged / published"）证明版本确实进去了。
  assert.match(src, /previously staged version\|previously published version/, '滞后时用 publish 探针判定')
  assert.match(src, /problems\.push\(\`npm 上暂时查不到/, '拿不准就要记进问题清单，不许当成功')
})

test('推完必须核对每个远端的 tag 指向 HEAD（Release API 会把 tag 建在旧 main 上）', () => {
  assert.match(src, /const headSha = run\('git', \['rev-parse', 'HEAD'\]\)\.out/, '要拿到 HEAD')
  assert.match(src, /refs\/tags\/\$\{tag\}\*/, '要逐个远端查 tag')
  assert.match(src, /const peeled = \(ls\.out\.split/, '要看 peeled 提交（annotated tag 的真实指向）')
  assert.match(src, /git push --force/, '不一致要强制修正')
  assert.match(src, /tag \$\{tag\} → \$\{headSha\.slice\(0, 7\)\} ✓/, '一致也要打一行 ✓（可核对）')
})

test('推送 / Release 失败必须汇总并让退出码非零（不许淹没在"完成"里）', () => {
  assert.match(src, /const problems = \[\]/, '要有问题清单')
  assert.match(src, /if \(!a\.ok\) problems\.push/, 'main 推失败要记下来')
  assert.match(src, /if \(!b\.ok\) problems\.push/, 'tag 推失败要记下来')
  assert.match(src, /process\.exitCode = 1/, '有未完成项时退出码非零')
  assert.match(src, /不要当作已发布完成/, '汇总要给一句显式警告')
})
