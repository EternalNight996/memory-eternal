// 记忆核心 · 技能卡生成（kind=skill）
//
// 定位：技能卡是「本机实际安装/可用的技能」的镜像，**不由 agent 对话沉淀**，
// 而是由技能注册表（宿主 ctx.skills）或技能文件（独立 web / 无宿主时）扫描生成。
//
// 审核边界：技能卡与 core 一样**强制 pending**（见 lib/db.js enforceAudit）——
// 技能正文可能包含任意指令，必须由人确认后才进主库，避免绕过审核直接进入召回。
//
// 幂等：按 source=`skill:<name>` 对齐已有卡。
// - 同名多版本同时安装 → 选 semver 最高的一份；
// - 待审卡版本/内容变了 → 原地刷新（仍是同一张待审卡，不刷屏）；
// - 已批准卡版本/内容变了 → 生成 99-Revisions 待审修改，批准后覆盖原卡（审核前旧卡继续可用）；
// - 驳回/删除过的卡 → 不复活（尊重人的决定）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { writeCard, updateCardContent, ensureVault, reviseCard } from './vault.js'
import { getDb } from './db.js'

/** 技能卡类型与目录（与 lib/vault.js 的 KIND_ROOTS 保持一致）。 */
export const SKILL_KIND = 'skill'
export const SKILL_ROOT = '10-Skills'
const DEFAULT_MAX_CONTENT = 16000

/** 归一化正文，仅用于「内容是否变化」的比较。 */
function sameText(a, b) {
  return String(a || '').replace(/\r\n/g, '\n').trim() === String(b || '').replace(/\r\n/g, '\n').trim()
}

/** 内容指纹（12 位足够区分同一技能的版本）。 */
export function skillContentHash(title, body) {
  return createHash('sha1').update(String(title || '') + '\n' + String(body || '')).digest('hex').slice(0, 12)
}

/** 宽松 semver 解析：接受 1、1.2、1.2.3 与 -pre / +build。 */
function parseSkillVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] || '' }
}

/**
 * 比较两个技能版本。返回 1/0/-1；解析不出 semver 时按字符串相等判定（不猜大小）。
 * 空版本视为「未知」：选择多份安装时低于有版本的副本；更新判断时调用方会跳过比较。
 */
