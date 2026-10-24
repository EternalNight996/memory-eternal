// 生成公开 Demo 的示例数据（纯虚构项目 northstar，与真实记忆库无关）。
// 运行：node site/demo/sample-data.mjs
import fs from 'node:fs'
import path from 'node:path'

const now = Date.now()
const DAY = 86400000

const recent = [
  {
    slug: 'northstar-cursor-pagination', kind: 'project', title: 'northstar API 分页从 offset 改为 cursor',
    tags: ['northstar', 'api', 'pagination', 'sqlite'], agent: 'deepseek-harness', age: 0.2,
    section: '决策',
    body: `把 \`/api/items\` 的分页从 \`offset/limit\` 改为 \`cursor\`：offset 在深度翻页时会因为并发写入重复或漏项。\n\n- cursor 使用 \`(updated_at, id)\` 复合键，排序稳定。\n- 兼容期保留 \`offset\`，响应头返回 \`next_cursor\`，2.5 后移除。\n- 前端列表库升级到支持 cursor 的版本，旧客户端仍能工作。`,
  },
  {
    slug: 'northstar-cache-sqlite', kind: 'project', title: 'northstar 缓存层选型：SQLite WAL 而不是 Redis',
    tags: ['northstar', 'cache', 'sqlite', 'architecture'], agent: 'claude', age: 0.5,
    section: '决策',
    body: `单机部署下不引入 Redis：缓存和主库同一个 SQLite 文件，WAL 模式支持并发读，备份也只需要一个文件。\n\n- 热点 key 用内存 LRU，持久层只存可重建的数据。\n- 代价是跨进程共享缓存需要走数据库，压测后读延迟仍在可接受范围。\n- 如果未来水平扩展，再把缓存抽成独立服务。`,
  },
  {
    slug: 'northstar-local-gate', kind: 'project', title: '部署流水线从 GitHub Actions 迁到本地门禁',
    tags: ['northstar', 'deploy', 'ci', 'github-actions'], agent: 'deepseek-harness', age: 1.1,
    section: '背景与结论',
    body: `Actions 额度耗尽后，PR 页面长期一片红，团队开始忽略 CI。改为本地门禁 + 合并前脚本，PR 只保留一个轻量检查。\n\n- 新增 \`scripts/pre-merge-check.ps1\`：构建、单测、迁移检查一次跑完。\n- 合并前必须贴出脚本输出，CI 只做“可合并”标记。\n- 结果：平均合并时间从 40 分钟降到 12 分钟，红灯噪音消失。`,
  },
  {
    slug: 'camera-roi-root-cause', kind: 'mistake', title: '相机采集丢帧根因：开流顺序导致 ROI 静默失效',
    tags: ['camera', 'gige', 'roi', 'root-cause'], agent: 'deepseek-harness', age: 1.4,
    section: '根因',
    body: `现场状态栏显示 \`1624×1240（配置 1280×720）\`：配置没有生效。原因不是 ROI 参数写错，而是先开流、后设 ROI，相机忽略了后续设置。\n\n- 正确顺序：停流 → 设置 Width/Height/Offset → 重新开流。\n- 加一条启动断言：读取实际分辨率，和配置不一致就报错，不再静默跑。\n- 带宽从 934 Mbps 降到 282 Mbps，丢包归零。`,
  },
  {
    slug: 'rust-upstream-default', kind: 'mistake', title: 'Rust 兼容上游新增字段：用 ..Default::default() 而非硬写字段',
    tags: ['rust', 'upstream', 'default', 'northstar'], agent: 'codex', age: 2.0,
    section: '教训',
    body: `上游给 \`Cfg\` 加了 \`frontTokenName\` 字段，本地旧代码构造结构体时直接报 E0063。\n\n- 反模式：每加一个字段就在本地硬写一行，永远追不上。\n- 正确做法：只在需要覆盖的字段上写值，其余用 \`..Default::default()\`。\n- 顺手加一条 CI 检查：上游结构体字段变更时，编译失败比运行时缺字段更早暴露。`,
  },
  {
    slug: 'mcp-tool-contract', kind: 'knowledge', title: 'MCP 工具描述要写成可执行契约',
    tags: ['mcp', 'tools', 'schema', 'design'], agent: 'deepseek-harness', age: 2.3,
    section: '结论',
    body: `工具描述不是说明书，是模型决定“什么时候调用、传什么参数”的唯一依据。\n\n- 一句话说清“什么时候用”，再给一个最小参数示例。\n- 错误要可行动：返回 \`INVALID_ARGUMENT: limit 必须 1..20\`，不要只返回 500。\n- 把“不适用场景”也写进去，减少误调用比增加功能更重要。`,
  },
  {
    slug: 'distill-card-prompt', kind: 'prompt', title: '把长会话蒸馏成卡的提示词模板',
    tags: ['prompt', 'distill', 'review', 'mcp'], agent: 'claude', age: 2.8,
    section: '核心改动',
    body: `模板只保留三个字段：\`decision\`（决定了什么）、\`evidence\`（依据/实测）、\`boundary\`（适用边界）。\n\n- 先让模型复述事实，再让它给结论，最后要求给出反例。\n- 输出必须是 JSON；解析失败时退回原文卡，不要丢内容。\n- 经验：字段越少，重复率越低，审核越快。`,
  },
  {
    slug: 'ui-release-regression', kind: 'knowledge', title: 'UI 连发多版引发回归的三条纪律',
    tags: ['ui', 'css', 'testing', 'regression'], agent: 'deepseek-harness', age: 3.2,
    section: '教训',
    body: `一天连发 6 个纯 UI 版本，业务代码没动，却出现滚动条错乱、按钮消失。根因是“源码测试通过”被当成了“界面正确”。\n\n- 任何 UI 改动先跑截图验收，断言无横向溢出、无白屏、无 JS 异常。\n- 改共享 CSS 类之前先列出使用者。\n- 状态判断抽成纯函数，穷举组合测试，不靠肉眼。`,
  },
  {
    slug: 'sqlite-backup-checkpoint', kind: 'tool', title: 'SQLite WAL 模式下备份要 checkpoint',
    tags: ['sqlite', 'backup', 'wal', 'ops'], agent: 'deepseek-harness', age: 3.6,
    section: '要点',
    body: `直接拷 \`.db\` 文件在 WAL 模式下可能丢掉尚未 checkpoint 的内容。\n\n- 备份前执行 \`PRAGMA wal_checkpoint(TRUNCATE)\`。\n- 用 \`VACUUM INTO\` 生成一致性快照，再压缩归档。\n- 恢复后跑一次完整性检查，别只看文件大小。`,
  },
  {
    slug: 'health-200-false-positive', kind: 'mistake', title: '一次线上 500 的假成功：/health 200 不代表新镜像',
    tags: ['deploy', 'health', 'docker', 'northstar'], agent: 'codex', age: 4.1,
    section: '教训',
    body: `部署脚本打印 \`/health = 200\` 就认为成功，实际容器还是旧镜像。\n\n- 200 只能证明“有个容器活着”，不能证明“新代码在跑”。\n- 改用新代码独有的探针路由，再比对容器 image ID。\n- 上传/load 失败必须显式退出，不能继续 compose。`,
  },
  {
    slug: 'theme-tokens', kind: 'project', title: 'northstar 主题系统 token 化',
    tags: ['ui', 'design-tokens', 'theme', 'northstar'], agent: 'claude', age: 4.6,
    section: '决策',
    body: `把散落在组件里的硬编码颜色收进一层 token：背景、文本、边框、状态、品牌色。\n\n- 浅色和深色各自映射，不在组件里写 \`if dark\`。\n- 只保留一个品牌强调色，状态色只表达状态。\n- 迁移顺序：先 token 化按钮和输入，再改卡片与图表。`,
  },
  {
    slug: 'playwright-real-backend', kind: 'tool', title: '用 Playwright 做真实后端 E2E',
    tags: ['e2e', 'playwright', 'testing', 'northstar'], agent: 'claude', age: 5.0,
    section: '要点',
    body: `mock 测不出登录态、数据库约束和清理顺序问题。\n\n- 只在设置 \`E2E_API\` 时跑真实栈，平时自动 skip。\n- 登录用 localStorage 注入，避免每个用例点一遍表单。\n- 测试数据用固定前缀，结束后 psql 清理，失败也清理。`,
  },
  {
    slug: 'release-2-4', kind: 'project', title: 'northstar 发布 2.4.0：迁移与回滚',
    tags: ['release', 'migration', 'northstar', 'ops'], agent: 'deepseek-harness', age: 5.5,
    section: '结果',
    body: `2.4.0 上线 0 停机，迁移耗时 38 秒，回滚脚本实测可用。\n\n- 迁移拆成“加列/回填/切换读/删旧列”四步，任何一步都能停。\n- 发布前在影子库跑一遍全量迁移。\n- 发布后 30 分钟观察错误率和慢查询，再放量。`,
  },
  {
    slug: 'pr-checklist', kind: 'knowledge', title: 'PR 合并前必须核对的 7 件事',
    tags: ['review', 'checklist', 'git', 'northstar'], agent: 'codex', age: 6.0,
    section: '要点',
    body: `合并前固定核对：构建、单测、迁移、回滚、日志、权限、文档。\n\n- 任何一项没有输出就算没做。\n- 不合并“只差一个测试”的 PR，除非有明确的豁免记录。\n- 合并后立刻回灌镜像，避免主仓和部署副本漂移。`,
  },
  {
    slug: 'search-slow-query', kind: 'project', title: 'northstar 搜索慢查询：tags 的反向索引',
    tags: ['search', 'sqlite', 'index', 'northstar'], agent: 'deepseek-harness', age: 6.4,
    section: '根因',
    body: `标签筛选从 80ms 涨到 1.8s，根因是 \`LIKE '%tag%'\` 无法走索引。\n\n- 建 \`card_tags(card_id, tag)\` 反向表，按 tag 先查 card_id。\n- 多标签用交集，而不是 OR 后再过滤。\n- 用 \`EXPLAIN QUERY PLAN\` 守住“全表扫描”回归。`,
  },
  {
    slug: 'camera-events', kind: 'knowledge', title: '相机 SDK 的异常事件回调',
    tags: ['camera', 'sdk', 'events', 'northstar'], agent: 'deepseek-harness', age: 6.9,
    section: '结论',
    body: `只靠取帧超时发现掉线，平均要 1.5 秒；打开 SDK 的异常事件回调后，拔线 200ms 内就能告警。\n\n- 回调里只做标记，重连交给状态机。\n- 回调可能重复触发，需要去抖。\n- 事件线程不要做 UI 操作，避免死锁。`,
  },
  {
    slug: 'mobile-single-column', kind: 'project', title: 'northstar 移动端单列布局修复',
    tags: ['ui', 'mobile', 'layout', 'northstar'], agent: 'claude', age: 7.2,
    section: '背景与结论',
    body: `390px 下侧栏常开、统计卡纵向堆叠，首屏看不到内容。改为底部 4 个 tab，统计压成一行数字。\n\n- 卡片单列，按钮最小 36px。\n- 结果行不再放键盘快捷键提示。\n- 用真实手机宽度跑截图验收，不靠桌面缩放。`,
  },
  {
    slug: 'review-card-fields', kind: 'prompt', title: '把 AI 的回答变成可审核卡的 3 个字段',
    tags: ['prompt', 'review', 'schema', 'northstar'], agent: 'claude', age: 7.8,
    section: '核心改动',
    body: `只让模型输出 \`decision\`、\`evidence\`、\`boundary\` 三个字段，其他内容进原文。\n\n- 审核时先看 decision，再看 evidence 是否支撑。\n- boundary 必填，避免把一次实验当成通用结论。\n- 字段缺失直接判为不合格，不让模型自由发挥。`,
  },
  {
    slug: 'log-sampling', kind: 'tool', title: 'northstar 日志分级与采样',
    tags: ['logs', 'observability', 'sampling', 'northstar'], agent: 'deepseek-harness', age: 8.3,
    section: '决策',
    body: `请求日志全量写会让磁盘一周涨 30GB；改为 error 全量、warn 10%、info 1%。\n\n- 采样键用 request id，保证同一条链路可追踪。\n- 关键业务事件不采样。\n- 日志保留 14 天，超期归档到冷存储。`,
  },
  {
    slug: 'docs-navigation', kind: 'content', title: 'northstar 文档站导航重构',
    tags: ['docs', 'navigation', 'content', 'northstar'], agent: 'claude', age: 9.0,
    section: '背景与结论',
    body: `文档从 12 个一级入口收成 4 个：开始、指南、参考、更新。搜索放在顶部固定位置。\n\n- 新用户从首页到“跑起来”最多 3 次点击。\n- 每个页面加“最后更新”和“适用版本”。\n- 旧链接保留重定向，不制造 404。`,
  },
  {
    slug: 'auth-policy', kind: 'project', title: 'northstar 权限模型：角色 vs 策略',
    tags: ['auth', 'rbac', 'security', 'northstar'], agent: 'deepseek-harness', age: 10.2,
    section: '决策',
    body: `不引入完整的 RBAC 表，先用“策略函数”表达权限：\`can(user, action, resource)\`。\n\n- 默认拒绝，所有放行都要有测试。\n- 角色只是策略的预设组合，不直接进数据库。\n- 等权限规则超过 20 条再考虑持久化。`,
  },
  {
    slug: 'pg-index-bloat', kind: 'knowledge', title: 'Postgres 索引膨胀的排查路径',
    tags: ['postgres', 'index', 'performance', 'northstar'], agent: 'codex', age: 11.0,
    section: '根因',
    body: `写入放大后索引体积翻倍，查询反而变慢。根因是 autovacuum 跟不上，死元组留在索引里。\n\n- 先看 \`pg_stat_user_tables\` 的 dead tuple 和 last_autovacuum。\n- 对大表调低 autovacuum 阈值，分批 reindex。\n- 用 \`pg_repack\` 避免长时间锁表。`,
  },
  {
    slug: 'feature-flag', kind: 'project', title: 'northstar 灰度发布开关设计',
    tags: ['release', 'feature-flag', 'risk', 'northstar'], agent: 'deepseek-harness', age: 12.0,
    section: '决策',
    body: `每个高风险功能必须有 kill switch，按用户/租户/百分比三档放量。\n\n- 开关状态变更写审计日志。\n- 默认关闭，发布后手动打开。\n- 开关过期时间强制填写，避免永久残留。`,
  },
  {
    slug: 'incident-delete', kind: 'mistake', title: '一次误删生产数据的复盘',
    tags: ['incident', 'backup', 'postmortem', 'northstar'], agent: 'claude', age: 13.2,
    section: '教训',
    body: `清理脚本少了一个 \`WHERE\`，删掉了 3 天的订单草稿。恢复花了 40 分钟。\n\n- 所有删除先软删，30 天后才物理清理。\n- 生产写操作默认 dry-run，必须显式加 \`--apply\`。\n- 备份恢复要定期演练，不能只验证备份文件存在。`,
  },
]

