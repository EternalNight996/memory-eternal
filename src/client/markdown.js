// 记忆核心 · 卡片正文排版（轻量 Markdown → 安全 HTML）
//
// 目标：把「机器写的」原文卡/知识卡排成「人写的」样子 ——
//   · 小标题自动配 emoji + 颜色分组（结论绿 / 风险琥珀 / 根因蓝 / 方案紫 / 示例粉）
//   · 连续 `- ` 行合成真正的 <ul>（旧实现是「• xxx<br/>」一串），有序列表同理带圆形序号
//   · `> 引用` 升级成带 emoji 的 callout 卡片；`---` 变分隔线；`- [x]` 变复选框
//   · 行首「键：值」渲染成对齐的 key/value；**加粗** 加荧光笔下划线
//
// 安全：先把 & < > 全转义，再只套**白名单**标签；链接只放行 http(s) / 相对路径 / 锚点。
// 卡片正文来自模型与用户，任何情况下都不得被当 HTML 执行。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ESC[c])

/** 小标题 → [emoji, 色组]（自上而下首个命中生效）。 */
const HEAD_RULES = [
  [/结论|总结|tl;?dr|summary|takeaway/i, '✅', 'ok'],
  [/风险|注意|警告|禁止|坑|踩坑|务必/i, '⚠️', 'warn'],
  [/根因|原因|为什么|定位|复现/i, '🔍', 'info'],
  [/修复|解决|变更|fix/i, '🔧', 'ok'],
  [/验证|测试|实测|回归/i, '🧪', 'ok'],
  [/方案|做法|实现|设计|思路|架构/i, '🛠️', 'plan'],
  [/步骤|流程|操作|用法|命令/i, '🧩', 'plan'],
  [/背景|由来|context/i, '🧭', 'info'],
  [/目标|需求|要解决/i, '🎯', 'plan'],
  [/环境|依赖|前置|安装/i, '📦', 'info'],
  [/收益|效果|性能|指标|数据|统计/i, '📈', 'ok'],
  [/示例|例子|样例|demo/i, '💡', 'idea'],
  [/参考|链接|相关/i, '🔗', 'info'],
]
const HEAD_FALLBACK = ['✨', 'info']

/** 引用块 → [emoji, 色组]。 */
const CALLOUT_RULES = [
  [/风险|注意|警告|禁止|坑|务必/i, '⚠️', 'warn'],
  [/提示|建议|tip|best practice/i, '💡', 'idea'],
  [/结论|总结/i, '✅', 'ok'],
  [/错误|失败|报错/i, '❗', 'bad'],
]

const headOf = (title) => {
  const s = String(title)
  for (const [re, ico, tone] of HEAD_RULES) if (re.test(s)) return [ico, tone]
  return HEAD_FALLBACK
}
const calloutOf = (lines) => {
  const s = lines.join(' ')
  for (const [re, ico, tone] of CALLOUT_RULES) if (re.test(s)) return [ico, tone]
  return ['📌', 'info']
}

/**
 * 行内格式：先转义，再套受控标签。
 * @param {string} raw 单行原文（未转义）
 * @returns {string} 安全 HTML
 */
export function renderInline(raw) {
  const text = String(raw)
  // 「键：值」→ 对齐样式（键短、无格式字符、无空格）
  // 只把「短、无空格、不像句子」的键当 key/value：中文散文里冒号很常见，
  // 一旦误判，正常段落会被排成表单字段，比不排版还难看。
  const kv = /^([^：:\s]{1,8})[：:]\s*(.+)$/.exec(text)
  if (kv && !/[是为有了吗呢着过把被和与或于]/.test(kv[1])) {
    return '<span class="md-kv"><span class="md-k">' + esc(kv[1]) + '</span><span class="md-v">' + renderInline(kv[2]) + '</span></span>'
  }
  let s = esc(text)
  // 复选框只认「[x] + 空白/行尾」；否则 [x](url) 这类链接会被误当任务框吞掉
  s = s.replace(/^\[([ xX])\](?=\s|$)\s*/, (m, c) => '<span class="md-task">' + (c.toLowerCase() === 'x' ? '☑' : '☐') + '</span> ')
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-b">$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => (/^(https?:|\/|#)/i.test(url) ? '<a class="md-link" href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label))
  return s
}

