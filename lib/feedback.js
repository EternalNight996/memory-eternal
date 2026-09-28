// 记忆核心 · 「反馈异常」支撑层（纯函数，便于单测）
//
// 为什么不做「点一下直接提交」：
//   1. GitHub 不允许匿名创建 issue（REST 必须带认证）；
//   2. 插件跑在用户机器上，内置 token 等于把 token 公开（asar/JS 反编译即可提取）；
//   3. 走 OAuth 或自建中转需要 client secret / 服务器，成本与风险都不合算。
// 因此提供两条可用路径：
//   A. 预填 issue 链接：标题/正文/标签/诊断都填好，用户点一次 Submit（等价于一点提交）；
//   B. 给 AI 的提示词：用户贴进对话框，让 AI 用 gh 建 issue 并回报链接。
//
// 另一件必须做的事：脱敏。issue 是公开的，绝不能把 home 目录、API key、token 带出去。

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^\s"',}]{8,}/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
]

/**
 * 脱敏：home 目录 → ~，各类 key/token → ***。
 * @param {string} input
 * @param {string} [home]
 * @returns {string}
 */
export function redactText(input, home = '') {
  let s = String(input ?? '')
  if (home && home.length > 3) {
    const variants = [home, home.split('\\').join('/'), home.split('/').join('\\')]
    for (const v of variants) if (v && v.length > 3) s = s.split(v).join('~')
  }
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~')
  s = s.replace(/(\/home\/|\/Users\/)[^/\s"']+/g, '~')
  for (const re of SECRET_PATTERNS) s = s.replace(re, '***')
  return s
}

/**
 * 组装诊断信息（markdown，已脱敏、已限长）。
 * @param {object} input
 * @param {string} [home]
 * @returns {string}
 */
export function buildDiagnostics(input = {}, home = '') {
  const rows = []
  const add = (k, v) => {
    if (v === undefined || v === null) return
    const s = String(v).trim()
    if (!s) return
    rows.push('- ' + k + ': ' + redactText(s, home))
  }
  add('memory-eternal', input.version)
  add('DSH', input.dshVersion)
  add('Host', input.host)
  add('OS', input.os)
  add('Node', input.node)
  add('Vault', input.vaultDir)
  add('Vault source', input.vaultSource)
  add('Workspace', input.workspace)
  add('Cards', input.cards)
  add('Graph', input.graph)
  if (input.health && input.health.ok === false) add('Health', 'FAIL: ' + (input.health.reason || ''))
  const log = Array.isArray(input.captureLog) ? input.captureLog.slice(-10) : []
  const out = ['### 诊断信息', '', ...rows]
  if (log.length) {
    out.push('', '最近沉淀日志（最多 10 条）：', '`')
    for (const e of log) out.push(redactText(typeof e === 'string' ? e : JSON.stringify(e), home))
    out.push('`')
  }
  let text = out.join('\n')
  if (text.length > 2400) text = text.slice(0, 2400) + '\n…（诊断信息过长已截断）'
  return text
}

/**
 * 生成 GitHub 预填 issue 链接（带长度保护：URL 过长会被 GitHub/浏览器直接拒绝）。
 * @param {{repo?:string, title?:string, body?:string, labels?:string[], maxLength?:number}} input
 * @returns {string}
 */
export function buildIssueUrl(input = {}) {
  const repo = input.repo || 'EternalNight996/memory-eternal'
  const title = String(input.title || '[Bug] ').slice(0, 120)
  const labels = Array.isArray(input.labels) ? input.labels : ['bug']
  const maxLength = Number(input.maxLength) > 500 ? Number(input.maxLength) : 7000
  const build = (body) => {
    const q = new URLSearchParams()
    q.set('title', title)
    q.set('body', body)
    if (labels.length) q.set('labels', labels.join(','))
    return 'https://github.com/' + repo + '/issues/new?' + q.toString()
  }
  let body = String(input.body || '')
  let url = build(body)
  if (url.length > maxLength) {
    // URLSearchParams 会把正文按 percent-encoding 膨胀（中文约 9 倍），用「长度估算」截断会不准。
    // 直接二分：找最大的 k 使 build(body.slice(0,k) + note).length <= maxLength —— 结果可证明在阈值内。
    const note = '\n\n> 内容过长已截断：完整诊断请在插件里点「复制诊断信息」，再补到 issue 评论里。'
    const withNote = (k) => build(body.slice(0, k) + note)
    if (withNote(0).length > maxLength) {
      body = note
    } else {
      let lo = 0
      let hi = body.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (withNote(mid).length <= maxLength) lo = mid
        else hi = mid - 1
      }
      body = body.slice(0, lo) + note
    }
    url = build(body)
  }
  return url
}

/**
 * 反馈正文模板（预填 issue 与提示词共用）。
 * @param {{description?:string, diagnostics?:string, version?:string}} [input]
 * @returns {string}
 */
export function buildIssueBody(input = {}) {
  return [
    '## 现象',
    String(input.description || '').trim() || '（请描述你遇到的问题）',
    '',
    '## 复现步骤',
    '1. ',
    '2. ',
    '',
    '## 期望行为',
    '',
    '## 实际行为',
    '',
    '## 环境',
    '- 插件版本: ' + (input.version || '（见诊断信息）'),
    '',
    input.diagnostics || '',
    '',
    '---',
    '> 由 memory-eternal 插件内「反馈异常」生成（诊断信息已自动脱敏：home 目录与各类 key/token 已替换）。',
  ].join('\n')
}

const REPO = 'https://github.com/EternalNight996/memory-eternal'

const PROMPT_ZH = [
  '我在使用 memory-eternal（DeepSeek Harness 的记忆插件）时遇到了问题，请你帮我把这个问题提交到 GitHub。',
  '',
  '仓库：' + REPO,
  '',
  '请按这个流程做：',
  '',
  '1. 先跑 `gh issue list --repo EternalNight996/memory-eternal --state open --limit 50`，看是否已有相同问题：',
  '   - 已有 → 用 `gh issue comment <编号> --body-file <文件>` 补充现象，不要重复开新 issue；',
  '   - 没有 → 继续第 2 步。',
  '2. 把正文写成文件，然后 `gh issue create --repo EternalNight996/memory-eternal --title "[Bug] <一句话概括>" --body-file <文件>`；正文用这个结构：',
  '   现象 / 复现步骤 / 期望行为 / 实际行为 / 环境（插件版本 / DSH 版本 / 操作系统 / Node）/ 诊断信息。',
  '3. 如果 `gh` 没登录或不可用，不要尝试提交，改为输出一条「标题与正文都已预填」的 GitHub 新建 issue 链接给我，我自己点提交。',
  '4. 提交成功后，把 issue 链接发给我。',
  '',
  '注意：我的问题描述请原样照录，不要替我美化或省略细节；诊断信息原样放进「诊断信息」一节。',
  '',
  '我的问题描述：',
  '<在这里写你的问题>',
  '',
  '诊断信息：',
  '<把「反馈异常」弹窗里复制的诊断信息粘到这里>',
].join('\n')

const PROMPT_EN = [
  'I hit a problem while using memory-eternal (a DeepSeek Harness memory plugin). Please file it on GitHub for me.',
  '',
  'Repo: ' + REPO,
  '',
  'Workflow:',
  '',
  '1. Run `gh issue list --repo EternalNight996/memory-eternal --state open --limit 50` first: if a matching issue exists, add a comment with `gh issue comment <n> --body-file <file>` instead of opening a duplicate.',
  '2. Otherwise create it with `gh issue create --repo EternalNight996/memory-eternal --title "[Bug] <one-line summary>" --body-file <file>`, using sections: Symptoms / Steps to reproduce / Expected / Actual / Environment (plugin, DSH, OS, Node) / Diagnostics.',
  '3. If `gh` is not authenticated or unavailable, do NOT try to submit: output a GitHub new-issue link with the title and body pre-filled instead, and I will click submit myself.',
  '4. Report the resulting issue URL back to me.',
  '',
  'Keep my description verbatim - do not rewrite or summarise it. Put the diagnostics under the Diagnostics section as-is.',
  '',
  'My description:',
  '<write your problem here>',
  '',
  'Diagnostics:',
  '<paste the diagnostics copied from the in-app Report-a-bug dialog>',
].join('\n')

/**
 * 给 AI 的提示词（用户贴进对话框）。
 * @param {{description?:string, diagnostics?:string, repo?:string, lang?:'zh'|'en'}} [input]
 * @returns {string}
 */
export function buildAgentPrompt(input = {}) {
  const lang = input.lang === 'en' ? 'en' : 'zh'
  let text = lang === 'en' ? PROMPT_EN : PROMPT_ZH
  const repo = input.repo || 'EternalNight996/memory-eternal'
  text = text.split(REPO).join('https://github.com/' + repo)
  if (input.description) text = text.replace(lang === 'en' ? '<write your problem here>' : '<在这里写你的问题>', String(input.description).trim())
  if (input.diagnostics) text = text.replace(lang === 'en' ? '<paste the diagnostics copied from the in-app Report-a-bug dialog>' : '<把「反馈异常」弹窗里复制的诊断信息粘到这里>', String(input.diagnostics).trim())
  return text
}