const old = [
  {
    slug: 'architecture-monolith-first', kind: 'project', title: 'northstar 早期架构：单体优先',
    tags: ['architecture', 'northstar', 'sqlite'], agent: 'deepseek-harness', age: 46,
    section: '结论',
    body: `第一版坚持单体 + SQLite：没有消息队列、没有微服务、没有 Redis。\n\n- 部署就是一个二进制 + 一个数据文件。\n- 所有模块先在同一进程内调用，边界用接口约束。\n- 等真的出现独立扩缩容需求，再拆。`,
  },
  {
    slug: 'search-simple-first', kind: 'knowledge', title: '为什么先把搜索做简单',
    tags: ['search', 'sqlite', 'northstar'], agent: 'claude', age: 52,
    section: '结论',
    body: `没有上向量库：先用 SQLite FTS + 标签过滤，把“能找到”做好。\n\n- 结构化标签的召回质量比 embedding 更可控。\n- 结果可解释：为什么命中、命中了哪些词。\n- 等用户量证明需要语义检索，再引入向量。`,
  },
  {
    slug: 'review-first-pitfalls', kind: 'mistake', title: '第一版审核流的三个坑',
    tags: ['review', 'workflow', 'northstar'], agent: 'deepseek-harness', age: 58,
    section: '教训',
    body: `第一版审核只能看标题，用户被迫盲批；批量批准没有撤销；队列没有排序。\n\n- 审核必须能读正文。\n- 所有批量操作必须可撤销。\n- 默认按时间倒序，别让用户猜。`,
  },
  {
    slug: 'backup-local-first', kind: 'tool', title: '本地优先的备份策略',
    tags: ['backup', 'local-first', 'sqlite'], agent: 'deepseek-harness', age: 65,
    section: '要点',
    body: `每天自动备份，保留 7 天；备份文件带时间戳，恢复前先校验。\n\n- 备份和主库不在同一个磁盘。\n- 恢复流程写成脚本，不靠记忆。\n- 每周抽查一次恢复。`,
  },
  {
    slug: 'logs-as-product', kind: 'content', title: '把日志当产品来设计',
    tags: ['logs', 'product', 'northstar'], agent: 'claude', age: 72,
    section: '要点',
    body: `日志不是调试残留，是用户理解系统的界面。\n\n- 一条日志回答：发生了什么、影响谁、下一步做什么。\n- 错误日志必须带 request id。\n- 不要打印完整 token 或用户隐私。`,
  },
  {
    slug: 'v1-retro', kind: 'project', title: 'v1 发布复盘：哪些决定还成立',
    tags: ['release', 'retro', 'northstar'], agent: 'deepseek-harness', age: 88,
    section: '结论',
    body: `v1 发布 3 个月后回看：单体、SQLite、审核优先、Markdown 可导出，四个决定仍然成立。\n\n- 不成立的是“先不做搜索”，用户第一周就在找东西。\n- 下一个版本优先补可解释召回。\n- 不要把“以后再说”当成决定。`,
  },
]