export function compareSkillVersions(a, b) {
  const A = parseSkillVersion(a)
  const B = parseSkillVersion(b)
  if (!A && !B) return String(a || '') === String(b || '') ? 0 : 0
  if (!A) return -1
  if (!B) return 1
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1
  if (A.pre === B.pre) return 0
  if (!A.pre) return 1
  if (!B.pre) return -1
  const as = A.pre.split('.')
  const bs = B.pre.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 从技能卡正文里读出版本标记（旧卡可能没有）。 */
export function skillVersionFromBody(body) {
  const m = /^-\s*(?:版本|Version)\s*[：:]\s*(.+?)\s*$/mi.exec(String(body || ''))
  return m ? m[1].trim() : ''
}

/** 插件类技能：从最近的 package.json 读取版本（仅 node_modules 路径，避免把项目版本当成技能版本）。 */
function packageVersionForFile(file) {
  if (!/[\\/]node_modules[\\/]/.test(String(file || ''))) return ''
  let dir = path.dirname(file)
  for (let i = 0; i < 6; i++) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
      const version = String(JSON.parse(raw).version || '').trim()
      if (version) return version
    } catch { /* 继续向上 */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/** 从 SKILL.md 文本里取 frontmatter；支持 description 的单行 / 多行块写法。 */
export function parseSkillFile(text, fallbackName = 'skill') {
  const raw = String(text || '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  let head = ''
  let body = raw
  if (m) { head = m[1]; body = raw.slice(m[0].length) }
  const meta = {}
  const lines = head.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const eq = line.indexOf(':')
    if (eq <= 0 || /^\s/.test(line)) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        i++
        parts.push(lines[i].replace(/^\s+/, ''))
      }
      value = parts.join(value.startsWith('|') ? '\n' : ' ').trim()
    }
    meta[key] = value.replace(/^['"]|['"]$/g, '')
  }
  const name = String(meta.name || '').trim()
  const description = String(meta.description || '').trim()
  return {
    name: name || fallbackName,
    description,
    version: String(meta.version || meta['skill-version'] || meta.skillVersion || '').trim(),
    content: body.trim(),
    whenToUse: String(meta.whenToUse || meta['when-to-use'] || '').trim(),
    // 与 DSH skill-filesystem 的准入对齐：必须有 frontmatter，且 name / description 都不能空。
    // 文件系统兜底用这两个标记过滤掉 README / 随手放的 markdown，避免把非技能文件生成卡片。
    hasFrontmatter: !!m,
    hasName: !!name,
    hasDescription: !!description,
  }
}

/** 安全读取目录（不存在返回 []）。 */
function readDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

/** 是否是目录（跟随 junction / symlink）。 */
function isDir(full) {
  try { return fs.statSync(full).isDirectory() } catch { return false }
}

/**
 * 找项目根：与 DSH skill-filesystem 一致，向上找 `.git`；找不到就用 cwd。
 * 这样在子目录里运行也能发现 <repo>/.dsh/skills、<repo>/.agents/skills 等项目级技能。
 */
export function findProjectRoot(cwd = process.cwd()) {
  const start = path.resolve(cwd || process.cwd())
  let current = start
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/** 读一个 skills 根下的所有 SKILL.md（<root>/<skill>/SKILL.md 或 <root>/<skill>.md）。 */
function collectFromSkillRoot(root, source) {
  const out = []
  for (const ent of readDirs(root)) {
    // 各家 agent 的内部内置技能目录（如 Codex 的 .system）不是用户技能，跳过。
    if (ent.name === '.system' || ent.name === 'node_modules') continue
    const full = path.join(root, ent.name)
    if (isDir(full)) {
      const file = path.join(full, 'SKILL.md')
      try {
        const text = fs.readFileSync(file, 'utf8')
        const parsed = parseSkillFile(text, ent.name)
        // 与 DSH skill-filesystem 的准入一致：必须有 frontmatter，且 name / description 非空。
        if (!parsed.hasFrontmatter || !parsed.hasName || !parsed.hasDescription) continue
        out.push({ file, source, parsed })
      } catch { /* 不是技能目录 */ }
    } else if (/\.md$/i.test(ent.name)) {
      const file = full
      try {
        const text = fs.readFileSync(file, 'utf8')
        const parsed = parseSkillFile(text, ent.name.replace(/\.md$/i, ''))
        if (!parsed.hasFrontmatter || !parsed.hasName || !parsed.hasDescription) continue
        out.push({ file, source, parsed })
      } catch { /* 读取失败跳过 */ }
    }
  }
  return out
}

/** 扫描 node_modules 下某个包目录的 skills / .agents/skills。 */
function collectFromPackage(pkgDir, source) {
  const out = []
  for (const sub of ['skills', path.join('.agents', 'skills')]) {
    const root = path.join(pkgDir, sub)
    if (isDir(root)) out.push(...collectFromSkillRoot(root, source))
  }
  return out
}

/** 扫描一个 node_modules 目录（支持 @scope/pkg 两层）。 */
function collectFromNodeModules(nmDir, source) {
  const out = []
  for (const ent of readDirs(nmDir)) {
    const full = path.join(nmDir, ent.name)
    if (!isDir(full)) continue
    if (ent.name.startsWith('@')) {
      for (const sub of readDirs(full)) {
        const pkg = path.join(full, sub.name)
        if (isDir(pkg)) out.push(...collectFromPackage(pkg, source))
      }
    } else if (ent.name !== '.bin' && ent.name !== '.pnpm') {
      out.push(...collectFromPackage(full, source))
    }
  }
  return out
}

/**
 * 文件系统兜底发现（独立 Web 进程 / 没有 ctx.skills 的宿主）。
 *
 * 覆盖（按各家 agent 的公开约定）：
 * - 项目级：<repo>/.dsh/skills、<repo>/.agents/skills、<repo>/.cursor/skills、
 *           <repo>/.claude/skills、<repo>/.codex/skills、<repo>/skills
 * - 自定义：MEMORY_SKILL_DIRS（path.delimiter 分隔）
 * - 用户级：DSH_HOME/skills、DSH_AGENTS_HOME(默认 ~/.agents)/skills、
 *           ~/.cursor/skills、~/.claude/skills、~/.codex/skills
 * - 不扫描 ~/.cursor/skills-cursor：那是 Cursor 自己的内部内置技能目录。
 * - 插件级：DSH_HOME/profiles/<profile>/node_modules/<pkg> 的 skills / .agents/skills
 * - bundled：DSH_BUNDLED_SKILL_DIR、packageRoot/skills
 *
 * @returns {Array<{name:string, description:string, content:string, source:string, provider:string, path:string}>}
 */
export function collectSkillFiles({ env = process.env, cwd = process.cwd(), packageRoot = '' } = {}) {
  const userHome = os.homedir()
  const dshHome = String(env.DSH_HOME || '').trim() || path.join(userHome, '.dsh')
  const agentsHome = String(env.DSH_AGENTS_HOME || env.AGENTS_HOME || '').trim() || path.join(userHome, '.agents')
  const cursorHome = String(env.CURSOR_HOME || '').trim() || path.join(userHome, '.cursor')
  const claudeHome = String(env.CLAUDE_CONFIG_DIR || '').trim() || path.join(userHome, '.claude')
  const codexHome = String(env.CODEX_HOME || '').trim() || path.join(userHome, '.codex')
  const geminiHome = String(env.GEMINI_HOME || '').trim() || path.join(userHome, '.gemini')
  const xdgConfig = String(env.XDG_CONFIG_HOME || '').trim() || path.join(userHome, '.config')
  const projectRoot = findProjectRoot(cwd)

  const cands = []
  const add = (root, source) => { if (root && isDir(root)) cands.push({ root, source }) }
  // 项目级：DSH 官方（.dsh / .agents），Cursor 兼容（.cursor / .claude / .codex）
  add(path.join(projectRoot, '.dsh', 'skills'), 'project-dsh')
  add(path.join(projectRoot, '.agents', 'skills'), 'project-agents')
  add(path.join(projectRoot, '.cursor', 'skills'), 'project-cursor')
  add(path.join(projectRoot, '.claude', 'skills'), 'project-claude')
  add(path.join(projectRoot, '.codex', 'skills'), 'project-codex')
  add(path.join(cwd, 'skills'), 'project')
  // 自定义目录（运维/企业批量注入；多个目录用系统路径分隔符）
  for (const dir of String(env.MEMORY_SKILL_DIRS || '').split(path.delimiter)) {
    const s = dir.trim()
    if (s) add(path.resolve(s), 'custom')
  }
  // 用户级：DSH → 跨 agent 共享目录 → 各家兼容目录
  add(path.join(dshHome, 'skills'), 'user-dsh')
  add(path.join(agentsHome, 'skills'), 'user-agents')
  add(path.join(cursorHome, 'skills'), 'user-cursor')
  add(path.join(claudeHome, 'skills'), 'user-claude')
  add(path.join(codexHome, 'skills'), 'user-codex')
  add(path.join(geminiHome, 'skills'), 'user-gemini')
  add(path.join(xdgConfig, 'opencode', 'skills'), 'user-opencode')
  // bundled / 本插件自带
  const bundled = String(env.DSH_BUNDLED_SKILL_DIR || '').trim()
  if (bundled) add(path.resolve(bundled), 'bundled')
  if (packageRoot) add(path.join(packageRoot, 'skills'), 'bundled')

  const found = []
  for (const c of cands) found.push(...collectFromSkillRoot(c.root, c.source))

  // 插件 skills（profile 的 node_modules）
  const profiles = path.join(dshHome, 'profiles')
  for (const ent of readDirs(profiles)) {
    const nm = path.join(profiles, ent.name, 'node_modules')
    if (isDir(nm)) found.push(...collectFromNodeModules(nm, 'plugin'))
  }

  // 去重：同一真实文件只取一次；同名技能保留**版本最高**的一份。
  // 版本相同/都未标注时保留先到先得（项目 > 自定义 > 用户 > 插件 > bundled）。
  const seenFile = new Set()
  const groups = new Map()
  for (const item of found) {
    const p = item.parsed
    if (!p || !p.name) continue
    let real = item.file
    try { real = fs.realpathSync(item.file) } catch { /* 保留原路径 */ }
    const key = real.toLowerCase()
    if (seenFile.has(key)) continue
    seenFile.add(key)
    const version = String(p.version || (item.source !== 'bundled' ? packageVersionForFile(item.file) : '') || '').trim()
    if (!groups.has(p.name)) groups.set(p.name, [])
    groups.get(p.name).push({
      name: p.name,
      description: p.description,
      version,
      whenToUse: p.whenToUse,
      content: p.content,
      source: item.source,
      provider: item.source,
      path: item.file,
      invocation: { modelInvocable: true, userInvocable: true },
    })
  }
  const out = []
  for (const list of groups.values()) {
    let best = list[0]
    for (const candidate of list) {
      if (compareSkillVersions(candidate.version, best.version) > 0) best = candidate
    }
    out.push(best)
  }
  return out
}

/** 从宿主技能注册表（ctx.skills）取「实际可用技能」的完整定义。 */
export async function collectSkillsFromRegistry(skills, { cwd = '', signal } = {}) {
  const opts = {}
  if (cwd) opts.cwd = cwd
  if (signal) opts.signal = signal
  let summaries = []
  if (typeof skills.snapshot === 'function') {
    const snap = await skills.snapshot(opts)
    summaries = Array.isArray(snap && snap.skills) ? snap.skills : []
  } else if (typeof skills.list === 'function') {
    summaries = await skills.list(opts)
  }
  const out = []
  for (const summary of summaries) {
    if (!summary || !summary.name) continue
    let content = ''
    let description = String(summary.description || '')
    let whenToUse = String(summary.whenToUse || '')
    let version = String(summary.version || (summary.metadata && summary.metadata.version) || '')
    let file = summary.path || ''
    try {
      if (typeof skills.get === 'function') {
        const def = await skills.get(summary.name, opts)
        if (def) {
          content = String(def.content || '')
          description = String(def.description || description)
          whenToUse = String(def.whenToUse || whenToUse)
          version = String(def.version || (def.metadata && def.metadata.version) || version)
          file = def.path || file
        }
      }
    } catch { /* 单个技能读不到正文时仍保留摘要卡 */ }
    out.push({
      name: summary.name,
      description,
      version: String(summary.source || '') === 'bundled' ? '' : version,
      whenToUse,
      content,
      source: String(summary.source || 'skill'),
      provider: String(summary.provider || ''),
      path: file,
      invocation: summary.invocation || { modelInvocable: true, userInvocable: true },
    })
  }
  return out
}

/** 组装一张技能卡的标题 / 标签 / 正文。 */
export function buildSkillCardBody(skill, { maxContentChars = DEFAULT_MAX_CONTENT } = {}) {
  const name = String(skill.name || 'skill').trim()
  const source = String(skill.source || 'unknown')
  const invocation = skill.invocation || {}
  const modelOk = invocation.modelInvocable !== false
  const userOk = invocation.userInvocable !== false
  const content = String(skill.content || '').trim()
  const clipped = content.length > maxContentChars
    ? content.slice(0, maxContentChars) + '\n\n…（技能正文过长，已截断 ' + (content.length - maxContentChars) + ' 字）'
    : content
  const info = [
    '- 名称：' + name,
    '- 来源：' + source,
    skill.version ? '- 版本：' + String(skill.version).trim() : '',
    skill.provider ? '- 提供方：' + skill.provider : '',
    skill.path ? '- 技能文件：' + skill.path : '',
    '- 模型可调用：' + (modelOk ? '是' : '否'),
    '- 用户可调用：' + (userOk ? '是' : '否'),
    skill.whenToUse ? '- 何时使用：' + skill.whenToUse : '',
  ].filter(Boolean)
  const lines = [
    '# ' + name,
    '',
    skill.description || '（技能未提供描述）',
    '',
    '## 技能信息',
    '',
    ...info,
    '',
    '## 技能说明',
    '',
    clipped || '（技能文件未提供正文）',
  ]
  const tags = ['skill', source].filter(Boolean)
  if (!modelOk) tags.push('user-only')
  return { title: name, body: lines.join('\n'), tags }
}

/** 查询两张表里所有由本模块生成的技能卡（source 以 skill: 开头）。 */
function loadExistingSkillCards(root) {
  const db = getDb(root)
  const sql = `
    SELECT path, status, source, title, body FROM quarantine WHERE source LIKE 'skill:%'
    UNION ALL
    SELECT path, status, source, title, body FROM cards WHERE source LIKE 'skill:%'
  `
  const rows = db.prepare(sql).all()
  const map = new Map()
  for (const row of rows) {
    if (!row.source) continue
    if (!map.has(row.source)) map.set(row.source, [])
    map.get(row.source).push(row)
  }
  return map
}

/** 查一张已批准技能卡当前待审的修改副本（审核通过后会覆盖原卡）。 */
function loadPendingRevision(root, targetPath) {
  const db = getDb(root)
  return db.prepare(`
    SELECT q.path, q.title, q.body, q.source
    FROM card_revisions r
    JOIN quarantine q ON q.path = r.revision_path
    WHERE r.target_path = ? AND q.status = 'pending'
    ORDER BY r.updated_at DESC
    LIMIT 1
  `).get(targetPath) || null
}

/**
 * 把「实际技能」同步成 kind=skill 的待审卡。
 *
 * @param {string} root vault 根目录
 * @param {object} [opts]
 * @param {object} [opts.skills] 宿主 ctx.skills（有则优先；没有则文件系统兜底）
 * @param {string} [opts.cwd]    技能解析用的工作区
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.packageRoot] 本插件包根（兜底扫描自带 skills）
 * @param {boolean} [opts.includeFilesystem=true] 是否同时扫描磁盘技能（默认 true；
 *   false 仅用于「只信注册表」的测试/特殊部署）
 * @param {boolean} [opts.force]  忽略「已驳回/已删除不复活」的保护（仅内部/测试用）
 * @returns {Promise<{ok:boolean, source:'registry'|'filesystem'|'registry+filesystem', total:number, created:number, updated:number, pendingUpdates:number, unchanged:number, skipped:number, removed:number, errors:string[], updates:Array}>}
 */
export async function syncSkillCards(root, { skills, cwd = '', env = process.env, packageRoot = '', force = false, includeFilesystem = true } = {}) {
  await ensureVault(root)
  let registryList = []
  if (skills && (typeof skills.list === 'function' || typeof skills.snapshot === 'function')) {
    try { registryList = await collectSkillsFromRegistry(skills, { cwd }) } catch { registryList = [] }
  }
  // 关键：ctx.skills.list() 默认只读**全局层**。DSH 的 agent 作用域技能
  // （项目 .dsh/skills、.agents/skills、用户技能目录）不一定在这个层里，所以不能
  // 因为注册表非空就跳过磁盘扫描 —— 否则技能审核里只会出现少数 bundled 技能。
  const fileList = includeFilesystem ? collectSkillFiles({ env, cwd: cwd || process.cwd(), packageRoot }) : []
  const source = registryList.length && fileList.length
    ? 'registry+filesystem'
    : (registryList.length ? 'registry' : 'filesystem')

  // 同名只保留一个：**版本高的优先**；同版本注册表优先（invocation 元数据更完整）。
  // 多个安装位置/多个版本同时存在时，不再按扫描顺序盲选。
  const byName = new Map()
  const consider = (s, preferRegistry) => {
    if (!s || !s.name) return
    const prev = byName.get(s.name)
    if (!prev) { byName.set(s.name, s); return }
    const cmp = compareSkillVersions(s.version, prev.version)
    if (cmp > 0 || (cmp === 0 && preferRegistry)) byName.set(s.name, s)
  }
  for (const s of fileList) consider(s, false)
  for (const s of registryList) consider(s, true)
  const skillsList = [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))

  const existing = loadExistingSkillCards(root)
  const currentNames = new Set(skillsList.map((s) => s.name))
  const stats = { ok: true, source, total: skillsList.length, created: 0, updated: 0, pendingUpdates: 0, unchanged: 0, skipped: 0, removed: 0, errors: [], updates: [] }

  // removed：库里曾经生成过、这次扫描不再存在（只统计，不删除）
  for (const key of existing.keys()) {
    const m = /^skill:([^#]+)$/.exec(key)
    if (m && !currentNames.has(m[1])) stats.removed++
  }

  for (const skill of skillsList) {
    try {
      const built = buildSkillCardBody(skill)
      const baseSource = 'skill:' + skill.name
      const incomingVersion = String(skill.version || '').trim()
      const baseRows = existing.get(baseSource) || []
      const pending = baseRows.find((r) => r.status === 'pending')
      const approved = baseRows.find((r) => r.status === 'approved')
      const rejected = baseRows.find((r) => r.status === 'rejected' || r.status === 'deleted')
      const sameCard = (row) => !!row && sameText(row.body, built.body) && row.title === built.title

      const addUpdate = (fromVersion, toVersion, title, path, targetPath) => {
        stats.updates.push({
          name: skill.name,
          fromVersion: String(fromVersion || '').trim(),
          toVersion: String(toVersion || '').trim(),
          title,
          path,
          targetPath: targetPath || '',
        })
      }

      if (pending) {
        const currentVersion = skillVersionFromBody(pending.body)
        const cmp = (incomingVersion && currentVersion) ? compareSkillVersions(incomingVersion, currentVersion) : 0
        if (cmp < 0) { stats.skipped++; continue }
        if (sameCard(pending)) { stats.unchanged++; continue }
        await updateCardContent(root, pending.path, {
          title: built.title,
          tags: built.tags,
          body: built.body,
          reason: '根据实际技能生成（版本/内容有更新）',
        })
        stats.updated++
        addUpdate(currentVersion, incomingVersion, built.title, pending.path, pending.path)
        continue
      }

      if (approved) {
        const currentVersion = skillVersionFromBody(approved.body)
        const cmp = (incomingVersion && currentVersion) ? compareSkillVersions(incomingVersion, currentVersion) : 0
        if (sameCard(approved) && cmp <= 0) { stats.unchanged++; continue }
        if (cmp < 0) { stats.skipped++; continue } // 不把已批准技能降级到旧版本

        const revision = loadPendingRevision(root, approved.path)
        if (revision) {
          const revisionVersion = skillVersionFromBody(revision.body)
          if (sameText(revision.body, built.body)) { stats.unchanged++; continue }
          if (incomingVersion && revisionVersion && compareSkillVersions(incomingVersion, revisionVersion) < 0) {
            stats.skipped++
            continue
          }
          const title = built.title
          const r = await reviseCard(root, {
            target: approved.path,
            title,
            tags: built.tags,
            body: built.body,
            reason: '技能版本/内容有更新，等待审核',
            source: 'skill-update:' + skill.name,
            submittedBy: 'skill-sync',
          })
          stats.pendingUpdates++
          addUpdate(revisionVersion || currentVersion, incomingVersion, title, r.path, approved.path)
          continue
        }

        const title = built.title
        const r = await reviseCard(root, {
          target: approved.path,
          title,
          tags: built.tags,
          body: built.body,
          reason: '技能版本/内容有更新，等待审核',
          source: 'skill-update:' + skill.name,
          submittedBy: 'skill-sync',
        })
        stats.pendingUpdates++
        addUpdate(currentVersion, incomingVersion, title, r.path, approved.path)
        continue
      }

      if (rejected && !force) { stats.skipped++; continue }

      const r = await writeCard(root, {
        kind: SKILL_KIND,
        title: built.title,
        tags: built.tags,
        body: built.body,
        source: baseSource,
        submittedBy: 'skill-sync',
        status: 'pending',
        reason: '根据实际技能生成',
      }, { dedup: false })
      if (r.ok) stats.created++
      else stats.skipped++
    } catch (error) {
      if (stats.errors.length < 10) stats.errors.push(skill.name + '：' + String((error && error.message) || error))
    }
  }
  return stats
}

/** 给宿主/独立端复用的默认扫描（无需 ctx.skills）。 */
export async function syncSkillCardsFromFiles(root, { env = process.env, cwd = process.cwd(), packageRoot = '' } = {}) {
  return syncSkillCards(root, { env, cwd, packageRoot })
}
