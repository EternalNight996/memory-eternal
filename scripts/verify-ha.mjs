#!/usr/bin/env node
/**
 * 容灾能力验收（一条命令把所有改动串起来验一遍）
 *
 * 覆盖：
 *   A. 配置默认值（自动备份开关 / 周期 / 30 天保留 / 自动还原开关）
 *   B. backupDb 的 30 天过期清理 + 同日去重 + 自校验
 *   C. 灾难自动还原（lib/auto-restore.js 的 ensureHealthy）
 *   D. 技能卡类型 tag（skill-type:* / 技能类型:*）覆盖率
 *   E. 红队知识库导出卡（source=poc:redteam:*，带 type:* tag）
 *
 * 用法：node scripts/verify-ha.mjs [--json]
 * 退出码：0 全过；1 有失败
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const VAULT = process.env.MEMORY_VAULT_DIR || path.join(os.homedir(), '.dsh', 'memory-vault')
const JSON_OUT = process.argv.includes('--json')
const out = { checks: [], failed: 0 }

function ok(name, detail = '') { out.checks.push({ name, pass: true, detail }); if (!JSON_OUT) console.log('  ✅ ' + name + (detail ? ' — ' + detail : '')) }
function bad(name, detail = '') { out.failed++; out.checks.push({ name, pass: false, detail }); if (!JSON_OUT) console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')) }
function section(t) { if (!JSON_OUT) console.log('\n' + t) }

const dbf = await import('file:///' + (REPO + '/lib/db.js').replace(/\\/g, '/'))
const { DatabaseSync } = await import('node:sqlite')

// ── A. 配置默认值 ─────────────────────────────────────────────
section('A. 容灾配置默认值')
try {
  const sd = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
  const need = [
    ['backupEnabled', /backupEnabled/],
    ['backupIntervalHours', /backupIntervalHours/],
    ['backupKeepDays', /backupKeepDays/],
    ['backupAutoRestore', /backupAutoRestore/],
  ]
  for (const [k, re] of need) re.test(sd) ? ok('配置键 ' + k + ' 存在') : bad('配置键 ' + k + ' 缺失')
  const defT = /backupEnabled[^;]{0,80}default\(\s*true\s*\)/s.test(sd)
  defT ? ok('自动备份默认开启') : bad('自动备份默认开启（找不到 default(true)）')
  const def30 = /backupKeepDays[^;]{0,80}default\(\s*30\s*\)/s.test(sd)
  def30 ? ok('保留默认 30 天') : bad('保留默认 30 天（找不到 default(30)）')
  const defR = /backupAutoRestore[^;]{0,80}default\(\s*true\s*\)/s.test(sd)
  defR ? ok('自动还原默认开启') : bad('自动还原默认开启')
} catch (e) { bad('读取 index.js 失败', String(e.message || e)) }

// ── B. 备份保留与自校验（隔离 vault）────────────────────────────
section('B. 备份：30 天保留 / 同日去重 / 自校验')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ha-'))
try {
  const { writeCard, setCardStatus } = await import('file:///' + (REPO + '/lib/vault.js').replace(/\\/g, '/'))
  for (let i = 0; i < 3; i++) {
    const r = await writeCard(tmp, { kind: 'knowledge', title: 'HA ' + i, tags: [], body: '# HA\n- ' + i, status: 'pending', submittedBy: 'verify' }, { dedup: false })
    await setCardStatus(tmp, r.path, 'approved')
  }
  dbf.closeAllDb()
  const b1 = await dbf.backupDb(tmp, { keepDays: 30 })
  b1.ok && b1.cards === 3 ? ok('backupDb 自校验通过', `cards=${b1.cards}`) : bad('backupDb 自校验', b1.error || JSON.stringify(b1))

  // 造 3 份 40 天前的备份（文件名带旧日期），keepDays=30 应把它们清掉
  const dir = path.join(tmp, 'backups')
  const old = new Date(Date.now() - 40 * 86400000)
  const oldName = `memory-eternal-${old.toISOString().slice(0, 10)}_0300.db`
  fs.copyFileSync(b1.path, path.join(dir, oldName))
  const b2 = await dbf.backupDb(tmp, { keepDays: 30 })
  const stillThere = fs.existsSync(path.join(dir, oldName))
  b2.ok && !stillThere ? ok('备份后清理过期（>30 天）', 'pruned=' + (b2.pruned ?? 'n/a')) : bad('过期清理', 'old still exists=' + stillThere + ' pruned=' + (b2.pruned ?? '未返回'))

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'))
  files.length === 1 ? ok('同一天只留最新一份', files[0]) : bad('同一天去重', files.join(', '))
  dbf.closeAllDb()
} catch (e) { bad('备份验收异常', String(e.message || e)) } finally {
  try { dbf.closeAllDb() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) } catch {}
}

// ── C. 灾难自动还原 ──────────────────────────────────────────
section('C. 灾难自动还原（ensureHealthy）')
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ha2-'))
try {
  let ensureHealthy = null
  try { ({ ensureHealthy } = await import('file:///' + (REPO + '/lib/auto-restore.js').replace(/\\/g, '/'))) } catch {}
  if (typeof ensureHealthy !== 'function') {
    bad('lib/auto-restore.js 未导出 ensureHealthy')
  } else {
    const { writeCard, setCardStatus } = await import('file:///' + (REPO + '/lib/vault.js').replace(/\\/g, '/'))
    for (let i = 0; i < 3; i++) {
      const r = await writeCard(tmp2, { kind: 'knowledge', title: 'DR ' + i, tags: [], body: '# DR\n- ' + i, status: 'pending', submittedBy: 'verify' }, { dedup: false })
      await setCardStatus(tmp2, r.path, 'approved')
    }
    dbf.closeAllDb()
    const b = await dbf.backupDb(tmp2, { keepDays: 30 })
    dbf.closeAllDb()
    const dbFile = path.join(tmp2, 'memory-eternal.db')
    fs.writeFileSync(dbFile, 'CORRUPTED')
    dbf.closeAllDb()
    const r = await ensureHealthy(tmp2, { env: { ...process.env } })
    const probe = dbf.probeDbFile(dbFile)
    dbf.closeAllDb()
    r && r.action === 'restored' && probe.ok && probe.cards === b.cards
      ? ok('库损坏 → 自动用最新可用备份重建', `action=${r.action} cards=${probe.cards}`)
      : bad('自动还原', JSON.stringify({ r, probe }))
    const aside = fs.readdirSync(tmp2).filter(f => f.includes('.corrupt-'))
    aside.length ? ok('坏库留证', aside.length + ' 个文件') : bad('坏库留证缺失')
    // 健康库不该被动
    const r2 = await ensureHealthy(tmp2, { env: { ...process.env } })
    dbf.closeAllDb()
    r2 && r2.action === 'none' ? ok('健康库不动（幂等）') : bad('健康库幂等', JSON.stringify(r2))
  }
} catch (e) { bad('自动还原验收异常', String(e.message || e)) } finally {
  try { dbf.closeAllDb() } catch {}
  try { fs.rmSync(tmp2, { recursive: true, force: true, maxRetries: 5 }) } catch {}
}

// ── D/E. 真库里的类型 tag ────────────────────────────────────
section('D/E. 类型 tag 覆盖（真库，只读）')
try {
  const db = new DatabaseSync(path.join(VAULT, 'memory-eternal.db'), { readOnly: true })
  const skillTotal = db.prepare("SELECT count(*) AS n FROM cards WHERE kind='skill'").get().n
  const skillTyped = db.prepare("SELECT count(*) AS n FROM cards WHERE kind='skill' AND tags LIKE '%skill-type:%'").get().n
  const rt = db.prepare("SELECT count(*) AS n FROM cards WHERE kind='skill' AND tags LIKE '%技能类型:%'").get().n
  skillTyped > 0 ? ok('技能卡带类型 tag', `${skillTyped}/${skillTotal}`) : bad('技能卡带类型 tag', `0/${skillTotal}（需要重新触发 /skills/sync）`)
  rt > 0 ? ok('技能卡带中文类型标签', String(rt)) : bad('技能卡带中文类型标签', '0')
  const kb = db.prepare("SELECT count(*) AS n FROM cards WHERE source LIKE 'poc:redteam:%' OR source LIKE 'kb:redteam:%'").get().n
  kb > 0 ? ok('红队知识库已导入', kb + ' 张') : bad('红队知识库导入', '0（尚未跑导出脚本或未审批）')
  const typed = db.prepare("SELECT count(*) AS n FROM cards WHERE (source LIKE 'poc:redteam:%' OR source LIKE 'kb:redteam:%') AND tags LIKE '%type:%'").get().n
  kb > 0 && typed === kb ? ok('导入卡都带漏洞类型 tag', String(typed)) : (kb > 0 ? bad('导入卡类型 tag 覆盖', `${typed}/${kb}`) : null)
  db.close()
} catch (e) { bad('读取真库失败', String(e.message || e)) }

section(out.failed ? `结果：${out.failed} 项未通过` : '结果：全部通过')
if (JSON_OUT) console.log(JSON.stringify(out, null, 1))
process.exit(out.failed ? 1 : 0)
