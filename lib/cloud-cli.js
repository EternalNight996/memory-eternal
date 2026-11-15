// 记忆核心 · 云端密钥 CLI —— `dsh-memory cloud <子命令>`
//
// 为什么要这个：签发**访问密钥**（`me_…`）原来只能 `curl -X POST /cloud/keys`，
// 还得先在服务端造一个 `MEMORY_CLOUD_ADMIN_TOKEN` 写进 env。运维真正的口径是
// 「**能在这台机器上执行命令的人 = 管理员**」—— 那他直接读写本地密钥台账就够了：
// 台账 (`$DSH_HOME/cloud-keys.json`) 与服务端是同一个文件，且 `resolveTenant` 是
// **每请求重新读盘**的，所以 CLI 签出来的密钥**立刻生效、不用重启**。
//
// 只有一种情况需要令牌：**不在这台机上**（`--url` + `--admin-token` 走管理面 HTTP）。
//
// 安全口径：明文只在 `issue` 那一刻打到 stdout 一次；`ls/info/token` 默认打掩码，
// 台账里从来只有 sha256（这是 lib/cloud-auth.js 的既有实现，这里不重复造）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { cloudRoot, keyStorePath, issueKey, listKeys, revokeKey, resolveTenant } from './cloud-auth.js'

const API_TAIL = '/memory-eternal/api'

/** 取 `--name value`（值不能以 `--` 开头，避免把下一个 flag 吃掉）。 */
const flagOf = (args, name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && i + 1 < args.length && !String(args[i + 1]).startsWith('--') ? String(args[i + 1]) : ''
}
const hasFlag = (args, name) => args.includes('--' + name)

/** `--home` 覆盖 DSH_HOME（云端实例可能跑在别的目录，运维要能对准它）。 */
const envFor = (args) => {
  const home = flagOf(args, 'home')
  return home ? { ...process.env, DSH_HOME: path.resolve(home) } : process.env
}

/** 台账目录（= cloud-keys.json 所在的 DSH_HOME）。 */
const ledgerDir = (env) => path.dirname(keyStorePath(env))

/** 管理令牌：env 优先 → 服务端落盘文件（`cloud-admin-token`）→ 没有。**只读，不生成**。 */
const adminTokenOf = (env) => {
  const fromEnv = String(env.MEMORY_CLOUD_ADMIN_TOKEN || '').trim()
  if (fromEnv) return { token: fromEnv, source: 'env' }
  try {
    const file = path.join(ledgerDir(env), 'cloud-admin-token')
    const t = String(readFileSync(file, 'utf8') || '').split(/\r?\n/)[0].trim()
    if (t.length >= 32) return { token: t, source: 'file', file }
  } catch { /* 没有就是没有 */ }
  return { token: '', source: 'none' }
}

/** 掩码：够看出"是哪一把"，又不会被人从屏幕/日志里抄走。 */
const mask = (s) => {
  const v = String(s || '')
  if (!v) return '（空）'
  if (v.length <= 12) return v.slice(0, 2) + '…'
  return v.slice(0, 6) + '…' + v.slice(-4)
}

