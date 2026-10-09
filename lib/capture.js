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

/**
 * 蒸馏输出 token 上限的默认值（issue #18）。
 *
 * 旧默认 900 与 system prompt 要求的「300-800 字正文」不匹配：中文 800 字本身就逼近 900 token，
 * 再叠加 JSON 结构开销与超长会话输入，轻易撞上限 → 输出被截断 → 旧代码把它误报成
 * UNPARSEABLE_OUTPUT，最终落一张 raw 噪声卡。2000 给正文留出余量（仍是单次调用的量级）。
 */
export const DEFAULT_CAPTURE_MAX_TOKENS = 2000

/** 蒸馏输出上限的硬顶（与 api.js 的 NUM_RANGE.captureMaxTokens 一致）。 */
export const MAX_CAPTURE_MAX_TOKENS = 4000

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

  const maxTokens = opts.maxTokens ?? DEFAULT_CAPTURE_MAX_TOKENS
  // #15：route.reasoningEffort === null 表示该 provider 明确声明不支持 reasoning effort，
  // 此时**不传**这个字段（传了会被 LLM 层硬校验拒绝，等于每次沉淀先白烧一次调用）。
  const effort = route.reasoningEffort === undefined ? 'off' : route.reasoningEffort
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens,
    ...(effort ? { reasoningEffort: effort } : {}),
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
  // #18 根因 1：撞到输出上限时 finish.kind === 'max-tokens'（dsh-llm 的 FinishReasonMap）。
  // 旧实现只认 error/aborted，于是截断的 JSON 一路落到 parseCaptureJson 上被误报成
  // UNPARSEABLE_OUTPUT —— 真实原因（输出被截断）被完全掩盖。这里给独立错误码。
  if (finish.kind === 'max-tokens') {
    return {
      failure: {
        code: 'MAX_TOKENS',
        message: `输出撞到 maxTokens=${maxTokens} 上限被截断（不是解析失败）：调大「蒸馏输出上限」captureMaxTokens，或缩短会话输入`,
      },
    }
  }
  const out = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
  const parsed = parseCaptureJsonDetailed(out)
  if (!parsed.card) {
    const why = out ? '模型输出无法解析为 JSON' : '模型返回空文本'
    // 括号没闭合 = 截断的强特征：即便宿主没给 max-tokens finish，也把方向指对（#18 建议 1）
    const hint = out && looksTruncatedJson(out) ? '（JSON 括号未闭合，疑似输出被截断）' : ''
    // #24：JSON.parse 的原始报错（如 Bad control character in string literal at position N）
    // 以前被两个裸 catch{} 完全吞掉，排查只能靠猜；现场摘要也从「只留前 160 字」改成首尾各留一段。
    const raw = parsed.error ? '（JSON.parse 原始报错：' + parsed.error + '）' : ''
    return { failure: { code: 'UNPARSEABLE_OUTPUT', message: why + hint + raw + (out ? '：' + describeOutputExcerpt(out) : '') } }
  }
  // repaired=true = 走了「字符串内裸控制字符转义」这条容错路径（#24），排障时能看到它真的生效了。
  return { card: parsed.card, repaired: parsed.repaired }
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

/**
 * 判断一段文本的 JSON 结构是否**没闭合**（截断的强特征，issue #18 建议 1）。
 * 只做括号/引号配对扫描，不解析；用于把「疑似被截断」和「模型乱输出」区分开。
 */
export function looksTruncatedJson(text) {
  const s = String(text || '').trim()
  if (!s) return false
  let depth = 0
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return depth > 0 || inStr
}

/**
 * 把 JSON **字符串值内部**未转义的裸控制字符改成合法转义（issue #24）。
 *
 * 模型写 markdown 正文时经常把换行写成真实的 U+000A（而不是 `\n` 两字符），
 * 这种输出括号是闭合的（looksTruncatedJson 得 false），却因为「字符串内不得出现
 * 未转义控制字符」被 JSON.parse 必然拒绝 —— 旧实现只做「截 { … }」一层容错，
 * 于是稳定地误报成 UNPARSEABLE_OUTPUT，真正的知识卡全丢进原文卡兜底。
 *
 * 只在字符串内部动手：字符串外的换行/制表符是合法 JSON 空白，改了反而是破坏。
 * 标准转义（\n \r \t \b \f）用短写，其余控制字符转 \u00XX。
 *
 * @returns {{ text: string, repaired: boolean }} repaired=true 表示确实改过字符
 */
export function repairJsonControlChars(text) {
  const s = String(text || '')
  let out = ''
  let inStr = false
  let esc = false
  let repaired = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (!inStr) {
      if (ch === '"') inStr = true
      out += ch
      continue
    }
    if (esc) { esc = false; out += ch; continue }
    if (ch === '\\') { esc = true; out += ch; continue }
    if (ch === '"') { inStr = false; out += ch; continue }
    const code = ch.charCodeAt(0)
    if (code < 0x20) {
      repaired = true
      out += code === 0x0a ? '\\n'
        : code === 0x0d ? '\\r'
        : code === 0x09 ? '\\t'
        : code === 0x08 ? '\\b'
        : code === 0x0c ? '\\f'
        : '\\u' + code.toString(16).padStart(4, '0')
      continue
    }
    out += ch
  }
  return { text: out, repaired }
}