const pending = [
  {
    slug: 'explainable-recall', kind: 'project', title: 'northstar 2.5 计划：把召回做成可解释的',
    tags: ['northstar', 'recall', 'explainability'], agent: 'deepseek-harness', age: 0.1,
    section: '背景与结论',
    body: `用户反馈“不知道为什么召回这张卡”。2.5 给每次召回加三个字段：命中词、共享标签、最后使用时间。\n\n- 召回结果旁显示“为什么是它”。\n- 支持用户点“不相关”，作为下一轮排序信号。\n- 不引入黑盒向量分数，先做可解释的规则。`,
  },
  {
    slug: 'camera-sdk-2-4', kind: 'knowledge', title: '相机 SDK 升级 2.4 的兼容性清单',
    tags: ['camera', 'sdk', 'compatibility'], agent: 'codex', age: 0.2,
    section: '要点',
    body: `SDK 2.4 改了事件回调线程模型，升级前核对：回调线程、句柄释放顺序、异常码映射。\n\n- 先在离线环境跑 24 小时拔插测试。\n- 旧固件保留回滚包。\n- 不要在线程回调里直接操作 UI。`,
  },
  {
    slug: 'keyboard-audit', kind: 'project', title: '把审核中心做成键盘优先',
    tags: ['review', 'keyboard', 'ux'], agent: 'claude', age: 0.3,
    section: '决策',
    body: `审核是高频动作，鼠标逐行点太低效。默认支持 J/K 切换、A 批准、R 驳回。\n\n- 焦点始终可见。\n- 批量操作保留确认与撤销。\n- 快捷键在界面上可发现，不靠记忆。`,
  },
  {
    slug: 'sqlite-cjk-search', kind: 'knowledge', title: 'SQLite 全文检索中文分词方案',
    tags: ['sqlite', 'cjk', 'search'], agent: 'deepseek-harness', age: 0.4,
    section: '根因',
    body: `SQLite FTS5 默认分词对中文不友好，整句被当成一个 token。\n\n- 方案 A：写入时按 2-gram 切分，召回高但索引大。\n- 方案 B：外部分词后存 token 列，查询走 LIKE 前缀。\n- 先测召回和体积，再选。`,
  },
  {
    slug: 'release-notes-template', kind: 'content', title: '发布说明模板 v2',
    tags: ['release', 'notes', 'template'], agent: 'claude', age: 0.5,
    section: '要点',
    body: `发布说明固定四段：一句话结论、用户可感知变化、升级注意、回滚方式。\n\n- 不贴提交列表。\n- 每个变化都写“对用户意味着什么”。\n- 附上升级命令。`,
  },
]

