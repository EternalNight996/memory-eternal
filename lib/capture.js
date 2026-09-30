// 记忆核心 · 自动沉淀管线
//
// 移植 boujoy-harness 的「知识捕获」理念：模型负责判定价值（score）与压缩
// （卡片正文），本模块只负责安全（写哪、多短拒绝、去重守卫）。
//
// 与 boujoy 的区别：不需要用户点「沉淀」——会话每轮结束后由 index.js 监听
// agent/turn-stopping 自动触发 summarizeTurn → writeCard/appendUpdate。
//
// 去重：两级。第一级是词法（Jaccard bigram，阈值 0.62，捕获纯重复）；第二级
// 是语义——把「现有卡片索引」（标题+摘要，最多近邻 8 张）喂给模型，让模型
// 判断新知识是「新建卡片」还是「追加到已有卡片」（append_to），这正是
// boujoy 的「追加更新记录，不要堆重复卡」语义，且对 LLM 改写免疫。

import { writeCard, appendUpdate, textSimilarity, dedupCheck, listCards, queryTerms } from './vault.js'

/** 默认去重阈值（与 boujoy 一致）。 */
export const DEDUP_THRESHOLD = 0.62

/** 参与语义去重的近邻卡片数上限（控制 token）。 */
export const DEDUP_NEIGHBORS = 8

// 沉淀预筛：仅当对话含「可复用」信号时才调用 LLM，避免对纯闲聊/寒暄发起昂贵的 LLM 判定。
const DURABLE_SIGNALS = /(#{1,3}\s|```|\[\[|\]|\(https?:|\.(md|ts|js|py|json|yml|yaml|sh|sql)\b|`|\b\d{2,}\b|选择|决定|采用|方案|结论|原因|根因|问题|解决|修复|报错|错误|教训|架构|设计|配置|部署|流程|步骤|算法|原理|函数|接口|参数|命令|依赖|版本|坑|踩|优化|性能|数据库|索引|模型|token|推荐|偏好|约定|规范)/

// -- 入料噪声闸门（P0 修复）--------------------------------------------------
//
// 背景：turn-stopping 抓的是「本会话新增的 user/assistant 消息」，而 DSH 会把
// 大量**运行时注入**伪装成 user 消息塞进会话：环境快照、team 广播、teammate 原文、
// 工具使用说明（`# create-hook`）、文件片段（"g libs."）。旧实现全部当正文喂给模型，
// 于是待审队列里出现「用户：<system-reminder> You are teammate」这类垃圾卡。
// 这里只做**机械剥离**，不做价值判断（价值判断仍归模型 + 审核中心）。

/** 运行时注入的段落标记：成对出现，整段剥掉。 */
const NOISE_BLOCKS = [
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<team-[a-z-]+>[\s\S]*?<\/team-[a-z-]+>/gi,
  /<teammate[^>]*>[\s\S]*?<\/teammate>/gi,
  /<agent-message[^>]*>[\s\S]*?<\/agent-message>/gi,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi,
  /<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/gi,
  /\[Tool use: [^\]]*\]/gi,
]
/** 运行时注入的行前缀：整行丢掉。 */
const NOISE_LINE = /^\s*(相关上下文|Current runtime context|Runtime context|Approval prompts are disabled|DSH file policy|Current DSH file policy|You are a teammate|Team Lead|Teammate |Subagent |Note: the user|系统提示|环境快照)[：:]?/i
/** 工具/命令使用说明的标题行（`# create-hook`、`## `codex create-hook``）。 */
const TOOL_DOC_HEADING = /^\s*#{1,4}\s*`?[a-z][a-z0-9-]{2,40}`?\s*$/i

