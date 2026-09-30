// 记忆核心 · 独立进程沉淀管线（MCP / CLI / hooks 共用）。
//
// 复刻 index.js runCapture 的判定链（预筛→配额→LLM 蒸馏→新建/追加→词法兜底），
// 但 LLM 来源是 lib/llm-openai.js 的 OpenAI 兼容适配器而非 DSH llm 服务。
// 未配置 LLM 时降级：跳过蒸馏，直接把原文写成一张卡（kind/tool 或调用方指定），
// 保证「无 LLM 环境也能沉淀，只是不压缩」。

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { captureCard, captureUpdate, pickNeighbors, summarizeTurnDetailed, routeCandidates, stripRuntimeNoise, hasUsableContent, deriveTitle, isUsableTitle } from './capture.js'
import { resolveVaultDir, defaultVaultRoot } from './vault-resolve.js'
import { createLlmFromEnv } from './llm-openai.js'

/**
 * 解析当前 vault 目录。
 *
 * 优先级必须与宿主 index.js 的 vaultDir() **完全一致**：
 *   MEMORY_VAULT_DIR → activeVault 命中 vaultProfiles → vaultDir → 默认 ~/.dsh/memory-vault。
 * 旧实现只认 MEMORY_VAULT_DIR / 默认路径，于是用户在宿主里切库后，CLI / MCP / hooks /
 * 独立 web / sweep 仍然写默认库 —— 同一台机器上记忆被劈成两份（dsh-memory-eternal#5）。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 绝对路径
 */
export function defaultVaultDir(env = process.env) {
  if (env.MEMORY_VAULT_DIR && env.MEMORY_VAULT_DIR.trim()) return path.resolve(env.MEMORY_VAULT_DIR.trim())
  try {
    const cfg = readConfig(env) || {}
    // 与宿主共用同一套解析（含 match.workspace 的按项目选库）
    return resolveVaultDir({
      env,
      profiles: cfg.vaultProfiles,
      activeVault: cfg.activeVault,
      configured: cfg.vaultDir,
    }).root
  } catch { /* 读不到共享配置就回落默认库 */ }
  return defaultVaultRoot(env)
}

// 读取 DSH 设置的完整配置（写入的共享文件），使独立 web / MCP hook 捕获与 DSH 设置同步。
const CONFIG_FILE = 'memory-eternal-config.json'
export function configFilePath(env = process.env) {
  return path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), CONFIG_FILE)
}
function readConfig(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(configFilePath(env), 'utf8'))
  } catch { return null }
}
function splitList(x) { return (Array.isArray(x) ? x : String(x || '').split(',')).map((s) => String(s).trim()).filter(Boolean) }

/**
 * 沉淀一段对话文本到 vault。
 * @returns {Promise<{ok:boolean, action:'created'|'appended'|'skipped'|'failed', path?:string, reason?:string, degraded?:boolean}>}
 */
