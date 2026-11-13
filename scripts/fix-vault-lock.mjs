// 修复「主库完好、却被残留 WAL 污染」的故障。
//
// 故障成因：替换/恢复库时，主库文件被换掉了，但旧的 `memory-eternal.db-wal` 还在
// （另一个进程——通常是 DSH 宿主——持着句柄，改名失败）。SQLite 打开新库时会重放旧 WAL，
// 于是 quick_check 报 `database disk image is malformed`，看起来像库坏了，其实库本体是好的。
//
// 用法（**先完全退出 DSH 桌面端**，否则 WAL 被锁着删不掉）：
//   node scripts/fix-vault-lock.mjs           只检查并报告
//   node scripts/fix-vault-lock.mjs --fix     真正执行（把 WAL/SHM 改名留证）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const VAULT = process.env.MEMORY_VAULT_DIR || path.join(os.homedir(), '.dsh', 'memory-vault')
const DB = path.join(VAULT, 'memory-eternal.db')
const FIX = process.argv.includes('--fix')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

const say = (ok, msg) => console.log((ok ? '✔ ' : '✘ ') + msg)

function probe(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    const qc = String(db.prepare('PRAGMA quick_check').get().quick_check)
    const cards = Number(db.prepare('SELECT count(*) n FROM cards').get().n)
    db.close()
    return { ok: qc === 'ok', qc, cards }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

console.log('vault:', VAULT)
if (!fs.existsSync(DB)) {
  say(false, '主库里不存在：' + DB)
  process.exit(1)
}

// ① 先把 WAL/SHM 挪开（**在检查主库之前**，否则读到的还是被污染的视图）
const aside = []
for (const suffix of ['-wal', '-shm']) {
  const f = DB + suffix
  if (!fs.existsSync(f)) continue
  const size = fs.statSync(f).size
  if (!FIX) {
    console.log(`  ${suffix} 存在（${Math.round(size / 1048576)}MB）—— 加 --fix 会改名留证`)
    continue
  }
  const to = f + '.stale-' + stamp
  try {
    fs.renameSync(f, to)
    aside.push(path.basename(to))
    say(true, `已把 ${suffix} 改名留证：${path.basename(to)}`)
  } catch (e) {
    say(false, `${suffix} 改名失败（多半是 DSH 宿主还开着）：${(e && e.message) || e}`)
    say(false, '请**完全退出 DSH 桌面端**（含托盘）后重跑本脚本')
    process.exit(2)
  }
}

// ② 检查主库本体
const r = probe(DB)
if (r.ok) {
  say(true, `主库完好：quick_check=ok，${r.cards} 张卡`)
} else {
  say(false, `主库仍有问题：${r.error || r.qc}`)
  say(false, '下一步：用最新备份还原 —— node scripts/backup-drill.mjs --verify-only 看哪些备份可用，')
  say(false, '        或 npm run backup:verify 后再用 dsh-memory doctor --restore 还原')
  process.exit(3)
}

if (aside.length) {
  console.log('\n留证文件（确认没问题后可删）：')
  for (const a of aside) console.log('  ' + path.join(VAULT, a))
}
console.log('\n完成。重启面板服务即可：')
console.log('  node bin/dsh-memory.mjs watchdog --port 7999 --interval 5000')
