// 卡片「知识类型」识别（与 kind 正交的第二维度）
//
// 为什么单独一个维度：`kind` 回答的是「这条记录是以什么形态存进来的」（project / knowledge /
// mistake / tool / content / prompt / skill），而 agent 真正要找的是「这是什么性质的知识」——
// 一次拍板的结论、一次故障的根因、一套能照着做的流程、一个配置项的取值。技能卡已经有
// `技能类型:`，知识卡一直没有对应物，于是只能靠关键词碰撞 tags。
//
// 这里的判定刻意做成**纯函数 + 纯关键词**：不调模型、结果可复现、可单测、可随时重跑回填。
// 落库形式与技能侧一致：`tags` 里加 `知识类型:<中文>` 与 `knowledge-type:<code>`，卡片正文不动。

/** 类型表：code → 中文标签。顺序即优先级（命中多个取第一个）。 */
export const KNOWLEDGE_TYPE_ORDER = [
  'root-cause', 'lesson', 'decision', 'pitfall', 'architecture', 'deploy', 'config',
  'api-integration', 'security', 'performance', 'testing', 'process', 'requirement',
  'concept', 'data', 'meeting', 'weekly', 'review', 'vuln-template', 'tooling', 'other',
]

export const KNOWLEDGE_TYPE_LABELS = {
  'root-cause': '根因分析',
  lesson: '经验教训',
  decision: '决策结论',
  pitfall: '踩坑记录',
  architecture: '架构设计',
  deploy: '部署运维',
  config: '配置项',
  'api-integration': '接口对接',
  security: '安全风险',
  performance: '性能优化',
  testing: '测试验证',
  process: '流程步骤',
  requirement: '需求定义',
  concept: '概念解释',
  data: '数据分析',
  meeting: '会议记录',
  weekly: '周期回顾',
  review: '复盘总结',
  'vuln-template': '漏洞模板',
  tooling: '工具用法',
  other: '其它',
}

export const KNOWLEDGE_TYPE_LABELS_EN = {
  'root-cause': 'Root cause',
  lesson: 'Lesson',
  decision: 'Decision',
  pitfall: 'Pitfall',
  architecture: 'Architecture',
  deploy: 'Deploy / Ops',
  config: 'Config',
  'api-integration': 'API integration',
  security: 'Security',
  performance: 'Performance',
  testing: 'Testing',
  process: 'Process',
  requirement: 'Requirement',
  concept: 'Concept',
  data: 'Data',
  meeting: 'Meeting',
  weekly: 'Weekly review',
  review: 'Retro',
  'vuln-template': 'Vuln template',
  tooling: 'Tooling',
  other: 'Other',
}

/**
 * 关键词规则：命中「标题」的权重最高，其次 tags，最后正文前 800 字。
 * 每条规则只在对应字段里匹配，避免正文里的偶然词把类型带偏。
 */
const RULES = [
  ['root-cause', [/根因/, /原因/, /为何/, /为什么/, /定位/, /root ?cause/i, /diagnos/i]],
  ['lesson', [/教训/, /经验/, /别再/, /下次/, /should have/i, /lesson/i, /避免/]],
  ['decision', [/决策/, /拍板/, /选型/, /定案/, /结论/, /取舍/, /方案对比/, /decision/i, /trade-?off/i]],
  ['pitfall', [/踩坑/, /坑点/, /坑：/, /翻车/, /事故/, /坑/, /pitfall/i, /gotcha/i, /陷阱/]],
  ['architecture', [/架构/, /拓扑/, /分层/, /模块划分/, /整体设计/, /architecture/i]],
  ['deploy', [/部署/, /上线/, /运维/, /发布/, /容器/, /docker/i, /k8s/i, /systemd/i, /启动/]],
  ['config', [/配置/, /参数/, /环境变量/, /settings/i, /config/i, /\.json\b/i, /\.ya?ml\b/i, /\.toml\b/i]],
  // testing 放在 api-integration 之前：「接口压测与回归用例」这类标题本质是测试，
  // 只因为带「接口」二字就被判成对接，会让"测试验证"这一类永远收不到卡。
  ['testing', [/测试/, /用例/, /回归/, /assert/i, /test/i, /验收/, /压测/]],
  ['api-integration', [/接口/, /api\b/i, /回调/, /webhook/i, /对接/, /鉴权/, /token/i, /sso/i, /oauth/i]],
  ['security', [/安全/, /脱敏/, /权限/, /越权/, /注入/, /漏洞/, /凭据/, /加密/, /secret/i, /security/i]],
  ['performance', [/性能/, /优化/, /延迟/, /吞吐/, /内存占用/, /慢查询/, /performance/i, /latency/i]],
  ['process', [/流程/, /步骤/, /操作手册/, /runbook/i, /怎么做/, /实操/, /流程化/]],
  ['requirement', [/需求/, /目标/, /验收标准/, /要求/, /requirement/i]],
  ['concept', [/概念/, /原理/, /是什么/, /简介/, /定义/, /机制/, /concept/i]],
  ['data', [/数据/, /统计/, /指标/, /报表/, /分布/, /dataset/i, /metrics/i]],
  ['meeting', [/会议/, /纪要/, /周会/, /对齐会/, /meeting/i]],
  ['weekly', [/周报/, /每周/, /本周/, /月度/, /weekly/i]],
  ['review', [/复盘/, /回顾/, /总结/, /沉淀/, /retro/i, /复盘会/]],
  ['tooling', [/工具/, /命令/, /cli\b/i, /用法/, /脚本/, /tooling/i, /install/i]],
]