export async function runStandaloneCapture(vaultRoot, text, { source = '', llm, env = process.env, minChars = 120 } = {}) {
  // 入料噪声闸门（P0）：先剥运行时注入（环境快照 / team 广播 / teammate 原文 / 工具说明），
  // 再判断是否还有真实内容。此处是 MCP memory_capture / CLI / hooks 的共同入口。
  const clean = stripRuntimeNoise(text)
  if (clean.length < minChars) return { ok: false, action: 'skipped', reason: 'text too short' }
  if (!hasUsableContent(clean)) return { ok: false, action: 'skipped', reason: 'text is runtime noise' }
  const title = deriveTitle(clean)
  if (!isUsableTitle(title)) return { ok: false, action: 'skipped', reason: 'cannot derive a usable title' }

  // 自动审核：共享配置文件(DSH)优先，其次 env，默认 all（独立进程无 DSH settings）
  // 注：`shared` 原先在回调里局部读取，第 80 行的路由兜底却引用了外层同名变量 → ReferenceError
  // 被下面的 try/catch 静默吞掉，导致 captureProvider/captureModel 在本进程从不生效。这里提到函数级。
  const shared = readConfig(env)
  const resolveAuditStatus = (kind, sub) => {
    const mode = shared?.auditMode || env.MEMORY_AUDIT_MODE || 'all'
    const agents = shared?.auditExemptAgents ? splitList(shared.auditExemptAgents) : splitList(env.MEMORY_AUDIT_EXEMPT_AGENTS || '')
    const kinds = shared?.auditExemptKinds ? splitList(shared.auditExemptKinds) : splitList(env.MEMORY_AUDIT_EXEMPT_KINDS || '')
    if (mode === 'none') return 'approved'
    if (agents.includes('__all__') || agents.includes(sub)) return 'approved'
    if (kinds.includes('__all__') || kinds.includes(kind)) return 'approved'
    return 'pending'
  }

  const llmClient = llm ?? createLlmFromEnv(env)
  // 与宿主同样的候选路由：显式配置优先，其余按注册顺序兜底（别写死 providers[0]，见 issue #3）
  const routes = llmClient ? await routeCandidates(llmClient, { provider: shared?.captureProvider, model: shared?.captureModel }) : []
  const route = routes[0] ?? null

  // 有 LLM：蒸馏判定链（与 DSH 侧一致）
  if (llmClient && route) {
    try {
      const neighbors = await pickNeighbors(vaultRoot, { title: '', body: clean.slice(0, 400) }, 8)
      const detailed = await summarizeTurnDetailed(llmClient, route, clean, { existing: neighbors, signal: AbortSignal.timeout(45000) })
      const result = detailed.card
      // 独立进程也必须把真实失败暴露出来（走 stderr），别再静默降级成「无输出」
      if (detailed.failure) {
        process.stderr.write(`[memory-eternal] 蒸馏失败（${route.provider}/${route.model}）：${detailed.failure.code} ${detailed.failure.message}\n`)
      }
      if (result && result.save === true) {
        if (result.append_to) {
          await captureUpdate(vaultRoot, result.append_to, result.update, { threshold: 0.62 })
          return { ok: true, action: 'appended', path: result.append_to }
        }
        const card = { kind: result.kind, title: result.title, tags: result.tags, body: result.body, source, status: resolveAuditStatus(result.kind, source || 'agent'), submittedBy: source || 'agent', severity: 'info', reason: 'AI 自动沉淀（蒸馏卡）' }
        const out = await captureCard(vaultRoot, card, { threshold: 0.62 })
        if (out.ok) return { ok: true, action: 'created', path: out.path ?? out.rel }
        if (out.duplicate) {
          await captureUpdate(vaultRoot, out.duplicate.path, `${result.title}：${result.body.slice(0, 400)}`, { threshold: 0.62 })
          return { ok: true, action: 'appended', path: out.duplicate.path }
        }
        return { ok: false, action: 'failed', reason: String(out.reason || 'write failed') }
      }
      if (result && result.save === false) return { ok: true, action: 'skipped', reason: 'model judged not durable' }
    } catch (error) {
      // LLM 失败 → 落入降级路径，不能让一次网络抖动丢掉沉淀
    }
  }

  // 降级：无 LLM（或 LLM 调用失败）→ 原文卡（kind 默认 content，dedup 开）
  // 标题用 deriveTitle 派生（不再 slice 硬切）；正文用剥离噪声后的 clean。
  const out = await captureCard(vaultRoot, {
    kind: 'content',
    title,
    tags: ['raw'],
    body: clean,
    source: source || 'manual',
    status: resolveAuditStatus('content', source || 'agent'),
    submittedBy: source || 'agent',
    severity: 'info',
    reason: 'AI 自动沉淀（原文卡）',
  }, { threshold: 0.62 })
  if (out.ok) return { ok: true, action: 'created', path: out.path ?? out.rel, degraded: true }
  if (out.duplicate) {
    await captureUpdate(vaultRoot, out.duplicate.path, clean.slice(0, 400), { threshold: 0.62 })
    return { ok: true, action: 'appended', path: out.duplicate.path, degraded: true }
  }
  return { ok: false, action: 'failed', reason: String(out.reason || 'write failed') }
}