const rejected = [
  {
    slug: 'user-note-raw', kind: 'content', title: '用户：把这个记一下',
    tags: ['raw'], agent: 'claude', age: 9, section: '摘要',
    body: '用户：把这个记一下。',
  },
  {
    slug: 'temp-test-card', kind: 'content', title: '临时测试卡',
    tags: ['raw'], agent: 'codex', age: 14, section: '摘要',
    body: '测试自动沉淀。',
  },
]

const folder = { project: '02-Projects', knowledge: '03-Knowledge', content: '04-Content', prompt: '05-Prompts', business: '06-Business', tool: '07-Tools', mistake: '08-Mistakes' }
const rank = { project: 0, knowledge: 1, mistake: 2, content: 3, tool: 4, prompt: 5, business: 6 }

function make(def, status, idx) {
  const updated = new Date(now - def.age * DAY).toISOString()
  const created = new Date(now - def.age * DAY - 3600000).toISOString()
  const path = `${folder[def.kind] || '04-Content'}/${def.slug}.md`
  const summary = `# ${def.title}\n\n## ${def.section}\n\n${def.body.replace(/\n+/g, ' ').slice(0, 180)}`
  const text = `---\nformatVersion: 1\nkind: ${def.kind}\ntitle: ${def.title}\ntags: [${def.tags.join(', ')}]\ncreated: ${created}\nupdated: ${updated}\nstatus: ${status}\nsubmittedBy: ${def.agent}\nreason: AI 自动沉淀（蒸馏卡）\nsource: ${def.agent}\n---\n\n# ${def.title}\n\n## ${def.section}\n\n${def.body}`
  return {
    card: {
      path, kind: def.kind, title: def.title, tags: def.tags, summary, created, updated,
      status, submittedBy: def.agent, severity: 'info',
      reason: status === 'pending' ? 'AI 自动沉淀（蒸馏卡）' : (status === 'rejected' ? 'AI 自动沉淀（原文卡）' : 'AI 自动沉淀（蒸馏卡）'),
    },
    text,
  }
}

