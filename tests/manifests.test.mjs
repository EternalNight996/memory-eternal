// 记忆核心 · 随包文件的“最低体检”：JSON 必须能解析、清单版本必须与 package.json 一致、
// 不能夹带编码事故留下的乱码。
//
// 为什么要有这条守卫：.claude-plugin / .codex-plugin / .cursor-plugin 三个清单曾长期是
// **非法 JSON**（描述串缺少收尾引号 + 双重编码乱码，最后一次改动在 v0.9.23），DSH 不走这三个
// 文件所以一直没人发现 —— 但只要有人用 Claude Code / Codex / Cursor 的插件市场安装就会直接失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

/** 走 package.json 的 files 白名单（= 真正会发出去的东西）。 */
async function shippedFiles() {
  const out = []
  const walk = async (abs) => {
    let ents = []
    try { ents = await fs.readdir(abs, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(abs, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(path.relative(root, p).split(path.sep).join('/'))
    }
  }
  for (const entry of pkg.files) await walk(path.join(root, entry))
  return out
}

const files = await shippedFiles()

test('随包的每个 JSON 都能解析（含三个第三方插件清单）', async () => {
  const jsons = files.filter((f) => f.endsWith('.json'))
  assert.ok(jsons.length >= 5, `至少要扫到几个 JSON，实际 ${jsons.length}`)
  for (const f of jsons) {
    const text = await fs.readFile(path.join(root, f), 'utf8')
    assert.doesNotThrow(() => JSON.parse(text), `${f} 不是合法 JSON`)
  }
})

test('三个插件清单的 name/version 与 package.json 一致且描述可读', async () => {
  for (const f of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    assert.ok(files.includes(f), `${f} 必须在 files 白名单里（否则安装侧会缺文件）`)
    const j = JSON.parse(await fs.readFile(path.join(root, f), 'utf8'))
    assert.equal(j.name, pkg.name, `${f} 的 name 应与 package.json 一致`)
    assert.equal(j.version, pkg.version, `${f} 的 version 未跟随发版更新（应为 ${pkg.version}）`)
    assert.ok(typeof j.description === 'string' && j.description.length >= 10, `${f} 缺少可读描述`)
  }
})

test('随包文本文件里不得有编码事故留下的乱码', async () => {
  const textFiles = files.filter((f) => /\.(md|json|yml|yaml|js|mjs|cjs|html|txt)$/.test(f))
  assert.ok(textFiles.length >= 20, `扫到的文本文件太少（${textFiles.length}），白名单可能变了`)
  const hits = []
  for (const f of textFiles) {
    const text = await fs.readFile(path.join(root, f), 'utf8')
    // U+FFFD 替换符 = 解码失败的证据；鈥/锛/鐠 一类是 UTF-8 被当 GBK 读的典型残渣
    if (text.includes('\uFFFD')) hits.push(`${f}（含 U+FFFD）`)
    else if (/[\u950b\u942d\u9357\u9420\u95ff\u951f\u93c1\u7e3a]/.test(text)) hits.push(`${f}（含 UTF-8→GBK 乱码）`)
  }
  assert.deepEqual(hits, [], '这些文件有编码事故：\n' + hits.join('\n'))
})