/**
 * 拆出 YAML frontmatter（卡片正文里带着它，直接渲染会像机器输出）。
 * @param {string} text 完整卡片文本
 * @returns {{ meta: Array<[string,string]>, body: string }}
 */
export function splitFrontmatter(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s)
  if (!m) return { meta: [], body: s }
  const meta = []
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (key) meta.push([key, value])
  }
  return { meta, body: s.slice(m[0].length) }
}

/**
 * 把 frontmatter 里的 tags 值（`[a, b]` / `["a","b"]` / `a, b`）解析成数组。
 * @param {string} value
 * @returns {string[]}
 */
export function parseTags(value) {
  const s = String(value || '').trim().replace(/^\[|\]$/g, '')
  if (!s) return []
  return s.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

/**
 * 渲染卡片正文为安全 HTML（块级 + 行内）。
 * @param {string} text 正文（可带 frontmatter，会自动跳过）
 * @returns {string}
 */
export function renderMd(text) {
  const src = splitFrontmatter(String(text || '').replace(/\r\n?/g, '\n')).body
  if (!src.trim()) return ''

  // 围栏代码先抽走，避免内部的 # / - / ** 被当成排版语法
  const fences = []
  const guarded = src.replace(/```([\w+#.-]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    fences.push('<pre class="md-pre"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>')
    return '\u0000F' + (fences.length - 1) + '\u0000'
  })

  const out = []
  let para = []
  let list = null
  let quote = null
  const flushPara = () => { if (para.length) { out.push('<p class="md-p">' + para.join('<br/>') + '</p>'); para = [] } }
  const flushList = () => {
    if (!list) return
    const tag = list.type
    out.push('<' + tag + ' class="md-' + tag + '">' + list.items.map((it) => '<li>' + it + '</li>').join('') + '</' + tag + '>')
    list = null
  }
  const flushQuote = () => {
    if (!quote) return
    const [ico, tone] = calloutOf(quote)
    out.push('<div class="md-callout md-c-' + tone + '"><span class="md-ico">' + ico + '</span>' + quote.join('<br/>') + '</div>')
    quote = null
  }
  const flushAll = () => { flushPara(); flushList(); flushQuote() }

  for (const raw of guarded.split('\n')) {
    const line = raw.trim()
    if (!line) { flushAll(); continue }
    const fence = /^\u0000F(\d+)\u0000$/.exec(line)
    if (fence) { flushAll(); out.push(fences[Number(fence[1])]); continue }
    let m
    if ((m = /^(#{1,6})\s+(.+)$/.exec(line))) {
      flushAll()
      const [ico, tone] = headOf(m[2])
      out.push('<div class="md-h md-h-' + (m[1].length <= 2 ? 'h1' : 'h2') + ' md-c-' + tone + '"><span class="md-ico">' + ico + '</span><span class="md-hx">' + renderInline(m[2]) + '</span></div>')
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flushAll(); out.push('<hr class="md-hr"/>'); continue }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote = quote || []; quote.push(renderInline(m[1])); continue }
    if ((m = /^[-*+]\s+(.+)$/.exec(line))) {
      flushPara(); flushQuote()
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] } }
      list.items.push(renderInline(m[1])); continue
    }
    if ((m = /^\d+[.)]\s+(.+)$/.exec(line))) {
      flushPara(); flushQuote()
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] } }
      list.items.push(renderInline(m[1])); continue
    }
    flushList(); flushQuote(); para.push(renderInline(line))
  }
  flushAll()
  return out.join('\n')
}
