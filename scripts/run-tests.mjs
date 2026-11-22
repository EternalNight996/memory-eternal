import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const files = readdirSync('tests').filter(f => f.endsWith('.test.mjs'))
let pass = 0, fail = 0
for (const f of files) {
  // 单个用例超时 180s：tui-scroll 会真起 dsh-tui 场景，实测 130s；
  // 旧的 60s 会把它当失败（此前 verify 里那条红就是这么来的，不是用例挂了）。
  try { execFileSync(process.execPath, ['tests/' + f], { stdio: 'pipe', timeout: 180000 }); pass++ }
  catch (e) { fail++; console.log('FAIL', f, String(e.stdout || e.message).slice(0, 200)) }
}
console.log(`测试: pass=${pass} fail=${fail} total=${files.length}`)
