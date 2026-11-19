// 域名基座：登录 / 支付 / 订阅 / 提示文案的**唯一真源**。
//
// 为什么要有这个文件：
//   · `mengbot.com.cn` 是**备案的官方域名**，作为默认首选（合规、长期）；
//   · `mengbot.vip` 是当前迁移期的临时域名，四个角色同样对称部署；
//   · 过去每个位置各自写死一个域（前端 placeholder 7 处、支付深链、OIDC 示例…），
//     切换时要挨个改，漏一处就出现「登录走 A、支付走 B、订阅回 A」的错位。
//
// 现在只有**一个开关**：`MEMORY_MENGBOT_DOMAIN=mengbot.vip`，或按当前云端连接地址
// 自动反推（`https://mem.mengbot.vip` → `mengbot.vip`）。派生规则固定：
//   `mem.<base>` 云端实例、`pay.<base>` 支付订阅、`accounts.<base>` 身份、`cloud.<base>` 控制面。

/** 备案官方域名：默认首选（新装、未配置时都指向它）。 */
export const DEFAULT_DOMAIN_BASE = 'mengbot.com.cn'

/** 已知可切换的基座（只认这两个，避免把任意域名猜成我们的）。 */
export const DOMAIN_BASES = ['mengbot.com.cn', 'mengbot.vip']

/** 各角色子域前缀。 */
export const DOMAIN_ROLES = ['mem', 'pay', 'accounts', 'cloud']

/** 校验/归一基座：接受 `mengbot.vip`、`https://mengbot.vip`、`mem.mengbot.vip`。 */
export function normalizeDomainBase(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const fromUrl = domainBaseFromUrl('https://' + s)
  return fromUrl || (DOMAIN_BASES.includes(s) ? s : '')
}

/**
 * 从任意一个已知子域反推基座：`https://mem.mengbot.vip` → `mengbot.vip`。
 * 不是我们的域返回 ''（自建部署不猜）。
 */
export function domainBaseFromUrl(url) {
  let host = ''
  try { host = new URL(String(url || '').trim()).hostname.toLowerCase() } catch { return '' }
  if (!host) return ''
  for (const base of DOMAIN_BASES) {
    if (host === base || host.endsWith('.' + base)) return base
  }
  return ''
}

/** 某个角色的完整主机名：`hostFor('pay', 'mengbot.vip')` → `pay.mengbot.vip`。 */
export function hostFor(role, base = DEFAULT_DOMAIN_BASE) {
  const b = normalizeDomainBase(base) || DEFAULT_DOMAIN_BASE
  const r = String(role || '').trim().toLowerCase()
  if (!r) return b
  return r + '.' + b
}

/**
 * 解析当前生效的基座。优先级：显式 env > 按当前云端实例反推 > 备案默认。
 * @param {{env?:NodeJS.ProcessEnv, cloudUrl?:string}} opts
 */
export function resolveDomainBase({ env = process.env, cloudUrl = '' } = {}) {
  const explicit = normalizeDomainBase(env && env.MEMORY_MENGBOT_DOMAIN)
  if (explicit) return explicit
  const derived = domainBaseFromUrl(cloudUrl)
  if (derived) return derived
  return DEFAULT_DOMAIN_BASE
}

/** 官方默认支付根地址（由基座派生，默认备案域）。 */
export const DEFAULT_PAY_BASE = 'https://' + hostFor('pay', DEFAULT_DOMAIN_BASE)

/**
 * 从当前云端实例地址推出支付根地址；自建域名不猜（返回 ''）。
 * 放在 domains.js 而不是 billing.js：billing 属私有模块（files 里被排除），
 * 而 api.js 这类公开模块要引用它 —— 私有 → 公开可以，公开 → 私有会让开源包启动即崩。
 */
export function payBaseFromCloudUrl(cloudUrl) {
  const base = domainBaseFromUrl(cloudUrl)
  return base ? 'https://' + hostFor('pay', base) : ''
}

/**
 * 支付根地址。优先级：显式配置 > 按当前云端实例推导 > 当前基座。
 * @param {{env?:NodeJS.ProcessEnv, cloudUrl?:string}} opts
 */
export function resolvePayBase({ env = process.env, cloudUrl = '' } = {}) {
  const explicit = String((env && env.MEMORY_MENGBOT_PAY_BASE) || '').trim().replace(/\/+$/, '')
  if (explicit) return explicit
  const derived = payBaseFromCloudUrl(cloudUrl)
  if (derived) return derived
  return 'https://' + hostFor('pay', resolveDomainBase({ env }))
}

/**
 * 一次性拿到当前生效的各角色主机名 —— 前端 placeholder / 服务端提示都用它，
 * 这样「切域名」只改一处，界面上每个输入框会同时跟着换。
 */
export function resolveDomains({ env = process.env, cloudUrl = '' } = {}) {
  const base = resolveDomainBase({ env, cloudUrl })
  const out = { base }
  for (const role of DOMAIN_ROLES) out[role] = hostFor(role, base)
  out.memUrl = 'https://' + out.mem
  out.payUrl = 'https://' + out.pay
  out.accountsUrl = 'https://' + out.accounts
  out.cloudUrl = 'https://' + out.cloud
  return out
}