/**
 * 修复「字符串值里未转义的裸引号」（10/8 实测现场）。
 *
 * 现场：`JSON.parse 原始报错：Expected ',' or '}' after property value in JSON at position 1913`，
 * 摘录里能看到正文写着 `运行 "npm test" 时…` —— 模型把引号当正文内容直接写进字符串，于是这个
 * 引号被当成字符串结束符，后面的中文就变成「属性值后面还有东西」。这与已经修过的「裸控制字符」
 * （#24）是**不同**的一类：控制字符在字符串内部是非法的，而引号在字符串内部是「合法但需要转义」。
 *
 * 启发式（只作为**最后一个候选**，见 parseCaptureJsonDetailed）：一个 `"` 只有当它后面（跳过空白）
 * 紧跟 `:` `,` `}` `]` 或文本结尾时才算「字符串结束」，否则补 `\"`。
 * 因为可能误修，调用方必须再通过卡片体检（`cardFromParsedJson`）才接受 —— 宁可不修，也不写坏卡。
 *
 * @returns {{ text: string, repaired: boolean }} repaired=true 表示确实补过反斜杠
 */
export function repairUnescapedQuotes(text) {
  const s = String(text || '')
  let out = ''
  let inStr = false
  let esc = false
  let repaired = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (esc) { esc = false; out += ch; continue }
    if (ch === '\\') { esc = true; out += ch; continue }
    if (ch !== '"') { out += ch; continue }
    if (!inStr) { inStr = true; out += ch; continue }
    // 已在字符串里：看这个引号后面是否紧跟结构字符
    let j = i + 1
    while (j < s.length && /\s/.test(s[j])) j++
    const next = j < s.length ? s[j] : ''
    const endsString = next === '' || next === ':' || next === ',' || next === '}' || next === ']'
    if (endsString) { inStr = false; out += ch; continue }
    repaired = true
    out += '\\"'
  }
  return { text: out, repaired }
}

/**
 * 失败现场摘要：首尾各留一段，中间省略多少字写清楚。
 *
 * 旧实现 `out.slice(0, 160)` 把正文后半段全砍了，而模型输出恰好经常被切在
 * `"body": "# ...` 的半截处 —— 看上去更像「输出断了」，把排查引向错误方向（#24）。
 */
export function describeOutputExcerpt(text, { head = 120, tail = 120 } = {}) {
  const s = String(text || '')
  if (s.length <= head + tail + 20) return s
  return s.slice(0, head) + '…（中间省略 ' + (s.length - head - tail) + ' 字）…' + s.slice(-tail)
}

/** 解析出来的对象 → 知识卡（返回 null = 解析成功但内容不合格 / 不值得保存）。 */
function cardFromParsedJson(parsed) {
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

/**
 * 解析模型输出：返回「卡片 + 解析诊断」。
 *
 * 候选串顺序（#24）：原样 → 截 \`{ … }\` → 各自的「字符串内裸控制字符已转义」版本。
 * 只要有一个 JSON.parse 成功就停在那一个上（解析成功但语义不合格时不再换候选 ——
 * 换候选只会把同一份内容再判一遍，与旧实现行为一致）。
 *
 * @returns {{ card: object|null, parsed: boolean, error: string, repaired: boolean }}
 *   parsed=false → 所有候选都没能 JSON.parse（error 里是**原始**报错，不再吞掉）
 *   parsed=true  → JSON 解析成功；card=null 表示内容不合格 / 不值得保存
 */
export function parseCaptureJsonDetailed(text) {
  if (!text) return { card: null, parsed: false, error: '空输出', repaired: false }
  // 去掉可能的 ```json 围栏
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const bases = [cleaned]
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) bases.push(cleaned.slice(start, end + 1))
  const candidates = []
  for (const base of bases) candidates.push({ text: base, repaired: false })
  for (const base of bases) {
    const fixed = repairJsonControlChars(base)
    if (fixed.repaired) candidates.push({ text: fixed.text, repaired: true })
  }
  // 最后一层：字符串内裸引号（10/8 现场）。它对合法 JSON 是恒等变换（repaired=false 时不入列），
  // 且必须仍能通过卡片体检才会被接受。
  for (const candidate of [...candidates]) {
    const fixed = repairUnescapedQuotes(candidate.text)
    if (fixed.repaired) candidates.push({ text: fixed.text, repaired: true })
  }
  let lastError = ''
  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate.text)
    } catch (error) {
      lastError = String((error && error.message) || error)
      continue
    }
    return { card: cardFromParsedJson(parsed), parsed: true, error: '', repaired: candidate.repaired }
  }
  return { card: null, parsed: false, error: lastError || '输出不是合法 JSON', repaired: false }
}

