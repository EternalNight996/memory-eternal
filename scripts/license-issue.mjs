// 签发 license（**只在签发方机器上跑**，私钥绝不进仓库）。
//
// 用法：
//   # 第一次：生成密钥对（私钥留在你手里，公钥贴进 lib/license.js 的 DEFAULT_PUBLIC_KEY_PEM）
//   node scripts/license-issue.mjs --gen-keys
//
//   # 签发
//   node scripts/license-issue.mjs --key ./license-private.pem --sub acme --plan pro \
//        --seats 5 --days 365 --features cloud,backup
//
//   # 校验（自检签出来的能不能通过 lib/license.js 的验签）
//   node scripts/license-issue.mjs --key ./license-private.pem --sub acme --days 30 --verify
import fs from 'node:fs'
import crypto from 'node:crypto'
import { signLicense, verifyLicense, parseLicense } from '../lib/license.js'

const args = process.argv.slice(2)
const arg = (name, dflt = '') => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt
}
const has = (name) => args.includes('--' + name)

if (has('gen-keys')) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const pub = publicKey.export({ type: 'spki', format: 'pem' })
  const outPriv = arg('out', 'license-private.pem')
  fs.writeFileSync(outPriv, priv, { mode: 0o600 })
  console.log('✔ 私钥 →', outPriv, '（0600，请离线保管，别提交）')
  console.log('\n把下面这段贴进 lib/license.js 的 DEFAULT_PUBLIC_KEY_PEM：\n')
  console.log(pub)
  process.exit(0)
}

const keyFile = arg('key')
if (!keyFile) {
  console.error('缺少 --key <私钥 pem>（或先跑 --gen-keys 生成）')
  process.exit(2)
}
let privateKeyPem
try {
  privateKeyPem = fs.readFileSync(keyFile, 'utf8')
} catch (e) {
  console.error('读不到私钥：' + String(e.message))
  process.exit(2)
}

const days = Number(arg('days', '365'))
const payload = {
  sub: String(arg('sub', 'customer')),
  plan: String(arg('plan', 'pro')),
  seats: Number(arg('seats', '1')),
  features: String(arg('features', 'cloud')).split(',').map((s) => s.trim()).filter(Boolean),
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + Math.round(days * 86400),
}
const token = signLicense(payload, privateKeyPem)

// 自检：用 lib/license.js 的公钥验签（若还没把公钥贴进去，这里会失败，属预期）
const pubPath = arg('pub')
if (pubPath) {
  const pub = fs.readFileSync(pubPath, 'utf8')
  const r = verifyLicense(token, { publicKey: pub })
  console.log('自检:', r.status, r.ok ? '✔ 通过' : '✘ ' + r.error, '| 到期:', r.expiresAt, '| 剩', r.daysLeft, '天')
} else {
  const parsed = parseLicense(token)
  console.log('payload:', JSON.stringify(parsed.payload))
  console.log('（没给 --pub，跳过验签自检）')
}

console.log('\n把下面整串配到服务端环境变量 MEMORY_SERVER_LICENSE：\n')
console.log(token)