function textOf(card) {
  const tags = Array.isArray(card?.tags) ? card.tags.map((x) => String(x)).join(' ') : String(card?.tags || '')
  return {
    title: String(card?.title || ''),
    tags,
    body: String(card?.body || '').slice(0, 800),
    kind: String(card?.kind || ''),
    source: String(card?.source || ''),
    path: String(card?.path || ''),
  }
}

/**
 * 在一段文本里找第一条命中的规则。
 * strict=true 用于**正文兜底**：正文里出现某个词，不等于这张卡就是那类知识
 * （一篇讲排障的文档里随手提一句"流程"不该被判成流程步骤）。所以只认两种强信号：
 * 命中位置靠前（正文前 200 字内），或同一模式在正文里出现 ≥2 次。
 */
function matchIn(text, rules, { strict = false } = {}) {
  if (!text) return null
  for (const [code, res] of rules) {
    for (const re of res) {
      const m = re.exec(text)
      if (!m) continue
      if (strict) {
        const first = m.index
        let count = 1
        try {
          const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
          count = (text.match(g) || []).length
        } catch { count = 1 }
        if (first > 200 && count < 2) continue
      }
      return { code, match: String(m[0]).trim() }
    }
  }
  return null
}

/**
 * 推断一张卡的知识类型。
 *
 * 判定顺序（越靠前越权威）：
 *   ① `source` 是红队导入（poc:/kb:redteam:）→ 漏洞模板；
 *   ② `kind === 'skill'` → 返回空（技能走技能类型，不在这里判）；
 *   ③ 标题 → tags → 正文前 800 字，每轮按 RULES 顺序取第一个命中；
 *   ④ 都没命中时按 kind 兜底（mistake→经验教训 / prompt→概念解释 / 会议卡→会议记录 / 其它）。
 *
 * @param {{kind?:string,title?:string,tags?:string[]|string,body?:string,source?:string,path?:string}} card
 * @param {{explain?:boolean}} [opts] explain=true 时返回 evidence（命中字段 + 命中关键词 + 命中的类型规则）
 * @returns {{code:string,label:string,labelEn:string,tags:string[],evidence?:object}}
 */
export function knowledgeTypeOf(card, { explain = false } = {}) {
  const t = textOf(card)
  let code = ''
  let evidence = null

  // 红队知识库导入的条目：一律归「漏洞模板」，正文/标题里再细的东西交给已有的 type:* tag
  if (/^(poc|kb):redteam:/.test(t.source)) {
    code = 'vuln-template'
    evidence = { where: 'source', match: t.source, rule: 'redteam-kb' }
  } else if (t.kind === 'skill') {
    // 技能卡走技能侧那套（技能类型:），这里直接返回空 —— 别让同一张卡有两个类型维度打架
    return { code: '', label: '', labelEn: '', tags: [] }
  } else {
    for (const [where, hay, strict] of [['title', t.title, false], ['tags', t.tags, false], ['body', t.body, true]]) {
      const hit = matchIn(hay, RULES, { strict })
      if (hit) { code = hit.code; evidence = { where, match: hit.match, rule: hit.code }; break }
    }
  }

  if (!code) {
    // kind 兜底：没有关键词线索时，用记录形态给一个最不坏的默认
    if (t.kind === 'mistake') code = 'lesson'
    else if (t.kind === 'prompt') code = 'concept'
    else if (t.kind === 'meeting') code = 'meeting'
    else code = 'other'
    evidence = { where: 'kind', match: t.kind || '-', rule: 'kind-fallback' }
  }
  if (!KNOWLEDGE_TYPE_LABELS[code]) code = 'other'
  const out = {
    code,
    label: KNOWLEDGE_TYPE_LABELS[code],
    labelEn: KNOWLEDGE_TYPE_LABELS_EN[code],
    tags: ['知识类型:' + KNOWLEDGE_TYPE_LABELS[code], 'knowledge-type:' + code],
  }
  if (explain) out.evidence = evidence
  return out
}

/** 把类型 tag 合并进原有 tags（幂等：先剔除旧的类型 tag，再按上限写入）。 */
export function mergeTypeTags(tags, typeTags, { max = 20 } = {}) {
  const kept = (Array.isArray(tags) ? tags : [])
    .map((x) => String(x))
    .filter((x) => !/^(知识类型:|knowledge-type:|技能类型:|skill-type:)/.test(x))
  const out = []
  for (const x of [...typeTags, ...kept]) {
    const s = String(x).trim()
    if (!s || s.length > 30) continue
    if (out.includes(s)) continue
    out.push(s)
    if (out.length >= max) break
  }
  return out
}