/** 段落级剥离：去掉注入块、注入行、工具说明标题行，并在相邻行间插入换行（保持行结构）。 */
export function stripRuntimeNoise(text) {
  let out = String(text || '')
  // 注入块整段删除（不留新行：相邻两行必须重新贴合，否则会粘出「A用户：B」这种错位文本）
  for (const re of NOISE_BLOCKS) out = out.replace(re, '')
  const kept = []
  for (const line of out.split('\n')) {
    if (NOISE_LINE.test(line) || TOOL_DOC_HEADING.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

/**
 * 剥掉运行时注入块之后是否**什么都不剩**（最可靠的注入特征：整段就是被标签包起来的注入）。
 * `[\s\S]*?` 非贪婪匹配，长注入块也能正确剥掉；旧的 `hasUsableContent` 用「≥120 字」近似，
 * 对长度超过 120 的注入块会失效（例如整段 teammate 原文），这里直接按「剥完是否为空」判定。
 */
function isPureInjection(text) {
  let out = String(text || '')
  for (const re of NOISE_BLOCKS) out = out.replace(re, '')
  return out.replace(/[\s\-*_`]+/g, '').length === 0
}

/**
 * 判定「这段文本像不像被截断的片段」——用于挡住碎片卡。
 * 现象来源：DSH 注入的上下文块被从中间切开，得到 `` chema-form` 当 external `` 这种标题。
 * 保守起见只在**明确可疑**时返回 true：以标点/反引号开头，或以 `、-`、`(`、`/` 等
 * 明显未完结字符结尾。
 */
export function looksTruncated(text) {
  const t = String(text || '').trim()
  if (!t) return true
  if (/^[`'"）)】」》.,，。;；:：\-–—/\\|>]/.test(t)) return true
  if (/[（(【「《,，、:：;；\-–—/\\|]$/.test(t)) return true
  return false
}

/** 过滤掉碎片行与注入行：抽标题 / 摘要前先用一次。 */
function dropFragmentLines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !looksTruncated(l))
    .join('\n')
}

/**
 * 剥离噪声后的正文是否还够「像一次真实对话」。
 *
 * 为什么不用固定 120 字门槛：真实对话常常是短行列表（每行几十字），按「逐行丢碎片 +
 * 总量 ≥120」会**误杀**这类正常记录（tests/capture-route.test.mjs 的 189 字短行会话就被
 * 误判过）。这里改成「事实量 + 噪声占比」双判据：
 *   1. 剥完至少还剩 60 字事实内容（挡住纯注入 / 极短寒暄）；
 *   2. 剥掉的部分不能超过原文的 85%（挡住「主体都是注入、只带一句人话」的轮次）。
 * 真实内容被误伤的成本远高于偶尔放进一条噪声（噪声还有审核中心兜底）。
 */
export function hasUsableContent(text) {
  const raw = String(text || '').trim()
  if (raw.length < 60) return false
  if (isPureInjection(raw)) return false // 整段都是注入块（无论多长）一律不算内容
  const stripped = stripRuntimeNoise(raw)
  if (stripped.length < 60) return false
  if (raw.length > 120 && stripped.length / raw.length < 0.15) return false
  return true
}

/** 判断一段（已剥离噪声的）对话是否值得交 LLM 判定（省 token 的启发式预筛）。 */
export function looksDurable(text) {
  const t = String(text || '')
  if (t.trim().length < 120) return false
  if (DURABLE_SIGNALS.test(t)) return true
  // 列表/编号密度：≥2 个列表项且有一定长度 => 大概率是结构化知识
  const items = (t.match(/(^|\n)\s*[-*]\s+/gm) || []).length + (t.match(/(^|\n)\s*\d+[.、)]\s+/gm) || []).length
  return items >= 2 && t.trim().length >= 160
}

/**
 * 从正文里取一个「像标题」的片段（降级原文卡 / 无 LLM 场景用）。
 *
 * 旧实现是 `text.slice(0, 40)`：一句话被硬切，于是出现 `` chema-form` 当 external ``
 * 这种从半截开始的标题，审核中心根本没法判断（P0 修复）。这里：
 * 1. 取第一行非碎片文本；2. 去掉 `用户：` / `助手：` 说话人前缀与 markdown 记号；
 * 3. 优先在首个句读（。！？；!?;）处断句；4. 仍以 `、和/` 这类连接性字符结尾就再截一点。
 */
export function deriveTitle(text, maxLen = 60) {
  const lines = dropFragmentLines(text).split('\n')
  const firstLine = lines[0] || String(text || '').trim()
  let t = cleanTitleLine(firstLine)
  // 首行是 "# T" 这种过短的装饰性标题时，往后找第一句真正像标题的话（上限 5 行，避免扫全文）。
  if (!isUsableTitle(t)) {
    for (const line of lines.slice(1, 6)) {
      const cand = cleanTitleLine(line)
      if (isUsableTitle(cand)) { t = cand; break }
    }
  }
  if (!t) return ''
  const cut = t.search(/[。！？；!?;]/)
  if (cut >= 4) t = t.slice(0, cut)
  if (t.length > maxLen) t = t.slice(0, maxLen)
  t = t.replace(/[、,，和与\/\\\-–—:：]+$/, '').trim()
  return t
}

/** 单行清洗：去说话人前缀、markdown 记号、压缩空白。 */
function cleanTitleLine(line) {
  return String(line || '')
    .replace(/^(用户|助手|user|assistant)\s*[:：]\s*/i, '')
    .replace(/^[#>\-*\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 用当前模型把一段对话压缩成知识卡（或判定不值得保存 / 应追加到已有卡）。
 * @param llm - dsh 的 llm 服务（ctx.get('llm')）
 * @param route - { provider, model } 解析结果
 * @param conversation - 本轮对话文本（用户+助手）
 * @param opts - { maxTokens, signal, existing }：existing 为 [{path,title,summary}]
 * @returns Promise<null | { save:boolean } | { save:true, title, kind, tags, body } | { append_to, update }>
 */
export async function summarizeTurn(llm, route, conversation, opts = {}) {
  const r = await summarizeTurnDetailed(llm, route, conversation, opts)
  return r.card ?? null
}

/**
 * summarizeTurn 的「带诊断」版本：把「跳过」与「真失败」分开。
 *
 * 关键：适配器错误（缺凭证 / 网络 / 限流）不会抛给调用方，而是以
 * \`{ kind:'error'|'aborted', failure:{ code, message } }\` 终结流。旧实现只收集 text 块，
 * 于是空文本被笼统记成「蒸馏无输出」，真实原因（例如 MISSING_CREDENTIAL）完全不可见。
 *
 * @returns {Promise<{card?:any, skip?:string, failure?:{code:string,message:string}}>}
 */
export async function summarizeTurnDetailed(llm, route, conversation, opts = {}) {
  const text = String(conversation || '').trim()
  if (text.length < 120) return { skip: 'too-short' } // 太短，没有沉淀价值
  if (!hasUsableContent(text)) return { skip: 'noisy' } // 剥离注入噪声后没剩多少真实内容（P0 噪声闸门）
  if (!looksDurable(text)) return { skip: 'not-durable' } // 启发式预筛：无可复用信号则跳过 LLM 判定（省 token）

  const existing = Array.isArray(opts.existing) ? opts.existing.slice(0, DEDUP_NEIGHBORS) : []
  const existingBlock = existing.length
    ? '\n\n## 记忆库已有卡片索引（若新知识属于其中某张，必须用 append_to 追加而不是新建）\n' +
      existing.map((e, i) => `${i + 1}. [${e.path}] ${e.title}${e.summary ? `：${e.summary.slice(0, 120)}` : ''}`).join('\n')
    : ''

  const system = [
    '你是本地知识库的「记忆沉淀引擎」。你的唯一任务：判断一段对话中是否有值得长期复用的知识，若有则压缩成一张知识卡。',
    '判断标准（全部满足才保存）：',
    '1. 内容对未来有复用价值（技术方案、项目背景、设计决策、领域知识、偏好约定等）；',
    '2. 不是纯闲聊、寒暄或一次性指令；',
    '3. 与已有知识不重复（见下）。',
    '输出严格 JSON（不要 markdown 代码块、不要多余文字）：',
    '{"save": false} 表示不值得保存；',
    '否则输出：',
    '{"save": true, "title": "简短标题", "kind": "knowledge|project|content|prompt|business|tool|mistake", "tags": ["标签"], "body": "300-800字的压缩正文，markdown，含要点列表，首行是# 标题"}',
    'kind 含义：project=项目背景/进度；knowledge=通用知识/技术方案/设计决策；content=内容素材/资料；prompt=提示词/工作流；business=业务/商业；tool=工具链/CLI/配置/环境坑；mistake=错误/反模式/踩坑/“别这么做”/debug 教训。',
    '正文要求：去掉对话口水，只留可复用的结论、参数、步骤、原因。语言与对话一致。',
    '已有卡片规则：若新知识与某张已有卡片是同一主题（同一技术、同一项目、同一决策），不要新建——输出',
    '{"append_to": "已有卡片的 path 字段原样", "update": "追加/修正的短文本（一段话）"}',
    '只有当已有卡片索引为空或不相关时，才新建卡片。',
  ].join('\n')

  const { BlockAssembler, createUserMessage } = await importLlmHelpers()
  const assembler = new BlockAssembler()
  const messages = [createUserMessage({
    content: [{ type: 'text', text: text + existingBlock }],
    source: { kind: 'plugin', plugin: 'memory-eternal' },
  })]

  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: opts.maxTokens ?? 900,
    reasoningEffort: 'off',
    purpose: 'memory-capture',
    signal: opts.signal ?? AbortSignal.timeout(45000),
  }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  // finish 块才是失败真相（见上）；没有 finish 的兼容适配器按 stop 处理。
  const finish = assembler.finish && typeof assembler.finish === 'object' ? assembler.finish : { kind: 'stop' }
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const f = finish.failure || {}
    return {
      failure: {
        code: String(f.code || f.kind || finish.kind),
        message: String(f.message || f.detail || '模型调用失败'),
      },
    }
  }
  const out = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
  const parsed = parseCaptureJson(out)
  if (!parsed) {
    return { failure: { code: 'UNPARSEABLE_OUTPUT', message: out ? '模型输出无法解析为 JSON：' + out.slice(0, 160) : '模型返回空文本' } }
  }
  return { card: parsed }
}

/**
 * 语义去重近邻：按关键词重叠为候选卡排序，返回最相似的若干张。
 * 关键词 = 新卡标题/正文的 CJK 整词 + bigram 与已有卡标题/摘要的命中数。
 */
export async function pickNeighbors(root, card, limit = DEDUP_NEIGHBORS) {
  const haystack = `${card.title}\n${card.body}`.toLowerCase()
  const wanted = queryTerms(haystack)
  const cards = await listCards(root)
  const scored = []
  for (const existing of cards) {
    let score = 0
    const target = `${existing.title}\n${existing.summary}`.toLowerCase()
    for (const term of wanted) if (target.includes(term.toLowerCase())) score += 1
    if (score > 0) scored.push({ ...existing, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/**
 * 去重守卫：目标目录里已有高度相似卡片时返回它，否则返回 null。
 * @returns Promise<null | { path, score }>
 */
export function makeDedupChecker(root) {
  return (text, threshold = DEDUP_THRESHOLD) => dedupCheck(root, text, threshold)
}

/** 写卡（带目录级去重守卫），命中返回 duplicate 而非写卡。 */
export async function captureCard(root, card, opts = {}) {
  const threshold = opts.threshold ?? DEDUP_THRESHOLD
  return writeCard(root, card, { threshold, dedup: true })
}

/** 追加更新记录（去重命中时）。 */
export async function captureUpdate(root, rel, text, opts = {}) {
  return appendUpdate(root, rel, text, { threshold: opts.threshold ?? DEDUP_THRESHOLD })
}

// -- helpers ---------------------------------------------------------------

async function importLlmHelpers() {
  // 延迟加载，避免在无 llm 服务时拉高启动成本；dsh-llm 是 peerDependency。
  // 独立进程（MCP server / CLI / web）没有 DSH 环境，import 失败时退回本地
  // 极简 shim：只实现 summarizeTurn 用到的最小面（push text chunk / blocks /
  // 构造 user message），供 lib/llm-openai.js 的 OpenAI 兼容适配器配合使用。
  try {
    const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm')
    return { BlockAssembler, createUserMessage }
  } catch {
    return {
      BlockAssembler: class {
        constructor() { this.parts = [] }
        push(chunk) {
          if (typeof chunk === 'string') this.parts.push(chunk)
          else if (chunk && typeof chunk.text === 'string') this.parts.push(chunk.text)
          else if (chunk && typeof chunk.delta?.text === 'string') this.parts.push(chunk.delta.text)
        }
        blocks() {
          const text = this.parts.join('')
          return text ? [{ type: 'text', text }] : []
        }
      },
      createUserMessage: (msg) => ({ role: 'user', content: msg?.content ?? msg, source: msg?.source }),
    }
  }
}

export function parseCaptureJson(text) {
  if (!text) return null
  // 去掉可能的 ```json 围栏
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // 容错：截取第一个 { 到最后一个 }
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return null
    }
  }
  if (!parsed || parsed.save === false) return { save: false }
  // 追加已有卡片：append_to 命中的优先级最高
  if (parsed.append_to) {
    const target = String(parsed.append_to).trim()
    const update = String(parsed.update || '').trim()
    if (target && update.length >= 10) return { append_to: target, update }
    return null
  }
  const title = String(parsed.title || '').trim().slice(0, 80)
  const body = String(parsed.body || '').trim()
  if (!title || body.length < 20) return null
  // 标题体检（P0 噪声闸门）：标题必须是「像标题」的一句话（去掉标点后 ≥4 字、不以标点/反引号开头、
  // 不被截断）。糊掉的标题会让审核中心无法判断，也会在召回结果里变成噪声。
  // 但**不放行垃圾标题、也不吞掉正文**：标题不合格时从正文首行派生一个，派生不出来才算无效。
  if (!isUsableTitle(title)) {
    const derived = deriveTitle(body)
    if (!isUsableTitle(derived)) return null
    return finishCard(parsed, derived, body)
  }
  return finishCard(parsed, title, body)
}

/** 标题是否「像标题」：≥4 个字母/数字字符，且不是碎片（错位开头 / 未完结结尾）。 */
export function isUsableTitle(title) {
  const t = String(title || '').trim()
  if (!t || looksTruncated(t)) return false
  return t.replace(/[^\p{L}\p{N}]/gu, '').length >= 4
}

/** 组装最终卡片对象（标题已体检通过）。 */
function finishCard(parsed, title, body) {
  const kind = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake'].includes(parsed.kind) ? parsed.kind : 'knowledge'
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 8)
    : []
  return { save: true, title, kind, tags, body }
}

/**
 * 从会话事件里提取「增量片段」的可读对话文本（用户 + 助手）。
 *
 * 每条消息先过 `stripRuntimeNoise`：DSH 注入的环境快照 / team 广播 / teammate 原文 /
 * 工具说明都不是用户的真实表达，混进来会变成垃圾卡（P0 修复）。剥离后为空的消息直接丢。
 */
export function extractLastTurn(events, _turn) {
  const lines = []
  const push = (role, raw) => {
    const text = stripRuntimeNoise(raw)
    if (!text) return
    lines.push(`${role}：${text}`)
  }
  const pushMessage = (event) => {
    const data = event.data || event
    const message = data.message || data
    const role = message.role === 'user' ? '用户' : '助手'
    const content = message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) push(role, block.text)
      }
    } else if (typeof content === 'string' && content) {
      push(role, content)
    }
  }
  for (const event of events) {
    const type = event.type
    const data = event.data || event
    if (type === 'user/message' || (type === 'message' && data.role === 'user')) {
      pushMessage(data)
    } else if (type === 'assistant/message' || type === 'assistant/chunk') {
      if (type === 'assistant/message') pushMessage(data)
      else if (data.chunk?.content) {
        const content = data.chunk.content
        if (typeof content === 'string') push('助手', content)
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) push('助手', block.text)
          }
        }
      }
    }
  }
  return lines.join('\n').trim()
}

/**
 * 读会话事件快照。
 *
 * 优先 `ownEvents()`（DSH 公开 API）：只取本会话自身事件，恢复/分叉会话不会把
 * 继承来的历史前缀重复沉淀；`snapshotEvents()` 次之，老结构里的 `events` 兜底。
 * 三条路都取不到时返回空数组，而不是让监听器抛异常（抛异常 = 管线静默死亡，
 * 页面只表现为「一直不写卡」）。
 */
export function sessionEvents(session) {
  if (!session) return []
  // 逐个试：某个取法报了错就换下一个，不要让监听器跟着挂掉。
  for (const pick of ['ownEvents', 'snapshotEvents']) {
    if (typeof session[pick] === 'function') {
      try {
        const out = session[pick]()
        if (Array.isArray(out)) return out
      } catch { /* 换下一个取法 */ }
    }
  }
  return Array.isArray(session.events) ? session.events : []
}

/**
 * 自动沉淀健康状态（进程内）。
 *
 * 目的：任何一条失败路径都必须留下「坏消息」，供 systemPrompt 段和 UI 横幅提示用户——
 * 沉淀是后台静默管线，坏了不能只写日志等人来看。`fail()` 记录当前故障与起始时间，
 * `succeed()` 表示一次真实写卡成功（故障自动清除）。
 */
export function createCaptureHealth() {
  let ok = true
  let reason = ''
  let since = 0
  let lastOkAt = 0
  let lastFailAt = 0
  return {
    fail(why) {
      ok = false
      reason = String(why || '未知原因').replace(/\s+/g, ' ').slice(0, 160)
      since = Date.now()
      lastFailAt = since
    },
    succeed() {
      ok = true
      reason = ''
      since = 0
      lastOkAt = Date.now()
    },
    snapshot() { return { ok, reason, since, lastOkAt, lastFailAt } },
  }
}

/**
 * 探测会话对象认识哪种「取事件」方式，返回用到的成员名（'' = 一个都不认识）。
 *
 * 这个返回值会写进自动沉淀日志：一旦 DSH 再改接口，日志第一行就会显示
 * 「没有事件接口」，而不是继续静默无输出。
 */
export function sessionEventApi(session) {
  if (!session) return ''
  // 顺序即优先级：ownEvents() 只含本会话自身事件（恢复/分叉不会重复沉淀历史）。
  for (const pick of ['ownEvents', 'snapshotEvents']) {
    if (typeof session[pick] === 'function') return pick
  }
  return Array.isArray(session.events) ? 'events' : ''
}

/** 取增量事件：seq 大于 lastSeq 的 user/assistant 消息事件。 */
export function sliceNewEvents(events, lastSeq) {
  const out = []
  for (const event of events) {
    const seq = event.seq
    // 无 seq 的事件（非常规日志）也收，避免漏掉消息；有 seq 则按水位过滤。
    if (typeof seq === 'number' && typeof lastSeq === 'number' && seq <= lastSeq) continue
    const type = event.type
    if (type === 'user/message' || type === 'assistant/message') out.push(event)
  }
  return out
}

/** 解析当前模型路由：取第一个 provider 的旗舰模型（与驯兽师一致）。 */
/** 记忆侧「压缩产物」接口：确定性（无 LLM）从一段文本抽出结构化关键内容，供 harness 会话内压缩旧轮次时注入。 */
export function compressExcerpt(text, maxChars = 2400) {
  const lines = String(text || '').split(/\r?\n/).map((L) => L.trim()).filter(Boolean)
  const structured = lines.filter((L) => /^(#{1,6}\s|[-*]\s|\d+[.、)]\s|>|`|\[x\]|\[ \])/.test(L))
  const src = structured.length ? structured : lines
  let out = src.join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\n+$/, '') + '\n…（已压缩，细节见记忆库）'
  return out
}

/**
 * 按优先级给出候选路由列表。
 *
 * 为什么不直接取 \`providers[0]\`：DSH 的 listProviders() 按**注册顺序**返回，内置的
 * deepseek-official 通常排第一；多 provider 用户（例如自建中转）本机没配官方 key 时，
 * 请求会在**发出去之前**就以「缺凭证」失败，而这条失败只体现在流末尾的 finish 块里
 * —— 旧代码只看 text，于是被误报成「蒸馏无输出」，管线 100% 静默失败（issue #3）。
 * 配置了 captureProvider / captureModel 时以配置为准，其余按注册顺序依次兜底尝试。
 *
 * @param {object} llm DSH llm 服务（或 lib/llm-openai.js 的兼容适配器）
 * @param {{provider?:string, model?:string, limit?:number}} [opts]
 * @returns {Promise<Array<{provider:string, model:string}>>}
 */
export async function routeCandidates(llm, opts = {}) {
  const out = []
  const want = String(opts.provider || '').trim()
  const wantModel = String(opts.model || '').trim()
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 4
  try {
    const providers = llm.listProviders() || []
    if (!providers.length) return out
    if (want) {
      const hit = providers.find((p) => p && p.id === want)
      if (hit) {
        const models = (await llm.listModels(hit.id)) || []
        const model = wantModel || (models[0] && models[0].id)
        if (model) out.push({ provider: hit.id, model })
      }
    }
    for (const p of providers) {
      if (!p || !p.id || out.some((r) => r.provider === p.id)) continue
      const models = (await llm.listModels(p.id)) || []
      const model = (p.id === want && wantModel) || (models[0] && models[0].id)
      if (model) out.push({ provider: p.id, model })
      if (out.length >= limit) break
    }
  } catch { /* 路由解析失败按空列表返回，由调用方兜底 */ }
  return out
}

/** 解析当前模型路由：显式配置优先，其次第一个 provider 的首个模型（保持旧行为作兜底）。 */
export async function resolveRoute(llm, opts = {}) {
  const list = await routeCandidates(llm, opts)
  return list[0] ?? null
}