/** 按内容算列宽的对齐表（不硬编码宽度，中文也算得对）。 */
const printTable = (headers, rows) => {
  const all = [headers, ...rows]
  const width = headers.map((_, c) => Math.max(...all.map((r) => String(r[c] ?? '').length)))
  const line = (r) => r.map((cell, c) => String(cell ?? '').padEnd(width[c])).join('  ').trimEnd()
  console.log(line(headers))
  console.log(width.map((w) => '─'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(r))
}

/** 远程模式：管理面 HTTP。base = --url + /memory-eternal/api */
const remoteCall = async (args, sub, { method = 'GET', body } = {}) => {
  const base = flagOf(args, 'url').replace(/\/+$/, '')
  const tok = flagOf(args, 'admin-token') || adminTokenOf(envFor(args)).token
  if (!tok) return { ok: false, code: 3, error: '远程模式需要 --admin-token <令牌>（或服务端 env MEMORY_CLOUD_ADMIN_TOKEN）' }
  let res
  try {
    res = await fetch(base + API_TAIL + sub, {
      method,
      headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    return { ok: false, code: 1, error: '连不上 ' + base + '：' + String((e && e.message) || e) }
  }
  let data = null
  try { data = await res.json() } catch { data = null }
  if (!res.ok) {
    const code = res.status === 401 || res.status === 403 ? 3 : 1
    return { ok: false, code, status: res.status, error: (data && (data.error || data.hint)) || ('HTTP ' + res.status) }
  }
  return { ok: true, code: 0, data }
}

const usage = () => `dsh-memory cloud —— 云端访问密钥管理（默认操作本机台账，不需要管理令牌）

用法：
  dsh-memory cloud info                              台账路径 / 密钥数 / 管理令牌来源
  dsh-memory cloud token [--show]                    管理令牌（默认掩码；--show 才显示全值）
  dsh-memory cloud keys ls [--json]                 列出台账里的密钥
  dsh-memory cloud keys issue --owner alice [--note 笔记本] [--vault work] [--json]
                                                     签发一把访问密钥（明文只显示这一次）
  dsh-memory cloud keys revoke --id k_xxx | --owner alice [--all] [--yes]
                                                     吊销（--owner 命中多把时要 --all 或 --id）
  dsh-memory cloud whoami --token me_xxx             本地校验这把密钥属于谁（不联网）

通用参数：
  --home <DSH_HOME>      对准另一个 DSH_HOME（默认 env.DSH_HOME 或 ~/.dsh）
  --url https://mem.example.com --admin-token <tok>   改走远程管理面（HTTP）

为什么本地模式不需要令牌：能在这台机跑命令的人本来就能读写台账文件，
而服务端**每个请求都重新读台账**，所以签发/吊销**立即生效、不用重启**。

例：
  dsh-memory cloud keys issue --owner alice --note 笔记本
  dsh-memory cloud keys ls
  dsh-memory cloud whoami --token me_xxx
  dsh-memory cloud keys revoke --owner alice
  dsh-memory cloud keys ls --url https://mem.example.com --admin-token <tok>
`

/**
 * 入口：`argv` 是 `cloud` 之后的参数（如 `['keys','issue','--owner','alice']`）。
 * @returns {Promise<number>} 退出码（0 成功 / 1 失败 / 2 参数错 / 3 远程鉴权）
 */
export async function runCloudCli(argv = []) {
  const args = [...argv]
  const sub0 = args[0] || 'help'
  const sub1 = args[1] || ''
  const asJson = hasFlag(args, 'json')
  const env = envFor(args)
  const remote = args.includes('--url')

  if (sub0 === 'help' || sub0 === '--help' || sub0 === '-h') { console.log(usage()); return 0 }

  // ── info ────────────────────────────────────────────────────────────────
  if (sub0 === 'info') {
    if (remote) {
      const r = await remoteCall(args, '/cloud/config')
      if (!r.ok) { console.error('✗ ' + r.error); return r.code }
      const d = r.data || {}
      console.log('实例：' + flagOf(args, 'url'))
      console.log('版本：' + (d.version || '?'))
      console.log('管理令牌来源：' + (d.adminTokenSource || (d.hasAdminToken ? '已配置' : 'none')))
      if (d.license) console.log('授权：' + [d.license.status, d.license.plan].filter(Boolean).join(' · '))
      return 0
    }
    const store = listKeys(env)
    const tok = adminTokenOf(env)
    const info = {
      home: ledgerDir(env),
      keyStore: keyStorePath(env),
      cloudRoot: cloudRoot(env),
      keys: store.length,
      activeKeys: store.filter((k) => !k.revoked).length,
      adminTokenSource: tok.source,
      adminTokenFile: tok.file || '',
    }
    if (asJson) { console.log(JSON.stringify(info, null, 2)); return 0 }
    console.log('DSH_HOME        ：' + info.home)
    console.log('密钥台账        ：' + info.keyStore)
    console.log('租户库根        ：' + info.cloudRoot)
    console.log('密钥            ：' + info.keys + ' 把（可用 ' + info.activeKeys + '）')
    console.log('管理令牌来源    ：' + ({ env: '环境变量 MEMORY_CLOUD_ADMIN_TOKEN', file: '文件 ' + (info.adminTokenFile || 'cloud-admin-token'), none: '尚未生成（服务端首次启动会生成并打印一次）' }[info.adminTokenSource] || info.adminTokenSource))
    return 0
  }

  // ── token ───────────────────────────────────────────────────────────────
  if (sub0 === 'token') {
    const tok = adminTokenOf(env)
    if (remote) {
      // 远程拿不到明文，只能报"有没有配"
      const r = await remoteCall(args, '/cloud/config')
      if (!r.ok) { console.error('✗ ' + r.error); return r.code }
      console.log('管理令牌来源：' + (r.data?.adminTokenSource || 'unknown') + '（远程模式不回显明文）')
      return 0
    }
    if (!tok.token) {
      console.log('尚未生成管理令牌：服务端首次以 MEMORY_CLOUD=1 启动时会自动生成并打印一次，')
      console.log('或你自己写 ' + path.join(ledgerDir(env), 'cloud-admin-token') + '（0600）。')
      return 0
    }
    console.log(hasFlag(args, 'show') ? tok.token : mask(tok.token))
    console.error('（来源：' + tok.source + (hasFlag(args, 'show') ? '；明文已输出，注意屏幕与日志' : '；加 --show 显示全值') + '）')
    return 0
  }

  // ── keys ────────────────────────────────────────────────────────────────
  if (sub0 === 'keys') {
    if (sub1 === 'ls' || sub1 === 'list' || !sub1) {
      const r = remote
        ? await remoteCall(args, '/cloud/keys')
        : { ok: true, code: 0, data: { keys: listKeys(env) } }
      if (!r.ok) { console.error('✗ ' + r.error); return r.code }
      const keys = (r.data && r.data.keys) || []
      if (asJson) { console.log(JSON.stringify({ ok: true, keys }, null, 2)); return 0 }
      if (!keys.length) {
        console.log('还没有任何访问密钥。签一把：')
        console.log('  dsh-memory cloud keys issue --owner <你>')
        return 0
      }
      printTable(
        ['id', 'owner', '备注', '库', '创建时间', '最近使用', '状态'],
        keys.map((k) => [
          k.id || '',
          k.owner || '',
          k.note || '',
          k.vault || '(默认)',
          String(k.createdAt || '').replace('T', ' ').slice(0, 16),
          String(k.lastUsedAt || '').replace('T', ' ').slice(0, 16) || '—',
          k.revoked ? '已吊销' : '可用',
        ]),
      )
      return 0
    }

    if (sub1 === 'issue' || sub1 === 'create' || sub1 === 'new') {
      const owner = flagOf(args, 'owner')
      if (!owner) { console.error('用法：dsh-memory cloud keys issue --owner <名字> [--note 备注] [--vault 库名]'); return 2 }
      const note = flagOf(args, 'note')
      const vault = flagOf(args, 'vault')
      let out
      if (remote) {
        const r = await remoteCall(args, '/cloud/keys', { method: 'POST', body: { owner, note, vault } })
        if (!r.ok) { console.error('✗ ' + r.error); return r.code }
        out = r.data
      } else {
        try { out = issueKey({ owner, note, vault }, env) } catch (e) { console.error('✗ ' + String((e && e.message) || e)); return 1 }
      }
      if (asJson) {
        // 明文只在这里出现一次（一次性凭据），别在其它命令的 JSON 里出现
        console.log(JSON.stringify({ ok: true, token: out.token, key: out.key }, null, 2))
      } else {
        console.log('✔ 已签发访问密钥（' + (out.key && out.key.id || '') + ' · owner=' + owner + '）')
        console.log('')
        console.log('  ' + out.token)
        console.log('')
      }
      console.error('提示：明文只显示这一次；服务端按请求读取台账 → 签发后立即生效，不用重启。')
      console.error('      填到面板「设置 → 实验性 → 云端连接 → 访问密钥」，或自己存进密码管理器。')
      if (vault) console.error('      这把密钥绑定到库：' + vault)
      return 0
    }

    if (sub1 === 'revoke' || sub1 === 'rm') {
      const id = flagOf(args, 'id')
      const owner = flagOf(args, 'owner')
      if (remote) {
        if (!id) { console.error('远程吊销要显式给 --id（远程模式下 `keys ls` 先查 id）'); return 2 }
        const r = await remoteCall(args, '/cloud/keys/' + encodeURIComponent(id), { method: 'DELETE' })
        if (!r.ok) { console.error('✗ ' + r.error); return r.code }
        console.log('✔ 已吊销 ' + id)
        return 0
      }
      const keys = listKeys(env)
      let targets = []
      if (id) {
        targets = keys.filter((k) => k.id === id)
        if (!targets.length) { console.error('✗ 没有这把密钥：' + id); return 1 }
      } else if (owner) {
        const hit = keys.filter((k) => k.owner === owner && !k.revoked)
        if (!hit.length) { console.error('✗ ' + owner + ' 没有可用密钥'); return 1 }
        if (hit.length > 1 && !hasFlag(args, 'all')) {
          console.error('✗ ' + owner + ' 有 ' + hit.length + ' 把可用密钥，请用 --id 指定，或加 --all 全吊销：')
          for (const k of hit) console.error('    ' + k.id + '  ' + (k.note || '') + '  ' + String(k.createdAt || '').slice(0, 16))
          return 2
        }
        targets = hit
      } else {
        console.error('用法：dsh-memory cloud keys revoke --id k_xxx | --owner <名字> [--all]')
        return 2
      }
      for (const k of targets) {
        const r = revokeKey(k.id, env)
        if (r && r.ok) console.log('✔ 已吊销 ' + k.id + '（owner=' + k.owner + '）')
        else console.error('✗ ' + k.id + ' 吊销失败：' + ((r && r.error) || '未知原因'))
      }
      return 0
    }

    console.error('未知的 keys 子命令：' + sub1 + '\n');
    console.log(usage())
    return 2
  }

  // ── whoami ──────────────────────────────────────────────────────────────
  if (sub0 === 'whoami') {
    const token = flagOf(args, 'token') || flagOf(args, 'key')
    if (!token) { console.error('用法：dsh-memory cloud whoami --token me_xxx'); return 2 }
    const r = resolveTenant('Bearer ' + token, env)
    if (asJson) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1 }
    if (!r.ok) { console.error('✗ ' + (r.error || '密钥无效')); return 1 }
    console.log('owner    ：' + r.owner)
    console.log('来源     ：' + (r.via || '?'))
    console.log('库       ：' + (r.vaultRoot || ''))
    if (r.keyId) console.log('密钥 id  ：' + r.keyId)
    return 0
  }

  console.error('未知子命令：' + sub0 + '\n')
  console.log(usage())
  return 2
}