/** 兼容旧签名：解析成卡片；解析失败 / 内容不合格返回 null。 */
export function parseCaptureJson(text) {
  return parseCaptureJsonDetailed(text).card
}

/**
 * 撞到输出上限后的重试上限序列（#24）：一路翻倍到 schema 上限，不再只翻一次。
 *
 * 旧实现 index.js 里只做一次 倍=2 的重试：1200 → 2400 仍不够就退成原文卡，
 * 尽管 4000 本来装得下。抽成纯函数，便于单测这条序列。
 *
 * @returns {number[]} 例如 start=1200, cap=4000 → [2400, 4000]；start>=cap → []
 */
export function maxTokenLadder(start, cap = MAX_CAPTURE_MAX_TOKENS) {
  const out = []
  const ceiling = Number(cap) || MAX_CAPTURE_MAX_TOKENS
  let cur = Number(start) || DEFAULT_CAPTURE_MAX_TOKENS
  while (cur < ceiling) {
    cur = Math.min(cur * 2, ceiling)
    out.push(cur)
  }
  return out
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
    // 候选按「能力」排序：明确不支持 reasoning effort 的往后放（#15 问题 2）。
    // 注意**不删除**它们 —— 不传 reasoningEffort 之后它们完全可能正常出卡，
    // 而删掉它们会让「候选全不支持」的机器直接没有兜底（见 #15 的实测：四个网关全不支持）。
    const push = (provider, model, modelInfo) => {
      if (!provider || !provider.id || !model) return
      if (out.some((r) => r.provider === provider.id)) return
      const entry = { provider: provider.id, model }
      if (!supportsReasoningEffort(provider, modelInfo)) entry.reasoningEffort = null
      out.push(entry)
    }
    const modelsOf = async (id) => {
      const list = await llm.listModels(id)
      return Array.isArray(list) ? list : []
    }
    if (want) {
      const hit = providers.find((p) => p && p.id === want)
      if (hit) {
        const models = await modelsOf(hit.id)
        const model = wantModel || (models[0] && models[0].id)
        push(hit, model, models.find((m) => m && m.id === model) || null)
      }
    }
    const rest = []
    for (const p of providers) {
      if (!p || !p.id || out.some((r) => r.provider === p.id)) continue
      const models = await modelsOf(p.id)
      const model = (p.id === want && wantModel) || (models[0] && models[0].id)
      if (!model) continue
      rest.push({ p, model, info: models.find((m) => m && m.id === model) || null })
    }
    // Array.prototype.sort 是稳定的：能力相同的候选保持原有的「注册顺序」语义
    rest.sort((a, b) => Number(!supportsReasoningEffort(a.p, a.info)) - Number(!supportsReasoningEffort(b.p, b.info)))
    for (const r of rest) {
      if (out.length >= limit) break
      push(r.p, r.model, r.info)
    }
  } catch { /* 路由解析失败按空列表返回，由调用方兜底 */ }
  return out
}

/**
 * 该 provider/model 是否**明确声明**不支持 reasoning effort（#15 问题 2）。
 *
 * DSH 的 LLM 层会按 provider 声明的能力硬校验：声明不支持时，请求里带上
 * reasoningEffort 会在发出前/发出时以 UNSUPPORTED_REASONING_EFFORT 失败。
 * 声明位置随版本而异（provider.compat / provider.capabilities / 模型条目的 reasoning），
 * 这里全部读一遍；**未知一律按「支持」处理**，避免把能力推断错成功能退化。
 *
 * @param {object|null} providerInfo llm.listProviders() 的条目
 * @param {object|null} [modelInfo]  llm.listModels() 的对应条目
 * @returns {boolean}
 */
export function supportsReasoningEffort(providerInfo, modelInfo = null) {
  const flag = (o) => {
    if (!o || typeof o !== 'object') return undefined
    if (typeof o.supportsReasoningEffort === 'boolean') return o.supportsReasoningEffort
    if (o.compat && typeof o.compat.supportsReasoningEffort === 'boolean') return o.compat.supportsReasoningEffort
    if (o.capabilities && typeof o.capabilities.supportsReasoningEffort === 'boolean') return o.capabilities.supportsReasoningEffort
    return undefined
  }
  const fromProvider = flag(providerInfo)
  if (fromProvider === false) return false
  const fromModel = flag(modelInfo)
  if (fromModel === false) return false
  // 模型条目自带 reasoning 能力表且**为空** → 该模型没有可选 effort，等于不支持
  const reasoning = modelInfo && modelInfo.reasoning
  if (reasoning && Array.isArray(reasoning.efforts) && reasoning.efforts.length === 0) return false
  return true
}

/** 解析当前模型路由：显式配置优先，其次第一个 provider 的首个模型（保持旧行为作兜底）。 */
export async function resolveRoute(llm, opts = {}) {
  const list = await routeCandidates(llm, opts)
  return list[0] ?? null
}