const bodies = {}
const mk = (list, status) => list.map((d, i) => { const m = make(d, status, i); bodies[m.card.path] = m.text; return m.card })
const approved = mk(recent, 'approved')
const oldCards = mk(old, 'approved')
const pendingCards = mk(pending, 'pending')
const rejectedCards = mk(rejected, 'rejected')

const activity = []
recent.slice(0, 8).forEach((d, i) => {
  const t = now - (i * 18 + 3) * 60000
  activity.push({ ts: t, action: 'created', text: `新卡：${d.title}（待审核）`, preview: '', session: 'demo', model: 'deepseek-flash' })
  activity.push({ ts: t - 240000, action: 'listen', text: '会话事件 18 条 → 有效对话 1,642 字', preview: '用户：把这次决策记下来，下次开会要用。', session: 'demo', model: 'deepseek-flash' })
})
activity.push({ ts: now - 15 * 3600000, action: 'boot', text: '面板一键重启常驻实例成功：端口 7999 正在服务 v0.11.0-rc.1', preview: '', session: 'system' })
activity.push({ ts: now - 20 * 3600000, action: 'skip', text: '冷却中：距上次沉淀 120s < 300s', preview: '', session: 'demo' })

const data = {
  generatedAt: new Date(now).toISOString(),
  version: '0.16.0',
  total: 897,
  recent: 183,
  tags: 1987,
  byKind: { project: 357, knowledge: 205, mistake: 165, content: 111, tool: 44, prompt: 12, business: 3 },
  quarantine: { pending: 5, rejected: 2, deleted: 1, total: 8 },
  approved,
  graphCards: approved.concat(oldCards),
  oldCards,
  pending: pendingCards,
  rejected: rejectedCards,
  bodies,
  activity,
  health: { ok: true, reason: '', since: 0, lastOkAt: now - 2 * 60000, lastFailAt: 0 },
  // 记忆账本示例数据：让 demo 与 0.16 的真实 UI 对齐（召回注入 / 蒸馏调用 / 有用率）
  ledger: {
    days: 7,
    recalls: 46,
    recallChars: 28400,
    captures: 14,
    captureInChars: 41200,
    captureOutChars: 9800,
    estTokens: 39700,
    feedback: { useful: 19, useless: 5, rate: 19 / 24 },
  },
}

fs.mkdirSync('site/demo', { recursive: true })
fs.writeFileSync('site/demo/data.js', 'window.ME_DATA = ' + JSON.stringify(data) + ';\n', 'utf8')
console.log(JSON.stringify({ approved: approved.length, old: oldCards.length, pending: pendingCards.length, bodies: Object.keys(bodies).length, activity: activity.length }, null, 2))
