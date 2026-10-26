// 记忆核心（client 侧）：设置 → 记忆 图形化知识库页面 + 侧边栏「记忆」按钮。
//
// 提供：
// - 侧边栏底部 footer 新增「记忆」按钮（sidebar.footer.action），一键打开完整记忆库弹窗；
// - 完整记忆库弹窗：统计概览 + 检索 + 分类筛选 + 知识卡网格 + 知识图谱（比设置页内嵌更开阔）；
// - 增强版知识图谱（力导向布局 / 渐变发光节点 / 曲线渐变连线 / 节点按度数放大 / 悬停高亮 / 入场动画）；
// - 设置 → 记忆 内嵌页面（复用同一套 MemoryLibrary）。
//
// 数据全部来自 host 的 /memory-eternal/api/* JSON 路由（同源 fetch），不引入额外依赖。

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { renderMd, splitFrontmatter, parseTags } from './markdown.js'
import brandIcon from '../../assets/icon.png'
import { snippetAround } from './snippet.js'
import { versionCardState } from './version-state.js'
// 「反馈异常」纯函数层（与宿主/独立 web 共用同一套脱敏与预填逻辑）
import { buildIssueUrl, buildIssueBody, buildAgentPrompt } from '../../lib/feedback.js'
// 图谱 LOD：视口剔除 + 标签预算（放大后卡顿的根治手段）
import { visibleWorldRect, inRect, pickLabelIds, labelBudget } from './graph-lod.js'
// 图谱预热策略：分帧 + 时间预算（替代原来「200 次同步 tick」造成的 1s+ 主线程冻结/空白）
import { WARM_FRAME_BUDGET_MS, warmTicksFor } from './graph-warmup.js'
// 保存后不闪烁：宿主 volatile 回流滞后期间，用本地叠加层顶住输入框的值
import { mergeLocalOverlay } from './config-merge.js'

const NS = 'memory-eternal'
const API = '/memory-eternal/api'

async function openExternal(url) {
  try {
    const r = await fetch(`${API}/open-external?url=${encodeURIComponent(url)}`, { method: 'POST' })
    const d = await r.json().catch(() => null)
    if (r.ok && d && d.ok) return true
  } catch { /* 落到 window.open */ }
  try { const w = window.open(url, '_blank', 'noopener,noreferrer'); if (w) return true } catch { /* ignore */ }
  try { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click(); return true } catch { /* ignore */ }
  return false
}
// 真分页页大小：首屏只拉一页（服务端 offset/limit），滚到底再续拉下一页
const PAGE_SIZE = 100

// dsh ≥0.1.7 的客户端服务表：settingsScope 已随 @deepseek-ai/dsh-client-runtime 一起移除
// （设置域改为 configForms / settingsSchema + settings.section 插槽），本插件只用到
// slots（注册设置页与侧边栏按钮）和 locale（i18n 字典），因此 inject 收窄到这两个。
export const inject = ['slots', 'locale']

export const ZH = {
  nav: '记忆',
  // 加载提示统一「进度条 + 文案」（用户群要求：不要干等，要看得见进度）。
  // 网络阶段是不确定进度条，布局阶段是真实百分比。
  loading: '加载中…',
  loadingGraph: '正在加载知识星图…',
  refresh: '刷新',
  overview: '记忆库概览',
  total: '知识卡',
  recent: '近 7 天新增',
  tags: '标签',
  searchPlaceholder: '搜索记忆（支持中文片段）…',
  search: '搜索',
  all: '全部',
  kindProject: '项目',
  kindKnowledge: '知识',
  kindContent: '内容',
  kindPrompt: '提示词',
  kindBusiness: '业务',
  kindTool: '工具',
  kindMistake: '教训',
  kindCore: '核心记忆',
  cardsTab: '知识卡',
  webTab: 'Web 版',
  webOpening: '正在用默认浏览器打开 Web 版…',
  webOpened: '已用默认浏览器打开 Web 版',
  webOpenFail: '打开浏览器失败，可手动访问',
  terminalTab: '终端版',
  terminalTitle: '终端完整版',
  terminalIntro: 'Web UI 不渲染终端原生 TUI。要完整批卡、长文滚动和全选，请打开本机终端；或者直接在 dsh-tui 里用 /audit。',
  terminalRun: '只读体验（真实队列）',
  terminalTui: '写入模式（真实批驳）',
  terminalWhy: '为什么不直接嵌进网页',
  terminalWhyBody: '终端 TUI 依赖 alternate screen、原始键盘事件和字符网格，无法用 iframe 忠实嵌入。这里给出真实命令，打开后就是同一套界面。',
  terminalCopy: '复制命令',
  terminalCopied: '已复制',
  terminalPreview: '终端预览',
  graphTab: '知识星图',
  graph: '知识图谱',
  graphHint: '节点=知识卡；连线=[[链接]] 或共享标签。点击节点阅读卡片。',
  graphTip: '左键凸显 · Shift+拖拽框选 · 右键菜单 · 滚轮缩放 · 拖拽平移',
  rebuild: '重建',
  reset: '重置',
  expandAll: '全部展开',
  capped: '已展示最核心的',
  clearFocus: '取消高亮',
  empty: '记忆库还是空的。多聊几轮后，值得保存的内容会自动沉淀成知识卡。',
  emptyGraph: '图谱暂无数据。',
  open: '阅读',
  updated: '更新于',
  created: '创建于',
  source: '来源',
  contents: '目录',
  related: '相关记忆',
  file: '文件',
  close: '关闭',
  vaultDir: '记忆库目录',
  capture: '自动沉淀',
  recall: '自动召回',
  enabled: '已启用',
  disabled: '已禁用',
  error: '加载失败',
  back: '返回列表',
  cardCount: '张卡',
  nodes: '节点',
  edges: '连线',
  memoryTitle: '记忆库',
  memoryHint: '你的本地第二大脑',
  zoomIn: '放大',
  zoomOut: '缩小',
  fit: '适应',
  enterFullscreen: '全屏',
  exitFullscreen: '退出全屏',
  exportGraph: '导出',
  openCard: '打开卡片',
  focusNeighbors: '凸显关联',
  copyName: '复制名称',
  noMatch: '没有匹配的记忆',
  clearFilter: '清除过滤',
  filterLabel: '筛选',
  sortRecent: '最近',
  sortTitle: '标题',
  sortHot: '热点',
  exportSel: '导出选中',
  clearSelection: '清空选择',
  download: '下载',
  openNewTab: '新标签打开',
  copyImage: '复制图片',
  done: '完成',
  downloaded: '已开始下载',
  openedTab: '已在新标签打开',
  copied: '已复制',
  exportedSel: '个节点已导出',
  fullscreen: '全屏',
  exitFull: '退出全屏',
  copyFail: '复制失败',
  timeDim: '时间维',
  graphWarming: '正在布局 {n} 个节点…',
  timeNew: '3 天内',
  timeRecent: '2 周内',
  timeMonth: '1 月内',
  timeOld: '更早',
  newBadge: '新',
  expand: '展开全部',
  collapse: '收起',
  copyBody: '复制正文',
  clearFilter: '清除标签筛选',
  copyPath: '复制路径',
  copied: '已复制',
  copyFail: '复制失败',
  readWidth: '阅读宽度',
  widthNarrow: '窄',
  widthMid: '中',
  widthWide: '宽',
  exportVault: '导出MD',
  exportJson: '导出JSON',
  exporting: '导出中…',
  exportedVault: '记忆库已导出',
  exportFail: '导出失败',
  importVault: '导入',
  importedVault: '导入完成',
  importedTotal: ' 张 / 文件共 ',
  importedTotalTail: ' 张',
  importedQuarantine: ' · 待审核 ',
  importedQuarantineTail: ' 张（隔离区，批准后才参与召回）',
  importedSkipped: ' · 跳过 ',
  importedSkippedTail: ' 张（重复或空）',
  importFail: '导入失败',
  location: '自选位置',
  saveAs: '另存为',
  saveAsUnsupported: '当前环境不支持选择保存位置',
  exportedTo: '已导出到',
  defaultDownloads: '默认下载文件夹',
  exportCancel: '已取消导出',
  manage: '管理',
  tabUsage: '运行状态',
  tabOptimize: '整理建议',
  adminLoadFail: '数据加载失败：请彻底重启 dsh-desktop（host 需加载新版 /memory-eternal 路由）',
  retry: '重试',
  mergeSimilar: '一键合并相似',
  trendLabel: '近 30 天趋势',
  cleanStale: '🗑️ 一键清理陈旧',
  deletedStale: '个陈旧卡已清理',
  newCard: '新建',
  tplDecision: '📝 技术决策',
  tplBug: '🐛 踩坑',
  tplMeeting: '📋 会议纪要',
  tplWeekly: '📊 周报',
  createCard: '创建',
  cardTitle: '标题',
  cardBody: '正文',
  fbUseful: '有用',
  fbIrr: '无关',
  todayAdd: '今日新增',
  weekAdd: '近 7 天',
  byKind: '分类统计',
  todayList: '今日沉淀',
  budgetLabel: '会话预算',
  budgetChars: '预算字符',
  recallLimitLabel: '召回条数',
  embeddingLabel: '语义召回',
  mergePairs: '相似卡对（可合并）',
  staleCards: '陈旧卡（>90 天未更新）',
  noOptimize: '暂无可整理项，很健康 🎉',
  refineTitle: '矛盾扫描',
  refineScan: '开始扫描',
  refineHint: '相似可以合并，矛盾必须人判断 —— 扫描只读，选择后才动数据（保留一张会把另一张放进回收站，可还原）',
  refineIdle: '点「开始扫描」：先宽召回可能有关系的卡片对，再让模型判断是重复 / 补充 / 矛盾 / 无关',
  refineNone: '这一轮没有发现需要你裁决的卡片对 🎉',
  refineFail: '矛盾扫描失败',
  refineApplied: '已记录你的裁决（不会重复打扰）',
  refineRel_duplicate: '重复（可合并）',
  refineRel_complement: '补充（都留着）',
  refineRel_conflict: '矛盾（需你裁决）',
  refineRel_unrelated: '无关',
  refineKeepA: '保留 A',
  refineKeepB: '保留 B',
  refineKeepBoth: '都保留',
  refineMerge: '合并',
  junkTitle: '注入垃圾卡',
  junkScan: '扫描存量',
  junkHint: '怀疑是运行时注入文本（技能目录 / system-reminder）沉淀成的卡 —— 扫描只读，回收走回收站可还原',
  junkIdle: '点「扫描存量」：找出正文其实是被注入的运行时文本、剥掉后几乎不剩人话的卡',
  junkNone: '没发现这类卡 🎉',
  junkRecycle: '回收',
  junkRecycleAll: '全部回收',
  junkRecycleAllConfirm: '确认把这些卡送进回收站？（不是永久删除，可在回收中心还原）',
  junkDone: '已送回收站',
  junkFail: '扫描 / 回收失败',
  dbReadonlyTitle: '记忆库当前不可写',
  dbReadonlyBody: '卡片读写 / 审核 / 图谱会失败，但**配置仍可保存**（配置不经过数据库）',
  dbReadonlyFix: '排查：dsh-memory doctor（看 journal 模式、写探针、备份清单与恢复步骤）',
  goalTitle: '同目标不同做法',
  goalScan: '扫描目标',
  goalHint: '按「这张卡解决什么问题」聚类 —— 正文相似度抓不到的做法差异（7z 压缩 / tar 分发 / npm 瘦身）也能归到一起',
  goalIdle: '点「扫描目标」：模型先给每张卡抽一句目标（首次会调模型，之后走缓存），再按目标聚类',
  goalNone: '没有发现「同一目标、多张卡」的簇 🎉',
  goalStats: '已索引 / 本次调用',
  goalCards: '张卡',
  goalKeep: '都保留',
  goalMerge: '合并这一组',
  goalMerged: '已提交合并（新卡进审核队列）',
  goalDone: '已记录「都保留」',
  goalFail: '目标聚类失败',
  oneClickOptimize: '一键优化',
  oneClickOptimizeConfirm: '确认一键优化？将合并所有相似卡对（默认不清理陈旧卡）。',
  oneClickAlsoStale: '同时清理陈旧卡',
  oneClickOptimizeDone: '一键优化完成',
  optimizedMerged: '对已合并',
  optimizedStaleDeleted: '张陈旧卡已清理',
  mcpSetupStatus: 'Agent MCP 挂载状态',
  rerunSetup: '补全 MCP',
  notInstalled: '未安装',
  noMcpEntry: '配置缺失',
  nodePathMismatch: 'node 路径不一致，建议重跑 setup',
  nodePathNote: 'node 环境不同（可用）',
  healthy: '配置正常',
  mcpSetupHint: '「自动挂载 MCP」= 让 Claude Code / Codex / Cursor 这些工具能调用记忆库。开启后自动把它们配置好；关掉就不动你电脑上任何配置文件，需要时手动跑 dsh-memory setup。',
  mcpManageHint: '每个 agent 用下方按钮单独安装/卸载 MCP',
  tabConfig: '记忆配置',
  configPageSub: '写入、路由、审核与服务的本地配置',
  tabAudit: '待审',
  statusApproved: '已审核',
  statusPending: '待审核',
  statusRejected: '已驳回',
  allStatus: '全部状态',
  tabRecycle: '回收中心',
  recyclePageSub: '已删除的卡保留 30 天，可恢复或永久删除',
  pending: '待审核',
  rejected: '已驳回',
  selectAll: '全选',
  approve: '批准',
  reject: '驳回',
  allAgents: '全部智能体',
  noAuditItems: '暂无审核项目',
  auditBodyFail: '正文读取失败',
  deletedAt: '删除于',
  restore: '恢复',
  restoreDelete: '删除进回收站',
  purge: '永久删除',
  emptyRecycle: '回收站为空',
  recycleHint: '删除的卡片先进回收站，30 天内可恢复，超期自动永久删除',
  purgeConfirm: '确定永久删除？不可恢复。',
  recycleDeleteConfirm: '确定删除进回收站？30 天内可恢复。',
  modeInit: '启动时拉一次',
  modeInterval: '周期保活',
  modeManual: '仅手动',
  serviceConfig: '服务自管理配置',
  auditConfig: '自动审核配置',
  auditHint: '命中免审的新卡直接入库，其余进待审核',
  auditMode: '审核模式',
  auditAll: '全部要审核',
  auditNone: '全部免审',
  auditExemptAgents: '免审智能体',
  auditExemptKinds: '免审类型',
  allExempt: '全部免审',
  recycleDays: '回收保留天数',
  editInSetting: '编辑请到 DSH 设置 → 记忆',
  pendingSyncNote: '此页是独立 Web 页：保存后由 DSH 宿主应用（新版宿主会被直接叫醒、在请求上下文里应用，点保存即生效）；若本机没有 DSH 宿主在运行，则直接写入共享配置、立即生效。只有在对接旧版宿主时才会退回「排队等它自己同步」，那时可在 DSH 设置 → 记忆里改同一项。',
  readonlyTitle: '当前页面只读，无法保存配置',
  readonlyBody: '这个进程没有 DSH 的设置服务（settings.update 不存在），配置只能在本机 DSH 里修改：桌面版 → 设置 → 记忆。',
  readonlyBtn: '只读',
  setupRunInTerminal: '请复制以下命令到终端执行：',
  dshMemoryConfig: 'DSH 记忆配置',
  coreMemory: '核心记忆（前置强制）',
  coreMemoryHint: '每次会话自动注入，不依赖模型主动召回；只读取已批准的核心卡',
  coreMemoryEnabled: '启用核心记忆注入',
  coreMemoryLimit: '核心记忆上限（张）',
  coreMemoryMaxChars: '核心记忆总字符上限',
  setCore: '设为核心记忆',
  unsetCore: '取消核心记忆',
  coreSetOk: '已设为核心记忆',
  coreUnsetOk: '已取消核心记忆',
  coreSetFail: '设置失败',
  autoCapture: '自动沉淀',
  autoRecall: '自动召回',
  captureMinChars: '捕获最小长度',
  maxCardsPerDay: '日配额',
  dedupThreshold: '去重阈值',
  recallLimit: '召回条数',
  vaultMulti: '多库（按项目隔离）',
  vaultMultiHint: '留空即单库，老配置不受影响',
  vaultNow: '当前生效',
  vaultSource: '来源',
  vaultWorkspace: '当前 workspace',
  vaultNamePh: '库名，如 work',
  vaultPathPh: '目录，如 D:/vaults/work',
  vaultMatchPh: '项目目录（可选，按 workspace 自动选库）',
  vaultAdd: '添加一个库',
  vaultActive: '激活库',
  vaultActiveNone: '默认库（不指定）',
  vaultSrcEnv: '环境变量 MEMORY_VAULT_DIR',
  vaultSrcProfile: '激活库配置',
  vaultSrcWorkspace: '按项目目录自动命中',
  vaultSrcVaultDir: '单库配置 vaultDir',
  vaultSrcDefault: '默认目录',
  fbNav: '反馈异常',
  fbTitle: '反馈异常（提交到 GitHub）',
  fbDesc: '描述你遇到的问题（现象 / 复现步骤 / 期望行为）',
  fbDiag: '诊断信息（已自动脱敏：home 目录与 key/token 已替换）',
  fbCopyDiag: '复制诊断信息',
  fbOpenIssue: '在 GitHub 提交（已预填）',
  fbCopyPrompt: '复制给 AI 的提示词',
  fbCopiedDiag: '诊断信息已复制',
  fbCopiedPrompt: '提示词已复制，粘进 AI 对话框即可',
  fbCopyFail: '复制失败，请手动选中复制',
  fbWhy: 'GitHub 不允许匿名创建 issue，插件里也不应内置 token：所以这里把标题 / 正文 / 诊断都预填好，你只需再点一次 Submit。',
  fbNeedDesc: '请先描述你遇到的问题',
  fbLoading: '正在收集诊断信息…',
  fbDiagFail: '诊断接口不可用（独立 web 或旧版宿主），请手动补充环境信息',
  fbOr: '或者',
  fbSelectAll: '全选',
  auditTypeLabel: '类型',
  auditInboxSub: '自动沉淀的卡先到这里 · 批准后进入记忆库',
  auditUndo: '批准与驳回都可撤销',
  auditSelected: '已选',
  auditClearSelection: '清空',
  preview: '预览',
  supportGroup: '交流群',
  supportSponsor: '赞助',
  supportLegacy: '旧程序',
  supportTitle: '支持与交流',
  clickToZoom: '点击放大',
  supportGroupHint: '扫码进交流群，遇到问题可以直接问。',
  supportSponsorHint: '如果这个插件帮你省了时间，可以请作者喝杯咖啡。完全自愿，不影响任何功能。',
  supportLegacyTitle: '旧程序（dsh-desktop）已停止维护',
  supportLegacyBody: '作者自研的 dsh-desktop 已停止维护，官方 DeepSeek Harness 桌面版已覆盖同样能力，建议迁移。旧 profile 里如果还钉着已撤下的 dsh-desktop-shell@0.3.0，先删掉那套依赖，否则 pnpm install 会失败。',
  supportReadme: '打开 README',
  supportReleases: '历史版本',
  supportFeedback: '异常反馈',
  supportReplay: '重新查看引导',
  onboardTitle: '30 秒认识记忆核心',
  onboardSub: '你的 AI 会在每轮对话后自动沉淀知识卡，先审后入。',
  onboardSkip: '跳过',
  onboardBack: '上一步',
  onboardNext: '下一步',
  onboardStart: '开始使用',
  onboardStep0Title: '先去 GitHub 点个 Star',
  onboardStep0Body: 'Star 是作者继续维护最直接的反馈；想自己改代码或部署，就顺手 Fork 一份。',
  onboardStar: 'Star / 点赞',
  onboardFork: 'Fork',
  onboardStarred: '已 Star，继续',
  onboardStarHint: '之后可以随时点顶栏的 ★ Star 回来。',
  onboardStep1Title: '自动沉淀，不用手动记',
  onboardStep1Body: '每轮对话结束，值得留下的决策、根因和教训会被写成一张卡。先生成，再审核。',
  onboardStep2Title: '读到有用的卡，点个 👍',
  onboardStep2Body: '打开任意卡片，点 👍 有用 / 👎 没用。不用先搜索，按钮现在一直都在。它会帮助召回排序。',
  onboardStep3Title: '左侧新增支持入口',
  onboardStep3Body: '交流群、赞助、旧程序、异常反馈都在左栏底部；需要帮助时不用翻 README。',
  onboardTip: '提示：这个引导可以在「支持与交流」里重新打开。',
  navWorkspace: '工作区',
  navSystem: '系统',
  navSupport: '支持',
  v5Local: '本地运行',
  v5Star: '去 GitHub 点 Star',
  runtimeTitle: '运行状态',
  runtimeSub: '知识库、备份、自动沉淀与版本',
  dbTitle: '知识库',
  backupTitle: '备份',
  captureTitle: '自动沉淀',
  versionTitle: '版本',
  cardsUnit: '张卡',
  links: '连接',
  todayReview: '今日回看',
  openArrow: '打开 →',
  reshuffle: '换一张',
  insightDecision: '决策',
  insightRoot: '根因',
  insightLesson: '教训',
  insightSummary: '摘要',
  pinCard: '固定这张卡',
  unpinCard: '取消固定',
  pinnedOnly: '已固定',

  toastApproved: '已批准',
  toastRejected: '已驳回',
  toastCardDeleted: '已删除',
  toastRestored: '已恢复',
  toastPurged: '已彻底删除',
  toastPurgedExpired: '已清理过期回收站',
  toastFailed: '操作失败',
  noSelection: '请先选择要处理的卡片',
  enabledLabel: '启用记忆核心',
  vaultDirLabel: '记忆库目录（单库）',
  captureCooldownMs: '沉淀冷却 (ms)',
  captureProvider: '蒸馏 provider（留空自动）',
  routeAuto: '自动（按注册顺序）',
  routeListFail: '取不到模型列表（{err}）→ 下面可直接手填 provider / model；桌面版弹窗会自动向宿主代理，若仍失败请从 DSH 设置页打开' ,
  captureFollowSession: '跟随当前会话（蒸馏用会话的 provider/model）',
  captureFirstOnly: '仅试首选（失败即停，不轮换兜底）',
  llmTest: '测试蒸馏路由',
  llmTestOk: '✓ 调用成功',
  llmTestFail: '✗ 调用失败',
  llmCandidates: '候选数',
  captureModel: '蒸馏 model（留空自动）',
  recallEmbedding: '语义召回 provider（可选）',
  sessionBudgetChars: '会话预算 (字符)',
  saving: '保存中…',
  savePending: '已写入配置文件；宿主仍是旧版，重启 DSH 后即以新值为准（本面板已生效）',
  actionRunning: '处理中…',
  recycleEmptyHint: '回收站为空：删掉的卡片会先放到这里，保留 {days} 天后自动清理。',
  recyclePurgeAll: '清空回收站',
  fbCopyManual: '自动复制被浏览器拦截，已把内容放在下面：点「全选」再按 Ctrl+C',
  vcPage: '页面脚本',
  vcPageStale: '⚠ 当前页面仍在运行旧版脚本（页面 v{page} / 磁盘 v{disk}）：按 Ctrl+F5 刷新页面即生效；若「运行中」仍是旧版号，则还需重启桌面版 / DSH',
  vcLoaded: '运行中（服务本页的进程）',
  vcResident: '常驻实例',
  vcOnDisk: '磁盘安装',
  vcLatest: 'npm 最新',
  vcStale: '磁盘已安装 v{disk}，但服务本页的进程仍加载 v{loaded} —— 点「重启常驻实例」即可用新代码重启它（不用重启 DSH）',
  vcRestart: '重启常驻实例',
  vcRestarting: '重启中…',
  vcRestartSent: '已调度重启常驻实例：约 3-8 秒后新进程接管，请稍等再刷新页面（Ctrl+F5）',
  vcRestartCurrent: '常驻实例已经是最新版，无需重启',
  vcRestartAnyway: '常驻实例已是 v{ver}；通常无需重启，卡住/行为异常时可强制重启',
  vcHostProcessStale: '磁盘已安装 v{disk}，但**服务本页的进程**（DSH 宿主）加载的仍是 v{loaded} —— 它来自宿主启动时的那份代码：**重启常驻实例不会改变本页**，需完全退出并重开 DSH。',
  vcRestartFixes: '点击会把常驻实例（端口上那个）换成 v{disk}（当前 v{served}），不用重启 DSH',
  vcRestartStart: '点击会用当前磁盘版本 v{disk} 把常驻实例拉起来（不用重启 DSH）',
  vcRestartRepair: '点击会把它重新托管并保活（版本已是 v{disk}，不用重启 DSH）',
  vcRestartHostOnly: '常驻实例已是 v{disk}；本页显示 v{loaded} 来自 DSH 宿主 —— 重启常驻实例不影响本页，请重启 DSH',
  vcRestartFail: '重启请求失败',
  vcRestartNoRoute: '当前页面对接的进程还是旧版（没有这个接口）：请重启桌面版 / DSH 后再试，或执行 {cmd}',
  vcHostStale: '上方的「运行中」来自服务本页的进程；常驻实例已是新版 —— 要让它也变成新版号，需重启桌面版 / DSH',
  vcResidentDownShort: '未运行',
  vcResidentDown: '常驻实例没在运行（端口 {port} 无响应）—— 点下面的按钮用新代码把它拉起来；拉不起来时执行 {cmd}，并贴一下 dsh-memory status 的输出',
  vcResidentUnmanagedShort: '未托管',
  vcResidentUnmanaged: '常驻实例在服务 v{served}，但**没有看门狗保活**（停止 / 硬杀后残留的孤儿）—— 点下面的按钮把它重新托管（重新拉一个看门狗 + 新实例）；也可以执行 {cmd}',
  vcResidentLockUnknownShort: '托管状态未知',
  vcResidentReplaceBlockedShort: '不可替换',
  vcResidentHostManagedShort: '宿主托管',
  vcResidentReplaceBlocked: '常驻实例**不可替换**（环境限制）：看门狗锁目录不可写（{err}；{path}）→ 端口上会**长期**停在 v{served}。这不是「暂时落后」：自动替换被正确地拒绝（避免留下孤儿）。出路：修复该目录权限后执行 {cmd}，或前台观察 dsh-memory watchdog --port 7999',
  vcResidentLockUnknown: '常驻实例在服务 v{served}，但**看门狗锁文件写不进去**（受限环境：沙箱禁写 / ACL / 非系统盘）→ 无法判断它有没有被托管（不是「未托管」）。原因：{err}（{path}）。保活通常仍然有效；点下面的按钮可用新代码重新托管一次。',
  vcOutdated: '有新版本',
  vcUpToDate: '已是最新',
  vcCheck: '检查更新',
  checking: '检查中…',
  vcCheckFail: '检查更新失败',
  recallSummaryLen: '召回摘要长度',
  recallBody: '召回含正文',
  secretHint: '凭证取用提示（注入每个会话）',
  autoWeb: 'Web server',
  autoWebMode: '保活模式',
  webPort: 'Web 端口',
  webCheckIntervalMs: '探活间隔(ms)',
  webMaxRestart: '最大重启次数',
  watchdogAutoSpawn: '看门狗进程',
  autoRestartOnDrift: '版本漂移自动重启常驻实例',
  autoMcpSetup: '自动挂载 MCP',
  saveConfig: '保存配置',
  saveFail: '保存失败',
  savedOk: '已保存',
  savedDirect: '本机没有 DSH 宿主在运行，已直接写入共享配置（hooks / MCP / 独立页立即生效）',
  savedApplied: '已保存并生效（宿主已在请求上下文里应用）',
  saveQueued: '已交给 DSH 宿主同步，尚未确认生效',
  saveHostGuard: '该宿主不允许插件从自己的回调上下文里写配置；请在「DSH 设置 → 记忆」里改同一项，或编辑 profile 的配置补丁层',
  saveFailHint: '宿主侧未应用，详见「反馈异常」里的诊断信息',
  recallTool: 'recall 工具',
  costControl: '成本控制',
  costHint: '省 token、控 LLM 消耗',
  distillEnabled: '蒸馏知识卡(开=LLM 压缩, 关=原文卡零 LLM)',
  dedupByLLM: '语义去重喂 LLM(关=纯词法更省)',
  captureMaxTokens: '蒸馏输出上限(token)',
  captureTimeoutMs: '蒸馏超时(毫秒；本地大模型冷启动建议 120000+)',
  recallMinScore: '召回相关性阈值(越高越省)',
  configNeedsDsh: '配置编辑需在 DSH 内打开（本页可能只读或有部分缺失）',
  installMcp: '安装 MCP',
  uninstallMcp: '卸载 MCP',
  uninstallConfirm: '确认卸载该智能体的 MCP？Claude Code/Codex 将无法再调用记忆库。',
  presetConfig: '一键推荐配置',
  presetHint: '点击填充对应方案，点保存生效',
  planApplied: '已填入「{plan}」· 点「保存配置」生效',
  planDescA: '个人开发推荐 · 蒸馏 4000 · 关看门狗',
  planDescB: '预算敏感 · 关蒸馏 · 近 0 成本',
  planDescC: '长项目 · 开看门狗 · 高质量',
  cfgSubCore: '自动沉淀 / 召回 / 库目录与去重策略',
  cfgSubMulti: '按项目隔离记忆库，切换后 CLI / MCP / hooks 同步生效',
  cfgSubCost: '控制 LLM 调用与召回规模，直接决定花多少钱',
  cfgSubAudit: '什么内容需要你人工确认后才进主库',
  cfgSubService: '保活、看门狗与版本自愈，一般保持默认即可',
  cfgDirty: '有未保存的更改',
  cfgClean: '已同步',
  unitChars: '字',
  unitPerDay: '张 / 天',
  unitTokens: 'tokens',
  unitMs: '毫秒',
  unitTimes: '次',
  unitDays: '天',
  mcpAutoHint: '自动识别已安装的 Agent 与其 MCP 配置（只读探测，不改任何文件）',
  mcpRefresh: '重新检测',
  mcpSummary: '识别到 {agents} 个 Agent · {servers} 个 MCP · {mounted} 个已挂载本插件',
  mcpNoServers: '未配置 MCP',
  mcpDetectedOnly: '仅识别',
  planA: 'A 轻量省心',
  planB: 'B 极致省钱',
  planC: 'C 高质量',
  pluginInfo: '插件信息',
  organizeTitle: '整理建议',
  scanAndOrganize: '一键搜索和整理',
  scanHint: '点「🔍 一键搜索和整理」扫描相似卡/陈旧卡，再用「⚡ 一键优化」执行。',
  mergeNow: '合并',
  delete: '删除',
  captureAlert: '自动沉淀异常',
  captureAlertHint: '打开左栏「用量/今日」看自动沉淀日志；若是接口/版本不匹配，需更新 memory-eternal 插件。',
  captureLog: '自动沉淀日志',
  captureLogHint: '每轮对话结束后自动跑：监听 → 判定 → 写卡。这里显示最近 100 条，用来排查「为什么没写卡」。',
  captureLogEmpty: '还没有记录。跟 Agent 聊一轮（> 捕获最小长度）后再回来看。',
  healthTitle: '健康概览',
  healthHint: '库 / 备份 / 沉淀 / 版本 —— 一眼看清有没有静默坏掉的东西',
  healthDb: '知识库',
  healthDbBad: '库不可写或损坏',
  healthBackups: '备份',
  healthNoBackups: '没有备份（执行 dsh-memory doctor 可建，宿主也会每日备份）',
  healthBackupAge: '{n} 个 · 最近 {d} 天前',
  healthBackupToday: '{n} 个 · 今天',
  healthCapture: '自动沉淀',
  healthNoRecords: '暂无记录（还没触发过沉淀）',
  healthCapOk: '最近一次成功写卡',
  healthCapFail: '最近一次失败',
  healthRunAlign: '运行「版本对齐检查」后显示',
  healthVersion: '版本',
  ledgerTitle: '记忆账本（近 7 天）',
  ledgerHint: '召回注入了多少、蒸馏调用了多少次 —— 判断「到底省不省 token」的第一块数据',
  ledgerRecalls: '召回次数',
  ledgerInjected: '注入',
  ledgerChars: '字符',
  ledgerCaptures: '沉淀次数',
  ledgerLlmCalls: 'LLM 调用',
  ledgerEstimate: '估算 token',
  ledgerEstimateHint: '按约 2 字符 ≈ 1 token 粗估，只看量级',
  ledgerUseful: '召回有用率',
  ledgerUsefulHint: '来自「有用 / 没用」反馈；低于 60% 说明注入可能净亏',
  ledgerFormula: '净收益 ≈ 被避免的上下文开销 −（注入字符 + 蒸馏调用 × 单价）。账本只记「花了多少」，收益侧请结合你实际省下的重读 / 返工来判断。',
  ledgerNoData: '近 7 天还没有记录：聊几轮或让 agent recall 一次后再看。',
  ledgerNeedRestart: '宿主仍在跑旧版 API（/ledger 不存在）：完全退出并重开 DSH 后，账本才会开始记录。',
  alignTitle: '版本对齐检查',
  alignRun: '开始检查',
  alignFix: '重写接线',
  alignFixConfirm: '重写 MCP / hooks 接线？（只碰插件自己的键，不动你的数据与配置）',
  alignFixed: '接线已重写；若上面提示「宿主进程旧」，仍需完全退出并重开 DSH',
  alignFail: '对齐检查失败',
  alignHint: '插件升级只换磁盘文件 —— 宿主内存里的事件订阅与 MCP / hooks 里的旧路径不会自己更新，这里一次查清',
  alignIdle: '点「开始检查」：对比宿主 / 常驻实例 / npm 的版本，并检查 MCP、hooks 里是否有旧路径与旧参数',
  alignDisk: '磁盘', alignResident: '常驻实例', alignHost: '宿主进程',
  captureLogUnavailable: '日志仅在 DSH 宿主内可用（独立 Web 页没有 host 运行时）。',
  captureAgentCards: 'Agent 自动沉淀的卡',
  noCards: '暂无',
  loadMore: '加载更多',
  batchMerge: '一键智能合并',
  mergeAllConfirm: '将按相似度分组的卡片各合并为一张（保留各自 kind），原卡删除？',
  crossVault: '跨库聚合',
  deleteConfirm: '确定删除该记忆卡？此操作不可撤销。',
  deleted: '已删除',
  deleteFail: '删除失败',
  deleteSelected: '删除选中',
  deletedSelected: '张卡已删除',
  merge: '合并',
  mergeNeed: '至少选 2 张卡',
  mergeConfirm: '将所选卡片合并为一张并删除原卡？',
  merged: '已合并',
  mergeFail: '合并失败',
  mcpInstalled: '✅ {agent} MCP 已安装',
  mcpUninstalled: '✅ {agent} MCP 已卸载',
  mcpActionFail: '❌ {agent} MCP 操作失败：{error}',
  dshHostLabel: 'DeepSeek Harness（当前宿主）',
  restartHint: '已保存。autoWebMode/watchdogAutoSpawn 等需重启 DSH 生效；已有常驻 watchdog 不会被自动停掉，需 dsh-memory stop / restart（#19）',
  conflictRefresh: '配置已被外部修改，请刷新后重试',
  untitled: '无标题',
  tplBlank: '📄 空白',
  tagsHint: '标签（逗号分隔）',
  connCount: '{n} 连接',
  tplDecisionTags: '决策, 方案',
  tplBugTags: '踩坑, 教训',
  tplMeetingTags: '会议, 纪要',
  tplWeeklyTags: '周报',
  tplDecisionBody: '# 技术决策：[标题]\n\n## 背景\n- 问题描述\n\n## 候选方案\n| 方案 | 优点 | 缺点 |\n| --- | --- | --- |\n| A | | |\n| B | | |\n\n## 决策\n选择方案 A，原因：\n\n## 风险与后续\n',
  tplBugBody: '# 踩坑记录：[标题]\n\n## 现象\n- 发生了什么\n\n## 根因\n\n## 解决方案\n\n## 教训\n- 如何避免下次',
  tplMeetingBody: '# 会议纪要：[标题]\n\n**日期**：\n**参会人**：\n\n## 议题\n1. \n\n## 结论\n\n## 待办\n- [ ] ',
  tplWeeklyBody: '# 周报 [YYYY-MM-DD]\n\n## 本周完成\n- \n\n## 下周计划\n- \n\n## 风险/阻塞\n- ',
}

export const EN = {
  nav: 'Memory',
  loading: 'Loading…',
  loadingGraph: 'Loading knowledge graph…',
  refresh: 'Refresh',
  overview: 'Memory Overview',
  total: 'Cards',
  recent: 'Added (7d)',
  tags: 'Tags',
  searchPlaceholder: 'Search memory…',
  search: 'Search',
  all: 'All',
  kindProject: 'Projects',
  kindKnowledge: 'Knowledge',
  kindContent: 'Content',
  kindPrompt: 'Prompts',
  kindBusiness: 'Business',
  kindTool: 'Tools',
  kindMistake: 'Mistakes',
  kindCore: 'Core memory',
  cardsTab: 'Cards',
  webTab: 'Web version',
  webOpening: 'Opening the web version in your browser…',
  webOpened: 'Opened the web version in your browser',
  webOpenFail: 'Could not open a browser; visit this URL manually',
  terminalTab: 'Terminal',
  terminalTitle: 'Full terminal UI',
  terminalIntro: 'The Web UI does not render the native terminal TUI. For select-all, batch review and long-form scrolling, open a local terminal or use /audit inside dsh-tui.',
  terminalRun: 'Read-only live queue',
  terminalTui: 'Write mode (real review)',
  terminalWhy: 'Why not embed it in the page',
  terminalWhyBody: 'The terminal TUI relies on the alternate screen, raw key events and a character grid; an iframe cannot reproduce it faithfully. These are the real commands.',
  terminalCopy: 'Copy command',
  terminalCopied: 'Copied',
  terminalPreview: 'Terminal preview',
  graphTab: 'Star map',
  graph: 'Knowledge Graph',
  graphHint: 'Nodes = cards; edges = [[links]] or shared tags. Click a node to read.',
  graphTip: 'Left-click highlights · Shift+drag box-select · right-click menu · scroll zoom · drag to pan',
  graphWarming: 'Laying out {n} nodes…',
  rebuild: 'Rebuild',
  reset: 'Reset',
  expandAll: 'Expand all',
  capped: 'Showing the',
  clearFocus: 'Clear highlight',
  empty: 'Memory is empty. After a few conversations, valuable content is auto-captured.',
  emptyGraph: 'No graph data yet.',
  open: 'Read',
  updated: 'Updated',
  created: 'Created',
  source: 'Source',
  contents: 'Contents',
  related: 'Related',
  file: 'File',
  close: 'Close',
  vaultDir: 'Vault directory',
  capture: 'Auto capture',
  recall: 'Auto recall',
  enabled: 'on',
  disabled: 'off',
  error: 'Load failed',
  back: 'Back to list',
  cardCount: 'cards',
  nodes: 'nodes',
  edges: 'edges',
  memoryTitle: 'Memory Library',
  memoryHint: 'Your local second brain',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit',
  enterFullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  exportGraph: 'Export',
  openCard: 'Open card',
  focusNeighbors: 'Highlight links',
  copyName: 'Copy name',
  noMatch: 'No matching memory',
  clearFilter: 'Clear filter',
  filterLabel: 'Filter',
  sortRecent: 'Recent',
  sortTitle: 'Title',
  sortHot: 'Hot',
  exportSel: 'Export selected',
  clearSelection: 'Clear selection',
  download: 'Download',
  openNewTab: 'Open in new tab',
  copyImage: 'Copy image',
  done: 'Done',
  downloaded: 'Download started',
  openedTab: 'Opened in new tab',
  copied: 'Copied',
  exportedSel: ' nodes exported',
  fullscreen: 'Fullscreen',
  exitFull: 'Exit fullscreen',
  copyFail: 'Copy failed',
  timeDim: 'Time',
  timeNew: '≤3 days',
  timeRecent: '≤2 weeks',
  timeMonth: '≤1 month',
  timeOld: 'Older',
  newBadge: 'NEW',
  expand: 'Expand',
  collapse: 'Collapse',
  copyBody: 'Copy body',
  clearFilter: 'Clear tag filter',
  copyPath: 'Copy path',
  copied: 'Copied',
  copyFail: 'Copy failed',
  readWidth: 'Reading width',
  widthNarrow: 'Narrow',
  widthMid: 'Medium',
  widthWide: 'Wide',
  exportVault: 'Export MD',
  exportJson: 'Export JSON',
  exporting: 'Exporting…',
  exportedVault: 'Vault exported',
  exportFail: 'Export failed',
  importVault: 'Import',
  importedVault: 'Import complete',
  importedTotal: ' / of ',
  importedTotalTail: '',
  importedQuarantine: ' · pending review ',
  importedQuarantineTail: ' (quarantined until approved)',
  importedSkipped: ' · skipped ',
  importedSkippedTail: ' (duplicate or empty)',
  importFail: 'Import failed',
  location: 'Choose location',
  saveAs: 'Save as',
  saveAsUnsupported: 'Choose-save-location not supported here',
  exportedTo: 'Exported to',
  defaultDownloads: 'default Downloads folder',
  exportCancel: 'Export cancelled',
  manage: 'Manage',
  tabUsage: 'Runtime',
  tabOptimize: 'Optimize',
  adminLoadFail: 'Load failed: fully restart dsh-desktop so the host picks up the new /memory-eternal routes',
  retry: 'Retry',
  mergeSimilar: 'Merge similar',
  trendLabel: 'Last 30 days trend',
  cleanStale: '🗑️ Clean stale',
  deletedStale: ' stale cards cleaned',
  newCard: 'New',
  tplDecision: '📝 Decision',
  tplBug: '🐛 Bug',
  tplMeeting: '📋 Meeting',
  tplWeekly: '📊 Weekly',
  createCard: 'Create',
  cardTitle: 'Title',
  cardBody: 'Body',
  fbUseful: 'Useful',
  fbIrr: 'Irrelevant',
  todayAdd: 'Added today',
  weekAdd: 'Last 7d',
  byKind: 'By kind',
  todayList: 'Captured today',
  budgetLabel: 'Session budget',
  budgetChars: 'Budget chars',
  recallLimitLabel: 'Recall limit',
  embeddingLabel: 'Semantic recall',
  mergePairs: 'Similar pairs (mergeable)',
  staleCards: 'Stale (>90d)',
  noOptimize: 'Nothing to organize, healthy 🎉',
  refineTitle: 'Conflict scan',
  refineScan: 'Scan now',
  refineHint: 'Similar cards can be merged; conflicts must be judged by a human — the scan is read-only, and data only moves after you choose (keeping one moves the other to the recycle bin, recoverable)',
  refineIdle: 'Hit "Scan now": recall possibly-related card pairs, then let the model classify each as duplicate / complement / conflict / unrelated',
  refineNone: 'No card pairs need your ruling this round 🎉',
  refineFail: 'Conflict scan failed',
  refineApplied: 'Your ruling was recorded (it will not ask again)',
  refineRel_duplicate: 'Duplicate (mergeable)',
  refineRel_complement: 'Complement (keep both)',
  refineRel_conflict: 'Conflict (needs your ruling)',
  refineRel_unrelated: 'Unrelated',
  refineKeepA: 'Keep A',
  refineKeepB: 'Keep B',
  refineKeepBoth: 'Keep both',
  refineMerge: 'Merge',
  junkTitle: 'Injected junk cards',
  junkScan: 'Scan existing',
  junkHint: 'Cards suspected to be captured runtime injections (skill catalogs / system-reminders) — the scan is read-only and recycling goes to the recycle bin (recoverable)',
  junkIdle: 'Hit "Scan existing": find cards whose body is really injected runtime text with almost no human content left after stripping',
  junkNone: 'No such cards found 🎉',
  junkRecycle: 'Recycle',
  junkRecycleAll: 'Recycle all',
  junkRecycleAllConfirm: 'Send these cards to the recycle bin? (Not a permanent delete — recoverable from the recycle center)',
  junkDone: 'Sent to recycle bin',
  junkFail: 'Scan / recycle failed',
  dbReadonlyTitle: 'The memory database is currently not writable',
  dbReadonlyBody: 'Card reads/writes, auditing and the graph will fail, but **settings can still be saved** (they do not go through the database)',
  dbReadonlyFix: 'Diagnose with: dsh-memory doctor (journal mode, write probe, backups and recovery steps)',
  goalTitle: 'Same goal, different approach',
  goalScan: 'Scan goals',
  goalHint: 'Clusters by "what problem does this card solve" — approaches that differ in wording (7z vs tar vs npm slimming) still land together',
  goalIdle: 'Hit "Scan goals": the model first writes a one-line goal per card (first run calls the model, later runs use the cache), then clusters by goal',
  goalNone: 'No clusters of "one goal, several cards" found 🎉',
  goalStats: 'indexed / calls this run',
  goalCards: 'cards',
  goalKeep: 'Keep all',
  goalMerge: 'Merge this group',
  goalMerged: 'Merge submitted (the new card goes to the audit queue)',
  goalDone: 'Recorded as "keep all"',
  goalFail: 'Goal clustering failed',
  oneClickOptimize: 'One-click optimize',
  oneClickOptimizeConfirm: 'Confirm one-click optimize? This will merge all similar pairs (stale cards are NOT deleted by default).',
  oneClickAlsoStale: 'Also clean stale cards',
  oneClickOptimizeDone: 'One-click optimize done',
  optimizedMerged: 'pairs merged',
  optimizedStaleDeleted: 'stale cards cleaned',
  mcpSetupStatus: 'Agent MCP mount status',
  rerunSetup: 'Re-run setup',
  notInstalled: 'not installed',
  noMcpEntry: 'no MCP entry',
  nodePathMismatch: 'node path mismatch, consider re-running setup',
  nodePathNote: 'different node env (usable)',
  healthy: 'healthy',
  mcpSetupHint: '"Auto-mount MCP" = lets Claude Code / Codex / Cursor use the memory vault. On = auto-configures them; Off = never touches your machine config, run dsh-memory setup manually when needed.',
  mcpManageHint: 'Use each agent row to install/uninstall MCP individually',
  tabConfig: 'Memory Config',
  configPageSub: 'Local write, routing, audit and service settings',
  tabAudit: 'Review',
  statusApproved: 'Approved',
  statusPending: 'Pending',
  statusRejected: 'Rejected',
  allStatus: 'All statuses',
  tabRecycle: 'Recycle Bin',
  recyclePageSub: 'Deleted cards stay for 30 days; restore or purge',
  pending: 'Pending',
  rejected: 'Rejected',
  selectAll: 'Select all',
  approve: 'Approve',
  reject: 'Reject',
  allAgents: 'All agents',
  noAuditItems: 'No items to review',
  auditBodyFail: 'Failed to load the card body',
  deletedAt: 'deleted',
  restore: 'Restore',
  restoreDelete: 'Delete to recycle',
  purge: 'Purge',
  emptyRecycle: 'Recycle bin is empty',
  recycleHint: 'Deleted cards go to the recycle bin — recover within 30 days, else auto-purged',
  purgeConfirm: 'Permanently delete? This cannot be undone.',
  recycleDeleteConfirm: 'Delete to recycle? Recoverable within 30 days.',
  modeInit: 'Init once',
  modeInterval: 'Interval keep-alive',
  modeManual: 'Manual only',
  serviceConfig: 'Service self-hosting config',
  auditConfig: 'Auto-audit config',
  auditHint: 'Cards matching an exemption go straight in; others await audit',
  auditMode: 'Audit mode',
  auditAll: 'Audit all',
  auditNone: 'Skip all',
  auditExemptAgents: 'Exempt agents',
  auditExemptKinds: 'Exempt kinds',
  allExempt: 'Exempt all',
  recycleDays: 'Recycle retention days',
  editInSetting: 'Edit in DSH Settings → Memory',
  pendingSyncNote: 'This is the standalone web page: the DSH host applies a save (a current host is woken up and applies it in a request context, so saving takes effect immediately); when no DSH host is running here the change goes straight into the shared config. Only an older host falls back to "queued until it syncs on its own" — in that case change the same option under DSH Settings → Memory.',
  readonlyTitle: 'This page is read-only; config cannot be saved here',
  readonlyBody: 'This process has no DSH settings service (settings.update is unavailable). Edit the config in DSH: desktop app → Settings → Memory.',
  readonlyBtn: 'Read-only',
  setupRunInTerminal: 'Copy this command to your terminal:',
  dshMemoryConfig: 'DSH Memory Config',
  coreMemory: 'Core memory (always-on)',
  coreMemoryHint: 'Injected into every session; only approved core cards are used',
  coreMemoryEnabled: 'Enable core-memory injection',
  coreMemoryLimit: 'Core-memory limit (cards)',
  coreMemoryMaxChars: 'Core-memory total character limit',
  setCore: 'Set as core memory',
  unsetCore: 'Remove from core memory',
  coreSetOk: 'Set as core memory',
  coreUnsetOk: 'Removed from core memory',
  coreSetFail: 'Failed to update',
  autoCapture: 'Auto capture',
  autoRecall: 'Auto recall',
  captureMinChars: 'Min capture chars',
  maxCardsPerDay: 'Daily quota',
  dedupThreshold: 'Dedup threshold',
  recallLimit: 'Recall limit',
  vaultMulti: 'Multiple vaults (per project)',
  vaultMultiHint: 'Empty = single vault; existing setups unaffected',
  vaultNow: 'Active now',
  vaultSource: 'Source',
  vaultWorkspace: 'Current workspace',
  vaultNamePh: 'Name, e.g. work',
  vaultPathPh: 'Directory, e.g. D:/vaults/work',
  vaultMatchPh: 'Project dir (optional, auto-select by workspace)',
  vaultAdd: 'Add a vault',
  vaultActive: 'Active vault',
  vaultActiveNone: 'Default vault (unset)',
  vaultSrcEnv: 'env MEMORY_VAULT_DIR',
  vaultSrcProfile: 'activeVault profile',
  vaultSrcWorkspace: 'matched by project dir',
  vaultSrcVaultDir: 'vaultDir setting',
  vaultSrcDefault: 'default directory',
  fbNav: 'Report a bug',
  fbTitle: 'Report a bug (files on GitHub)',
  fbDesc: 'Describe the problem (symptoms / steps / expected)',
  fbDiag: 'Diagnostics (auto-redacted: home dir and keys/tokens replaced)',
  fbCopyDiag: 'Copy diagnostics',
  fbOpenIssue: 'Open prefilled issue on GitHub',
  fbCopyPrompt: 'Copy AI prompt',
  fbCopiedDiag: 'Diagnostics copied',
  fbCopiedPrompt: 'Prompt copied — paste it into your AI chat',
  fbCopyFail: 'Copy failed; please select and copy manually',
  fbWhy: 'GitHub does not allow anonymous issue creation and the plugin must not ship a token: so the title, body and diagnostics are pre-filled — you just click Submit.',
  fbNeedDesc: 'Please describe the problem first',
  fbLoading: 'Collecting diagnostics…',
  fbDiagFail: 'Diagnostics endpoint unavailable (standalone web or older host); please add environment info manually',
  fbOr: 'or',
  fbSelectAll: 'Select all',
  auditTypeLabel: 'Type',
  auditInboxSub: 'Captured cards land here · approve to publish',
  auditUndo: 'Approve and reject are both undoable',
  auditSelected: 'Selected',
  auditClearSelection: 'Clear',
  preview: 'Preview',
  supportGroup: 'Community',
  supportSponsor: 'Sponsor',
  supportLegacy: 'Legacy app',
  supportTitle: 'Support & community',
  clickToZoom: 'Click to enlarge',
  supportGroupHint: 'Scan to join the community; ask questions directly.',
  supportSponsorHint: 'If this plugin saved you time, you can buy the author a coffee. Completely optional.',
  supportLegacyTitle: 'Legacy app (dsh-desktop) is discontinued',
  supportLegacyBody: 'The author’s dsh-desktop is discontinued; the official DeepSeek Harness desktop build covers the same capabilities. If an old profile still pins the withdrawn dsh-desktop-shell@0.3.0, remove that dependency or pnpm install will fail.',
  supportReadme: 'Open README',
  supportReleases: 'Releases',
  supportFeedback: 'Report a bug',
  supportReplay: 'Replay onboarding',
  onboardTitle: '30 seconds with memory-eternal',
  onboardSub: 'After every conversation, the AI distills knowledge cards. Review first, keep the good ones.',
  onboardSkip: 'Skip',
  onboardBack: 'Back',
  onboardNext: 'Next',
  onboardStart: 'Start using',
  onboardStep0Title: 'Star the project on GitHub first',
  onboardStep0Body: 'A Star is the most direct signal to keep maintaining it; Fork it if you want to modify or self-host.',
  onboardStar: 'Star',
  onboardFork: 'Fork',
  onboardStarred: 'Starred, continue',
  onboardStarHint: 'You can always come back via ★ Star in the top bar.',
  onboardStep1Title: 'Auto-capture, no manual notes',
  onboardStep1Body: 'When a session ends, decisions, root causes and lessons become a card. Capture first, review second.',
  onboardStep2Title: 'Found a useful card? Tap 👍',
  onboardStep2Body: 'Open any card and tap 👍 useful / 👎 not useful. No search needed: the buttons are always there. It helps recall ranking.',
  onboardStep3Title: 'New support entries',
  onboardStep3Body: 'Community, sponsor, legacy app and bug report live at the bottom of the left rail. No need to dig through the README.',
  onboardTip: 'Tip: reopen this guide from Support & community.',
  navWorkspace: 'Workspace',
  navSystem: 'System',
  navSupport: 'Support',
  v5Local: 'Local',
  v5Star: 'Star on GitHub',
  runtimeTitle: 'Runtime status',
  runtimeSub: 'Vault, backups, capture and version',
  dbTitle: 'Vault',
  backupTitle: 'Backups',
  captureTitle: 'Auto capture',
  versionTitle: 'Version',
  cardsUnit: 'cards',
  links: 'links',
  todayReview: "Today's resurface",
  openArrow: 'Open →',
  reshuffle: 'Another',
  insightDecision: 'Decision',
  insightRoot: 'Root cause',
  insightLesson: 'Lesson',
  insightSummary: 'Summary',
  pinCard: 'Pin this card',
  unpinCard: 'Unpin',
  pinnedOnly: 'Pinned',

  toastApproved: 'approved',
  toastRejected: 'rejected',
  toastCardDeleted: 'deleted',
  toastRestored: 'restored',
  toastPurged: 'permanently deleted',
  toastPurgedExpired: 'expired recycle entries purged',
  toastFailed: 'Action failed',
  noSelection: 'Select the cards to act on first',
  enabledLabel: 'Enable memory core',
  vaultDirLabel: 'Vault directory (single)',
  captureCooldownMs: 'Capture cooldown (ms)',
  captureProvider: 'Distill provider (auto if empty)',
  routeAuto: 'Auto (registration order)',
  routeListFail: 'Could not load the model list ({err}) — you can type provider / model below; the desktop popup proxies this to the host, so if it still fails open the settings from DSH',
  captureFollowSession: 'Follow current session (distill with the session provider/model)',
  captureFirstOnly: 'First candidate only (stop on failure, no fallback)',
  llmTest: 'Test distill route',
  llmTestOk: '✓ Call succeeded',
  llmTestFail: '✗ Call failed',
  llmCandidates: 'candidates',
  captureModel: 'Distill model (auto if empty)',
  recallEmbedding: 'Semantic recall provider (optional)',
  sessionBudgetChars: 'Session budget (chars)',
  saving: 'Saving…',
  savePending: 'Saved to the config file; the host half is still the old build, so restart DSH to make it effective (already applied in this panel)',
  saveInvalid: 'Some field values are invalid; nothing was submitted',
  invalidField: '"{field}" must be a number between {min} and {max} (now: {value})',
  actionRunning: 'Working…',
  recycleEmptyHint: 'Recycle bin is empty: deleted cards land here first and are purged automatically after {days} days.',
  recyclePurgeAll: 'Empty recycle bin',
  fbCopyManual: 'Auto-copy was blocked by the browser — the text is below: click Select all, then Ctrl+C',
  vcLoaded: 'running (process serving this page)',
  vcResident: 'resident instance',
  vcOnDisk: 'on disk',
  vcLatest: 'npm latest',
  vcStale: 'v{disk} is installed on disk but the process serving this page still has v{loaded} loaded — click "Restart resident instance" to restart it on the new code (no DSH restart needed)',
  vcRestart: 'Restart resident instance',
  vcRestarting: 'Restarting…',
  vcRestartSent: 'Resident restart scheduled: the new process takes over in ~3-8s — refresh the page (Ctrl+F5) shortly',
  vcRestartCurrent: 'The resident instance is already up to date — no restart needed',
  vcRestartAnyway: 'Resident is already v{ver}; usually no restart needed — use this if it looks stuck',
  vcHostProcessStale: 'Disk has v{disk}, but **the process serving this page** (the DSH host) still loads v{loaded} — that code was loaded when the host started, so **restarting the resident instance does not change this page**: fully quit and reopen DSH.',
  vcRestartFixes: 'Restarts the resident instance (the process on the port) onto v{disk} (currently v{served}) without restarting DSH',
  vcRestartStart: 'Starts the resident instance on the current disk version v{disk} (no DSH restart needed)',
  vcRestartRepair: 'Re-registers it under a watchdog and keeps it alive (already v{disk}; no DSH restart needed)',
  vcRestartHostOnly: 'The resident instance is already v{disk}; this page shows v{loaded} from the DSH host — restarting the resident does not affect it, please restart DSH',
  vcRestartFail: 'Restart request failed',
  vcRestartNoRoute: 'The process serving this page is still the old build (no such endpoint): restart the desktop app / DSH and retry, or run {cmd}',
  vcHostStale: 'The "running" chip above comes from the process serving this page; the resident instance is already current — restart the desktop app / DSH to refresh that chip',
  vcResidentDownShort: 'not running',
  vcResidentDown: 'The resident instance is not running (no response on port {port}) — use the button below to bring it up on the new code; if that fails run {cmd} and share the output of dsh-memory status',
  vcResidentUnmanagedShort: 'unmanaged',
  vcResidentUnmanaged: 'The resident instance serves v{served} but has **no watchdog keeping it alive** (an orphan left by a stop or a hard kill) — use the button below to put it back under management (a fresh watchdog plus a new instance), or run {cmd}',
  vcResidentLockUnknownShort: 'management unknown',
  vcResidentReplaceBlockedShort: 'cannot replace',
  vcResidentHostManagedShort: 'host-managed',
  vcResidentReplaceBlocked: 'The resident instance **cannot be replaced** (environment limit): the watchdog lock directory is not writable ({err}; {path}) → the port will stay on v{served} **long-term**. This is not "temporarily behind": automatic replacement is refused on purpose to avoid leaving an orphan. Way out: fix that directory permissions and run {cmd}, or run dsh-memory watchdog --port 7999 in the foreground',
  vcResidentLockUnknown: 'The resident instance serves v{served}, but the **watchdog lock file cannot be written** (restricted environment: sandbox, ACLs, non-system drive) → whether it is managed cannot be determined (this is not "unmanaged"). Cause: {err} ({path}). Keep-alive usually still works; the button below can put it back under management on the new code.',
  vcPage: 'Page script',
  vcPageStale: '⚠ This page is still running an older script (page v{page} / disk v{disk}): press Ctrl+F5 to refresh. If the running version is still old, restart the desktop app / DSH as well',
  vcOutdated: 'update available',
  vcUpToDate: 'up to date',
  vcCheck: 'Check for updates',
  checking: 'Checking…',
  vcCheckFail: 'Update check failed',
  recallSummaryLen: 'Recall summary len',
  recallBody: 'Recall with body',
  secretHint: 'Credential hint (injected into every session)',
  autoWeb: 'Web server',
  autoWebMode: 'Keep-alive mode',
  webPort: 'Web port',
  webCheckIntervalMs: 'Probe interval (ms)',
  webMaxRestart: 'Max restart',
  watchdogAutoSpawn: 'Watchdog process',
  autoRestartOnDrift: 'Auto-restart resident on version drift',
  autoMcpSetup: 'Auto-mount MCP',
  saveConfig: 'Save config',
  saveFail: 'Save failed',
  savedOk: 'Saved',
  savedDirect: 'No DSH host is running here, so the change went straight into the shared config (hooks / MCP / the standalone page pick it up immediately)',
  savedApplied: 'Saved and applied (the host applied it in a request context)',
  saveQueued: 'Handed to the DSH host for sync — not confirmed applied yet',
  saveHostGuard: 'This host does not let a plugin write config from its own callback context; change the same option under DSH Settings → Memory, or edit the profile patch layer',
  saveFailHint: 'the host did not apply it — see Diagnostics under Report a bug',
  recallTool: 'recall tool',
  costControl: 'Cost control',
  costHint: 'save tokens, control LLM usage',
  distillEnabled: 'Distill cards (on=LLM compress, off=raw cards zero LLM)',
  dedupByLLM: 'Dedup feeds LLM (off=pure lexical, cheaper)',
  captureMaxTokens: 'Distill output cap (tokens)',
  captureTimeoutMs: 'Distill timeout (ms; use 120000+ for cold local models)',
  recallMinScore: 'Recall min score (higher = cheaper)',
  configNeedsDsh: 'Edit config inside DSH (this page may be read-only or partially missing)',
  installMcp: 'Install MCP',
  uninstallMcp: 'Uninstall MCP',
  uninstallConfirm: 'Confirm uninstall MCP for this agent? Claude Code/Codex will lose access to the memory vault.',
  presetConfig: 'One-click preset config',
  presetHint: 'Click to fill a plan, then hit Save',
  planApplied: 'Filled "{plan}" — hit "Save config" to apply',
  planDescA: 'Personal dev · distill 4000 · watchdog off',
  planDescB: 'Budget · no distill · ~zero cost',
  planDescC: 'Long projects · watchdog on · high quality',
  cfgSubCore: 'Capture / recall / vault dir and dedup strategy',
  cfgSubMulti: 'Per-project vaults; CLI / MCP / hooks follow the active one',
  cfgSubCost: 'Control LLM calls and recall size — this is your bill',
  cfgSubAudit: 'What must be reviewed before entering the main vault',
  cfgSubService: 'Keep-alive, watchdog and version self-heal — defaults are fine',
  cfgDirty: 'Unsaved changes',
  cfgClean: 'Synced',
  unitChars: 'chars',
  unitPerDay: 'cards / day',
  unitTokens: 'tokens',
  unitMs: 'ms',
  unitTimes: 'times',
  unitDays: 'days',
  mcpAutoHint: 'Auto-detects installed agents and their MCP configs (read-only probe)',
  mcpRefresh: 'Re-scan',
  mcpSummary: '{agents} agents · {servers} MCP servers · {mounted} mounting this plugin',
  mcpNoServers: 'No MCP configured',
  mcpDetectedOnly: 'detected only',
  planA: 'A Light',
  planB: 'B Budget',
  planC: 'C Premium',
  pluginInfo: 'Plugin info',
  organizeTitle: 'Organize',
  scanAndOrganize: 'Scan & organize',
  scanHint: 'Click "🔍 Scan & organize" to find similar/stale cards, then "⚡ One-click optimize" to run.',
  mergeNow: 'Merge',
  delete: 'Delete',
  captureAlert: 'Auto-capture failed',
  captureAlertHint: 'Open "Usage / Today" for the capture log; if the cause is an API/version mismatch, update the memory-eternal plugin.',
  captureLog: 'Auto-capture log',
  captureLogHint: 'Runs after every turn: listen → judge → write. Last 100 entries, so you can see why a card was not written.',
  captureLogEmpty: 'No entries yet. Chat one turn (> min capture chars) and come back.',
  healthTitle: 'Health',
  healthHint: 'Database / backups / capture / versions — spot anything that broke silently',
  healthDb: 'Database',
  healthDbBad: 'database is unwritable or corrupt',
  healthBackups: 'Backups',
  healthNoBackups: 'no backups yet (run dsh-memory doctor; the host also backs up daily)',
  healthBackupAge: '{n} files · newest {d} day(s) ago',
  healthBackupToday: '{n} files · newest today',
  healthCapture: 'Auto capture',
  healthNoRecords: 'no records yet (capture has not run)',
  healthCapOk: 'last capture wrote a card',
  healthCapFail: 'last capture failed',
  healthRunAlign: 'run Version alignment check to show',
  healthVersion: 'Versions',
  ledgerTitle: 'Memory ledger (last 7 days)',
  ledgerHint: 'How much recall injected and how many distillation calls ran — the first data point for the "does it save tokens?" question',
  ledgerRecalls: 'Recalls',
  ledgerInjected: 'injected',
  ledgerChars: 'chars',
  ledgerCaptures: 'Captures',
  ledgerLlmCalls: 'LLM calls',
  ledgerEstimate: 'Est. tokens',
  ledgerEstimateHint: 'rough estimate at ~2 chars per token; order of magnitude only',
  ledgerUseful: 'Recall usefulness',
  ledgerUsefulHint: 'from useful / not-useful feedback; below 60% means injection may cost more than it saves',
  ledgerFormula: 'Net benefit ≈ avoided context cost − (injected chars + distillation calls × price). The ledger only records what we spent; weigh it against the re-reads and rework you actually avoided.',
  ledgerNoData: 'No entries in the last 7 days: chat a few turns or let the agent recall once, then come back.',
  ledgerNeedRestart: 'The host is still running the old API (/ledger missing): fully quit and reopen DSH to start recording.',
  alignTitle: 'Version alignment check',
  alignRun: 'Check now',
  alignFix: 'Rewrite wiring',
  alignFixConfirm: 'Rewrite the MCP / hooks wiring? (Only the plugin\'s own keys are touched; your data and config stay as they are)',
  alignFixed: 'Wiring rewritten; if it still reports an old host process, you must fully quit and reopen DSH',
  alignFail: 'Alignment check failed',
  alignHint: 'Upgrading the plugin only replaces files on disk — the host\'s in-memory event subscriptions and stale paths inside MCP / hooks do not update themselves; this checks all of it at once',
  alignIdle: 'Hit "Check now": compare the host / resident / npm versions and look for stale paths and arguments in MCP and hooks',
  alignDisk: 'disk', alignResident: 'resident', alignHost: 'host process',
  captureLogUnavailable: 'Log is available only inside the DSH host (the standalone web page has no host runtime).',
  captureAgentCards: 'Cards auto-captured by the agent',
  noCards: 'none',
  loadMore: 'Load more',
  batchMerge: 'Smart batch merge',
  mergeAllConfirm: 'Merge similar-grouped cards into one each (keep kind), delete originals?',
  crossVault: 'All vaults',
  deleteConfirm: 'Delete this memory card? This cannot be undone.',
  deleted: 'Deleted',
  deleteFail: 'Delete failed',
  deleteSelected: 'Delete selected',
  deletedSelected: ' cards deleted',
  merge: 'Merge',
  mergeNeed: 'Select at least 2 cards',
  mergeConfirm: 'Merge the selected cards into one and delete the originals?',
  merged: 'Merged',
  mergeFail: 'Merge failed',
  mcpInstalled: '✅ {agent} MCP installed',
  mcpUninstalled: '✅ {agent} MCP uninstalled',
  mcpActionFail: '❌ {agent} MCP action failed: {error}',
  dshHostLabel: 'DeepSeek Harness (current host)',
  restartHint: 'Saved. autoWebMode/watchdogAutoSpawn take effect after restarting DSH; a resident watchdog is never stopped automatically — use dsh-memory stop / restart (#19)',
  conflictRefresh: 'Config changed elsewhere — refresh and retry',
  untitled: 'Untitled',
  tplBlank: '📄 Blank',
  tagsHint: 'Tags (comma-separated)',
  connCount: '{n} connections',
  tplDecisionTags: 'decision, plan',
  tplBugTags: 'pitfall, lesson',
  tplMeetingTags: 'meeting, minutes',
  tplWeeklyTags: 'weekly report',
  tplDecisionBody: '# Tech decision: [title]\n\n## Background\n- Problem\n\n## Candidates\n| Option | Pros | Cons |\n| --- | --- | --- |\n| A | | |\n| B | | |\n\n## Decision\nOption A, because:\n\n## Risks & follow-ups\n',
  tplBugBody: '# Pitfall: [title]\n\n## Symptom\n- What happened\n\n## Root cause\n\n## Fix\n\n## Lesson\n- How to avoid it next time',
  tplMeetingBody: '# Meeting notes: [title]\n\n**Date**:\n**Attendees**:\n\n## Topics\n1. \n\n## Conclusions\n\n## Action items\n- [ ] ',
  tplWeeklyBody: '# Weekly report [YYYY-MM-DD]\n\n## Done this week\n- \n\n## Next week\n- \n\n## Risks/blockers\n- ',
}

const KIND_IDS = ['all', 'core', 'project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake']
const KIND_COLORS = { core: '#FF7A45', project: '#3B82F6', knowledge: '#10B981', content: '#F59E0B', prompt: '#A855F7', business: '#EC4899', tool: '#06B6D4', mistake: '#EF4444', other: '#6B7280' }
// issue #41：畸形卡（tags 是字符串 / undefined）曾让整页黑屏（React 根组件挂载失败）——
// 渲染层一律走这个兜底，坏数据最多少显示几个标签，不能把整棵树带走。
const tagsOf = (c) => (Array.isArray(c && c.tags) ? c.tags : [])
const KIND_EMOJI = { core: '⭐', project: '📁', knowledge: '📚', content: '📝', prompt: '💬', business: '💼', tool: '🔧', mistake: '⚠️', other: '📎' }
const KIND_LABELS = { core: 'kindCore', project: 'kindProject', knowledge: 'kindKnowledge', content: 'kindContent', prompt: 'kindPrompt', business: 'kindBusiness', tool: 'kindTool', mistake: 'kindMistake', other: 'kindKnowledge' }
// DSH 宿主自动沉淀卡的署名（与 index.js 的 DSH_AGENT 保持一致）。
// 归一化：session:<uuid> / agent / unknown / 空 → deepseek-harness；claude-code → claude；其余取冒号前 token。
const DSH_AGENT = 'deepseek-harness'
const normAgent = (sub) => {
  const s = String(sub || '')
  const l = s.toLowerCase()
  if (!s || s === 'agent' || s === 'unknown' || s.startsWith('session:') || l.startsWith('claude-code')) {
    return l.startsWith('claude-code') ? 'claude' : DSH_AGENT
  }
  if (l === 'deepseek harness') return DSH_AGENT
  return s.split(':')[0] || DSH_AGENT
}
// 智能体筛选候选 = 恒含 DSH + 已配置外部智能体 + 卡上出现过的署名。
const KNOWN_AGENTS = [DSH_AGENT, 'claude', 'codex', 'cursor', 'codex-desktop']
const agentOptions = (existing = []) => [...new Set([...KNOWN_AGENTS, ...(existing || []).map(normAgent)])]

// 自动沉淀日志的动作标记（与 index.js 的 logCapture(action) 一一对应）。
const CAPTURE_ACTIONS = {
  boot: ['🚀', '#8b5cf6'],
  listen: ['👂', 'inherit'],
  created: ['✅', '#10b981'],
  appended: ['➕', '#3b82f6'],
  skip: ['⏭', '#f59e0b'],
  warn: ['⚠️', '#f59e0b'],
  fail: ['❌', '#ef4444'],
}

const CSS = `
.memory-eternal-root { font-family: inherit; color: var(--dsw-alias-label-primary, #1f2937); }
.mc-card { background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; padding: 14px 16px; }
.mc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 14px; }
.mc-stat { text-align: center; }
.mc-stat b { display: block; font-size: 22px; line-height: 1.2; }
.mc-stat span { font-size: 12px; opacity: 0.65; }
.mc-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.mc-toolbar input[type=text] { flex: 1; min-width: 180px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-base, #f9fafb); color: inherit; font-size: 13px; }
.mc-btn { border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: transparent; color: inherit; border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.mc-btn.me-on { background: var(--dsw-alias-accent, #2563eb) !important; color: #fff !important; border-color: transparent !important; }
.mc-new { display: inline-block; margin-left: 7px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; line-height: 16px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #f97316, #ef4444); vertical-align: middle; }
.mc-hl { background: rgba(245,158,11,0.35); color: inherit; border-radius: 2px; padding: 0 1px; }
.mc-btn:hover { opacity: 0.85; }
.mc-btn:active { transform: scale(0.97); }
.mc-btn:disabled { opacity: .5; cursor: not-allowed; }
/* ---- 记忆配置页（专业表单布局） ---- */
.mc-cfg { width: 100%; }
.mc-cfg-sec { margin-bottom: 12px; padding: 16px 18px !important; }
.mc-cfg-sec-head { display: flex; align-items: flex-start; gap: 11px; margin-bottom: 14px; }
.mc-cfg-sec-ico { flex: none; width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; background: rgba(127,127,127,.12); }
.mc-cfg-sec-title { font-size: 13.5px; font-weight: 650; letter-spacing: .2px; line-height: 1.35; }
.mc-cfg-sec-sub { font-size: 11.5px; opacity: .58; margin-top: 3px; line-height: 1.55; }
.mc-cfg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 13px 16px; }
.mc-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; font-size: 12px; }
.mc-field-label { font-size: 11.5px; opacity: .62; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; }
.mc-field-hint { font-size: 10.5px; opacity: .45; line-height: 1.4; }
.mc-field input, .mc-field select { width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 12px; transition: border-color .15s, box-shadow .15s; }
.mc-field input:focus, .mc-field select:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #3b82f6); box-shadow: 0 0 0 3px rgba(59,130,246,.14); }
.mc-field input:disabled, .mc-field select:disabled { opacity: .55; cursor: not-allowed; }
.mc-switch { display: flex; align-items: flex-start; gap: 9px; cursor: pointer; font-size: 12px; line-height: 1.5; min-width: 0; }
.mc-switch input { appearance: none; -webkit-appearance: none; flex: none; width: 34px; height: 20px; margin: 1px 0 0; border-radius: 999px; background: var(--dsw-alias-border-l2, #cbd5e1); position: relative; cursor: pointer; transition: background .16s; }
.mc-switch input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.28); transition: transform .16s; }
.mc-switch input:checked { background: var(--dsw-alias-brand-primary, #3b82f6); }
.mc-switch input:checked::after { transform: translateX(14px); }
.mc-switch span { padding-top: 1px; white-space: normal; overflow-wrap: anywhere; }
.mc-plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.mc-plan { text-align: left; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: transparent; border-radius: 10px; padding: 11px 13px; cursor: pointer; color: inherit; font: inherit; display: flex; flex-direction: column; gap: 4px; transition: border-color .16s, transform .16s, box-shadow .16s; }
.mc-plan:hover { border-color: var(--dsw-alias-brand-primary, #3b82f6); transform: translateY(-1px); }
.mc-plan.on { border-color: var(--dsw-alias-brand-primary, #3b82f6); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary, #3b82f6) inset, 0 6px 18px rgba(59,130,246,.14); background: rgba(59,130,246,.06); }
.mc-plan b { font-size: 12.5px; font-weight: 650; }
.mc-plan span { font-size: 10.5px; opacity: .56; line-height: 1.5; }
.mc-plan:disabled { opacity: .55; cursor: not-allowed; }
.mc-cfg-actions { position: sticky; bottom: 0; z-index: 20; display: flex; align-items: center; gap: 10px; padding: 11px 4px; margin-top: 2px; background: linear-gradient(to top, var(--dsw-alias-bg-layer-1, #fff) 72%, rgba(0,0,0,0)); }
.mc-cfg-dirty { font-size: 11.5px; color: #f59e0b; display: inline-flex; align-items: center; gap: 6px; }
.mc-cfg-dirty::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; }
.mc-cfg-clean { font-size: 11.5px; opacity: .45; }
.mc-cfg-spacer { flex: 1; }
.mc-mcp-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-top: 1px solid rgba(127,127,127,.12); }
.mc-mcp-row:first-child { border-top: 0; padding-top: 2px; }
.mc-mcp-main { flex: 1; min-width: 0; }
.mc-mcp-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; line-height: 1.5; }
.mc-mcp-badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(127,127,127,.14); opacity: .85; white-space: nowrap; }
.mc-mcp-servers { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.mc-mcp-servers code { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); opacity: .85; }
.mc-mcp-servers code.on { border-color: rgba(16,185,129,.55); background: rgba(16,185,129,.12); opacity: 1; }
.mc-mcp-path { font-size: 10.5px; opacity: .38; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-mcp-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.mc-mcp-summary { font-size: 11.5px; opacity: .62; margin-bottom: 6px; }
.me-v5 .mc-cfg-sec-ico { background: rgba(255,122,69,.14); }
.me-v5 .mc-plan:hover { border-color: rgba(255,122,69,.6); }
.me-v5 .mc-plan.on { border-color: #ff7a45; box-shadow: 0 0 0 1px #ff7a45 inset, 0 6px 18px rgba(255,122,69,.16); background: rgba(255,122,69,.1); }
.me-v5 .mc-cfg-actions { background: linear-gradient(to top, #21252c 72%, rgba(0,0,0,0)); }
.mc-tabs { display: inline-flex; gap: 4px; padding: 3px; background: var(--dsw-alias-bg-base, #f3f4f6); border-radius: 999px; }
.mc-tab { border: 0; background: transparent; color: inherit; border-radius: 999px; padding: 5px 14px; font-size: 12px; cursor: pointer; opacity: 0.7; }
.mc-viewbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.mc-rail { width: 54px; flex: none; display: flex; flex-direction: column; gap: 8px; align-items: stretch; padding-right: 12px; border-right: 1px solid var(--dsw-alias-border-l1, #e5e7eb); transition: width 0.18s ease; overflow-y: auto; }
.mc-rail.open { width: 150px; }
.mc-rail-collapse { align-self: flex-start; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-base, #f3f4f6); color: var(--dsw-alias-label-secondary, #6b7280); border-radius: 8px; width: 26px; height: 26px; line-height: 1; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease; }
.mc-rail-collapse:hover { color: var(--dsw-alias-label-primary, #111); border-color: var(--dsw-alias-brand-primary, #3b82f6); }
.mc-railbtn { width: 100%; height: 44px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: var(--dsw-alias-bg-base, #f3f4f6); color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 0 10px; font-size: 13px; font-weight: 650; transition: all 0.16s ease; }
.mc-railbtn .mc-rail-ico { font-size: 18px; flex: none; }
.mc-railbtn .mc-rail-label { white-space: nowrap; overflow: hidden; }
.mc-rail:not(.open) .mc-railbtn { justify-content: center; padding: 0; }
.mc-rail:not(.open) .mc-railbtn .mc-rail-label, .mc-rail:not(.open) .mc-rail-collapse { position: relative; }
.mc-railbtn:hover { border-color: var(--dsw-alias-brand-primary, #3b82f6); color: var(--dsw-alias-label-primary, #111); background: var(--dsw-alias-bg-layer-1, #fff); }
.mc-railbtn.active { background: #3b82f6; border-color: transparent; color: #fff; box-shadow: 0 6px 18px rgba(59,130,246,0.35); }
.mc-main { flex: 1; min-width: 0; overflow: auto; display: flex; flex-direction: column; }
.mc-tab.active { background: var(--dsw-alias-bg-layer-1, #fff); opacity: 1; font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
.mc-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.mc-chip { border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: transparent; color: inherit; border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; opacity: 0.7; }
.mc-chip.active { opacity: 1; font-weight: 600; border-color: currentColor; }
.mc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.mc-cardrow { cursor: pointer; transition: border-color 0.15s, transform 0.15s; display: flex; flex-direction: column; gap: 6px; min-height: 110px; }
.mc-snippet { font-size: 11.5px; line-height: 1.5; opacity: .72; margin: 2px 0 0; }
.mc-tag-click { cursor: pointer; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; padding: 0 4px; border-radius: 6px; }
.mc-tag-click:hover { border-color: var(--dsw-alias-brand-primary, #6366f1); opacity: 1; }
.mc-cardrow:hover { border-color: var(--dsw-alias-brand-primary, #6366f1); transform: translateY(-1px); box-shadow: 0 8px 22px rgba(0,0,0,0.08); }
.mc-cardrow h4 { margin: 0; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; word-break: break-word; }
.mc-cardrow p { margin: 0; font-size: 12px; opacity: 0.7; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.mc-cardrow footer { margin-top: auto; display: flex; justify-content: space-between; align-items: center; font-size: 11px; opacity: 0.55; }
.mc-card-del { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 5px; border-radius: 5px; opacity: 0.45; }
.mc-cardrow:hover .mc-card-del { opacity: 0.9; }
.mc-card-del:hover { color: #ef4444; background: rgba(239,68,68,0.12); }
/* 知识库滚动条：清晰可见 */
.memory-eternal-root * { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-label-secondary, #94a3b8) transparent; }
.memory-eternal-root ::-webkit-scrollbar { width: 10px; height: 10px; }
.memory-eternal-root ::-webkit-scrollbar-thumb { background: var(--dsw-alias-label-secondary, #94a3b8); border-radius: 6px; }
.memory-eternal-root ::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-label-primary, #64748b); }
.memory-eternal-root ::-webkit-scrollbar-track { background: rgba(127,127,127,0.08); }
.mc-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.mc-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-border-l2, #d1d5db); opacity: 1; color: var(--dsw-alias-label-primary, #1f2937); }
.mc-status { display: inline-block; margin-left: 7px; padding: 1px 7px; border-radius: 999px; font-size: 10px; line-height: 16px; font-weight: 600; color: #fff; vertical-align: middle; }
.mc-kind { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.mc-empty { text-align: center; padding: 40px 10px; opacity: 0.6; font-size: 13px; }
/* ---- 审核中心：左侧类型栏 + 批量操作 ---- */
.me-audit { display: block; container-type: inline-size; }
.me-audit-types-top { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; width: 100%; padding-bottom: 8px; border-bottom: 1px solid rgba(127,127,127,.12); }
.me-audit-types-label { padding: 0 5px 0 2px; font-size: 9px; letter-spacing: .14em; opacity: .5; font-weight: 600; text-transform: uppercase; }
.me-audit-types-top .me-audit-kind { width: auto; padding: 3px 7px; gap: 5px; font-size: 10.5px; border-radius: 6px; }
.me-audit-types-top .me-audit-kind-name { flex: none; }
.me-audit-types-top .me-audit-kind-count { min-width: 16px; line-height: 14px; font-size: 9px; }
.me-audit-filter-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%; }
.me-audit-filtercard { min-width: 0; }
.me-audit-kinds { position: sticky; top: 0; width: 150px; flex: 0 0 150px; padding: 10px 8px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }
.me-audit-kinds-title { padding: 0 6px 7px; font-size: 10px; letter-spacing: .12em; opacity: .55; font-weight: 600; }
.me-audit-kind { display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 7px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.me-audit-kind:hover { background: rgba(127,127,127,.08); }
.me-audit-kind.active { border-color: rgba(99,102,241,.35); background: rgba(99,102,241,.13); }
.me-audit-kind-dot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.me-audit-kind-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-audit-kind-count { min-width: 18px; padding: 0 5px; border-radius: 5px; background: rgba(127,127,127,.12); font-size: 10px; line-height: 16px; text-align: center; opacity: .8; font-variant-numeric: tabular-nums; }
.me-audit-kind-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid; border-radius: 999px; font-size: 10px; line-height: 17px; white-space: nowrap; flex: none; }
.me-audit-main { flex: 1; min-width: 0; display: flex; gap: 10px; align-items: flex-start; }
.me-audit-queue { flex: 1; min-width: 0; }
.me-audit-preview { flex: 0 0 500px; width: 500px; position: sticky; top: 0; display: flex; flex-direction: column; max-height: calc(100vh - 130px); overflow: hidden; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }
.me-audit-preview-head { flex: none; padding: 13px 14px 10px; border-bottom: 1px solid rgba(127,127,127,.12); }
.me-audit-preview-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.me-audit-preview-head h3 { margin: 9px 0 0; font-size: 15px; line-height: 1.45; color: inherit; overflow-wrap: anywhere; }
.me-audit-preview-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 8px; font-size: 10px; color: var(--dsw-alias-label-secondary, #6b7280); }
.me-audit-preview-reason { color: #f59e0b; }
.me-audit-preview-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px 16px; }
.me-audit-preview-body .md-doc { font-size: 12px; }
.me-audit-preview-body .md-doc table, .me-audit-preview-body .md-doc pre { display: block; max-width: 100%; overflow-x: auto; }
.me-audit-preview-summary { margin: 0; font-size: 12px; line-height: 1.75; opacity: .72; }
.me-audit-preview-empty { padding: 24px 12px; text-align: center; font-size: 12px; opacity: .55; }
.me-audit-preview-actions { flex: none; display: flex; gap: 7px; padding: 10px 14px; border-top: 1px solid rgba(127,127,127,.12); }
.me-audit-row-actions { display: flex; align-items: center; gap: 4px; flex: none; margin-left: auto; }
.me-audit-row { border-bottom: 1px solid rgba(127,127,127,.12); }
.me-audit-row:last-child { border-bottom: 0; }
.me-audit-row:hover { background: rgba(127,127,127,.035); }\n.me-audit-row.active { background: rgba(255,122,69,.055); box-shadow: inset 2px 0 0 #ff7a45; }\n.me-audit-row-main { cursor: pointer; }
.me-audit-row-main { display: flex; align-items: flex-start; gap: 9px; padding: 10px 8px; min-width: 0; }
.me-audit-row-main > input { margin-top: 7px; flex: none; }
.me-audit-row-expand { padding: 2px 5px !important; flex: none; margin-top: 4px; opacity: .55; }
.me-audit-row-tile { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid; border-radius: 8px; font-size: 14px; flex: none; margin-top: 1px; }
.me-audit-row-copy { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.me-audit-row-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.me-audit-row-kind { font-size: 10px; color: #b0b7c1; }
.me-audit-row-state { padding: 0 5px; border-radius: 4px; font-size: 9px; line-height: 15px; background: rgba(245,158,11,.1); color: #fbbf24; }
.me-audit-row-state.rejected { background: rgba(248,113,113,.1); color: #f87171; }
.me-audit-row-time { margin-left: auto; font-size: 9.5px; color: #99a1ac; white-space: nowrap; }
.me-audit-row-title { padding: 0; border: 0; background: transparent; text-align: left; color: #f3f5f8; font-size: 13px; line-height: 1.5; font-weight: 600; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.me-audit-row-title:hover { color: #ff9a72; }
.me-audit-row-reason { margin: 0; font-size: 11px; line-height: 1.55; color: #aeb5bf; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.me-audit-row-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 9.5px; color: #8f98a4; }
.me-audit-row-meta span { white-space: nowrap; }
.me-audit-row .me-audit-row-actions { align-items: center; padding-top: 3px; }
@container (max-width: 1120px) { .me-audit-main { flex-direction: row; } .me-audit-preview { display: flex; flex: 0 0 460px; width: 460px; max-height: calc(100vh - 130px); position: sticky; top: 0; } }
@container (max-width: 950px) {
  .me-audit-kinds { position: static; flex: 0 0 100%; width: 100%; display: flex; flex-wrap: wrap; gap: 3px; padding: 8px; }
  .me-audit-kinds-title { width: 100%; padding-bottom: 4px; }
  .me-audit-kind { width: auto; }
  .me-audit-row-sev, .me-audit-row-reason { display: none; }
}
@container (max-width: 900px) {
  .mc-audit-batchcard { display: grid !important; grid-template-columns: 1fr 1fr; gap: 6px !important; }
  .mc-audit-batchcard > label, .mc-audit-batchcard > span, .mc-audit-batchcard > b { grid-column: 1 / -1; }
  .mc-audit-batchcard > .mc-btn { width: 100%; }
  .mc-audit-batchcard > div[style*="flex: 1"] { display: none; }
}
@media (max-width: 1100px) {
  .me-v5 .mc-rail, .me-v5 .mc-rail.open { width: 68px; padding: 10px 8px; }
  .me-v5 .mc-v5-railbrand, .me-v5 .mc-rail-sec, .me-v5 .mc-rail-label { display: none; }
  .me-v5 .mc-railbtn { justify-content: center; padding: 0; }
}
@container (max-width: 1100px) {
  .me-v5 .mc-rail, .me-v5 .mc-rail.open { width: 68px; padding: 10px 8px; }
  .me-v5 .mc-v5-railbrand, .me-v5 .mc-rail-sec, .me-v5 .mc-rail-label { display: none; }
  .me-v5 .mc-railbtn { justify-content: center; padding: 0; }
}
@media (max-width: 1180px) { .me-audit-main { flex-direction: row; } .me-audit-preview { display: flex; flex: 0 0 460px; width: 460px; max-height: calc(100vh - 130px); position: sticky; top: 0; } }
@media (max-width: 900px) { .me-audit-main { gap: 8px; } .me-audit-preview { flex-basis: 360px; width: 360px; } }
.me-audit-bulk { position: sticky; bottom: 0; z-index: 6; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 -8px 24px rgba(0,0,0,.12); }
/* ---- 支持与交流 / 首次引导 ---- */
.me-support { max-width: 720px; }
.me-support-tabs { display: flex; gap: 6px; padding: 10px 18px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb); }
.me-support-tab { border: 0; border-bottom: 2px solid transparent; background: transparent; color: inherit; opacity: .6; font-size: 12px; padding: 7px 9px; cursor: pointer; }
.me-support-tab.active { opacity: 1; border-bottom-color: var(--dsw-alias-brand-primary, #6366f1); font-weight: 600; }
.me-support-body { padding: 16px 18px; overflow: auto; }
.me-support-qr { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.me-support-qr figure { margin: 0; }
.me-support-qr img { width: 190px; max-width: 46vw; display: block; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; background: #fff; padding: 6px; cursor: zoom-in; }
.me-lightbox { position: fixed; inset: 0; z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 34px; background: rgba(0,0,0,.84); backdrop-filter: blur(8px); WebkitBackdropFilter: blur(8px); }
.me-lightbox img { max-width: 90vw; max-height: 88vh; border-radius: 10px; background: #fff; padding: 7px; box-shadow: 0 30px 90px rgba(0,0,0,.65); cursor: default; }
.me-lightbox-close { position: absolute; right: 22px; top: 18px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(255,255,255,.12); color: #fff; font-size: 16px; }
.me-lightbox-close:hover { background: rgba(255,255,255,.22); }
.me-support-qr figcaption { margin-top: 6px; font-size: 11px; opacity: .6; text-align: center; }
.me-support-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.me-support-note { margin: 0 0 10px; font-size: 11.5px; line-height: 1.75; opacity: .72; }
.me-support-link { color: var(--dsw-alias-brand-primary, #6366f1); font-size: 11.5px; }
.me-guide { max-width: 620px; }
.me-guide-head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 10px; }
.me-guide-head b { font-size: 15px; }
.me-guide-head .spacer { flex: 1; }
.me-guide-dots { display: flex; gap: 5px; padding: 0 20px 4px; }
.me-guide-dot { width: 16px; height: 3px; border-radius: 2px; background: rgba(127,127,127,.22); }
.me-guide-dot.on { background: var(--dsw-alias-brand-primary, #6366f1); }
.me-guide-body { padding: 12px 20px 6px; }
.me-guide-body h3 { margin: 0 0 8px; font-size: 16px; }
.me-guide-body p { margin: 0; font-size: 12.5px; line-height: 1.8; opacity: .75; }
.me-guide-github { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
.me-guide-github .mc-btn { text-decoration: none; }
.me-guide-github-hint { flex-basis: 100%; font-size: 10.5px; color: #99a1ac; }
.me-guide-like { display: inline-flex; align-items: center; gap: 8px; margin-top: 14px; padding: 9px 16px; border: 1px solid rgba(16,185,129,.35); border-radius: 9px; background: rgba(16,185,129,.10); font-size: 15px; font-weight: 600; animation: me-guide-pulse 1.8s ease-in-out infinite; }
.me-guide-thumb { font-size: 26px; line-height: 1; }
@keyframes me-guide-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); } 50% { box-shadow: 0 0 0 7px rgba(16,185,129,.12); } }
.me-guide-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.me-guide-chips span { padding: 4px 9px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 7px; font-size: 11px; opacity: .78; }
.me-guide-actions { display: flex; align-items: center; gap: 8px; padding: 14px 20px 18px; }
.me-guide-actions .spacer { flex: 1; }
.me-guide-tip { font-size: 10px; opacity: .5; }
@media (max-width: 720px) {
  .mc-rail, .mc-rail.open { width: 54px; padding-right: 8px; }
  .mc-rail .mc-rail-label { display: none; }
  .mc-rail .mc-railbtn { justify-content: center; padding-left: 0; padding-right: 0; }
  .mc-rail .mc-rail-collapse { display: none; }
  .me-guide-head span { display: none; }
  .me-guide-actions { flex-wrap: wrap; }
  .me-guide-tip { display: none; }
}
@media (max-width: 760px) {
  .me-audit { flex-direction: column; }
  .me-audit-kinds { position: static; width: 100%; flex: none; display: flex; flex-wrap: wrap; gap: 3px; padding: 8px; }
  .me-audit-kinds-title { width: 100%; padding-bottom: 4px; }
  .me-audit-kind { width: auto; }
}
.mc-flag { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); margin-left: 6px; }
/* 侧栏按钮上的计数徽标（审核中心 = 隔离区待审数，回收中心 = 回收站数） */
.mc-dot { position: absolute; top: 2px; right: 2px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; background: #ef4444; color: #fff; font-size: 9.5px; line-height: 15px; font-weight: 700; text-align: center; box-shadow: 0 0 0 2px var(--dsw-alias-bg-base, rgba(0,0,0,.35)); }
.mc-railbtn { position: relative; }

/* ---- sidebar footer button ---- */
/* 让「记忆」按钮独占一行。注意：槽位宿主有两种形态 ——
   ① 壳自己的横向行容器（.footerActions），这里要 flex-wrap + width:100% 才能让入口独占一行；
   ② 被别的插件（dsh-diff-approval / dsh-footer-order 等）改成 flex-direction:column 的
      div[data-slot="sidebar.footer.action"]。纵向容器里 wrap 的语义是「换列」，
      而 flex-basis:100% 指的是「高度 100%」——两者叠加会把按钮挤进右侧溢出列，
      最终裁切到只剩右边缘一条缝（issue #2）。所以这两条只用在 ①，② 只给宽度。 */
[class*="footerActions"]:has(.me-footer), :has(> .me-footer) { width: 100%; }
[class*="footerActions"]:has(.me-footer) { flex-wrap: wrap; }
.me-footer { width: 100%; flex: 0 0 auto; min-width: 0; }
.me-footer-btn { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14)); background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04)); color: var(--dsw-alias-label-secondary, #6b7280); font: inherit; font-size: 13.5px; line-height: 18px; border-radius: 8px; cursor: pointer; text-align: left; }
.me-footer-btn:hover { background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-primary, #111); }
.me-footer-btn:active { transform: translateY(0.5px); }
.me-footer-ico { display: inline-flex; flex: none; width: 18px; height: 18px; align-items: center; justify-content: center; }
.me-footer-ico svg { width: 18px; height: 18px; }
.me-footer-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.me-footer.rail .me-footer-btn { justify-content: center; padding: 7px 0; }
.me-footer.rail .me-footer-label { display: none; }

/* ---- full library modal ---- */
.me-overlay-top { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,0.72); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 28px; }
.me-modal { width: min(1380px, 98vw); height: min(98vh, 1080px); display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #1e232c); color: var(--dsw-alias-label-primary, #e5e7eb); border: 1px solid var(--dsw-alias-border-l1, #2c333c); border-radius: 18px; box-shadow: 0 34px 90px rgba(0,0,0,0.6); overflow: hidden; animation: me-pop 0.22s cubic-bezier(0.2,0.8,0.2,1); }
/* 弹窗必须永远装得进遮罩的 28px×2 内边距。98vh 的弹窗 + 56px 内边距在多数窗口高度下会溢出，
   flex 居中把顶边顶到可视区外/顶进桌面壳的 caption —— 右上角控制条压到原生窗口按钮上，
   点击被系统接管：用户反馈的「右上角缩小/关闭点不动」就是这个。夹死高度 = 居中恒等于顶对齐。 */
.me-overlay-top .me-modal:not(.me-modal-full) { height: min(calc(100vh - 56px), 1080px); max-height: calc(100vh - 56px); }
@keyframes me-pop { from { opacity: 0; transform: translateY(12px) scale(0.985); } }
/* ---- 统一「加载中」提示（进度条 + 文案）------------------------------------
   用户群反馈：点开知识星图/记忆库时先是白屏，不知道是在加载还是坏了；要「进度条」。
   现在所有加载态共用一个 .me-progress：
     - 网络/首屏阶段 → 不确定进度条（左右流动，表示"在动"）；
     - 布局阶段（知道还剩多少 tick）→ 真百分比（is-determinate + width）。
   进度条纯 CSS 动画，不依赖 JS 定时器，也不会因主线程忙而停住。 */
.me-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px 10px; opacity: .85; font-size: 13px; }
.me-loading-text { opacity: .82; letter-spacing: .01em; }
.me-progress { position: relative; width: min(280px, 72vw); height: 5px; border-radius: 999px; overflow: hidden; background: rgba(127,127,127,.22); }
.me-progress-fill { position: absolute; top: 0; bottom: 0; left: 0; width: 38%; border-radius: 999px; background: var(--dsw-alias-brand-primary, #3b82f6); animation: me-prog-slide 1.15s ease-in-out infinite; }
.me-progress.is-determinate .me-progress-fill { animation: none; transition: width .18s linear; }
@keyframes me-prog-slide { 0% { transform: translateX(-105%); } 100% { transform: translateX(270%); } }
.me-progress-sm { width: 92px; height: 4px; }
@media (prefers-reduced-motion: reduce) { .me-progress-fill { animation-duration: 2.6s; } }
/* iframe 首帧之前的兜底提示：iframe 自身背景设为透明，加载完成由 onLoad 撤掉这层 */
.me-frame-boot { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: var(--dsw-alias-bg-base, #111418); color: var(--dsw-alias-label-secondary, #9aa3af); font-size: 13px; pointer-events: none; }
.me-modal-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb); }
.me-modal-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.me-modal-title h2 { margin: 0; font-size: 17px; font-weight: 700; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.me-modal-title span { font-size: 12px; opacity: 0.55; white-space: nowrap; flex: 0 0 auto; }
.me-modal-title .me-wicon { width: 26px; height: 26px; flex: none; }
.me-modal-title .me-wicon svg, .me-modal-title .me-wicon img { display: block; width: 100%; height: 100%; object-fit: contain; }
.me-modal-head .spacer { flex: 1; }
.me-modal-close { border: 0; background: transparent; color: inherit; border-radius: 8px; width: 30px; height: 30px; line-height: 1; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: .55; transition: background .15s ease, color .15s ease, opacity .15s ease; }
.me-modal-close svg { width: 15px; height: 15px; }
.me-modal-close:hover { background: rgba(255,122,69,.12); color: #ff9a72; opacity: 1; }
.me-modal-close:active { background: rgba(255,122,69,.18); }
/* ---- 弹窗右上角窗口控制条（参考桌面客户端标题栏：扁平、细线、悬停才出底、关闭悬停变红）----
   格子高度 = iframe 顶栏行高（54px，窄屏 50/46）：图标因此与「本地运行 / 版本 / Star / ?」同一基线；
   宽度 46px，两颗正好落在 iframe 顶栏预留的 108px 安全区（窄屏 96px）里，贴死右上圆角。
   图标走内联 SVG 而不是 ⤢/× 字符 —— 不依赖系统字体，线宽与系统 caption 一致。 */
.me-wctl { position: absolute; top: 0; right: 0; z-index: 30; display: flex; align-items: stretch; }
.me-wctl-btn { width: 46px; height: 54px; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--dsw-alias-label-secondary, #9aa3af); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .12s ease, color .12s ease; }
.me-wctl-btn svg { width: 13px; height: 13px; display: block; }
.me-wctl-btn:last-child { border-top-right-radius: 17px; }
.me-wctl-btn:hover { background: rgba(127,127,127,.16); color: var(--dsw-alias-label-primary, #e9ecf1); }
.me-wctl-btn:active { background: rgba(127,127,127,.26); }
.me-wctl-btn:focus-visible { outline: 2px solid rgba(255,122,69,.7); outline-offset: -2px; }
.me-wctl-close:hover { background: #e81123; color: #fff; }
.me-wctl-close:active { background: #c50f1f; }
/* 与 iframe 内 .mc-v5-top 的高度断点对齐（iframe 宽 = 窗口宽 − 56px 左右）：
   ≤816 窗口 → iframe ≤760 → 顶栏 50px；≤776 窗口 → iframe ≤720 → 顶栏 46px。 */
@media (max-width: 816px) { .me-wctl-btn { height: 50px; } }
@media (max-width: 776px) { .me-wctl-btn { width: 44px; height: 46px; } }
.me-modal-body { flex: 1; padding: 18px 20px; overflow: hidden; display: flex; }
.me-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.66); z-index: 2147483001; display: flex; align-items: center; justify-content: center; padding: 24px; }
.me-dialog { background: var(--dsw-alias-bg-layer-1, #1e232c); color: var(--dsw-alias-label-primary, #e5e7eb); border-radius: 14px; max-width: 760px; width: 100%; max-height: 84vh; display: flex; flex-direction: column; box-sizing: border-box; box-shadow: 0 24px 60px rgba(0,0,0,0.5); border: 1px solid var(--dsw-alias-border-l1, #2c333c); }
.me-reader-dialog { max-width: 1180px; }
.me-reader-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 260px; }
.me-reader-main { margin: 0 auto; }
.me-reader-callout { margin: 0 0 18px; padding: 11px 13px; border-left: 3px solid var(--dsw-alias-brand-primary, #ff7a45); border-radius: 0 8px 8px 0; background: linear-gradient(90deg, rgba(255,122,69,.09), rgba(255,122,69,.02)); }
.me-reader-callout-k { display: block; margin-bottom: 3px; color: #ff9a72; font-size: 9px; font-weight: 650; letter-spacing: .08em; }
.me-reader-callout p { margin: 0; color: #c7ccd4; font-size: 12px; line-height: 1.75; }
.me-reader-side { min-height: 0; overflow: auto; padding: 16px 16px 26px; border-left: 1px solid var(--dsw-alias-border-l1, #2c333c); background: rgba(127,127,127,.025); }
.me-reader-side .side-label { margin: 16px 0 6px; font-size: 9px; letter-spacing: .13em; text-transform: uppercase; font-weight: 650; opacity: .48; }
.me-reader-side .side-label:first-child { margin-top: 0; }
.me-reader-side-val { font-size: 11px; line-height: 1.6; opacity: .72; overflow-wrap: anywhere; }
.me-reader-side-val.mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; }
.me-reader-toc { display: flex; flex-direction: column; gap: 2px; }
.me-reader-toc button { display: flex; gap: 7px; text-align: left; padding: 4px 5px; border: 0; background: transparent; border-radius: 5px; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #9aa3af); }
.me-reader-toc button:hover { background: rgba(127,127,127,.09); color: var(--dsw-alias-label-primary, #e9ecf1); }
.me-reader-toc button.lv2 { padding-left: 13px; }
.me-reader-toc button.lv3 { padding-left: 22px; }
.me-reader-toc button span { flex: none; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 8.5px; opacity: .45; padding-top: 1px; }
.me-reader-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.me-reader-tags .mc-chip { font-size: 9.5px; padding: 2px 7px; }
.me-reader-related { display: flex; flex-direction: column; gap: 4px; }
.me-reader-related button { display: flex; gap: 7px; align-items: flex-start; text-align: left; padding: 6px 7px; border: 1px solid var(--dsw-alias-border-l1, #2c333c); border-radius: 7px; background: transparent; font-size: 10.5px; line-height: 1.45; color: var(--dsw-alias-label-primary, #e9ecf1); }
.me-reader-related button:hover { border-color: var(--dsw-alias-brand-primary, #ff7a45); }
.me-reader-related button b { font-weight: 500; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.me-reader-related button span { flex: none; }
.md-h { scroll-margin-top: 14px; }
@media (max-width: 860px) {
  .me-reader-dialog { max-width: 760px; }
  .me-reader-body { grid-template-columns: 1fr; }
  .me-reader-side { display: none; }
}
.me-dialog-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb); }
.me-dialog-head h3 { margin: 0; font-size: 15px; }
/* 标题过长时不许挤压按钮（用户反馈，见图 1/图 2）：
   ① h3 必须能收缩（min-width:0）并单行省略，否则长标题会把按钮顶出可视区；
   ② 按钮组：按钮自身 nowrap（不许压成竖排「收/起」），但**组内允许换行** ——
      阅读器最多有 8 个按钮（复制正文/路径、宽度、反馈×2、收起、删除、关闭），
      在 max-width:760px 的对话框里 nowrap 会横向溢出 → 出现横向滚动条（用户反馈的「滚动条异常」）；
   ③ 头部允许换行：极窄时按钮整体掉到第二行，仍然一个个可点，而不是被压扁。 */
.me-dialog-head { flex-wrap: wrap; gap: 8px 12px; }
.me-dialog-head h3 { min-width: 0; flex: 1 1 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-dialog-head .me-head-actions { display: flex; flex-wrap: wrap; gap: 8px; flex: 0 1 auto; margin-left: auto; align-items: center; justify-content: flex-end; }
.me-dialog-head .me-head-actions .mc-btn { flex: 0 0 auto; white-space: nowrap; }
/* 读卡进度：2px 细条贴在头部下沿，随正文滚动推进（读长卡时知道还剩多少） */
.me-read-progress { position: relative; height: 2px; margin-top: -1px; background: transparent; }
.me-read-progress > i { display: block; height: 100%; width: 0; background: var(--dsw-alias-brand-primary, #6366f1); transition: width .08s linear; }
.me-dialog-body { padding: 14px 18px; overflow: auto; overflow-x: hidden; box-sizing: border-box; font-size: 13.5px; line-height: 1.78; white-space: normal; word-break: break-word; position: relative; }
.me-dialog-body h3 { font-size: 15px; margin: 10px 0 6px; color: var(--dsw-alias-label-primary, #111); }
/* 表单控件：width:100% + padding/border 在 content-box 下会横向溢出（反馈弹窗实测 +22px → 横向滚动条） */
.me-overlay input, .me-overlay textarea, .me-overlay select { box-sizing: border-box; max-width: 100%; }
.me-dialog-body h4 { font-size: 13px; margin: 8px 0 4px; color: var(--dsw-alias-label-primary, #111); }
.me-dialog-body a { color: var(--dsw-alias-accent, #2563eb); }
/* ---- 卡片正文排版（.md-doc）：emoji 小标题 + 颜色分组 + 真正的列表 ---- */
.md-doc { max-width: 78ch; }
.md-doc > *:first-child { margin-top: 0 !important; }
.md-p { margin: 8px 0; }
.md-h { display: flex; align-items: center; gap: 7px; margin: 15px 0 7px; font-size: 14.5px; font-weight: 700; letter-spacing: .2px; }
.md-h .md-ico { font-size: 15px; line-height: 1; }
.md-h .md-hx { min-width: 0; }
.md-h::after { content: ''; flex: 1; height: 1px; background: currentColor; opacity: .16; border-radius: 1px; }
.md-h-h1 { font-size: 16px; }
.md-c-ok { color: #10B981; }
.md-c-warn { color: #F59E0B; }
.md-c-info { color: var(--dsw-alias-label-primary, #3B82F6); }
.md-c-plan { color: #A855F7; }
.md-c-idea { color: #EC4899; }
.md-c-bad { color: #EF4444; }
.md-ul, .md-ol { margin: 8px 0; padding-left: 0; list-style: none; }
.md-ul > li, .md-ol > li { position: relative; padding-left: 19px; margin: 5px 0; }
.md-ul > li::before { content: ''; position: absolute; left: 5px; top: .72em; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #3B82F6); opacity: .8; }
.md-ol { counter-reset: mdol; }
.md-ol > li { padding-left: 27px; }
.md-ol > li::before { counter-increment: mdol; content: counter(mdol); position: absolute; left: 0; top: .2em; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.16)); font-size: 10.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.md-b { font-weight: 700; background: linear-gradient(transparent 64%, rgba(59,130,246,.24) 64%); border-radius: 2px; }
.md-code { background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.14)); border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); border-radius: 5px; padding: .5px 5px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: .92em; }
.md-pre { background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.1)); border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); border-radius: 10px; padding: 10px 12px; overflow: auto; margin: 10px 0; }
.md-pre code { background: none; border: 0; padding: 0; font-size: 12.5px; line-height: 1.6; }
.md-callout { margin: 10px 0; padding: 9px 12px; border-radius: 10px; border-left: 3px solid currentColor; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08)); }
.md-callout .md-ico { margin-right: 6px; }
.md-kv { display: inline-flex; gap: 8px; align-items: baseline; margin: 3px 0; max-width: 100%; }
.md-k { flex: none; min-width: 4.5em; font-weight: 600; opacity: .72; }
.md-v { min-width: 0; word-break: break-word; }
.md-hr { border: 0; border-top: 1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.28)); margin: 14px 0; }
.md-task { margin-right: 2px; }
.md-link { color: var(--dsw-alias-accent, #2563eb); text-decoration: none; border-bottom: 1px solid currentColor; }
/* 元信息 chips（kind / 状态 / 标签 / 时间 / 来源） */
.md-meta { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 18px 0; }
.md-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24)); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08)); white-space: nowrap; max-width: 22em; overflow: hidden; text-overflow: ellipsis; }
.md-chip-kind { font-weight: 600; }
.md-chip-st-ok { color: #10B981; border-color: rgba(16,185,129,.35); background: rgba(16,185,129,.1); }
.md-chip-st-warn { color: #F59E0B; border-color: rgba(245,158,11,.35); background: rgba(245,158,11,.1); }
.md-chip-st-bad { color: #EF4444; border-color: rgba(239,68,68,.35); background: rgba(239,68,68,.1); }
.md-date { opacity: .65; }
.md-collapsed-hint { text-align: center; font-size: 12px; padding: 7px; cursor: pointer; opacity: .72; border-top: 1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.28)); }
.md-collapsed-hint:hover { opacity: 1; color: var(--dsw-alias-accent, #2563eb); }
/* ---- enhanced graph ---- */
.me-graph { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.me-graph-toolbar { display: flex; align-items: center; gap: 8px; }
.me-graph-toolbar input[type=text] { flex: 1; min-width: 180px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-base, #f9fafb); color: inherit; font-size: 13px; }
.me-graph-count { font-size: 12px; opacity: 0.7; }
.me-graph-canvas { position: relative; flex: 1; min-height: 300px; border-radius: 14px; overflow: hidden; background: radial-gradient(120% 120% at 50% 40%, var(--dsw-alias-bg-layer-2, #f8fafc) 0%, var(--dsw-alias-bg-base, #eef2f7) 100%); border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); cursor: grab; touch-action: none; user-select: none; }
.me-graph-canvas.dragging { cursor: grabbing; }
.me-graph-tip { font-size: 11px; opacity: 0.6; }
.me-graph-canvas svg { width: 100%; height: 100%; display: block; }
.me-graph-edge { fill: none; stroke-width: 1; }
.me-graph-node { cursor: pointer; }
.me-nodelabel { font-size: 11px; fill: var(--dsw-alias-label-primary, #334); pointer-events: none; transition: opacity .12s; }
.me-nodelabel.core { font-weight: 650; }
.me-graph-legend { display: flex; gap: 12px; flex-wrap: wrap; padding: 2px 2px 0; font-size: 11px; opacity: 0.85; }
.me-graph-legend .lg { display: inline-flex; align-items: center; gap: 5px; border: none; background: transparent; color: inherit; font: inherit; font-size: 11px; padding: 3px 6px; border-radius: 7px; cursor: pointer; }
.me-graph-legend .lg:hover { background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)); }
.me-graph-legend .lg.active { background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.14)); box-shadow: 0 0 0 1px var(--dsw-alias-border-l1, #d1d5db); }
.me-graph-legend .lg.lg-clear { opacity: 0.85; }
/* 图谱筛选下拉：选项深色底浅字，避免白卡片刺眼 */
.me-graph-legend-pop { color: #e5e7eb; }
.me-graph-legend-pop .lg { width: 100%; background: rgba(255,255,255,0.06); color: #e5e7eb; padding: 7px 9px; margin-bottom: 2px; border-radius: 7px; }
.me-graph-legend-pop .lg:hover { background: rgba(255,255,255,0.14); }
.me-graph-legend-pop .lg.active { background: rgba(59,130,246,0.32); color: #fff; box-shadow: 0 0 0 1px rgba(59,130,246,0.5); }
.me-graph-legend-pop .lg.lg-clear { color: #f87171; }
.me-graph-ctxmenu { min-width: 156px; padding: 6px; background: rgba(28,28,32,0.95); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #eee; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; box-shadow: 0 12px 34px rgba(0,0,0,.3); font-size: 12px; }
.me-graph-ctxmenu button { display: block; width: 100%; text-align: left; padding: 7px 10px; border: none; border-radius: 7px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.me-graph-ctxmenu button:hover { background: rgba(255,255,255,0.1); }
.me-graph-hint { font-size: 11px; opacity: 0.6; margin-left: auto; }
/* ---- 官方桌面版：让开窗口标题栏 ----------------------------------------------
   桌面壳（Electron）把「最小化 / 最大化 / 关闭」画在页面顶部，并按 DSH 的约定在
   <html> 上打 data-windows-titlebar、给出 --dsh-windows-titlebar-height
   （DSH 自己的全屏浮层也是这么让位的；已在官方桌面版的 app.asar 里确认这两个标记存在）。
   记忆库浮层必须整条让开：一来盖住窗口控制面板很难看，二来我们自己右上角的「×」
   恰好压在窗口「关闭」上 —— 点下去会直接退出整个桌面壳（实测踩坑）。
   浏览器里没有该属性 → 偏移 0px，行为与之前完全一致。 */
[data-windows-titlebar] .me-overlay-top,
[data-windows-titlebar] .me-overlay {
  top: var(--dsh-windows-titlebar-height, 0px);
}
/* Windows 桌面版：遮罩已下移 caption 高度，但 98vh + 56px 内边距仍然装不下 —— 居中溢出
   会把弹窗顶边顶回 caption 区，右上角控制条正好压在原生「最小化/关闭」上，点下去命中系统
   按钮（表现为「缩小/关闭用不了」）。把高度夹到「可视高 − caption − 上下各 28px」，
   居中即等于顶边恒在 caption 下方。 */
[data-windows-titlebar] .me-overlay-top .me-modal:not(.me-modal-full) {
  height: min(calc(100vh - var(--dsh-windows-titlebar-height, 0px) - 56px), 1080px);
  max-height: calc(100vh - var(--dsh-windows-titlebar-height, 0px) - 56px);
}
.me-modal-full {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  max-width: 100vw;
  max-height: 100vh;
  border-radius: 0;
}
[data-windows-titlebar] .me-modal-full {
  top: var(--dsh-windows-titlebar-height, 0px);
  height: calc(100vh - var(--dsh-windows-titlebar-height, 0px));
  max-height: calc(100vh - var(--dsh-windows-titlebar-height, 0px));
}
/* ---- macOS 桌面版：让开窗口左上角的红绿灯 ----------------------------------------
   宿主层的结论（issue #46）：macOS 桌面版是 Electron 的 titleBarStyle: hiddenInset +
   trafficLightPosition {x:16, y:18}，「关闭 / 最小化 / 缩放」是**原生 NSWindow 控件**，
   由操作系统画在网页内容之上。它不是 DOM —— 任何 z-index、portal、顶层层级都排不到它前面，
   插件能做的只有「让开那块矩形」，盖住它是做不到的。
   宿主自己已经把安全区发布了（ui-layout 的 AppFrame 写在 <html> 上）：
     · html[data-platform="darwin"] 只由桌面版 preload 写入（普通浏览器文档没有这个属性，
       所以下面的规则在浏览器 / Windows / Linux 上完全不生效，行为与之前一致）；
     · --dsh-frame-overlay-top 是宿主给对话框/菜单定的顶边让位量（macOS = 顶带 48px + 20px，
       原生全屏时宿主自己降到 20px，因为那时红绿灯隐藏）—— 直接跟随它，不必特判全屏。
   为什么之前会被遮：浮层是 inset: 0 + 居中，而 .me-modal 高 98vh（比可视区还高），
   居中溢出后顶边被顶到 ~1vh，正好落在红绿灯下面。于是 iframe 里左栏顶部那排控件
   （配置 / 审核中心等）被红绿灯压住，点过去实际命中的是原生「关闭」→ 整个桌面壳被关掉。
   做法：把顶边让到安全区下沿，并让对话框高度**正好**等于剩余空间 —— 此时「居中」等于
   「顶对齐」，顶边恒为 --dsh-frame-overlay-top；遮罩仍铺满全屏（继续挡住背景点击）。 */
[data-platform=darwin] .me-overlay-top {
  padding-top: var(--dsh-frame-overlay-top, 68px);
  padding-bottom: 16px;
}
[data-platform=darwin] .me-overlay-top .me-modal:not(.me-modal-full) {
  height: min(calc(100vh - var(--dsh-frame-overlay-top, 68px) - 16px), 1080px);
}
/* 阅读器 / 新建卡 / 导出等小对话框：同样让开顶带（导出全屏模式会顶到 24px）。 */
[data-platform=darwin] .me-overlay {
  padding-top: var(--dsh-frame-overlay-top, 68px);
}
[data-platform=darwin] .me-modal-full {
  top: var(--dsh-frame-overlay-top, 68px);
  height: calc(100vh - var(--dsh-frame-overlay-top, 68px));
  max-height: calc(100vh - var(--dsh-frame-overlay-top, 68px));
}
/* ---- V5：Memory Atlas 主题（RC） ---- */
.memory-eternal-root.me-v5 {
  --dsw-alias-bg-base: #1e2228;
  --dsw-alias-bg-layer-1: #262b33;
  --dsw-alias-bg-layer-2: #2f353e;
  --dsw-alias-border-l1: #3a404a;
  --dsw-alias-border-l2: #454c57;
  --dsw-alias-label-primary: #f3f5f8;
  --dsw-alias-label-secondary: #b0b7c1;
  --dsw-alias-accent: #ff7a45;
  --dsw-alias-brand-primary: #ff7a45;
  background: #1e2228;
  color: #f3f5f8;
}
.me-v5 .mc-v5-top { flex: none; height: 54px; display: flex; align-items: center; gap: 9px; padding: 0 16px; border-bottom: 1px solid #343a43; background: linear-gradient(180deg, rgba(35,39,46,.98), rgba(30,34,40,.96)); }
.me-v5 .mc-v5-top .spacer { flex: 1 1 auto; }
/* 右上角 108px 安全区：给 WebModal（左栏「记忆」/「配置」打开的全屏弹窗）的窗口控制条让位。
   控制条是两颗 46px 按钮（窄屏 2×44=88px），所以窄屏预留 96px、宽屏 108px。 */
.me-v5 .mc-v5-top.in-host { padding-right: 108px; }
.me-v5 .mc-v5-logo { width: 22px; height: 22px; border-radius: 7px; object-fit: cover; flex: none; background: #fff; box-shadow: 0 0 0 1px rgba(255,255,255,.08); }
.me-v5 .mc-v5-crumb { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #b0b7c1; white-space: nowrap; }
.me-v5 .mc-v5-crumb b { color: #f3f5f8; font-weight: 600; }
.me-v5 .mc-v5-crumb i { color: #5a616d; font-style: normal; }
.me-v5 .mc-v5-top-actions { display: flex; align-items: center; gap: 7px; min-width: 0; }
.me-v5 .mc-v5-sys { display: inline-flex; align-items: center; gap: 6px; height: 25px; padding: 0 9px; border: 1px solid #3a404a; border-radius: 999px; color: #b0b7c1; font-size: 10px; white-space: nowrap; }
.me-v5 .mc-v5-sys i { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 3px rgba(74,222,128,.1); }
.me-v5 .mc-v5-ver { height: 24px; display: inline-flex; align-items: center; padding: 0 8px; border-radius: 6px; background: rgba(127,127,127,.08); color: #99a1ac; font-family: var(--mono, ui-monospace, monospace); font-size: 9.5px; white-space: nowrap; }
.me-v5 .mc-v5-star { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border: 1px solid #454c57; border-radius: 7px; background: transparent; color: #dde2e9; font-size: 10.5px; text-decoration: none; white-space: nowrap; cursor: pointer; }
.me-v5 .mc-v5-star:hover { border-color: rgba(255,122,69,.45); color: #ff9a72; }
.me-v5 .mc-v5-help { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #454c57; border-radius: 50%; background: transparent; color: #b0b7c1; font-size: 12px; font-weight: 650; cursor: pointer; }
.me-v5 .mc-v5-help:hover { border-color: rgba(255,122,69,.45); color: #ff9a72; }
.me-v5 .me-modal-body { background: #1e2228; container-type: inline-size; }
.me-v5 .mc-rail { width: 68px; gap: 2px; padding: 12px 10px 12px 8px; background: #1b1f25; border-right: 1px solid #343a43; }
.me-v5 .mc-rail.open { width: 228px; }
.me-v5 .mc-v5-rail-top { display: flex; align-items: center; gap: 8px; padding: 0 4px 11px; }
.me-v5 .mc-v5-railbrand { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1; }
.me-v5 .mc-v5-railbrand .mark { width: 27px; height: 27px; display: block; border-radius: 8px; object-fit: cover; background: #fff; border: 1px solid #3a404a; padding: 1px; flex: none; }
.me-v5 .mc-v5-railbrand b { display: block; font-size: 13px; color: #f3f5f8; white-space: nowrap; }
.me-v5 .mc-v5-railbrand span { display: block; margin-top: 1px; font-size: 8px; letter-spacing: .16em; color: #99a1ac; white-space: nowrap; }
.me-v5 .mc-rail-collapse { margin-left: auto; width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent; color: #b0b7c1; }
.me-v5 .mc-rail-collapse:hover { background: rgba(255,255,255,.05); color: #f3f5f8; border-color: transparent; }
.me-v5 .mc-rail-sec { padding: 12px 10px 5px; font-size: 9px; letter-spacing: .14em; font-weight: 600; color: #99a1ac; text-transform: uppercase; }
.me-v5 .mc-rail:not(.open) .mc-v5-railbrand, .me-v5 .mc-rail:not(.open) .mc-rail-sec { display: none; }
.me-v5 .mc-railbtn { height: 37px; padding: 0 10px; gap: 10px; border: 0; border-radius: 9px; background: transparent; color: #b0b7c1; font-size: 12.5px; font-weight: 500; }
.me-v5 .mc-railbtn:hover { background: rgba(255,255,255,.04); color: #f3f5f8; border-color: transparent; }
.me-v5 .mc-railbtn.active { background: linear-gradient(90deg, rgba(255,122,69,.16), rgba(255,122,69,.04)); color: #fff; box-shadow: inset 0 0 0 1px rgba(255,122,69,.18); }
.me-v5 .mc-railbtn.active .mc-rail-ico { color: #ff7a45; }
.me-v5 .mc-railbtn .mc-rail-ico { font-size: 16px; }
.me-v5 .mc-rail:not(.open) .mc-railbtn { justify-content: center; padding: 0; }
.me-v5 .mc-main { background: #1e2228; }
.me-v5 .mc-card, .me-v5 .me-audit-kinds, .me-v5 .me-audit-bulk { background: #262b33; border-color: #3a404a; }
.me-v5 .mc-toolbar input[type=text] { background: #262b33; border-color: #454c57; border-radius: 8px; color: #f3f5f8; }
.me-v5 .mc-btn { background: #2a3038; border-color: #454c57; color: #dde2e9; border-radius: 8px; }
.me-v5 .mc-btn:hover { border-color: #ff7a45; color: #fff; opacity: 1; }
.me-v5 .mc-btn.me-on { background: #ff7a45; border-color: transparent; color: #160d08; box-shadow: 0 6px 18px rgba(255,122,69,.2); }
.me-v5 .mc-chip { border-color: #454c57; color: #b0b7c1; background: transparent; }
.me-v5 .mc-chip.active { border-color: rgba(255,122,69,.4); color: #ff9a72; background: rgba(255,122,69,.06); }
.me-v5 .mc-tabs { background: #262b33; border: 1px solid #3a404a; }
.me-v5 .mc-tab.active { background: #30363f; }
.me-v5 .mc-cardrow { background: #262b33; border-color: #3a404a; border-radius: 12px; }
.me-v5 .mc-cardrow:hover { border-color: rgba(255,122,69,.35); box-shadow: 0 10px 30px rgba(0,0,0,.28); }
.me-v5 .mc-grid { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 11px; }
.me-v5 .mc-v5-pagehead { display: flex; align-items: flex-end; gap: 16px; padding: 8px 4px 16px; }
.me-v5 .mc-v5-eyebrow { font-size: 9px; letter-spacing: .16em; color: #ff7a45; font-weight: 650; margin-bottom: 5px; }
.me-v5 .mc-v5-pagehead h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: -.02em; font-weight: 650; color: #f0f2f5; }
.me-v5 .mc-v5-pagehead p { margin: 6px 0 0; font-size: 11.5px; line-height: 1.6; color: #b0b7c1; max-width: 56ch; }
.me-v5 .mc-v5-pagehead-stats { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: 10.5px; color: #99a1ac; }
.me-v5 .mc-v5-pagehead-stats b { color: #f3f5f8; font-weight: 650; }
.me-v5 .mc-v5-pagehead-stats span + span { position: relative; padding-left: 12px; }
.me-v5 .mc-v5-pagehead-stats span + span::before { content: ''; position: absolute; left: 0; top: 50%; width: 3px; height: 3px; border-radius: 50%; background: #5a616d; transform: translateY(-50%); }
.me-v5 .mc-v5-audithead { flex: none; padding-bottom: 12px; }
.me-v5 .mc-v5-audit-trust { display: inline-flex; align-items: center; gap: 5px; margin-left: 4px; padding: 4px 9px; border: 1px solid #363c46; border-radius: 999px; background: #22262d; color: #b0b7c1; font-size: 10px; white-space: nowrap; }
.me-v5 .mc-v5-recycle-hint { margin: 0 2px 10px; font-size: 11px; color: #99a1ac; }
.me-v5 .mc-v5-recycle { overflow: hidden; padding: 0 !important; }
.me-v5 .mc-v5-recycle-row { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px 12px; border-bottom: 1px solid rgba(127,127,127,.12); }
.me-v5 .mc-v5-recycle-row:last-child { border-bottom: 0; }
.me-v5 .mc-v5-recycle-row:hover { background: rgba(127,127,127,.035); }
.me-v5 .mc-v5-recycle-tile { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid; border-radius: 9px; font-size: 15px; flex: none; }
.me-v5 .mc-v5-recycle-copy { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.me-v5 .mc-v5-recycle-copy b { font-size: 12.5px; line-height: 1.5; color: #f3f5f8; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-v5 .mc-v5-recycle-copy span { font-size: 10px; color: #99a1ac; }
.me-v5 .mc-v5-recycle-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.me-v5 .mc-danger { color: #f87171; }
.me-v5 .mc-v5-empty-state { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 34px 16px; text-align: center; font-size: 12px; color: #99a1ac; }
.me-v5 .mc-v5-empty-state b { color: #e5e9ef; font-size: 13px; }
.me-v5 .mc-v5-empty-state span { font-size: 11px; }
@media (max-width: 640px) { .me-v5 .mc-v5-recycle-row { flex-wrap: wrap; } .me-v5 .mc-v5-recycle-actions { width: 100%; padding-left: 42px; } }
.me-v5 .mc-v5-pagecount { margin-left: auto; padding-bottom: 4px; font-size: 10px; color: #99a1ac; font-variant-numeric: tabular-nums; white-space: nowrap; }
.me-v5 .mc-v5-card { min-height: 176px; padding: 13px 14px 11px; gap: 7px; }
.me-v5 .mc-v5-card-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.me-v5 .mc-v5-card-kind { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid; border-radius: 999px; font-size: 9.5px; line-height: 17px; white-space: nowrap; }
.me-v5 .mc-v5-card-tile { width: 23px; height: 23px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid; border-radius: 7px; font-size: 12px; flex: none; }
.me-v5 .mc-v5-card-kind-name { font-size: 9.5px; color: #b0b7c1; white-space: nowrap; }
.me-v5 .mc-v5-pin { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; font-size: 9px; opacity: .35; flex: none; }
.me-v5 .mc-v5-pin:hover, .me-v5 .mc-v5-pin.on { opacity: 1; background: rgba(255,122,69,.12); }
.me-v5 .mc-v5-card.pinned { border-color: rgba(255,122,69,.32); }
.me-v5 .mc-v5-card-insight { display: flex; gap: 6px; align-items: flex-start; min-width: 0; }
.me-v5 .mc-v5-insight-k { flex: none; margin-top: 1px; padding: 1px 4px; border-radius: 4px; background: rgba(255,122,69,.09); color: #ff9a72; font-size: 8.5px; line-height: 14px; white-space: nowrap; }
.me-v5 .mc-v5-card-lead { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.me-v5 .mc-v5-mini { flex: none; opacity: .9; }
.me-v5 .mc-v5-conn { display: inline-flex; align-items: center; gap: 3px; color: #e0a184; }
.me-v5 .mc-v5-conn b { color: #ff9a72; }
.me-v5 .mc-chip-n { margin-left: 5px; padding: 0 4px; border-radius: 4px; background: rgba(127,127,127,.12); font-size: 9px; line-height: 14px; opacity: .7; }
.me-v5 .mc-v5-card .mc-tag.more { opacity: .55; }
.me-v5 .mc-v5-card-status { font-size: 9px; padding: 1px 6px; border-radius: 999px; line-height: 15px; }
.me-v5 .mc-v5-card-status.pending { color: #fbbf24; background: rgba(251,191,36,.1); }
.me-v5 .mc-v5-card-status.rejected { color: #fb7185; background: rgba(251,113,133,.1); }
.me-v5 .mc-v5-card-time { font-size: 9px; color: #99a1ac; white-space: nowrap; }
.me-v5 .mc-v5-card-title { margin: 1px 0 0; font-size: 13.5px; line-height: 1.48; font-weight: 600; color: #f3f5f8; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.me-v5 .mc-v5-card-lead { margin: 0; font-size: 11px; line-height: 1.65; color: #b9bfc9; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.me-v5 .mc-v5-card-tags { margin-top: 0; }
.me-v5 .mc-v5-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 7px; border-top: 1px solid rgba(127,127,127,.1); font-size: 9.5px; color: #99a1ac; }
.me-v5 .mc-v5-conn { color: #e6a98c; }
.me-v5 .mc-v5-author { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px; }
.me-v5 .mc-v5-feature { display: flex; align-items: stretch; gap: 18px; margin-bottom: 11px; padding: 18px 20px; border: 1px solid rgba(255,122,69,.22); border-radius: 14px; background: linear-gradient(115deg, rgba(255,122,69,.09), rgba(255,122,69,.02) 55%, rgba(255,255,255,.01)); cursor: pointer; transition: border-color .15s ease, transform .15s ease; }
.me-v5 .mc-v5-feature:hover { border-color: rgba(255,122,69,.45); transform: translateY(-1px); }
.me-v5 .mc-v5-feature-copy { flex: 1; min-width: 0; }
.me-v5 .mc-v5-feature h3 { margin: 3px 0 0; font-size: 20px; line-height: 1.35; font-weight: 650; color: #f3f5f8; overflow-wrap: anywhere; }
.me-v5 .mc-v5-feature p { margin: 8px 0 0; font-size: 11.5px; line-height: 1.7; color: #b9bfc9; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.me-v5 .mc-v5-feature-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; font-size: 9.5px; color: #99a1ac; }
.me-v5 .mc-v5-feature-side { flex: none; width: 88px; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 2px; border-left: 1px solid rgba(255,122,69,.16); padding-left: 16px; }
.me-v5 .mc-v5-feature-side b { font-size: 26px; line-height: 1; color: #ff9a72; font-weight: 650; }
.me-v5 .mc-v5-feature-side span { font-size: 9.5px; color: #99a1ac; }
.me-v5 .mc-v5-feature-open { margin-top: 7px; color: #ff9a72 !important; }
.me-v5 .mc-v5-feature-shuffle { margin-top: 5px; padding: 2px 6px; border: 1px solid rgba(255,122,69,.28); border-radius: 5px; background: transparent; color: #ff9a72; font-size: 9px; cursor: pointer; }
.me-v5 .mc-v5-feature-shuffle:hover { background: rgba(255,122,69,.1); }
@media (max-width: 720px) { .me-v5 .mc-v5-feature { flex-direction: column; padding: 15px; } .me-v5 .mc-v5-feature-side { width: 100%; flex-direction: row; justify-content: flex-start; align-items: baseline; gap: 8px; border-left: 0; border-top: 1px solid rgba(255,122,69,.16); padding: 8px 0 0; } .me-v5 .mc-v5-feature h3 { font-size: 17px; } }
@media (max-width: 760px) { .me-v5 .mc-v5-top { height: 50px; padding: 0 10px; gap: 6px; } .me-v5 .mc-v5-top.in-host { padding-right: 96px; } .me-v5 .mc-v5-ver, .me-v5 .mc-v5-star-label { display: none; } .me-v5 .mc-v5-star { padding: 0 7px; } .me-v5 .mc-v5-sys { padding: 0 7px; } }
.me-v5 .mc-v5-statusgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.me-v5 .mc-v5-statuscard { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 13px 14px; border: 1px solid #30353e; border-radius: 12px; background: #1c1f25; min-width: 0; }
.me-v5 .mc-v5-status-ico { position: absolute; right: 12px; top: 11px; opacity: .55; font-size: 14px; }
.me-v5 .mc-v5-statuscard b { font-size: 22px; line-height: 1.2; color: #f3f5f8; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-v5 .mc-v5-statuscard > span:not(.mc-v5-status-ico) { font-size: 10.5px; color: #b0b7c1; }
.me-v5 .mc-v5-statuscard small { font-size: 9.5px; color: #99a1ac; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-v5 .mc-v5-graphhead { flex: none; padding: 0 4px 10px; }
.me-v5 .me-graph-count { display: none; }
.me-v5 .mc-v5-graph-legend { position: absolute; left: 12px; top: 12px; z-index: 2; min-width: 130px; padding: 9px 10px; border: 1px solid rgba(127,127,127,.18); border-radius: 9px; background: rgba(28,31,37,.78); backdrop-filter: blur(10px); WebkitBackdropFilter: blur(10px); pointer-events: none; }
.me-v5 .mc-v5-graph-legend-title { margin-bottom: 6px; font-size: 8.5px; letter-spacing: .14em; color: #99a1ac; font-weight: 650; }
.me-v5 .mc-v5-graph-legend-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 10px; color: #b0b7c1; }
.me-v5 .mc-v5-graph-legend-row i { width: 6px; height: 6px; border-radius: 2px; flex: none; }
.me-v5 .mc-v5-graph-legend-row span { flex: 1; }
.me-v5 .mc-v5-graph-legend-row b { color: #e9ecf1; font-weight: 600; font-variant-numeric: tabular-nums; }
@media (max-width: 900px) { .me-v5 .mc-v5-statusgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .me-v5 .mc-v5-graph-legend { display: none; } }
.me-v5 .mc-stats { gap: 10px; }
.me-v5 .mc-stats .mc-card { border-radius: 12px; }
.me-v5 .mc-stat b { color: #f0f2f5; font-weight: 650; }
.me-v5 .mc-stat span { color: #b0b7c1; }
.me-v5 .me-modal-head { background: #1b1f25; border-bottom-color: #343a43; }
.me-v5 .me-dialog { background: #242930; border-color: #454c57; }
.me-v5 .me-dialog-head { border-bottom-color: #3a404a; }
.me-v5 .md-doc { color: #dde2e9; }
.me-v5 .md-doc h1, .me-v5 .md-doc h2, .me-v5 .md-doc h3 { color: #f3f5f8; }
.me-v5 .me-audit-kind.active { border-color: rgba(255,122,69,.3); background: rgba(255,122,69,.1); }
.me-v5 .me-audit-bulk { box-shadow: 0 -8px 24px rgba(0,0,0,.32); }
.me-v5 .mc-dot { background: #ff7a45; color: #160d08; }
.me-audit-eye { display: none; align-items: center; justify-content: center; padding: 2px 6px; }
.me-audit-drawer-backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.46); backdrop-filter: blur(2px); }
.me-audit-drawer-close { display: none; position: absolute; top: 9px; right: 9px; z-index: 3; width: 27px; height: 27px; padding: 0; justify-content: center; }
@container (max-width: 1120px) {
  .me-audit-eye { display: inline-flex; }
  .me-audit-preview.drawer-open { display: flex; position: fixed; top: 0; right: 0; bottom: 0; z-index: 81; width: min(440px, 92vw); max-height: none; height: 100dvh; border-radius: 0; box-shadow: -24px 0 70px rgba(0,0,0,.45); }
  .me-audit-preview.drawer-open .me-audit-drawer-close { display: inline-flex; }
  .me-audit-preview.drawer-open .me-audit-preview-head { padding-right: 42px; }
}
@media (max-width: 1100px) {
  .me-v5 .mc-rail, .me-v5 .mc-rail.open { width: 68px; padding: 10px 8px; }
  .me-v5 .mc-v5-railbrand, .me-v5 .mc-rail-sec, .me-v5 .mc-rail-label { display: none; }
  .me-v5 .mc-railbtn { justify-content: center; padding: 0; }
}
@container (max-width: 1100px) {
  .me-v5 .mc-rail, .me-v5 .mc-rail.open { width: 68px; padding: 10px 8px; }
  .me-v5 .mc-v5-railbrand, .me-v5 .mc-rail-sec, .me-v5 .mc-rail-label { display: none; }
  .me-v5 .mc-railbtn { justify-content: center; padding: 0; }
}
@media (max-width: 720px) {
  .me-v5 .mc-rail, .me-v5 .mc-rail.open { width: 54px; padding: 10px 8px; }
  .me-v5 .mc-v5-railbrand, .me-v5 .mc-rail-sec { display: none; }
  .me-v5 .mc-v5-top { height: 46px; padding: 0 12px; }
  .me-v5 .mc-v5-crumb { font-size: 10px; }
  .me-v5 .mc-v5-pagehead h1 { font-size: 21px; }
  .me-v5 .mc-v5-pagehead p { display: none; }
  .me-v5 .mc-v5-pagehead { padding-bottom: 10px; }
  .me-audit-queue .mc-card { min-width: 0; }
  .me-audit-queue .mc-card > div[style*="flex: 1"] { display: none; }
  .me-audit-queue .mc-card .mc-btn { flex: 0 0 auto; }

  .mc-audit-batchcard { display: grid !important; grid-template-columns: 1fr 1fr; gap: 6px !important; }
  .mc-audit-batchcard > label, .mc-audit-batchcard > span, .mc-audit-batchcard > b { grid-column: 1 / -1; }
  .mc-audit-batchcard > .mc-btn { width: 100%; }
  .mc-audit-batchcard > div[style*="flex: 1"] { display: none; }
}
`

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'memory-eternal: locale')
  const t = ctx.locale.bind(NS)

  // 设置 → 记忆：顶部「可编辑配置」+ 下方记忆库浏览（同源 DSH host）
  //   - 配置表单内嵌 ConfigPanel（DSH 设置页即 DSH host 同源 → /config 可读写）
  //   - 记忆库用 iframe 加载独立 web（浏览）
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: NS, order: 25, label: () => t('nav'), locale: NS, inject: () => ({}) },
    () => React.createElement(SettingSection, { t }),
  )), 'memory-eternal: settings section')

  // 侧边栏底部 footer：「记忆」按钮 → 弹窗内嵌 web 端（记忆配置已并入记忆视图，左栏⚙ 可开）
  // locale face 一并传入：iframe web 端首屏 URL 带 ?lang=，语言变化经 postMessage 实时跟随 DSH 系统配置
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: `${NS}:footer`, order: 100, label: () => t('nav'), locale: NS, inject: () => ({}) },
    (props) => React.createElement(MemoryFooterButton, { t, locale: ctx.locale, wide: !(props && props.wide === false) }),
  )), 'memory-eternal: sidebar footer action')
}

// -- Web 端 iframe 壳 ----------------------------------------------------------

/**
 * web 端 UI 地址：**同源优先**，旧宿主才回落常驻实例地址。
 *
 * 为什么（issue #29）：iframe 过去完全依赖 `/web-info` 报的「常驻实例监听端口」，而那个端口会在
 * 自愈/端口漂移时变化 —— web-info 一旦悬空，记忆页就变成「拒绝连接 127.0.0.1」。
 * 宿主已经把同一份 web UI 挂在 `/memory-eternal/ui/app`（与配置页 /ui/config 同一套路，index.html
 * 里 `<script src="app.js">` 是相对路径，正好解析到 /ui/app.js），于是 iframe 与端口彻底解耦。
 * 0.10.8 及更早的宿主没有这条路由 → 探测返回 404 时回落到 web-info（老行为）。
 */
function useWebUrl() {
  const [url, setUrl] = useState(API + '/ui/app')
  useEffect(() => {
    let alive = true
    const fallback = () => fetch('/memory-eternal/api/web-info')
      .then((r) => r.json())
      .then((d) => {
        if (alive && d && d.ok && d.alive !== false && d.url) setUrl(d.url.endsWith('/') ? d.url : d.url + '/')
      })
      .catch(() => {})
    fetch(API + '/ui/app', { method: 'HEAD' })
      .then((r) => { if (alive && !r.ok) return fallback() })
      .catch(() => (alive ? fallback() : undefined))
    return () => { alive = false }
  }, [])
  return url
}

/** 设置 → 记忆 左栏整页：仅记忆配置（同源 DSH host 可写），不含记忆库浏览。 */
function SettingSection({ t }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <style>{CSS}</style>
      <ConfigPanel t={t} onReload={() => {}} version={0} />
    </div>
  )
}

// -- Sidebar footer button ---------------------------------------------------

function MemoryFooterButton({ t, locale, wide }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`me-footer${wide ? '' : ' rail'}`}>
      <style>{CSS}</style>
      <button type="button" className="me-footer-btn" onClick={() => setOpen(true)} aria-label={t('nav')} title={t('nav')}>
        <span className="me-footer-ico" aria-hidden="true"><DatabaseIcon /></span>
        <span className="me-footer-label">{t('nav')}</span>
      </button>
      {open && <WebModal t={t} locale={locale} onClose={() => setOpen(false)} />}
    </div>
  )
}

/** 侧边栏底部「⚙ 配置」按钮 → 弹窗内嵌 web 配置视图（?tab=config）。 */
/** 全屏弹窗内嵌 web 端（渲染走 web，与浏览器访问同一份 UI）。可选 tab 指定初始视图。 */
/** 窗口控制条图标：13px、1.4px 细线，和桌面客户端 caption 同一视觉语言（不依赖字体字形）。 */
function WctlMaximizeGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2.9" y="2.9" width="10.2" height="10.2" rx="1.7" /></svg>
}
function WctlRestoreGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2.6" y="5.4" width="8" height="8" rx="1.5" /><path d="M5.6 5.4V4.1c0-.9.7-1.6 1.6-1.6h4.7c.9 0 1.6.7 1.6 1.6v4.7c0 .9-.7 1.6-1.6 1.6h-1.3" /></svg>
}
function WctlCloseGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" /></svg>
}
function WebModal({ t, locale, onClose, tab }) {
  const [full, setFull] = useState(false)
  // iframe 首帧之前不能是纯白块（用户群反馈的「打开记忆先白屏」）：iframe 背景置透明，
  // 由 onLoad 撤掉盖在上面的马赛克式加载提示。
  const [frameReady, setFrameReady] = useState(false)
  const iframeRef = useRef(null)
  const base = useWebUrl()
  // 跟随 DSH 系统语言：订阅 locale 快照（getSnapshot/subscribe，同 slots 响应式链路）
  const subscribe = useCallback((cb) => (locale && typeof locale.subscribe === 'function' ? locale.subscribe(cb) : () => {}), [locale])
  const getSnapshot = useCallback(() => (locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null), [locale])
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  const lang = snap && (snap.active === 'zh' || snap.active === 'en') ? snap.active : null
  // 打开瞬间把语言定格进 URL（iframe 首屏即正确）；之后的变化走 postMessage，避免 iframe 整页重载
  const openLang = useRef(null)
  if (openLang.current === null && lang) openLang.current = lang
  const url = useMemo(() => {
    const q = openLang.current ? `lang=${openLang.current}` : ''
    if (tab === 'config') return `${API}/ui/config?tab=config${q ? `&${q}` : ''}`
    const root = base.replace(/\/$/, '')
    // 同源壳（/memory-eternal/ui/app）直接拼 ?；独立实例是目录根，要多一个 /
    const sep = root.endsWith('/ui/app') ? '?' : '/?'
    if (tab) return `${root}${sep}tab=${tab}${q ? `&${q}` : ''}`
    return q ? `${root}${sep}${q}` : base
  }, [base, tab]) // eslint-disable-line react-hooks/exhaustive-deps -- openLang 定格，语言变化走 postMessage
  // DSH 系统语言变化 → 实时通知 iframe 内 web 端切换
  useEffect(() => {
    const win = iframeRef.current && iframeRef.current.contentWindow
    if (win && lang) win.postMessage({ source: 'memory-eternal', type: 'locale', lang }, '*')
  }, [lang])
  // tab=config 与记忆库整页都走 DSH host 同源壳（/memory-eternal/ui/config、/memory-eternal/ui/app），
  // 保证 API 同源，也让 iframe 不再依赖常驻实例的端口（issue #29）；只有旧宿主才回落独立 web server。
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const overlay = (
    <div className="me-overlay-top" onClick={onClose}>
      <style>{CSS}</style>
      <div className={'me-modal' + (full ? ' me-modal-full' : '')} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
          {/* 右上角窗口控制条：桌面客户端标题栏风格（扁平细线、悬停才出底、关闭悬停变红）。
              两颗 46×34 贴死弹窗右上圆角，正好落在 iframe 顶栏预留的 108px 安全区里；
              弹窗高度已被上面的 clamp 规则约束，永远不会压到桌面壳的原生窗口按钮上。 */}
          <div className="me-wctl">
            <button type="button" className="me-wctl-btn" data-me-wctl={full ? 'restore' : 'full'} aria-pressed={full} onClick={() => setFull((f) => !f)} aria-label={full ? t('exitFullscreen') : t('enterFullscreen')} title={full ? t('exitFullscreen') : t('enterFullscreen')}>
              {full ? <WctlRestoreGlyph /> : <WctlMaximizeGlyph />}
            </button>
            <button type="button" className="me-wctl-btn me-wctl-close" data-me-wctl="close" onClick={onClose} aria-label={t('close')} title={t('close')}>
              <WctlCloseGlyph />
            </button>
          </div>
          <iframe ref={iframeRef} src={url} title="memory-eternal" allow="clipboard-write; clipboard-read" onLoad={() => setFrameReady(true)} style={{ width: '100%', flex: 1, border: 0, borderRadius: 'inherit', background: 'transparent' }} />
          {!frameReady && <div className="me-frame-boot" role="status" aria-live="polite"><ProgressBar /><span className="me-loading-text">{t('loading')}</span></div>}
        </div>
      </div>
    </div>
  )
  // portal 到 body：脱离 DSH 插件容器的 stacking context，避免被第三方插件（对话栏等）盖住
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}

function DatabaseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="mg-brain" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFC46B" />
          <stop offset="50%" stopColor="#F97316" />
          <stop offset="100%" stopColor="#EA580C" />
        </linearGradient>
      </defs>
      <path fill="url(#mg-brain)" d="M12 4.5a3.2 3.2 0 0 0-6.4.1 4.1 4.1 0 0 0-2.7 5.9 4.1 4.1 0 0 0 .6 6.7A4.2 4.2 0 0 0 12 18.2Z" />
      <path fill="url(#mg-brain)" d="M12 4.5a3.2 3.2 0 0 1 6.4.1 4.1 4.1 0 0 1 2.7 5.9 4.1 4.1 0 0 1-.6 6.7A4.2 4.2 0 0 1 12 18.2Z" />
      <path d="M12 9.2c-.8-1.4-1.7-2-3.1-2.2M12 9.2c.8-1.4 1.7-2 3.1-2.2M12 12.4c-1.2 1-3.2 1.6-5 1.4M12 12.4c1.2 1 3.2 1.6 5 1.4M12 13.2v4" fill="none" stroke="rgba(255,255,255,0.62)" strokeWidth="1" strokeLinecap="round" />
      <circle cx="12" cy="8.6" r="1.1" fill="rgba(255,255,255,0.85)" />
    </svg>
  )
}

// -- Shared library content (inline settings page + modal) ------------------

// 构建期由 build.mjs 注入（esbuild define）；直接跑源码（如 SSR 测试）时为 undefined，用 typeof 安全降级。
const CLIENT_VERSION = typeof __ME_CLIENT_VERSION__ === 'string' ? __ME_CLIENT_VERSION__ : ''

function TerminalGuide({ t }) {
  const [copied, setCopied] = useState('')
  const runCmd = 'dsh-memory tui'
  const tuiCmd = 'dsh-memory tui --write'
  const copy = async (text, key) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1600) } catch {}
  }
  const card = { border: '1px solid #3a404a', borderRadius: 14, background: '#22262d', padding: '16px 18px' }
  const code = { margin: '10px 0 0', padding: '12px 14px', borderRadius: 10, background: '#171a1f', border: '1px solid #333943', color: '#f3f5f8', fontSize: 12.5, lineHeight: 1.7, overflowX: 'auto', fontFamily: 'ui-monospace, Consolas, monospace' }
  const button = { marginTop: 10, border: '1px solid #4a515c', background: 'transparent', color: '#ffb08a', borderRadius: 9, padding: '7px 12px', fontSize: 12, cursor: 'pointer' }
  return (
    <div style={{ padding: '22px 26px 34px', maxWidth: 1040, color: '#f3f5f8' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 24, letterSpacing: '-.02em' }}>{t('terminalTitle')}</h2>
        <span style={{ color: '#99a1ac', fontSize: 12 }}>TUI · LIVE · dsh-tui</span>
      </div>
      <p style={{ margin: '9px 0 20px', color: '#aeb5bf', fontSize: 13.5, lineHeight: 1.8 }}>{t('terminalIntro')}</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, .9fr)', gap: 14 }}>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>▸ {t('terminalRun')}</div>
          <pre style={code}>{runCmd}</pre>
          <button type="button" style={button} onClick={() => copy(runCmd, 'run')}>{copied === 'run' ? '✓ ' + t('terminalCopied') : '⧉ ' + t('terminalCopy')}</button>
          <div style={{ marginTop: 12, color: '#99a1ac', fontSize: 12, lineHeight: 1.7 }}>
            默认读取真实记忆库与待审队列；只读，确认后才用 `--write`。示例数据用 `--demo`。
            <br />没有 `dsh-memory` 命令时：`npx -p memory-eternal dsh-memory tui`
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>▸ {t('terminalTui')}</div>
          <pre style={code}>{tuiCmd}</pre>
          <button type="button" style={button} onClick={() => copy(tuiCmd, 'tui')}>{copied === 'tui' ? '✓ ' + t('terminalCopied') : '⧉ ' + t('terminalCopy')}</button>
          <div style={{ marginTop: 12, color: '#99a1ac', fontSize: 12, lineHeight: 1.7 }}>
            真实批准/驳回；不确定时先用只读模式。
          </div>
        </div>
      </div>

      <div style={{ ...card, marginTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>▸ {t('terminalPreview')}</div>
        <pre style={{ ...code, marginTop: 10, color: '#d7dce3', fontSize: 12, lineHeight: 1.5 }}>
{`╭─ MEMORY ATLAS / 待审 ─────────────────────────────╮
│  类型  ● 全部 7   ○ 项目 3   ○ 知识 1   ○ 教训 1  │
│                                                    │
│  ▣ 全选 7    已选 3     s 全选                     │
│  ▌◉ [项目] memory-eternal V5 收口                 │
│  ◉  [知识] MVCheck 多相机独立成像参数             │
│  ◉  [教训] shj-web 端口菜单错位                   │
│                                                    │
│  [a] 批准 3   [r] 驳回   [s] 反选   [Esc] 清空    │
╰────────────────────────────────────────────────────╯`}
        </pre>
      </div>

      <div style={{ marginTop: 16, color: '#99a1ac', fontSize: 12.5, lineHeight: 1.8 }}>
        <b style={{ color: '#f3f5f8' }}>{t('terminalWhy')}</b><br />{t('terminalWhyBody')}
      </div>
    </div>
  )
}

// 面板级错误边界：插件此前没有 ErrorBoundary —— 任何渲染期异常（组件/effect）都会让
// React 直接卸载整棵树，用户看到的就是「整页白屏，Console 里只有一个红字」。
// 现在最外层兜住：显示可读的错误 + 一键重新加载，至少不丢上下文、能自助恢复。
class PanelErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) { return { error: error || new Error('unknown') } }
  componentDidCatch(error, info) {
    try { console.warn('[memory-eternal] 记忆面板渲染异常（已兜底，不再整页白屏）', error, info && info.componentStack) } catch (e) { /* ignore */ }
  }
  render() {
    if (!this.state.error) return this.props.children
    const msg = String((this.state.error && this.state.error.message) || this.state.error || 'unknown')
    return (
      <div style={{ padding: '22px 24px', fontFamily: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif', color: 'var(--dsw-alias-label-primary, #1f2937)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>记忆面板渲染出错</div>
        <div style={{ fontSize: 12.5, opacity: 0.75, lineHeight: 1.7, marginBottom: 14, wordBreak: 'break-all' }}>{msg}</div>
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 14, lineHeight: 1.7 }}>已经兜底住，不会再整页白屏。点「重新加载」可恢复；反复出现请用左栏「反馈异常」带上这段报错。</div>
        <button type="button" className="mc-btn" onClick={() => { try { window.location.reload() } catch (e) { /* ignore */ } }}>重新加载</button>
      </div>
    )
  }
}

export function MemoryLibrary(props) {
  return <PanelErrorBoundary><MemoryLibraryInner {...props} /></PanelErrorBoundary>
}
function MemoryLibraryInner({ t, inModal, onClose }) {
  const inHost = typeof window !== 'undefined' && (!!window.__DSH_BOOT__ || String(location.pathname || '').includes('/memory-eternal/api/ui/app'))
  const [overview, setOverview] = useState(null)
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [capHealth, setCapHealth] = useState(null)
  const [error, setError] = useState('')
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [agentFilter, setAgentFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [pinned, setPinned] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('me-pinned-v5') || '[]')) } catch { return new Set() }
  })
  const [onlyPinned, setOnlyPinned] = useState(false)
  const togglePin = useCallback((path) => {
    setPinned((s) => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path); else n.add(path)
      try { localStorage.setItem('me-pinned-v5', JSON.stringify([...n])) } catch { /* 隐私模式忽略 */ }
      return n
    })
  }, [])
  // 标签筛选（点击芯片即筛，可与搜索/类型/状态叠加）
  const [tagPick, setTagPick] = useState('')
  // 'cards' | 'graph' | 'stats' | 'audit' | 'optimize' | 'config' | 'terminal'
  const [view, setView] = useState(() => {
    try {
      const tab = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('tab')
      const map = { cards: 'cards', graph: 'graph', usage: 'stats', stats: 'stats', audit: 'audit', recycle: 'optimize', optimize: 'optimize', config: 'config', terminal: 'terminal' }
      if (tab && map[tab]) return map[tab] // 深链：?tab=audit / config / graph / usage / recycle
    } catch {}
    return 'cards'
  })
  // 懒挂载：面板首次切到该视图才 mount，之后保持 mount（切页不丢状态）。
  // 目的：打开「设置 / 配置」不该顺带拉 250KB 卡片列表 + 890KB 知识图谱。
  const [visited, setVisited] = useState(() => new Set([view]))
  const goView = useCallback((v) => {
    setVisited((s) => (s.has(v) ? s : new Set(s).add(v)))
    setView(v)
  }, [])
  const [sort, setSort] = useState('recent') // 'recent' | 'title' | 'hot'
  const [libToast, setLibToast] = useState(null)
  const libToastTimer = useRef(null)
  const importRef = useRef(null)
  const [exporting, setExporting] = useState(false)
  const [reader, setReader] = useState(null)
  const [allVaults, setAllVaults] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [supportTab, setSupportTab] = useState('group')
  const [onboardOpen, setOnboardOpen] = useState(false)
  const finishOnboard = useCallback(() => {
    setOnboardOpen(false)
    try { localStorage.setItem('me-onboard-v2', '1') } catch { /* 隐私模式忽略 */ }
  }, [])
  const openSupport = useCallback((tab = 'group') => { setSupportTab(tab); setSupportOpen(true) }, [])
  // 左侧栏「Web 版」：用系统默认浏览器打开独立 Web UI。
  // 顺序：① 服务端 /open-web（真·系统浏览器，Host/常驻都可以；带本地白名单）
  //       ② 失败再退回 window.open（老宿主还没有这条路由时，至少能在浏览器/新窗口打开）
  //       ③ 都失败就把地址显示出来，让用户自己粘。
  const webBusyRef = useRef(false)
  const openWebVersion = useCallback(async () => {
    if (webBusyRef.current) return
    webBusyRef.current = true
    const show = (msg, ok = true) => {
      if (libToastTimer.current) clearTimeout(libToastTimer.current)
      setLibToast({ ok, msg })
      libToastTimer.current = setTimeout(() => setLibToast(null), 3000)
    }
    show(t('webOpening'))
    try {
      const r = await fetch(`${API}/open-web`, { method: 'POST' }).then((x) => x.json()).catch(() => null)
      if (r && r.ok && r.url) { show(t('webOpened') + ' · ' + r.url); return }
      // 老宿主/独立页没有 /open-web 时：先查地址，再用 window.open 兜底
      const info = await fetch(`${API}/web-info`).then((x) => x.json()).catch(() => null)
      // 兜底地址用常驻实例默认端口，而不是宿主同源壳：宿主壳在外部浏览器里要 DSH 登录态，不叫「Web 版」。
      const url = (info && info.ok && info.url) || 'http://127.0.0.1:7999/'
      const w = window.open(url, '_blank', 'noopener,noreferrer')
      show(w ? t('webOpened') + ' · ' + url : t('webOpenFail') + ' · ' + url, !!w)
    } catch (e) {
      show(t('webOpenFail'), false)
    } finally {
      webBusyRef.current = false
    }
  }, [t])
  useEffect(() => {
    try {
      if (localStorage.getItem('me-onboard-v2')) return
      if (view !== 'cards') return
      const id = setTimeout(() => setOnboardOpen(true), 900)
      return () => clearTimeout(id)
    } catch { /* 隐私模式不弹 */ }
  }, [view])
  const [railOpen, setRailOpen] = useState(true)
  const [newCard, setNewCard] = useState(null)
  const [dataVer, setDataVer] = useState(0)
  const bump = useCallback(() => setDataVer((v) => v + 1), [])
  // 两套存储：隔离区计数（审核中心 / 回收中心徽标）。overview.quarantine 由服务端给出。
  const quarantinePending = overview?.quarantine?.pending ?? 0
  const quarantineDeleted = overview?.quarantine?.deleted ?? 0
  const searchTimer = useRef(null)
  const [cardTotal, setCardTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const sentinelRef = useRef(null)
  const mainRef = useRef(null)

  const loadCards = useCallback(async (nextKind = kind, nextQuery = query, nextStatus = statusFilter, opts = {}) => {
    const append = opts.append === true
    try {
      if (append) setLoadingMore(true)
      else { setLoading(true); setError('') }
      const qs = new URLSearchParams()
      if (nextKind && nextKind !== 'all') qs.set('kind', nextKind)
      if (nextQuery.trim()) qs.set('q', nextQuery.trim())
      const tagQ = opts.tag !== undefined ? opts.tag : tagPick
      if (tagQ) qs.set('tag', tagQ)
      qs.set('status', nextStatus || 'all')
      qs.set('limit', String(PAGE_SIZE))
      qs.set('offset', String(opts.offset || 0))
      // 标题排序必须由服务端做，否则只对已加载的那一页有序
      if (sort === 'title') qs.set('sort', 'title')
      const res = await fetch(`${API}/cards?${qs.toString()}`)
      const data = await res.json()
      if (data.ok) {
        const list = data.cards || []
        setCards((prev) => (append ? [...prev, ...list.filter((c) => !prev.some((p) => p.path === c.path))] : list))
        setCardTotal(Number(data.total) || list.length)
      }
    } catch (e) {
      setError(String(e && e.message ? e.message : e))
    } finally {
      if (append) setLoadingMore(false)
      else setLoading(false)
    }
  }, [kind, query, statusFilter, sort, tagPick])

  const loadAll = useCallback(async () => {
    try {
      // 只拉轻量数据（<1KB）：概览 + 沉淀健康状态。
      // 卡片列表（250KB）/ 图谱（890KB）改由各自视图按需拉取——设置页不该付这份代价。
      const [ov, capRes] = await Promise.all([
        fetch(`${API}/overview`).then((r) => r.json()),
        fetch(`${API}/capture-log`).then((r) => r.json()).catch(() => null),
      ])
      if (ov.ok) setOverview(ov)
      setCapHealth(capRes && capRes.ok && capRes.available ? (capRes.health || null) : null)
    } catch (e) {
      setError(String(e && e.message ? e.message : e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 删除单张记忆卡（卡片行按钮 / 卡片阅读器）
  const deleteMemory = async (path) => {
    try {
      const res = await fetch(`${API}/delete?path=${encodeURIComponent(path)}`)
      const data = await res.json()
      if (data.ok) { setLibToast({ ok: true, msg: t('deleted') }); await loadAll(); bump() }
      else setLibToast({ ok: false, msg: (data.error || t('deleteFail')) })
    } catch (e) {
      setLibToast({ ok: false, msg: t('deleteFail') })
    }
    if (libToastTimer.current) clearTimeout(libToastTimer.current)
    libToastTimer.current = setTimeout(() => setLibToast(null), 2000)
  }

  useEffect(() => {
    loadAll()
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [loadAll])

  const onSearch = (value) => {
    setQuery(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => loadCards(kind, value, statusFilter), 280)
  }

  const onKind = (k) => {
    setKind(k)
    loadCards(k, query, statusFilter)
  }
  // 点标签芯片 → 立即按该标签筛选（同一 tick 用显式参数，避免读到旧 state）
  const onTagPick = (tag) => {
    const next = String(tag || '')
    setTagPick(next)
    setReader(null)
    loadCards(kind, query, statusFilter, { tag: next })
  }

  // 状态筛选变更 → 按该状态重新拉取（pending/rejected 走 /cards?status=）
  // 只在真正看「知识卡」视图时拉卡片；切回来或数据变更（dataVer）时刷新。
  useEffect(() => {
    if (view !== 'cards') return
    loadCards(kind, query, statusFilter)
  }, [statusFilter, view, dataVer, sort, tagPick])

  // 无限滚动：滚动到底部哨兵进入视口时再续拉一页。root 指向实际滚动容器(.mc-main)，
  // 否则 IntersectionObserver 以 viewport 为基准在内部滚动容器里判定失效，导致不触发。
  // ⚠ 必须放在 loadCards 定义之后：依赖数组在渲染期求值，写在前面会因 TDZ 抛
  //   "Cannot access 'loadCards' before initialization" 把整个记忆页渲染搞崩。
  useEffect(() => {
    if (view !== 'cards' || loading || loadingMore) return
    if (cards.length >= cardTotal) return // 已加载完（total 由服务端返回）
    const el = sentinelRef.current
    const root = mainRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0] && entries[0].isIntersecting) loadCards(kind, query, statusFilter, { append: true, offset: cards.length })
    }, { root: root || null, rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [view, cards, cardTotal, loading, loadingMore, kind, query, statusFilter, loadCards])

  const changeCardKind = async (path, kind) => {
    try {
      const r = await fetch(`${API}/card-kind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, kind }),
      }).then((x) => x.json())
      if (!r || !r.ok) {
        setLibToast({ ok: false, msg: (r && r.error) || t('coreSetFail') })
      } else {
        setReader((prev) => (prev && prev.path === path ? { ...prev, kind: r.kind } : prev))
        await loadAll()
        bump()
        setLibToast({ ok: true, msg: kind === 'core' ? t('coreSetOk') : t('coreUnsetOk') })
      }
    } catch (e) {
      setLibToast({ ok: false, msg: String((e && e.message) || e) })
    }
    if (libToastTimer.current) clearTimeout(libToastTimer.current)
    libToastTimer.current = setTimeout(() => setLibToast(null), 2000)
  }

  const openCard = async (card) => {
    try {
      // 两套存储：未审核 / 回收站卡在隔离区，读取必须显式声明 status，
      // 否则服务端按「只读主库」处理并返回 403（CARD_NOT_APPROVED）。
      // 列表来自 /cards（带 status），但审核中心 / 回收站的卡片对象不一定带 —— 两侧都兜住。
      let st = card.status
      if (!st && card.path) {
        try {
          const r = await fetch(`${API}/cards?status=all&q=${encodeURIComponent(card.title || '')}&limit=50`).then((x) => x.json())
          const hit = (r.cards || []).find((c) => c.path === card.path)
          if (hit) st = hit.status
        } catch { /* 取不到就按主库处理 */ }
      }
      const qs = st && st !== 'approved' ? `&status=${encodeURIComponent(st)}` : ''
      const res = await fetch(`${API}/card?path=${encodeURIComponent(card.path || card.id)}${qs}`)
      const data = await res.json()
      if (data.ok) setReader({ path: data.path, title: card.title, text: data.text, kind: card.kind || 'knowledge' })
      else setError(data.error || `HTTP ${res.status}`)
    } catch (e) {
      setError(String(e && e.message ? e.message : e))
    }
  }

  const exportVault = async (format, selfPick) => {
    setExporting(true)
    try {
      const res = await fetch(`${API}/export`)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'export failed')
      let content, name, mime
      // JSON 备份写成带信封的对象（老版本只认 payload.cards，所以信封比裸数组更互通）；
      // /import 同时兼容裸数组，v0.10.0 及以前导出的备份仍能导回。
      if (format === 'json') {
        name = 'memory-vault.json'; mime = 'application/json'
        const cards = data.cards.map((c) => ({ path: c.path, title: c.title, kind: c.kind, status: c.status, store: c.store, text: c.text }))
        content = JSON.stringify({
          format: data.format || 'memory-eternal-vault',
          formatVersion: data.formatVersion || 1,
          exportedAt: data.exportedAt || new Date().toISOString(),
          count: cards.length,
          cards,
        }, null, 2)
      }
      else { name = 'memory-vault.md'; mime = 'text/markdown;charset=utf-8'; content = data.cards.map((c) => c.text.trim()).filter(Boolean).join('\n\n---\n\n') }
      const blob = new Blob([content], { type: mime })
      const r = await saveFile(blob, name, false)
      if (!r.ok) { setLibToast({ ok: false, msg: t('exportFail') }); setExporting(false); return }
      setLibToast({ ok: true, msg: t('exportedTo') + '：' + t('defaultDownloads') + ' · ' + r.name })
    } catch (e) {
      setLibToast({ ok: false, msg: t('exportFail') + ' · ' + (e.message || '') })
    } finally {
      setExporting(false)
    }
    if (libToastTimer.current) clearTimeout(libToastTimer.current)
    libToastTimer.current = setTimeout(() => setLibToast(null), 2600)
  }

  const importVault = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const res = await fetch(`${API}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
      const data = await res.json()
      if (data.ok) {
        await loadAll()
        const n = data.imported || 0
        let msg = t('importedVault') + '：' + n
        if (data.total) msg += t('importedTotal') + data.total + t('importedTotalTail')
        if (data.quarantined) msg += t('importedQuarantine') + data.quarantined + t('importedQuarantineTail')
        if (data.skipped) msg += t('importedSkipped') + data.skipped + t('importedSkippedTail')
        if (data.warning) msg += ' · ' + data.warning
        // 一张都没进来（且文件本来有卡）时按失败提示：静默的「0 张」正是这次 bug 最难查的地方。
        setLibToast({ ok: n > 0 || !data.total, msg })
      }
      else setLibToast({ ok: false, msg: (data.error || t('importFail')) })
    } catch (err) {
      setLibToast({ ok: false, msg: t('importFail') })
    }
    if (libToastTimer.current) clearTimeout(libToastTimer.current)
    libToastTimer.current = setTimeout(() => setLibToast(null), 2400)
  }

  const sortedCards = useMemo(() => {
    let arr = cards.slice()
    if (agentFilter !== 'all') arr = arr.filter((c) => normAgent(c.submittedBy) === agentFilter)
    if (statusFilter !== 'all') arr = arr.filter((c) => (c.status || 'approved') === statusFilter)
    if (onlyPinned) arr = arr.filter((c) => pinned.has(c.path))
    if (sort === 'title') arr.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')))
    else if (sort === 'hot') arr.sort((a, b) => ((b.weight || b.links || 0) - (a.weight || a.links || 0)))
    else arr.sort((a, b) => (new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime()))
    return arr
  }, [cards, sort, agentFilter, statusFilter, onlyPinned, pinned])
  const cardAgents = useMemo(() => [...new Set(cards.map((c) => normAgent(c.submittedBy)))], [cards])
  const connMap = useMemo(() => {
    const m = {}
    for (const c of cards) {
      const set = new Set(c.tags || [])
      let n = 0
      for (const o of cards) if (o.path !== c.path && (o.tags || []).some((x) => set.has(x))) n++
      m[c.path] = n
    }
    return m
  }, [cards])
  const [featuredPath, setFeaturedPath] = useState(null)
  const featuredCard = useMemo(() => {
    if (!sortedCards.length) return null
    const chosen = featuredPath ? sortedCards.find((c) => c.path === featuredPath) : null
    if (chosen) return chosen
    const old = sortedCards.find((c) => Date.now() - new Date(c.updated || 0).getTime() > 21 * 86400000)
    return old || sortedCards[0]
  }, [sortedCards, featuredPath])
  const nextFeature = () => {
    if (!sortedCards.length) return
    const i = sortedCards.findIndex((c) => c.path === (featuredCard && featuredCard.path))
    setFeaturedPath(sortedCards[(i + 1 + sortedCards.length) % sortedCards.length].path)
  }
  const showFeature = !query && kind === 'all' && !tagPick && statusFilter === 'all' && !!featuredCard

  return (
    <div className="memory-eternal-root me-v5" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{CSS}</style>
      {!inModal && (
        <div className={`mc-v5-top${inHost ? ' in-host' : ''}`}>
          <img className="mc-v5-logo" src={brandIcon} alt="" />
          <span className="mc-v5-crumb"><b>{t('memoryTitle')}</b><i>/</i><span>{t(view === 'cards' ? 'cardsTab' : view === 'graph' ? 'graphTab' : view === 'stats' ? 'tabUsage' : view === 'audit' ? 'tabAudit' : view === 'optimize' ? 'tabRecycle' : view === 'terminal' ? 'terminalTab' : 'tabConfig')}</span></span>
          <div className="spacer" />
          <div className="mc-v5-top-actions">
            <span className="mc-v5-sys"><i />{t('v5Local')}</span>
            <span className="mc-v5-ver">v{CLIENT_VERSION}</span>
            <button type="button" className="mc-v5-star" onClick={() => openExternal('https://github.com/EternalNight996/memory-eternal')} title={t('v5Star')}>★ <span className="mc-v5-star-label">Star</span></button>
            <button type="button" className="mc-v5-help" onClick={() => openSupport('group')} title={t('supportTitle')} aria-label={t('supportTitle')}>?</button>
          </div>
        </div>
      )}
      {libToast && <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'fixed', left: '50%', transform: 'translateX(-50%)', top: 22, zIndex: 70, background: 'rgba(20,22,26,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: '#f5f5f5', borderRadius: 12, padding: '10px 20px', fontSize: 13.5, fontWeight: 600, boxShadow: '0 14px 44px rgba(0,0,0,.5)', pointerEvents: 'none', animation: 'me-pop .22s ease', borderLeft: '4px solid ' + (libToast.ok ? '#22c55e' : '#ef4444'), maxWidth: '90vw' }}><span style={{ color: libToast.ok ? '#34d399' : '#f87171', fontWeight: 800, fontSize: 15 }}>{libToast.ok ? '✓' : '✕'}</span><span>{libToast.msg}</span></div>}
      {inModal && (
        <div className="me-modal-head">
          <div className="me-modal-title">
            <span className="me-wicon"><img src={brandIcon} alt="" /></span>
            <h2>{t('memoryTitle')}</h2>
            <span>{t('memoryHint')}</span>
          </div>
          <div className="spacer" />
          <button type="button" className="me-modal-close me-modal-x" onClick={onClose} aria-label={t('close')} title={t('close')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      )}
      {capHealth && capHealth.ok === false && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 8px', padding: '9px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.45)', borderLeft: '4px solid #ef4444', color: 'var(--dsw-alias-label-primary, #e5e7eb)', fontSize: 12.5, lineHeight: 1.6 }}>
          <span style={{ fontWeight: 800 }}>⚠ {t('captureAlert')}</span>
          <span style={{ flex: 1 }}>
            {capHealth.reason}
            <div style={{ opacity: 0.68, fontSize: 11.5, marginTop: 2 }}>{t('captureAlertHint')}</div>
          </span>
          <span style={{ opacity: 0.7 }}>{capHealth.since ? fmtDate(new Date(capHealth.since).toISOString()) : ''}</span>
        </div>
      )}
      <div className="me-modal-body">
        <div className={`mc-rail${railOpen ? ' open' : ''}`}>
          <div className="mc-v5-rail-top">
            {railOpen && <div className="mc-v5-railbrand"><img className="mark" src={brandIcon} alt="" /><div><b>{t('memoryTitle')}</b><span>MEMORY ATLAS</span></div></div>}
            <button type="button" className="mc-rail-collapse" onClick={() => setRailOpen((v) => !v)} aria-label={railOpen ? t('collapse') : t('expand')} title={railOpen ? t('collapse') : t('expand')}>{railOpen ? '«' : '»'}</button>
          </div>
          {railOpen && <div className="mc-rail-sec">{t('navWorkspace')}</div>}
          <button type="button" className={`mc-railbtn${view === 'cards' ? ' active' : ''}`} onClick={() => goView('cards')} title={t('cardsTab')}>
            <span className="mc-rail-ico">🧠</span>
            {railOpen && <span className="mc-rail-label">{t('cardsTab')}</span>}
          </button>
          <button type="button" className={`mc-railbtn${view === 'graph' ? ' active' : ''}`} onClick={() => goView('graph')} title={t('graphTab')}>
            <span className="mc-rail-ico">🔮</span>
            {railOpen && <span className="mc-rail-label">{t('graphTab')}</span>}
          </button>
          <button type="button" className={`mc-railbtn${view === 'stats' ? ' active' : ''}`} onClick={() => goView('stats')} title={t('tabUsage')}>
            <span className="mc-rail-ico">📈</span>
            {railOpen && <span className="mc-rail-label">{t('tabUsage')}</span>}
          </button>
          <button type="button" className={`mc-railbtn${view === 'audit' ? ' active' : ''}`} onClick={() => goView('audit')} title={t('tabAudit')}>
            <span className="mc-rail-ico">🔍</span>
            {railOpen && <span className="mc-rail-label">{t('tabAudit')}</span>}
            {quarantinePending > 0 && <span className="mc-dot">{quarantinePending > 99 ? '99+' : quarantinePending}</span>}
          </button>
          {railOpen && <div className="mc-rail-sec">{t('navSystem')}</div>}
          <button type="button" className={`mc-railbtn${view === 'optimize' ? ' active' : ''}`} onClick={() => goView('optimize')} title={t('tabRecycle')}>
            <span className="mc-rail-ico">♻️</span>
            {railOpen && <span className="mc-rail-label">{t('tabRecycle')}</span>}
            {quarantineDeleted > 0 && <span className="mc-dot" style={{ background: '#6b7280' }}>{quarantineDeleted > 99 ? '99+' : quarantineDeleted}</span>}
          </button>
          <button type="button" className={`mc-railbtn${view === 'terminal' ? ' active' : ''}`} onClick={() => goView('terminal')} title={t('terminalTab')}>
            <span className="mc-rail-ico">▸_</span>
            {railOpen && <span className="mc-rail-label">{t('terminalTab')}</span>}
          </button>
          {/* 「Web 版」：直接用系统默认浏览器打开本机独立 Web UI（不是切视图，所以不加 active）。
              为什么走服务端：iframe 里 window.open 常被宿主拦；服务端用 rundll32/open/xdg-open 起真浏览器。 */}
          <button type="button" className="mc-railbtn" onClick={openWebVersion} title={t('webTab')} aria-label={t('webTab')}>
            <span className="mc-rail-ico">🌐</span>
            {railOpen && <span className="mc-rail-label">{t('webTab')}</span>}
          </button>
          <button type="button" className={`mc-railbtn${view === 'config' ? ' active' : ''}`} onClick={() => goView('config')} title={t('tabConfig')}>
            <span className="mc-rail-ico">⚙️</span>
            {railOpen && <span className="mc-rail-label">{t('tabConfig')}</span>}
          </button>
          {railOpen && <div className="mc-rail-sec">{t('navSupport')}</div>}
          <button type="button" className="mc-railbtn" onClick={() => openSupport('group')} title={t('supportGroup')}>
            <span className="mc-rail-ico">💬</span>
            {railOpen && <span className="mc-rail-label">{t('supportGroup')}</span>}
          </button>
          <button type="button" className="mc-railbtn" onClick={() => openSupport('sponsor')} title={t('supportSponsor')}>
            <span className="mc-rail-ico">☕</span>
            {railOpen && <span className="mc-rail-label">{t('supportSponsor')}</span>}
          </button>
          <button type="button" className="mc-railbtn" onClick={() => openSupport('legacy')} title={t('supportLegacy')}>
            <span className="mc-rail-ico">🧩</span>
            {railOpen && <span className="mc-rail-label">{t('supportLegacy')}</span>}
          </button>
          <button type="button" className="mc-railbtn" onClick={() => setFeedbackOpen(true)} title={t('fbNav')}>
            <span className="mc-rail-ico">🐞</span>
            {railOpen && <span className="mc-rail-label">{t('fbNav')}</span>}
          </button>
        </div>
        <div className="mc-main" ref={mainRef}>
        {/* 库不可写（#33）：跨标签明示一次，并说清"配置仍可保存"，避免用户以为整个插件坏了。
            详情与恢复步骤来自 /overview 的 db 字段（0.10.21 起返回）。 */}
        {overview && overview.db && overview.db.writable === false ? (
          <div style={{ margin: '8px 10px 0', padding: '8px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.7, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)', color: '#b91c1c' }}>
            ⚠️ {t('dbReadonlyTitle')}：{overview.db.error || '—'} —— {t('dbReadonlyBody')}
            <div style={{ opacity: 0.85, marginTop: 2 }}>{t('dbReadonlyFix')}</div>
          </div>
        ) : null}
        {view === 'cards' && (
          <div className="mc-v5-pagehead">
            <div>
              <div className="mc-v5-eyebrow">MEMORY LIBRARY</div>
              <h1>{t('memoryTitle')}</h1>
              <p>{t('memoryHint')}</p>
              <div className="mc-v5-pagehead-stats">
                <span><b>{overview?.total ?? '—'}</b> {t('cardsUnit')}</span>
                <span>{t('recent')} +{overview?.recent ?? 0}</span>
                <span>{t('pending')} {overview?.quarantine?.pending ?? overview?.status?.pending ?? 0}</span>
                <span>{t('rejected')} {overview?.quarantine?.rejected ?? overview?.status?.rejected ?? 0}</span>
              </div>
            </div>
            <span className="mc-v5-pagecount">{cards.length} / {cardTotal}</span>
          </div>
        )}

        {view === 'cards' && (
          <div className="mc-toolbar">
            <input
              type="text"
              placeholder={t('searchPlaceholder')}
              value={query}
              onChange={(e) => onSearch(e.target.value)}
            />
            {tagPick && (
              <button type="button" className="mc-chip active" title={t('clearFilter')} onClick={() => onTagPick('')}>
                🏷 {tagPick} <span style={{ opacity: 0.7 }}>✕</span>
              </button>
            )}
            <input ref={importRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={importVault} />
            <button type="button" className="mc-btn" onClick={() => importRef.current && importRef.current.click()}>{t('importVault')}</button>
            <button type="button" className="mc-btn me-on" onClick={() => setNewCard({ kind: 'knowledge', title: '', body: '', tags: '', template: '' })}>+ {t('newCard')}</button>
            <button type="button" className="mc-btn" disabled={exporting} onClick={() => exportVault('md')}>{exporting ? t('exporting') : t('exportVault')}</button>
            <button type="button" className="mc-btn" disabled={exporting} onClick={() => exportVault('json')}>{exporting ? t('exporting') : t('exportJson')}</button>
            <button type="button" className="mc-btn" onClick={() => loadAll()}>{t('refresh')}</button>
          </div>
        )}

        {view === 'cards' && (
          <div className="mc-chips">
            {KIND_IDS.map((k) => (
              <button key={k} type="button" className={`mc-chip${kind === k ? ' active' : ''}`} onClick={() => onKind(k)}>
                {k === 'all' ? t('all') : t(KIND_LABELS[k])}
                <span className="mc-chip-n">{k === 'all' ? (overview?.total ?? 0) : (overview?.byKind?.[k] ?? 0)}</span>
              </button>
            ))}
            <button type="button" className={`mc-chip${onlyPinned ? ' active' : ''}`} onClick={() => setOnlyPinned((v) => !v)}>📌 {t('pinnedOnly')}<span className="mc-chip-n">{pinned.size}</span></button>
            <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, #d1d5db)' }}>
              <option value="all">🤖 {t('allAgents')}</option>
              {agentOptions(cardAgents).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, #d1d5db)' }}>
              <option value="all">{t('allStatus')}</option>
              <option value="approved">{t('statusApproved')}</option>
              <option value="pending">{t('statusPending')}</option>
              <option value="rejected">{t('statusRejected')}</option>
            </select>
            <span className="spacer" style={{ flex: 1 }} />
            {[{ key: 'recent', label: t('sortRecent') }, { key: 'title', label: t('sortTitle') }, { key: 'hot', label: t('sortHot') }].map((o) => (
              <button key={o.key} type="button" className={`mc-chip${sort === o.key ? ' active' : ''}`} onClick={() => setSort(o.key)}>{o.label}</button>
            ))}
          </div>
        )}

        {error && <div className="mc-empty">{t('error')}：{error}</div>}

        <div style={{ display: view === 'cards' ? 'contents' : 'none' }}>
          {loading
            ? <LoadingNote text={t('loading')} />
            : error
              ? <div className="mc-empty">{t('error')}：{error} <button type="button" className="mc-btn" onClick={() => loadAll()}>{t('retry')}</button></div>
            : cards.length === 0
              ? <div className="mc-empty">{t('empty')}</div>
              : <>{showFeature && (
                <div className="mc-v5-feature" onClick={() => openCard(featuredCard)}>
                  <div className="mc-v5-feature-copy">
                    <div className="mc-v5-eyebrow">{t('todayReview')}</div>
                    <h3>{featuredCard.title}</h3>
                    <p>{cardLead(featuredCard)}</p>
                    <div className="mc-v5-feature-meta">
                      <span>{KIND_EMOJI[featuredCard.kind] || '📎'} {t(KIND_LABELS[featuredCard.kind] || 'kindKnowledge')}</span>
                      <span>🕒 {fmtDate(featuredCard.updated)}</span>
                      {(featuredCard.tags || []).slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}
                    </div>
                  </div>
                  <div className="mc-v5-feature-side">
                    <MiniGraph n={connMap[featuredCard.path] || 0} color={KIND_COLORS[featuredCard.kind] || KIND_COLORS.other} size={58} />
                    <b>{connMap[featuredCard.path] || 0}</b>
                    <span>{t('links')}</span>
                    <button type="button" className="mc-v5-feature-shuffle" onClick={(e) => { e.stopPropagation(); nextFeature() }}>{t('reshuffle')}</button>
                    <span className="mc-v5-feature-open">{t('openArrow')}</span>
                  </div>
                </div>
              )}<div className="mc-grid">{sortedCards.filter((card) => !showFeature || card.path !== featuredCard.path).map((card) => <CardRow key={card.path} card={card} t={t} query={query.trim()} onOpen={openCard} onDelete={deleteMemory} onTagClick={onTagPick} pinned={pinned.has(card.path)} onPin={togglePin} links={connMap[card.path] || 0} />)}</div>{cards.length < cardTotal && <div ref={sentinelRef} style={{ height: 1 }} />}{loadingMore && <div className="mc-empty" style={{ padding: '10px 0' }}>{t('loading')}（{cards.length} / {cardTotal}）</div>}</>
          }
        </div>
        <div style={{ display: view === 'graph' ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          {/* active 必须跟着视图走：以前恒为 true → 打开任何视图都拉 890KB 图谱（约 3.5s） */}
          {visited.has('graph') && <GraphView t={t} onOpen={openCard} all={allVaults} onAllChange={setAllVaults} onMutate={bump} active={view === 'graph'} visible={view === 'graph'} />}
        </div>
        <div style={{ display: view === 'terminal' ? 'contents' : 'none' }}>
          {visited.has('terminal') && <TerminalGuide t={t} />}
        </div>
        <div style={{ display: view === 'config' ? 'contents' : 'none' }}>
          {visited.has('config') && <ConfigPanel t={t} onReload={() => loadAll()} version={dataVer} />}
        </div>
        <div style={{ display: view === 'stats' ? 'contents' : 'none' }}>
          {visited.has('stats') && <LibraryAdmin t={t} tab="stats" onReload={() => loadAll()} version={dataVer} />}
        </div>
        <div style={{ display: view === 'audit' ? 'contents' : 'none' }}>
          {visited.has('audit') && <AuditPanel t={t} onReload={() => loadAll()} version={dataVer} />}
        </div>
        <div style={{ display: view === 'optimize' ? 'contents' : 'none' }}>
          {visited.has('optimize') && <RecoverPanel t={t} onReload={() => loadAll()} version={dataVer} />}
        </div>

        {feedbackOpen && <FeedbackModal t={t} onClose={() => setFeedbackOpen(false)} />}
        {supportOpen && <SupportModal t={t} tab={supportTab} onTab={setSupportTab} onClose={() => setSupportOpen(false)} onFeedback={() => { setSupportOpen(false); setFeedbackOpen(true) }} onReplay={() => { setSupportOpen(false); setOnboardOpen(true) }} />}
        {onboardOpen && <Onboarding t={t} onDone={finishOnboard} />}
        {reader && <CardReader t={t} card={reader} query={query.trim()} onNavigate={(d) => { const i = sortedCards.findIndex((c) => c.path === reader.path); const next = sortedCards[i + d]; if (next) openCard(next) }} onTagClick={onTagPick} onClose={() => setReader(null)} onDelete={(p) => { setReader(null); deleteMemory(p) }} onFeedback={(useful) => { const p = reader.path; fetch(`${API}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query.trim(), path: p, useful }) }).then(() => setLibToast({ ok: true, msg: useful ? t('fbUseful') : t('fbIrr') })).catch(() => {}); if (libToastTimer.current) clearTimeout(libToastTimer.current); libToastTimer.current = setTimeout(() => setLibToast(null), 2000) }} allCards={sortedCards} onOpenRelated={(c) => openCard(c)} onKindChange={changeCardKind} />}
        <NewCardModal t={t} newCard={newCard} setNewCard={setNewCard} onCreated={() => { loadAll(); bump(); setLibToast({ ok: true, msg: t('created') }); if (libToastTimer.current) clearTimeout(libToastTimer.current); libToastTimer.current = setTimeout(() => setLibToast(null), 2000) }} />
        </div>
      </div>
    </div>
  )
}

/** 面板内联提示条：操作结果就地反馈（比 fixed toast 可靠，不受滚动/裁剪影响）。 */
const InlineToast = ({ toast }) => (toast ? (
  <div className="mc-card" style={{ marginBottom: 10, padding: '8px 12px', fontSize: 12, borderLeft: '4px solid ' + (toast.ok ? '#10b981' : '#ef4444'), background: toast.ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)' }}>
    {toast.ok ? '✅' : '⚠'} {toast.msg}
  </div>
) : null)

const StatCell = ({ label, value }) => (
  <div className="mc-stat mc-card">
    <b>{value}</b>
    <span>{label}</span>
  </div>
)

/** DSH 设置→记忆 左栏配置面板：插件信息 + Agent MCP 挂载状态 + 全部配置项（一键推荐 / DSH 记忆配置 / 成本控制 / 自动审核配置 / 服务自管理配置 / 保存）。 */
function ConfigPanel({ t, onReload, version, compact }) {
  const [cfg, setCfg] = useState(null)
  const [revision, setRevision] = useState(0)
  const [schema, setSchema] = useState(null)
  const [form, setForm] = useState(null)
  const [readonly, setReadonly] = useState(false)
  const [viaPending, setViaPending] = useState(false) // 独立 Web 页：改动经「待应用文件」由 DSH 同步
  // 即时同步（SSE）：别处改了配置 → 已打开的页面自动更新；正在编辑时不覆盖用户输入
  const dirtyRef = useRef(false)
  const reloadRef = useRef(null)
  // 已保存、但宿主还没回显的字段 → 渲染时用本地值，避免「先退回旧值再跳回新值」
  const savedOverlayRef = useRef({})
  const [dsh, setDsh] = useState(null)
  const [setupStatus, setSetupStatus] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [saved, setSaved] = useState('')
  // issue #42 ①：可选的 provider / model（动态拉取；取不到就回退文本输入）
  const [routes, setRoutes] = useState(null)
  const [vc, setVc] = useState(null)   // 版本跟踪：运行中 / 磁盘 / npm 最新
  // 界面显示旧版本号 = 宿主进程还在用启动时加载的那份（磁盘更新了也没用），所以这里三版本对照
  // silent：周期轮询/切回标签页时静默刷新（不点亮「检查更新」按钮，也不弹 toast）
  const checkVersion = useCallback(async (force, silent = false) => {
    if (!silent) setBusy('version')
    try {
      const d = await fetch(API + '/version-check' + (force ? '?force=1' : '')).then((r) => r.json())
      if (d && d.ok) {
        setVc(d)
        if (force) notify(d.updateAvailable ? t('vcLatest') + ' v' + d.latest : t('vcUpToDate'))
      } else if (force) notify(t('vcCheckFail'), false)
    } catch { if (force) notify(t('vcCheckFail'), false) } finally { if (!silent) setBusy('') }
  }, [t])
  // 用户反馈：点完「重启常驻实例」后面板一直显示「常驻实例 未运行」—— 因为探针只在挂载时跑一次，
  // 恰好撞上重启窗口就被缓存住了。现在：① 每 60s 静默复查；② 切回页面时立刻复查。
  useEffect(() => {
    checkVersion(false)
    const id = setInterval(() => { checkVersion(false, true) }, 60000)
    const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) checkVersion(false, true) }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [version, checkVersion])
  const [runSetup, setRunSetup] = useState('')
  const [toast, setToast] = useState(null)
  const [appliedPlan, setAppliedPlan] = useState('')
  const [dirty, setDirty] = useState(false)
  const toastTimer = useRef(null)
  const notify = (msg, ok = true) => { if (toastTimer.current) clearTimeout(toastTimer.current); setToast({ msg, ok }); toastTimer.current = setTimeout(() => setToast(null), 1900) }
  // 「重启常驻实例」：常驻 web（默认 7999）比 DSH 宿主活得久 —— 升级只换磁盘文件，端口上那个
  // 进程仍跑着启动时加载的旧代码。这里一键用新代码重启它（服务端走 watchdog --replace 助手：
  // 收旧实例 → 抢锁 → 拉起新 web → 自检端口上真正服务的版本），不需要重启 DSH。
  const restartResident = async () => {
    if (busy) return
    setBusy('restart')
    try {
      const raw = await fetch(API + '/restart-self', { method: 'POST' })
      // 旧版宿主根本没有这个路由：直说「本页所在进程是旧版，请重启桌面版/DSH 或用命令」，
      // 而不是把 404 抛成一句「未知接口」让用户去猜（实测：DSH 设置页 → 旧宿主 → 404）。
      if (raw.status === 404 || raw.status === 405) {
        notify(tf('vcRestartNoRoute', { cmd: (vc && vc.restartCommand) || 'dsh-memory restart --port 7999' }), false)
        return
      }
      const d = await raw.json().catch(() => null)
      if (!d) { notify(t('vcRestartFail') + '（HTTP ' + raw.status + '）', false); return }
      if (!d.ok) { notify(d.error || t('vcRestartFail'), false); return }
      if (d.alreadyCurrent) { notify(d.note || t('vcRestartCurrent')); return }
      notify(d.note || t('vcRestartSent'))
      // 新进程接管要几秒：稍后重新体检，版本号与告警自动更新（不必让用户再点「检查更新」）
      if (!d.alreadyRunning) setTimeout(() => { checkVersion(true) }, 6000)
    } catch (e) { notify(t('vcRestartFail') + '：' + String((e && e.message) || e), false) } finally { setBusy('') }
  }
  // 只有「端口上那个常驻实例落后于磁盘」才该给「重启常驻实例」按钮 —— 那时点了才有用；
  // 若落后的是**服务本页的那个进程**（例如还没重启的 DSH 宿主），重启常驻实例既帮不上忙，
  // 也可能因为旧宿主没有该接口而报 404（本会话实测到的「未知接口」就是这个）。
  const residentServed = vc && vc.resident ? String(vc.resident.served || '') : ''
  const residentStale = Boolean(vc && vc.onDisk && residentServed && residentServed !== vc.onDisk)
  // 常驻实例「没在跑」：探针拿不到任何版本（端口无响应 / 进程死了 / 从没起来）。这也是最需要
  // 一键重启的场景 —— 但过去只在「served 有值且落后」时才给按钮，于是这种情况下面板**整个横幅
  // 都不显示**（vc.stale 为假），用户只看到一条「自动沉淀异常」，找不到能点的东西（实测 #28）。
  // 没在跑（无响应）**或**在跑但没人托管（看门狗被 stop / 被 kill -9 后残留的孤儿 —— 版本号可能还是新的，
  // 但没人保活、也不会被后续升级替换）。后者只有新宿主会报（旧宿主没有 resident.managed 字段，不会误报）。
  // 三态（#33 第③层）：被托管 / 确实没被托管 / **判不出来**（受限环境写不进看门狗锁文件）。
  // 判不出来时若照旧显示「未托管」，用户会以为实例坏了、反复重启 —— 这里单独说出来并解释原因。
  const residentLockUnknown = Boolean(vc && vc.resident && vc.resident.managed === false && vc.resident.managedKnown === false)
  // 「不可替换（环境限制）」：锁目录不可写的机器上，常驻实例**永远追不平**（#30 第五轮复测）。
  // 必须和「暂时落后」分开说 —— 否则用户会一直等一个不会发生的追平。
  const residentReplaceBlocked = (vc && vc.resident && vc.resident.replaceBlocked && vc.resident.replaceBlocked.fresh) || null
  // 「宿主托管」（#30 ④）：锁不可写的机器上由宿主自己保活 —— 锁里没登记，但**不是**孤儿。
  const residentHostManaged = Boolean(vc && vc.resident && vc.resident.managedBy === 'host')
  const residentUnmanaged = Boolean(vc && vc.resident && vc.resident.managed === false && !residentLockUnknown && !residentHostManaged)
  const residentDown = Boolean(vc && vc.resident && !residentServed)
  const residentNeedsRestart = residentStale || residentDown || residentUnmanaged || residentLockUnknown
  // 版本卡的显示判定统一走纯函数（tests/version-card-state.test.mjs 里 324 种组合穷举）——
  // 组件里不再手写三元链：0.10.45 的事故就是那条链漏了「常驻新 + 宿主旧」这一个组合。
  const vstate = versionCardState({
    hasVersion: Boolean(vc),
    hostVersion: vc ? vc.loaded : '',
    onDisk: vc ? vc.onDisk : '',
    residentServed: vc && vc.resident ? vc.resident.served : '',
    residentPresent: Boolean(vc && vc.resident),
    residentManaged: vc && vc.resident ? vc.resident.managed : null,
    residentManagedKnown: vc && vc.resident ? vc.resident.managedKnown : null,
    residentManagedBy: vc && vc.resident ? vc.resident.managedBy : '',
    replaceBlocked: vc && vc.resident ? vc.resident.replaceBlocked : null,
  })
  // key → 文案（组件只负责翻译，判定全在纯函数里）
  const vcWarnText = {
    hostProcessStale: () => tf('vcHostProcessStale', { disk: vc.onDisk, loaded: vc.loaded }),
    residentDown: () => tf('vcResidentDown', { port: (vc.resident && vc.resident.port) || '', cmd: vc.restartCommand || 'dsh-memory restart --port 7999' }),
    residentReplaceBlocked: () => tf('vcResidentReplaceBlocked', { served: residentServed, err: (residentReplaceBlocked && residentReplaceBlocked.error) || '', path: (residentReplaceBlocked && residentReplaceBlocked.lockPath) || '', cmd: vc.restartCommand || ('dsh-memory restart --port ' + ((vc.resident && vc.resident.port) || 7999)) }),
    residentLockUnknown: () => tf('vcResidentLockUnknown', { served: residentServed, path: (vc.resident && vc.resident.lock && vc.resident.lock.path) || '', err: (vc.resident && vc.resident.lock && vc.resident.lock.error) || '' }),
    residentUnmanaged: () => tf('vcResidentUnmanaged', { served: residentServed, cmd: vc.restartCommand || 'dsh-memory restart --port 7999' }),
  }
  const vcHintText = {
    restartStart: () => tf('vcRestartStart', { disk: (vc && vc.onDisk) || '' }),
    restartRepair: () => tf('vcRestartRepair', { disk: (vc && vc.onDisk) || '' }),
    restartFixes: () => tf('vcRestartFixes', { served: residentServed || '', disk: (vc && vc.onDisk) || '' }),
    restartHostOnly: () => tf('vcRestartHostOnly', { loaded: (vc && vc.loaded) || '', disk: (vc && vc.onDisk) || '' }),
    restartAnyway: () => tf('vcRestartAnyway', { ver: (vc && vc.onDisk) || '' }),
  }
  // 词条带 {placeholder} 填充（本项目 t 为词典直查，不含参数替换）
  const tf = (k, map) => Object.keys(map).reduce((s, kk) => s.split('{' + kk + '}').join(map[kk]), t(k))
  const load = useCallback(async () => {
    try {
      const [c, ss, b, rt] = await Promise.all([
        fetch(`${API}/config`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/setup-status`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/budget`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/llm-routes`).then((r) => r.json()).catch(() => null),
      ])
      if (rt && rt.ok) setRoutes(rt)
      if (c && c.ok) {
        setCfg(c)
        setRevision(c.revision ?? 0)
        setSchema(c.schema ?? null)
        // 宿主快照 + 本地叠加层：宿主尚未回流的字段继续用本地值（否则会闪一下旧值）
        const merged = mergeLocalOverlay(c.config ?? {}, savedOverlayRef.current)
        savedOverlayRef.current = merged.overlay
        setForm({ ...merged.values })
        setDirty(false)
        setDsh(c.dsh ?? null)
        setReadonly(c.writable === false)
        setViaPending(c.viaPending === true)
        setErr('')
        dirtyRef.current = false // 已与服务端对齐，后续 SSE 推送可以安全覆盖
      } else {
        // /config 不可用（如独立 web server 7999 无 DSH settings）：降级用 /budget 展示 + 提示
        if (b && b.ok) {
          setForm({ ...b })
          setDirty(false)
          setReadonly(true)
          setErr(t('configNeedsDsh'))
        } else {
          setErr(t('adminLoadFail'))
        }
      }
      if (ss && ss.ok) setSetupStatus(ss)
      setSaved('')
    } catch (e) { setErr(t('adminLoadFail')) }
  }, [t])
  useEffect(() => { load() }, [version, load])
  const set = (k, v) => { dirtyRef.current = true; setDirty(true); setAppliedPlan(''); setForm((f) => ({ ...(f ?? {}), [k]: v })) }
  useEffect(() => { reloadRef.current = load }, [load])
  // SSE 订阅：配置变更即时到达（不依赖手动刷新）
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined
    let es = null
    try { es = new EventSource(API + '/events') } catch { return undefined }
    const onConfig = () => { if (!dirtyRef.current && typeof reloadRef.current === 'function') reloadRef.current() }
    try { es.addEventListener('config', onConfig) } catch { /* 老浏览器忽略 */ }
    return () => { try { es.close() } catch { /* 已关闭 */ } }
  }, [])
  const NUM_KEYS_LIKE = new Set(['dedupThreshold', 'captureMinChars', 'captureCooldownMs', 'maxCardsPerDay', 'captureMaxTokens', 'recallMinScore', 'recallLimit', 'recallSummaryLen', 'recycleRetentionDays', 'webPort', 'webCheckIntervalMs', 'webMaxRestart', 'sessionBudgetChars'])
  const autoWebModeLabel = (m) => ({ init: t('modeInit'), interval: t('modeInterval'), manual: t('modeManual') }[m] || m)
  const save = async () => {
    if (!form) return
    if (readonly) { notify(t('editInSetting'), false); return }
    // 数字字段先按 schema 范围自检：宿主对非法值只回空 500，用户只会看到「保存失败」（issue #12 复现）
    const NUM_RANGE = {
      dedupThreshold: [0, 1], captureMinChars: [0, 1000000], captureCooldownMs: [0, 1000000000],
      maxCardsPerDay: [0, 1000000], captureMaxTokens: [100, 4000], recallMinScore: [0, 50],
      recallLimit: [1, 20], recallSummaryLen: [40, 400], recycleRetentionDays: [1, 3650],
      webPort: [1, 65535], webCheckIntervalMs: [1000, 600000], webMaxRestart: [1, 1000],
      sessionBudgetChars: [0, 1000000000],
    }
    const badFields = []
    for (const [k, [lo, hi]] of Object.entries(NUM_RANGE)) {
      if (!(k in form)) continue
      const raw = form[k]
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n) || n < lo || n > hi) {
        badFields.push(t('invalidField', { field: k, min: lo, max: hi, value: String(raw === '' ? '空' : raw) }))
      }
    }
    if (badFields.length) { const msg = t('saveInvalid') + '：' + badFields.join('；'); setErr(msg); notify(msg, false); return }
    setBusy('save')
    try {
      // 空行（没填名字也没填目录）不要提交：schema 会拒绝，且会让用户莫名其妙
      const payload = { ...form }
      for (const k of Object.keys(form)) if (k in payload && typeof payload[k] === 'string' && payload[k].trim() !== '' && NUM_KEYS_LIKE.has(k)) payload[k] = Number(payload[k])
      if (Array.isArray(payload.vaultProfiles)) {
        payload.vaultProfiles = payload.vaultProfiles.filter((p) => p && (String(p.name || '').trim() || String(p.path || '').trim()))
      }
      const r = await fetch(`${API}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: payload, expectedRevision: revision }) })
      // 宿主对非法值可能回「空响应体 500」：兜底解析，避免只显示无信息量的「保存失败」
      const rawText = await r.text()
      let d = null
      try { d = rawText ? JSON.parse(rawText) : null } catch { d = null }
      if (!d) d = { error: 'HTTP ' + r.status + (rawText ? '：' + rawText.slice(0, 200) : '（宿主未返回原因，请检查是否有数字字段为空或超出范围）') }
      if (d && d.ok) {
        // issue #21：不再一律弹「已保存」。pendingOutcome 有四种可能，只有前两种是真生效：
        //   applied        = 宿主已应用
        //   applied-direct = 本机没有 DSH 宿主，独立服务已直接写入共享配置
        //   queued         = 已交给宿主，尚未确认生效（用非成功样式，别让用户以为已生效）
        //   failed         = 宿主侧应用失败（守卫类错误给出「去哪改」的指路）
        const outcome = typeof d.pendingOutcome === 'string' ? d.pendingOutcome : ''
        let msg
        let okStyle = true
        if (outcome === 'applied') {
          // 方案 A：宿主在 HTTP 请求上下文里应用成功 —— 点保存即生效，不再停在「已排队」
          msg = t('savedApplied') + (Array.isArray(d.applied) && d.applied.length ? ' · ' + d.applied.join('、') : '')
        } else if (outcome === 'queued') {
          okStyle = false
          msg = t('saveQueued')
        } else if (outcome === 'failed') {
          okStyle = false
          msg = t('saveFail') + ' · ' + (d.hostGuard ? t('saveHostGuard') : t('saveFailHint'))
        } else if (outcome === 'applied-direct') {
          msg = t('savedOk') + ' · ' + t('savedDirect')
        } else {
          // 兼容宿主自己拦截实现的 /config（它回的是 pending/retried/note 那套老字段）
          const extra = (Array.isArray(d.pending) && d.pending.length) ? ' · ' + t('savePending') : (d.note ? ' · ' + t('restartHint') : '')
          msg = (d.retried ? '♻ ' : '') + t('savedOk') + extra
        }
        savedOverlayRef.current = { ...savedOverlayRef.current, ...payload }
        if (okStyle) { setAppliedPlan(''); setDirty(false); setSaved(msg) }
        else setErr(msg)
        notify(msg, okStyle)
        await load()
      }
      else { const msg = r.status === 409 ? t('conflictRefresh') : (d?.error || t('saveFail')); setErr(msg); notify(msg, false) }
    } catch { setErr(t('saveFail')); notify(t('saveFail'), false) }
    finally { setBusy('') }
  }
  const resetForm = () => { savedOverlayRef.current = {}; setForm({ ...(cfg?.config ?? {}) }); setAppliedPlan(''); setDirty(false); setSaved('') }
  // -- 多库（#10）：vaultProfiles / activeVault 的可视化编辑 --
  const VAULT_SRC_KEYS = { env: 'vaultSrcEnv', profile: 'vaultSrcProfile', workspace: 'vaultSrcWorkspace', vaultDir: 'vaultSrcVaultDir', default: 'vaultSrcDefault' }
  const profilesOf = (f) => (Array.isArray(f?.vaultProfiles) ? f.vaultProfiles : [])
  const updateProfile = (i, key, value) => { dirtyRef.current = true; setDirty(true); setForm((f) => {
    const list = profilesOf(f).map((x) => ({ ...(x || {}) }))
    const row = { ...(list[i] || {}) }
    if (key === 'match') {
      if (String(value).trim()) row.match = { ...(row.match || {}), workspace: value }
      else delete row.match
    } else row[key] = value
    list[i] = row
    return { ...(f ?? {}), vaultProfiles: list }
  }) }
  const addProfile = () => { dirtyRef.current = true; setDirty(true); setForm((f) => ({ ...(f ?? {}), vaultProfiles: [...profilesOf(f), { name: '', path: '' }] })) }
  const removeProfile = (i) => { dirtyRef.current = true; setDirty(true); setForm((f) => ({ ...(f ?? {}), vaultProfiles: profilesOf(f).filter((_, k) => k !== i) })) }
  const vcChip = { fontSize: 11, padding: '2px 8px', background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', borderRadius: 6 }
  const vaultInput = { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, minWidth: 0 }
  // 三套推荐方案值（A轻量/B省钱/C高质量）——一键填充表单
  const PLANS = {
    A: { label: t('planA'), autoWebMode: 'init', watchdogAutoSpawn: false, distillEnabled: true, dedupByLLM: true, captureMaxTokens: 4000, recallMinScore: 2, recallLimit: 5, recallSummaryLen: 130, recallIncludeBody: false, captureCooldownMs: 300000 },
    B: { label: t('planB'), autoWebMode: 'init', watchdogAutoSpawn: false, distillEnabled: false, dedupByLLM: false, captureMaxTokens: 500, recallMinScore: 3, recallLimit: 3, recallSummaryLen: 80, recallIncludeBody: false, captureMinChars: 300, maxCardsPerDay: 40, captureCooldownMs: 300000 },
    C: { label: t('planC'), autoWebMode: 'interval', watchdogAutoSpawn: true, distillEnabled: true, dedupByLLM: true, captureMaxTokens: 1200, recallMinScore: 1, recallLimit: 8, recallSummaryLen: 200, recallIncludeBody: true, captureCooldownMs: 120000 },
  }
  const applyPlan = (key) => {
    const plan = PLANS[key]
    if (!plan) return
    setForm((f) => ({ ...(f ?? {}), ...plan }))
    dirtyRef.current = true
    setDirty(true)
    setAppliedPlan(key)
    notify(tf('planApplied', { plan: plan.label }))
  }
  // 单智能体安装/卸载 MCP：POST /mcp/action，操作后刷新状态
  const refreshSetup = async () => {
    try { const s = await fetch(API + '/setup-status').then((r) => r.json()); if (s && s.ok) setSetupStatus(s) } catch { /* 探测失败保持旧数据 */ }
  }
  const mcpAction = async (agent, action) => {
    setBusy(agent + action)
    try {
      const r = await fetch(`${API}/mcp/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, action }) })
      const d = await r.json()
      if (d && d.ok) notify(tf(action === 'install' ? 'mcpInstalled' : 'mcpUninstalled', { agent }))
      else notify(tf('mcpActionFail', { agent, error: d?.error || '' }), false)
      try { const s = await fetch(`${API}/setup-status`).then((x) => x.json()); if (s && s.ok) setSetupStatus(s) } catch {}
    } catch { notify(t('mergeFail'), false) }
    finally { setBusy('') }
  }
  const F = ({ k, label, hint, type = 'text', step, min, max }) => (
    <label className="mc-field">
      <span className="mc-field-label">{label || k}</span>
      <input
        type={type}
        step={step} min={min} max={max}
        value={form ? (form[k] ?? '') : ''}
        onChange={(e) => {
          const raw = e.target.value
          // 清空时保留空串（Number('') === 0 会静默变成 0，再被 schema 以 min 拒绝 → 用户只看到「保存失败」）
          set(k, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw)
        }}
      />
      {hint ? <span className="mc-field-hint">{hint}</span> : null}
    </label>
  )
  // schema 里 default(true) 的开关：宿主快照里**还没有这个键**时（旧宿主没升级、或共享配置还没写过它），
  // 界面必须按「默认开」渲染。否则用户看到的是「版本漂移自动重启」没勾上，而实际生效值（宿主里
  // `cfg.autoRestartOnDrift !== false`）是开 —— 面板与真实行为不一致，最容易误判（2026-10-08 实测：
  // 0.10.6 宿主 + 0.10.7 面板 → 复选框空着）。勾选后再改一次才写进配置，未升级的宿主不受影响。
  const BOOL_DEFAULT_ON = new Set(['autoRestartOnDrift'])
  const Bool = ({ k, label }) => {
    const raw = form ? form[k] : undefined
    const on = raw === undefined ? BOOL_DEFAULT_ON.has(k) : !!raw
    return (
      <label className="mc-switch">
        <input type="checkbox" checked={on} onChange={(e) => set(k, e.target.checked)} />
        <span>{label || k}</span>
      </label>
    )
  }
  // 统一分区：图标 + 标题 + 一句说明 + 内容（配置页所有区块共用，视觉一致）
  const CfgSection = ({ icon, title, sub, children }) => (
    <div className="mc-card mc-cfg-sec">
      <div className="mc-cfg-sec-head">
        <div className="mc-cfg-sec-ico">{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div className="mc-cfg-sec-title">{title}</div>
          {sub ? <div className="mc-cfg-sec-sub">{sub}</div> : null}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>{children}</div>
    </div>
  )
  const mcpList = (setupStatus && Array.isArray(setupStatus.agents)) ? setupStatus.agents : []
  const mcpInstalled = mcpList.filter((a) => a.installed)
  const mcpServersAll = [...new Set(mcpInstalled.flatMap((a) => (Array.isArray(a.servers) ? a.servers : [])))]
  const mcpMounted = mcpList.filter((a) => a.mcpConfigured && !a.isDsh).length
  const mcpHasServerData = mcpList.some((a) => Array.isArray(a.servers))
  return (
    <div className="mc-admin" style={{ display: 'flex', flexDirection: 'column', overflow: 'auto', flex: compact ? '0 0 auto' : 1, minHeight: 0, maxHeight: compact ? '52vh' : undefined }}>
      <style>{CSS}</style>
      {toast && <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'fixed', left: '50%', transform: 'translateX(-50%)', top: 22, zIndex: 70, background: 'rgba(20,22,26,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: '#f5f5f5', borderRadius: 12, padding: '10px 20px', fontSize: 13.5, fontWeight: 600, boxShadow: '0 14px 44px rgba(0,0,0,.5)', pointerEvents: 'none', animation: 'me-pop .22s ease', borderLeft: '4px solid ' + (toast.ok ? '#22c55e' : '#ef4444'), maxWidth: '90vw' }}><span style={{ color: toast.ok ? '#34d399' : '#f87171', fontWeight: 800, fontSize: 15 }}>{toast.ok ? '✓' : '✕'}</span><span style={{ wordBreak: 'break-all' }}>{toast.msg}</span></div>}
      <div style={{ overflow: 'auto', padding: 4 }}>
        {!compact && (
          <div className="mc-v5-pagehead">
            <div>
              <div className="mc-v5-eyebrow">MEMORY CONFIG</div>
              <h1>{t('tabConfig')}</h1>
              <p>{t('configPageSub')}</p>
            </div>
            <span className="mc-v5-audit-trust">🛡 {t('v5Local')}</span>
          </div>
        )}
        {err && <div className="mc-card" style={{ borderLeft: '4px solid #ef4444', background: 'rgba(239,68,68,0.08)', padding: '12px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: '#b91c1c', fontWeight: 600, marginBottom: 6 }}>⚠ {err}</div>
          <button type="button" className="mc-btn" onClick={load}>↻ {t('retry')}</button>
        </div>}
        {viaPending && <div className="mc-card" style={{ borderLeft: '4px solid #3b82f6', background: 'rgba(59,130,246,0.08)', padding: '10px 14px', marginBottom: 10, fontSize: 12, color: '#1d4ed8', lineHeight: 1.7 }}>ℹ {t('pendingSyncNote')}</div>}
        {readonly && <div className="mc-card" style={{ borderLeft: '4px solid #f59e0b', background: 'rgba(245,158,11,0.08)', padding: '10px 14px', marginBottom: 10, fontSize: 12, color: '#b45309' }}>ℹ️ {t('configNeedsDsh')} —— {t('editInSetting')}</div>}
        {saved && <div className="mc-card" style={{ borderLeft: '4px solid #10b981', background: 'rgba(16,185,129,0.08)', padding: '10px 14px', marginBottom: 10, fontSize: 12, color: '#059669' }}>✓ {saved}</div>}
        {/* 插件信息：版本跟踪（运行中 / 磁盘 / npm 最新）+ 记忆库目录 */}
        {(cfg && (cfg.version || cfg.dsh?.vaultDir)) && (
          <div className="mc-card" style={{ marginBottom: 10, padding: '10px 14px' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 12 }}>📦 {t('pluginInfo')}</b>
              <span style={{ fontSize: 12, opacity: 0.7 }}>{t('dshHostLabel')}</span>
              {cfg.version && <code style={vcChip}>{t('vcLoaded')} v{cfg.version}</code>}
              {/* 常驻实例（端口上那个进程）与「服务本页的进程」是不同的进程时，必须分开显示 ——
                  这正是「运行中还是旧版本」最容易被误读的地方（宿主已新、常驻 web 仍旧，反之亦然） */}
              {vc && vc.resident && vc.resident.served && vc.resident.served !== cfg.version && (
                <code style={vcChip}>{t('vcResident')} v{vc.resident.served}</code>
              )}
              {vc && vc.resident && !vc.resident.served && (
                <code style={{ ...vcChip, color: '#b45309', fontWeight: 600 }}>{t('vcResident')} {t('vcResidentDownShort')}</code>
              )}
              {vc && vc.resident && vc.resident.served && vc.resident.managed === false && (
                <code style={{ ...vcChip, color: '#b45309', fontWeight: 600 }}>{t('vcResident')} v{vc.resident.served} · {residentReplaceBlocked ? t('vcResidentReplaceBlockedShort') : residentHostManaged ? t('vcResidentHostManagedShort') : residentLockUnknown ? t('vcResidentLockUnknownShort') : t('vcResidentUnmanagedShort')}</code>
              )}
              {CLIENT_VERSION && <code style={vcChip}>{t('vcPage')} v{CLIENT_VERSION}</code>}
              {vc && vc.onDisk && <code style={vcChip}>{t('vcOnDisk')} v{vc.onDisk}</code>}
              {vc && vc.latest && <code style={vcChip}>{t('vcLatest')} v{vc.latest}</code>}
              {cfg.dsh?.vaultDir && <span style={{ fontSize: 11, opacity: 0.6 }}>📁 {cfg.dsh.vaultDir}</span>}
              <div style={{ flex: 1 }} />
              <button type="button" className="mc-btn" disabled={busy === 'version'} onClick={() => checkVersion(true)}>{busy === 'version' ? t('checking') : '🔄 ' + t('vcCheck')}</button>
            </div>
            {/* 警告块：显示哪个 key 由 versionCardState 决定（组件不再手写状态链） */}
            {vc && vstate.warn && (
              <div style={{ marginTop: 8, fontSize: 11.5, color: '#b45309', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 8, padding: '6px 10px' }}>
                <div>⚠️ {vcWarnText[vstate.warn] ? vcWarnText[vstate.warn]() : ''}</div>
              </div>
            )}
            {/* issue #46 反馈：「重启常驻实例」按钮消失了 —— 它原来被包在「有异常才渲染」的警告块里，
                于是版本一对齐就整块消失，用户再也找不到这个按钮（#28 也抱怨过找不到）。
                现在操作行**常驻显示**：异常时是修复入口，一切正常时也能主动重启。 */}
            {/* 按钮**永远存在**（用户连报两轮「按钮消失」）：状态只影响「它现在能解决什么」的说明，
                不再决定按钮是否渲染。三种状态各自给一句准确的话：
                  · 常驻实例旧 → 点了就能换成新版（这就是修复入口）；
                  · 常驻实例新、但**服务本页的进程**旧（DSH 宿主）→ 点了只影响 7999/独立页，本页要重启 DSH；
                  · 全部对齐 → 保留为「卡住时的强制重启」。 */}
            {/* 按钮永远存在：vstate.showButton 只取决于「有没有拿到版本信息」 */}
            {vstate.showButton && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                <button type="button" className={'mc-btn' + (vstate.emphasis ? ' me-on' : '')} disabled={!!busy} onClick={restartResident}>
                  {busy === 'restart' ? '⏳ ' + t('vcRestarting') : '🔄 ' + t('vcRestart')}
                </button>
                {vc.restartCommand && <code style={{ fontSize: 11, opacity: 0.75 }}>{vc.restartCommand}</code>}
                <span style={{ fontSize: 11, opacity: 0.65 }}>
                  {vcHintText[vstate.hint] ? vcHintText[vstate.hint]() : ''}
                </span>
              </div>
            )}
            {/* 最常见的困惑：更新了插件但「当前页面」跑的还是旧脚本 —— 直接告诉用户按刷新 */}
            {CLIENT_VERSION && vc && vc.onDisk && CLIENT_VERSION !== vc.onDisk && (
              <div style={{ marginTop: 8, fontSize: 11.5, color: '#b45309', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 8, padding: '6px 10px', lineHeight: 1.7 }}>
                {t('vcPageStale', { page: CLIENT_VERSION, disk: vc.onDisk })}
              </div>
            )}
            {vc && vc.updateAvailable && <div style={{ marginTop: 8, fontSize: 11.5, opacity: 0.88 }}>⬆ {t('vcOutdated')} → <code>{vc.updateCommand}</code></div>}
            {vc && vc.checkError && <div style={{ marginTop: 8, fontSize: 11.5, color: '#b91c1c' }}>{t('vcCheckFail')}：{vc.checkError}</div>}
          </div>
        )}
        {/* DSH / Agent 状态面板：自动识别本机 Agent 与其已配置的 MCP（含 DSH 宿主行） */}
        {setupStatus && setupStatus.agents && (
          <div className="mc-card mc-cfg-sec">
            <div className="mc-cfg-sec-head">
              <div className="mc-cfg-sec-ico">🔌</div>
              <div style={{ minWidth: 0 }}>
                <div className="mc-cfg-sec-title">{t('mcpSetupStatus')}</div>
                <div className="mc-cfg-sec-sub">{t('mcpAutoHint')}</div>
              </div>
              <span className="mc-cfg-spacer" />
              <button type="button" className="mc-btn" style={{ padding: '2px 8px', flex: 'none' }} onClick={refreshSetup}>{t('mcpRefresh')}</button>
            </div>
            {mcpHasServerData ? <div className="mc-mcp-summary">{tf('mcpSummary', { agents: mcpInstalled.length, servers: mcpServersAll.length, mounted: mcpMounted })}</div> : null}
            {mcpList.map((a) => {
              const hasServers = Array.isArray(a.servers)
              const servers = hasServers ? a.servers : []
              const title = a.isDsh ? t('dshHostLabel') : (a.label || a.name)
              return (
                <div key={a.name + (a.mcpPath || '')} className="mc-mcp-row" style={{ opacity: a.installed ? 1 : 0.55 }}>
                  <div className="mc-mcp-main">
                    <div className="mc-mcp-title">
                      <b>{title}</b>
                      {a.isDsh && a.version && <span className="mc-mcp-badge">v{a.version}</span>}
                      {!a.installed && <span className="mc-mcp-badge">{t('notInstalled')}</span>}
                      {a.installed && a.mcpConfigured === false && <span className="mc-mcp-badge" style={{ color: '#f59e0b' }}>{t('noMcpEntry')}</span>}
                      {a.mcpConfigured === true && <span className="mc-mcp-badge" style={{ color: '#10b981' }}>✓ {t('healthy')}</span>}
                      {a.mcpConfigured === true && a.mcpMatchesCurrentNode === false && <span className="mc-mcp-badge">{t('nodePathNote')}</span>}
                      {a.isDsh && <span className="mc-mcp-badge">{t('recallTool')}: {a.recallTool ? t('enabled') : t('disabled')}</span>}
                      {a.detectedOnly && <span className="mc-mcp-badge">{t('mcpDetectedOnly')}</span>}
                      {a.reason && <span className="mc-mcp-badge" style={{ color: '#f59e0b' }}>{a.reason}</span>}
                    </div>
                    {hasServers ? (servers.length ? (
                      <div className="mc-mcp-servers">
                        {servers.map((s) => <code key={s} className={s === 'memory' ? 'on' : ''}>{s}</code>)}
                      </div>
                    ) : (a.installed ? <div className="mc-mcp-servers"><span style={{ fontSize: 10.5, opacity: 0.45 }}>{t('mcpNoServers')}</span></div> : null)) : null}
                    {a.mcpPath && <div className="mc-mcp-path" title={a.mcpPath}>{a.mcpPath}</div>}
                  </div>
                  <div className="mc-mcp-actions">
                    {a.hook && <span style={{ fontSize: 10.5, opacity: 0.55 }}>hook: {a.hook}</span>}
                    {!a.isDsh && !a.detectedOnly && a.installed && a.mcpConfigured === false && (
                      <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => mcpAction(a.name, 'install')}>{t('installMcp')}</button>
                    )}
                    {!a.isDsh && !a.detectedOnly && a.installed && a.mcpConfigured === true && (
                      <button type="button" className="mc-btn" style={{ padding: '2px 8px', color: '#f87171' }} disabled={!!busy} onClick={() => { if (window.confirm(t('uninstallConfirm'))) mcpAction(a.name, 'uninstall') }}>{t('uninstallMcp')}</button>
                    )}
                  </div>
                </div>
              )
            })}
            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 6 }}>{t('mcpSetupHint')}</div>
            {runSetup && <div style={{ fontSize: 11, marginTop: 6 }}><code style={{ padding: '2px 6px', background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', borderRadius: 4 }}>{runSetup}</code></div>}
          </div>
        )}
        {/* 可编辑配置表单 */}
        {form ? (
          <div className="mc-cfg">
            {/* 一键推荐配置：三方案填充 */}
            <CfgSection icon="🎯" title={t('presetConfig')} sub={t('presetHint')}>
              <div className="mc-plan-grid">
                {['A', 'B', 'C'].map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={'mc-plan' + (appliedPlan === k ? ' on' : '')}
                    aria-pressed={appliedPlan === k}
                    onClick={() => applyPlan(k)}
                    disabled={!!busy}
                  >
                    <b>{appliedPlan === k ? '✅ ' : (k === 'A' ? '🟢 ' : k === 'B' ? '💰 ' : '⭐ ')}{PLANS[k].label}</b>
                    <span>{t('planDesc' + k)}</span>
                  </button>
                ))}
              </div>
              {appliedPlan ? (
                <div style={{ fontSize: 11, color: '#10b981' }}>✅ {tf('planApplied', { plan: PLANS[appliedPlan].label })}</div>
              ) : null}
            </CfgSection>
            {/* DSH 记忆配置 */}
            <CfgSection icon="🧠" title={t('dshMemoryConfig')} sub={t('cfgSubCore')}>
              <div className="mc-cfg-grid">
                <Bool k="enabled" label={t('enabledLabel')} />
                <Bool k="autoCapture" label={t('autoCapture')} />
                <Bool k="autoRecall" label={t('autoRecall')} />
                <F k="vaultDir" label={t('vaultDirLabel')} />
                <F k="captureMinChars" label={t('captureMinChars')} hint={t('unitChars')} type="number" />
                <F k="maxCardsPerDay" label={t('maxCardsPerDay')} hint={t('unitPerDay')} type="number" />
                <F k="dedupThreshold" label={t('dedupThreshold')} type="number" step="0.01" min="0" max="1" />
                <F k="recallLimit" label={t('recallLimit')} type="number" />
                <F k="recallSummaryLen" label={t('recallSummaryLen')} hint={t('unitChars')} type="number" />
                <Bool k="recallIncludeBody" label={t('recallBody')} />
                {/* 凭证取用提示：一句自己写的约定，会被注入到每个会话的 systemPrompt（触发 agent 去查目录卡） */}
                <F k="secretHint" label={t('secretHint')} />
                <F k="recallEmbedding" label={t('recallEmbedding')} />
              </div>
            </CfgSection>
            {/* 核心记忆（前置强制注入） */}
            <CfgSection icon="⭐" title={t('coreMemory')} sub={t('coreMemoryHint')}>
              <div className="mc-cfg-grid">
                <Bool k="coreMemoryEnabled" label={t('coreMemoryEnabled')} />
                <F k="coreMemoryLimit" label={t('coreMemoryLimit')} type="number" />
                <F k="coreMemoryMaxChars" label={t('coreMemoryMaxChars')} type="number" />
              </div>
            </CfgSection>
            {/* 多库（按项目隔离记忆）—— #10 */}
            <CfgSection icon="🗂️" title={t('vaultMulti')} sub={t('cfgSubMulti')}>
              <div style={{ fontSize: 11.5, opacity: 0.85, marginBottom: 8, lineHeight: 1.7 }}>
                {t('vaultNow')}：<code>{dsh?.vaultDir || '—'}</code>
                {dsh?.vaultName ? `（${dsh.vaultName}）` : ''}
                {' · '}{t('vaultSource')}：{t(VAULT_SRC_KEYS[dsh?.vaultSource] || 'vaultSrcDefault')}
                {dsh?.workspace ? <><br />{t('vaultWorkspace')}：<code>{dsh.workspace}</code></> : null}
              </div>
              {profilesOf(form).map((p, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr 1.5fr auto', gap: 6, marginBottom: 6 }}>
                  <input value={p.name || ''} placeholder={t('vaultNamePh')} onChange={(e) => updateProfile(i, 'name', e.target.value)} style={vaultInput} disabled={readonly} />
                  <input value={p.path || ''} placeholder={t('vaultPathPh')} onChange={(e) => updateProfile(i, 'path', e.target.value)} style={vaultInput} disabled={readonly} />
                  <input value={(p.match && p.match.workspace) || ''} placeholder={t('vaultMatchPh')} onChange={(e) => updateProfile(i, 'match', e.target.value)} style={vaultInput} disabled={readonly} />
                  <button type="button" className="mc-btn" onClick={() => removeProfile(i)} disabled={readonly} title={t('delete')}>✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                <button type="button" className="mc-btn" onClick={addProfile} disabled={readonly}>＋ {t('vaultAdd')}</button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ opacity: 0.6 }}>{t('vaultActive')}</span>
                  <select value={form.activeVault || ''} onChange={(e) => set('activeVault', e.target.value)} disabled={readonly} style={vaultInput}>
                    <option value="">{t('vaultActiveNone')}</option>
                    {profilesOf(form).filter((p) => p && p.name).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                </label>
              </div>
            </CfgSection>
            {/* 成本控制（省钱、控 LLM 消耗） */}
            <CfgSection icon="💰" title={t('costControl')} sub={t('costHint')}>
              <div className="mc-cfg-grid">
                <Bool k="distillEnabled" label={t('distillEnabled')} />
                <Bool k="dedupByLLM" label={t('dedupByLLM')} />
                <F k="captureMaxTokens" label={t('captureMaxTokens')} type="number" />
                <F k="captureTimeoutMs" label={t('captureTimeoutMs')} type="number" />
                <F k="recallMinScore" label={t('recallMinScore')} type="number" />
                <F k="captureCooldownMs" label={t('captureCooldownMs')} type="number" />
                {/* issue #42 ①：下拉选 provider / model（动态拉取，不再手填编号）；取不到时回退成文本输入 */}
                {routes && routes.ok === false && (
                  <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: '#b45309', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 8, padding: '6px 10px', lineHeight: 1.6 }}>
                    ⚠ {tf('routeListFail', { err: routes.error || '未知原因' })}
                  </div>
                )}
                {routes && routes.providers && routes.providers.length ? (
                  <>
                    <label className="mc-field">
                      <span className="mc-field-label">{t('captureProvider')}</span>
                      <select value={form.captureProvider || ''} onChange={(e) => { set('captureProvider', e.target.value); set('captureModel', '') }}>
                        <option value="">{t('routeAuto')}</option>
                        {routes.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </label>
                    <label className="mc-field">
                      <span className="mc-field-label">{t('captureModel')}</span>
                      <select value={form.captureModel || ''} onChange={(e) => set('captureModel', e.target.value)}>
                        <option value="">{t('routeAuto')}</option>
                        {((routes.providers.find((p) => p.id === form.captureProvider) || {}).models || []).map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <F k="captureProvider" label={t('captureProvider')} />
                    <F k="captureModel" label={t('captureModel')} />
                  </>
                )}
                <Bool k="captureFollowSession" label={t('captureFollowSession')} />
                <Bool k="captureFirstOnly" label={t('captureFirstOnly')} />
                <F k="sessionBudgetChars" label={t('sessionBudgetChars')} type="number" />
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button type="button" className="mc-btn" disabled={!!busy} onClick={async () => {
                    setBusy('llmtest')
                    try {
                      const r = await fetch(API + '/llm-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: form.captureProvider || '', model: form.captureModel || '', firstOnly: form.captureFirstOnly === true }) }).then((x) => x.json())
                      if (r && r.ok) notify(t('llmTestOk') + '：' + r.route.provider + (r.route.model ? '/' + r.route.model : '') + ' · ' + r.ms + 'ms · ' + t('llmCandidates') + ' ' + r.candidates)
                      else notify(t('llmTestFail') + '：' + ((r && (r.failure ? (r.failure.code + ' ' + r.failure.message) : r.error)) || '?'), false)
                    } catch (e) { notify(t('llmTestFail') + '：' + String((e && e.message) || e), false) }
                    finally { setBusy('') }
                  }}>{busy === 'llmtest' ? t('exporting') : '🔌 ' + t('llmTest')}</button>
                </div>
              </div>
            </CfgSection>
            {/* 自动审核配置 */}
            <CfgSection icon="🛡️" title={t('auditConfig')} sub={t('auditHint')}>
              <div className="mc-cfg-grid">
                <label className="mc-field">
                  <span className="mc-field-label">{t('auditMode')}</span>
                  <select value={form.auditMode ?? 'all'} onChange={(e) => set('auditMode', e.target.value)}>
                    <option value="all">{t('auditAll')}</option>
                    <option value="none">{t('auditNone')}</option>
                  </select>
                </label>
                <MultiDD
                  label={t('auditExemptAgents')}
                  value={form.auditExemptAgents || []}
                  options={[{ value: '__all__', label: t('allExempt') }, ...(setupStatus?.agents || []).filter((a) => !a.isDsh).map((a) => ({ value: a.name, label: a.name }))]}
                  onChange={(v) => set('auditExemptAgents', v)}
                />
                <MultiDD
                  label={t('auditExemptKinds')}
                  value={form.auditExemptKinds || []}
                  options={[{ value: '__all__', label: t('allExempt') }, ...KIND_IDS.filter((k) => k !== 'all').map((k) => ({ value: k, label: t(KIND_LABELS[k]) }))]}
                  onChange={(v) => set('auditExemptKinds', v)}
                />
                <F k="recycleRetentionDays" label={t('recycleDays')} hint={t('unitDays')} type="number" />
              </div>
            </CfgSection>
            {/* 服务自管理配置 */}
            <CfgSection icon="🛠" title={t('serviceConfig')} sub={t('cfgSubService')}>
              <div className="mc-cfg-grid">
                <Bool k="autoWeb" label={t('autoWeb')} />
                <label className="mc-field">
                  <span className="mc-field-label">{t('autoWebMode')}</span>
                  <select value={form.autoWebMode ?? 'init'} onChange={(e) => set('autoWebMode', e.target.value)}>
                    <option value="init">{t('modeInit')}</option>
                    <option value="interval">{t('modeInterval')}</option>
                    <option value="manual">{t('modeManual')}</option>
                  </select>
                </label>
                <F k="webPort" label={t('webPort')} type="number" />
                <F k="webCheckIntervalMs" label={t('webCheckIntervalMs')} type="number" />
                <F k="webMaxRestart" label={t('webMaxRestart')} hint={t('unitTimes')} type="number" />
                <Bool k="watchdogAutoSpawn" label={t('watchdogAutoSpawn')} />
                <Bool k="autoRestartOnDrift" label={t('autoRestartOnDrift')} />
                <Bool k="autoMcpSetup" label={t('autoMcpSetup')} />
              </div>
            </CfgSection>
            <div className="mc-cfg-actions">
              {dirty ? <span className="mc-cfg-dirty">{t('cfgDirty')}</span> : <span className="mc-cfg-clean">✓ {t('cfgClean')}</span>}
              <span className="mc-cfg-spacer" />
              {busy === 'save' && <span style={{ fontSize: 11.5, opacity: 0.75 }}>⏳ {t('saving')}</span>}
              {saved && busy !== 'save' && <span style={{ fontSize: 11.5, color: '#10b981' }}>✅ {saved}</span>}
              {err && busy !== 'save' && <span style={{ fontSize: 11.5, color: '#b91c1c' }}>⚠ {err}</span>}
              <button type="button" className="mc-btn" onClick={resetForm} disabled={!!busy}>{t('reset')}</button>
              {/* readonly 时也保持可点击：点了必须给出明确原因，不能像以前那样「毫无反应」 */}
              <button
                type="button"
                className="mc-btn me-on"
                onClick={readonly ? () => notify(t('readonlyTitle') + '：' + t('readonlyBody'), false) : save}
                disabled={busy === 'save'}
                title={readonly ? t('readonlyBody') : t('saveConfig')}
              >
                {busy === 'save' ? '⏳ ' + t('saving') : (readonly ? '🔒 ' + t('readonlyBtn') : '💾 ' + t('saveConfig'))}
              </button>
            </div>
          </div>
        ) : <div style={{ fontSize: 12, opacity: 0.6 }}>{t('loading')}</div>}
      </div>
    </div>
  )
}

/** 审核中心：待审核/驳回卡清单 + 筛选（日期/类型/智能体/全选）+ 批准/驳回。 */
function AuditPanel({ t, onReload, version }) {
  const [pending, setPending] = useState([])
  const [rejected, setRejected] = useState([])
  const [kindF, setKindF] = useState('all')
  const [agentF, setAgentF] = useState('all')
  const [dateF, setDateF] = useState('')
  const [sel, setSel] = useState(new Set())
  const [previewPath, setPreviewPath] = useState(null)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState(null)
  const [tab, setTab] = useState('pending')
  const notify = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3000) }
  const agents = [...new Set([...pending, ...rejected].map((c) => c.submittedBy).filter(Boolean))]
  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/audit/list`).then((x) => x.json()); if (r.ok) { setPending(r.pending || []); setRejected(r.rejected || []); setSel(new Set()); setBodies({}) } } catch {}
  }, [])
  useEffect(() => { load() }, [version, load])
  const items = (tab === 'pending' ? pending : rejected).filter((c) => {
    if (kindF !== 'all' && c.kind !== kindF) return false
    if (agentF !== 'all' && normAgent(c.submittedBy) !== agentF) return false
    if (dateF) { const d = (c.created || '').slice(0, 10); if (d && d !== dateF) return false }
    return true
  })
  // 左侧类型栏的计数：只按 agent/date 收窄，不按当前 kind，否则切到某类型后其他类型都变 0。
  const kindCounts = useMemo(() => {
    const base = tab === 'pending' ? pending : rejected
    const m = { all: 0 }
    base.forEach((c) => {
      if (agentF !== 'all' && normAgent(c.submittedBy) !== agentF) return
      if (dateF) { const d = (c.created || '').slice(0, 10); if (d && d !== dateF) return }
      m.all++
      m[c.kind || 'other'] = (m[c.kind || 'other'] || 0) + 1
    })
    return m
  }, [pending, rejected, tab, agentF, dateF])
  const toggle = (p) => setSel((s) => { const n = new Set(s); if (n.has(p)) { n.delete(p) } else { n.add(p) }; return n })
  const applyStatus = async (status, paths) => {
    const list = paths || [...sel]
    if (!list.length) { notify(t('noSelection'), false); return }
    setBusy('apply')
    const verb = status === 'approved' ? t('toastApproved') : status === 'rejected' ? t('toastRejected') : t('toastCardDeleted')
    try {
      let failed = 0
      for (const p of list) {
        const ep = status === 'approved' ? 'audit/approve' : status === 'rejected' ? 'audit/reject' : 'delete'
        try {
          const r = await fetch(API + '/' + ep + '?path=' + encodeURIComponent(p) + (status === 'delete' ? '&permanent=0' : ''))
          if (!r.ok) failed++
        } catch { failed++ }
      }
      await load(); if (onReload) onReload()
      // 必须给反馈：以前这里 catch{} 吞掉一切，用户点了没反应（用户反馈）
      if (failed) notify(t('toastFailed') + '（' + failed + '/' + list.length + '）', false)
      else notify(verb + ' ' + list.length + ' 张')
    } catch (e) { notify(t('toastFailed') + ': ' + String((e && e.message) || e), false) } finally { setBusy('') }
  }
  // issue #27：审核中心过去只列标题，看不到正文、只能盲批。
  // 现在点击队列行直接更新右侧判词面板，正文按需拉取；不再用行内展开/弹窗。
  const [bodies, setBodies] = useState({})
  const bodyState = (p) => bodies[p] || {}
  const toggled = [...sel]
  const previewCard = items.find((c) => c.path === previewPath) || items[0] || null
  const previewSt = previewCard ? bodyState(previewCard.path) : {}
  useEffect(() => {
    const c = previewCard
    if (!c || bodies[c.path]) return
    let alive = true
    const p = c.path
    setBodies((b) => ({ ...b, [p]: { loading: true } }))
    const status = c.status || (tab === 'pending' ? 'pending' : 'rejected')
    fetch(`${API}/card?path=${encodeURIComponent(p)}&status=${status}`).then((x) => x.json()).then((r) => {
      if (!alive) return
      if (r && r.ok) setBodies((b) => ({ ...b, [p]: { text: r.text || '' } }))
      else setBodies((b) => ({ ...b, [p]: { error: (r && r.error) || 'HTTP' } }))
    }).catch((e) => { if (alive) setBodies((b) => ({ ...b, [p]: { error: String((e && e.message) || e) } })) })
    return () => { alive = false }
  }, [previewCard && previewCard.path, tab])
  const clearSel = () => setSel(new Set())
  const switchTab = (next) => { setTab(next); clearSel() }
  const kindList = ['all', ...KIND_IDS.filter((k) => k !== 'all')]
  return (
    <div className="mc-admin" style={{ display: 'flex', flexDirection: 'column', overflow: 'auto', flex: 1, minHeight: 0 }}>
      <style>{CSS}</style>
      <div style={{ overflow: 'auto', padding: 4 }}>
        <InlineToast toast={toast} />
        <div className="mc-v5-pagehead mc-v5-audithead">
          <div>
            <div className="mc-v5-eyebrow">REVIEW INBOX</div>
            <h1>{t('tabAudit')}</h1>
            <p>{t('auditInboxSub')}</p>
          </div>
          <span className="mc-v5-pagecount">{pending.length} 张</span>
          <span className="mc-v5-audit-trust">🛡 {t('auditUndo')}</span>
        </div>
        <div className="me-audit">
          <div className="mc-card mc-audit-filtercard" style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="me-audit-filter-row">
              <b style={{ fontSize: 12 }}>🛡️ {t('tabAudit')}</b>
              <div style={{ flex: 1 }} />
              <select value={agentF} onChange={(e) => { setAgentF(e.target.value); clearSel() }} style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, #d1d5db)' }}>
                <option value="all">{t('allAgents')}</option>
                {agentOptions(agents).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <input type="date" value={dateF} onChange={(e) => { setDateF(e.target.value); clearSel() }} style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, #d1d5db)' }} />
            </div>
            <div className="me-audit-types-top">
              <span className="me-audit-types-label">{t('auditTypeLabel')}</span>
              {kindList.map((k) => {
                const color = k === 'all' ? 'var(--dsw-alias-label-secondary, #9ca3af)' : (KIND_COLORS[k] || '#6B7280')
                return (
                  <button key={k} type="button" className={`me-audit-kind${kindF === k ? ' active' : ''}`} onClick={() => { setKindF(k); clearSel() }}>
                    <span className="me-audit-kind-dot" style={{ background: color }} />
                    <span className="me-audit-kind-name">{k === 'all' ? t('all') : t(KIND_LABELS[k])}</span>
                    <span className="me-audit-kind-count">{kindCounts[k] || 0}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="me-audit-main">
            <div className="me-audit-queue">
            <div className="mc-card mc-audit-batchcard" style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className={`mc-btn${tab === 'pending' ? ' me-on' : ''}`} onClick={() => switchTab('pending')}>{t('pending')}（{pending.length}）</button>
              <button type="button" className={`mc-btn${tab === 'rejected' ? ' me-on' : ''}`} onClick={() => switchTab('rejected')}>{t('rejected')}（{rejected.length}）</button>
              <div style={{ flex: 1 }} />
              <label style={{ fontSize: 12 }}><input type="checkbox" checked={items.length > 0 && toggled.length === items.length} onChange={(e) => { if (e.target.checked) { setSel(new Set(items.map((c) => c.path))) } else { setSel(new Set()) } }} /> {t('selectAll')}（{items.length}）</label>
              <span style={{ fontSize: 11, opacity: 0.65 }}>{t('auditSelected')} {toggled.length}</span>
              <button type="button" className="mc-btn me-on" disabled={!toggled.length || !!busy} onClick={() => applyStatus('approved')}>✓ {tab === 'rejected' ? t('restore') : t('approve')}</button>
              {tab === 'pending'
                ? <button type="button" className="mc-btn" style={{ color: '#f87171' }} disabled={!toggled.length || !!busy} onClick={() => applyStatus('rejected')}>✕ {t('reject')}</button>
                : <button type="button" className="mc-btn" style={{ color: '#f87171' }} disabled={!toggled.length || !!busy} onClick={() => { if (window.confirm(t('recycleDeleteConfirm'))) applyStatus('delete') }}>🗑 {t('restoreDelete')}</button>}
              {toggled.length > 0 && <button type="button" className="mc-btn" onClick={clearSel}>{t('auditClearSelection')}</button>}
            </div>
            {items.length ? (
              <div className="mc-card" style={{ display: 'flex', flexDirection: 'column' }}>
                {items.map((c) => {
                  const color = KIND_COLORS[c.kind] || '#6B7280'
                  return (
                    <div key={c.path} className={`me-audit-row${previewCard && previewCard.path === c.path ? " active" : ""}`}>
                      <div className="me-audit-row-main" onClick={() => setPreviewPath(c.path)}>
                        <input type="checkbox" checked={sel.has(c.path)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(c.path)} />
                        <span className="me-audit-row-tile" style={{ color, borderColor: color + '38', background: color + '18' }}>{KIND_EMOJI[c.kind] || '📎'}</span>
                        <div className="me-audit-row-copy">
                          <div className="me-audit-row-top">
                            <span className="me-audit-row-kind">{t(KIND_LABELS[c.kind] || 'kindKnowledge')}</span>
                            <span className={`me-audit-row-state ${tab === 'pending' ? 'pending' : 'rejected'}`}>{tab === 'pending' ? '⏳ ' + t('statusPending') : '⛔ ' + t('statusRejected')}</span>
                            <span className="me-audit-row-time">{c.created ? c.created.slice(0, 16).replace('T', ' ') : '-'}</span>
                          </div>
                          <button type="button" className="me-audit-row-title" title={c.title} onClick={() => setPreviewPath(c.path)}>{c.title}</button>
                          {(c.reason || c.summary) && <p className="me-audit-row-reason">{c.reason || c.summary}</p>}
                          <div className="me-audit-row-meta">
                            <span>🤖 {normAgent(c.submittedBy)}</span>
                            {(Array.isArray(c.tags) ? c.tags : []).slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}
                          </div>
                        </div>
                        <div className="me-audit-row-actions" onClick={(e) => e.stopPropagation()}>
                          {tab === 'pending' ? (
                            <>
                              <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} onClick={() => applyStatus('approved', [c.path])}>✓</button>
                              <button type="button" className="mc-btn" style={{ padding: '2px 8px', color: '#f87171' }} onClick={() => applyStatus('rejected', [c.path])}>✕</button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} title={t('restore')} onClick={() => applyStatus('approved', [c.path])}>✓</button>
                              <button type="button" className="mc-btn" style={{ padding: '2px 8px', color: '#f87171' }} title={t('restoreDelete')} onClick={() => { if (window.confirm(t('recycleDeleteConfirm'))) applyStatus('delete', [c.path]) }}>🗑</button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : <div style={{ opacity: 0.6, fontSize: 12, padding: 20, textAlign: 'center' }}>{t('noAuditItems')}</div>}
            </div>
            <aside className="me-audit-preview">
              {previewCard ? (
                <>
                  <div className="me-audit-preview-head">
                    <div className="me-audit-preview-top">
                      <span className="me-audit-kind-badge" style={{ color: KIND_COLORS[previewCard.kind] || '#6B7280', borderColor: (KIND_COLORS[previewCard.kind] || '#6B7280') + '59', background: (KIND_COLORS[previewCard.kind] || '#6B7280') + '1a' }}>{KIND_EMOJI[previewCard.kind] || '📎'} {t(KIND_LABELS[previewCard.kind] || 'kindKnowledge')}</span>
                      <span className={`md-chip ${tab === 'pending' ? 'md-chip-st-warn' : 'md-chip-st-bad'}`}>{tab === 'pending' ? '⏳ ' + t('statusPending') : '⛔ ' + t('statusRejected')}</span>
                      <span className="spacer" style={{ flex: 1 }} />
                      <span style={{ fontSize: 10, opacity: 0.55 }}>{previewCard.created ? previewCard.created.slice(0, 16).replace('T', ' ') : ''}</span>
                    </div>
                    <h3>{previewCard.title}</h3>
                    <div className="me-audit-preview-meta">
                      <span>🤖 {normAgent(previewCard.submittedBy)}</span>
                      {!!previewCard.reason && <span className="me-audit-preview-reason">⚑ {previewCard.reason}</span>}
                      {(Array.isArray(previewCard.tags) ? previewCard.tags : []).slice(0, 5).map((tag) => <span key={tag}>#{tag}</span>)}
                    </div>
                  </div>
                  <div className="me-audit-preview-body">
                    {previewSt.loading && <div className="me-audit-preview-empty">{t('loading')}</div>}
                    {previewSt.error && <div className="me-audit-preview-empty" style={{ color: '#f87171' }}>⚠ {t('auditBodyFail')}：{previewSt.error}</div>}
                    {previewSt.text != null
                      ? <div className="md-doc" dangerouslySetInnerHTML={{ __html: renderMd(stripRepeatedTitle(splitFrontmatter(previewSt.text).body, previewCard.title)) }} />
                      : (!previewSt.loading && <p className="me-audit-preview-summary">{previewCard.summary || ''}</p>)}
                  </div>
                  <div className="me-audit-preview-actions">
                    <button type="button" className="mc-btn me-on" disabled={!!busy} onClick={() => applyStatus('approved', [previewCard.path])}>✓ {tab === 'rejected' ? t('restore') : t('approve')}</button>
                    {tab === 'pending'
                      ? <button type="button" className="mc-btn" style={{ color: '#f87171' }} disabled={!!busy} onClick={() => applyStatus('rejected', [previewCard.path])}>✕ {t('reject')}</button>
                      : <button type="button" className="mc-btn" style={{ color: '#f87171' }} disabled={!!busy} onClick={() => { if (window.confirm(t('recycleDeleteConfirm'))) applyStatus('delete', [previewCard.path]) }}>🗑 {t('restoreDelete')}</button>}
                  </div>
                </>
              ) : <div className="me-audit-preview-empty">{t('noAuditItems')}</div>}
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 回收中心：软删卡列表 + 恢复/永久删除 + 30天自动清理提示。 */
function RecoverPanel({ t, onReload, version }) {
  const [items, setItems] = useState([])
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState(null)
  const notify = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3200) }
  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/recycle/list`).then((x) => x.json()); if (r.ok) setItems(r.items || []) } catch {}
  }, [])
  useEffect(() => { load() }, [version, load])
  const action = async (act, p) => {
    const title = (items.find((x) => x.path === p) || {}).title || p
    setBusy(act + p)
    try {
      const url = act === 'restore' ? '/recycle/restore' : '/recycle/purge'
      const r = await fetch(API + url + '?path=' + encodeURIComponent(p))
      const d = await r.json().catch(() => null)
      await load(); if (onReload) onReload()
      // 以前这里 catch{} 吞掉一切 + 不给成功提示，用户看到的就是「点了没反应」
      if (r.ok && (!d || d.ok !== false)) notify((act === 'restore' ? t('toastRestored') : t('toastPurged')) + '：' + title)
      else notify(t('toastFailed') + '：' + ((d && d.error) || ('HTTP ' + r.status)), false)
    } catch (e) { notify(t('toastFailed') + '：' + String((e && e.message) || e), false) } finally { setBusy('') }
  }
  return (
    <div className="mc-admin" style={{ display: 'flex', flexDirection: 'column', overflow: 'auto', flex: 1, minHeight: 0 }}>
      <style>{CSS}</style>
      <div style={{ overflow: 'auto', padding: 4 }}>
        <InlineToast toast={toast} />
        <div className="mc-v5-pagehead">
          <div>
            <div className="mc-v5-eyebrow">RECYCLE CENTER</div>
            <h1>{t('tabRecycle')}</h1>
            <p>{t('recyclePageSub')}</p>
          </div>
          <span className="mc-v5-pagecount">{items.length}</span>
          <button type="button" className="mc-btn" disabled={!!busy || items.length === 0} title={items.length ? '' : t('emptyRecycle')} onClick={async () => { setBusy('purgeAll'); try { const r = await fetch(API + '/recycle/purge-expired?days=0'); const d = await r.json().catch(() => null); await load(); notify(r.ok ? t('toastPurgedExpired') + (d && d.purged != null ? '（' + d.purged + '）' : '') : t('toastFailed'), r.ok) } catch (e) { notify(t('toastFailed') + '：' + String((e && e.message) || e), false) } finally { setBusy('') } }}>🗑 {t('emptyRecycle')}</button>
        </div>
        <div className="mc-v5-recycle-hint">{t('recycleHint')}</div>
        {items.length ? (
          <div className="mc-card mc-v5-recycle">
            {items.map((c) => {
              const color = KIND_COLORS[c.kind] || '#6B7280'
              return (
                <div key={c.path} className="mc-v5-recycle-row">
                  <span className="mc-v5-recycle-tile" style={{ color, background: color + '18', borderColor: color + '38' }}>{KIND_EMOJI[c.kind] || '📎'}</span>
                  <div className="mc-v5-recycle-copy">
                    <b>{c.title}</b>
                    <span>{t(KIND_LABELS[c.kind] || 'kindKnowledge')} · {t('deletedAt')} {(c.deletedAt || '').slice(0, 10)}</span>
                  </div>
                  <div className="mc-v5-recycle-actions">
                    <button type="button" className="mc-btn" disabled={!!busy} onClick={() => action('restore', c.path)}>{t('restore')}</button>
                    <button type="button" className="mc-btn mc-danger" disabled={!!busy} onClick={() => { if (window.confirm(t('purgeConfirm'))) action('purge', c.path) }}>{t('purge')}</button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : <div className="mc-card mc-v5-empty-state">🗑️ <b>{t('emptyRecycle')}</b><span>{t('recycleEmptyHint').split('{days}').join('30')}</span></div>}
      </div>
    </div>
  )
}

const stripRepeatedTitle = (md, title) => {
  const lines = String(md || '').split(/\r?\n/)
  const norm = (s) => String(s || '').replace(/[#*_`]/g, '').replace(/[\s:：\-–—·]/g, '').trim()
  const target = norm(title)
  for (;;) {
    let i = 0
    while (i < lines.length && !lines[i].trim()) i++
    const m = /^#{1,2}\s+(.+?)\s*$/.exec(lines[i] || '')
    if (!m || norm(m[1]) !== target) break
    lines.splice(i, 1)
    while (i < lines.length && !lines[i].trim()) lines.splice(i, 1)
  }
  return lines.join('\n')
}
const tocOfMarkdown = (md) => {
  const out = []
  let inFence = false
  let n = 0
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (/^```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+)$/.exec(line)
    if (!m) continue
    n++
    const level = m[1].length
    if (level <= 3) out.push({ id: 'md-h-' + n, level, text: m[2].replace(/[#*_`>\[\]()]/g, '').replace(/\s+/g, ' ').trim() })
  }
  return out
}
const cardLead = (card) => {
  const s = String(card.summary || '').replace(/[#>*_`]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > 150 ? s.slice(0, 148) + '…' : s
}
const cardInsightKey = (card) => {
  const s = String(card.summary || '').toLowerCase()
  if (/决策|结论|决定|decision/.test(s)) return 'insightDecision'
  if (/根因|原因|root cause/.test(s)) return 'insightRoot'
  if (/教训|避免|lesson/.test(s)) return 'insightLesson'
  return 'insightSummary'
}
const MiniGraph = ({ n = 0, color = '#ff9a72', size = 30 }) => {
  const count = Math.max(2, Math.min(6, Number(n) || 2))
  const pts = Array.from({ length: count }, (_, i) => {
    const a = (-Math.PI / 2) + (i * Math.PI * 2 / count)
    const r = i % 2 ? 13 : 16
    return [20 + Math.cos(a) * r, 20 + Math.sin(a) * r]
  })
  return (
    <svg className="mc-v5-mini" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      {pts.map(([x, y], i) => <line key={'l' + i} x1="20" y1="20" x2={x} y2={y} stroke={color} strokeOpacity=".35" />)}
      {pts.map(([x, y], i) => <circle key={'c' + i} cx={x} cy={y} r={i % 2 ? 2.2 : 1.8} fill={color} fillOpacity={i % 2 ? .8 : .55} />)}
      <circle cx="20" cy="20" r="2.6" fill={color} />
    </svg>
  )
}
const CardRow = ({ card, t, onOpen, query, onDelete, onTagClick, pinned, onPin, links }) => {
  const color = KIND_COLORS[card.kind] || KIND_COLORS.other
  const linkCount = Number(links ?? card.links ?? card.weight ?? 0)
  const tags = tagsOf(card)
  return (
    <article className={`mc-cardrow mc-card mc-v5-card${pinned ? ' pinned' : ''}`} onClick={() => onOpen(card)}>
      <div className="mc-v5-card-top">
        <span className="mc-v5-card-tile" style={{ color, background: color + '18', borderColor: color + '38' }}>{KIND_EMOJI[card.kind] || '📎'}</span>
        <span className="mc-v5-card-kind-name">{t(KIND_LABELS[card.kind] || 'kindKnowledge')}</span>
        {card.status === 'pending' && <span className="mc-v5-card-status pending">⏳ {t('statusPending')}</span>}
        {card.status === 'rejected' && <span className="mc-v5-card-status rejected">⛔ {t('statusRejected')}</span>}
        {isNewCard(card.updated) && <span className="mc-new">{t('newBadge')}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="mc-v5-card-time">{fmtDate(card.updated)}</span>
        {onPin && <button type="button" className={`mc-v5-pin${pinned ? ' on' : ''}`} title={t(pinned ? 'unpinCard' : 'pinCard')} aria-label={t(pinned ? 'unpinCard' : 'pinCard')} onClick={(e) => { e.stopPropagation(); onPin(card.path) }}>📌</button>}
      </div>
      <h4 className="mc-v5-card-title">{query ? highlightMatches(card.title, query) : card.title}</h4>
      <div className="mc-v5-card-insight">
        <span className="mc-v5-insight-k">{t(cardInsightKey(card))}</span>
        <span className="mc-v5-card-lead">{query ? highlightMatches(card.summary || '', query) : cardLead(card)}</span>
      </div>
      {query && (() => {
        const sn = snippetAround(card.body || '', query)
        return sn ? <p className="mc-snippet">{highlightMatches(sn, query)}</p> : null
      })()}
      {tagsOf(card).length > 0 && (
        <div className="mc-tags mc-v5-card-tags">
          {tagsOf(card).slice(0, 2).map((tag) => <button key={tag} type="button" className="mc-tag mc-tag-click" title={tag} onClick={(e) => { e.stopPropagation(); onTagClick && onTagClick(tag) }}>#{tag}</button>)}
          {tags.length > 2 && <span className="mc-tag more">+{tags.length - 2}</span>}
        </div>
      )}
      <footer className="mc-v5-card-foot">
        {linkCount > 0 && <span className="mc-v5-conn"><MiniGraph n={linkCount} color={color} /> <b>{linkCount}</b> {t('links')}</span>}
        <span className="mc-v5-author">🤖 {normAgent(card.submittedBy)}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" className="mc-card-del" title={t('delete')} onClick={(e) => { e.stopPropagation(); if (window.confirm(t('deleteConfirm'))) onDelete && onDelete(card.path) }}>🗑</button>
      </footer>
    </article>
  )
}

// 管理面板：用量/今日 + 整理建议（非破坏预览）+ 会话预算。
function LibraryAdmin({ t, tab, onReload, version }) {
  const [stats, setStats] = useState(null)
  const [err, setErr] = useState('')
  const [opt, setOpt] = useState(null)
  const [budget, setBudget] = useState(null)
  const [captureLog, setCaptureLog] = useState(null)
  // 健康概览（库 / 备份 / 沉淀 / 版本）——「看不见的状态」集中一处（issue 可靠性线）
  const [health, setHealth] = useState(null)
  // 记忆账本：召回注入 / 蒸馏调用 / 召回有用率（回答「到底省不省 token」）
  const [ledger, setLedger] = useState(null)
  // 版本对齐检查（回答「插件迭代后旧接口还在」）：宿主/常驻/npm 版本差 + MCP/hooks 旧接线
  const [align, setAlign] = useState(null)
  const runAlign = useCallback(async () => {
    setBusy('align')
    try {
      const r = await fetch(API + '/align').then((x) => x.json())
      if (r && r.findings) setAlign(r)
      else notify(t('alignFail'), false)
    } catch { notify(t('alignFail'), false) }
    finally { setBusy('') }
  }, [t])
  const fixWiring = async () => {
    if (!window.confirm(t('alignFixConfirm'))) return
    setBusy('alignfix')
    try {
      const r = await fetch(API + '/setup-run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json())
      if (r && r.ok) { notify(t('alignFixed')); await runAlign() } else notify(t('alignFail'), false)
    } catch { notify(t('alignFail'), false) }
    finally { setBusy('') }
  }
  const [agentCards, setAgentCards] = useState([])
  const [busy, setBusy] = useState('')
  const [oneClickCleanupStale, setOneClickCleanupStale] = useState(false)
  const doBatchMerge = useCallback(async () => {
    if (!opt || !opt.merge || !opt.merge.length) return
    if (!window.confirm(t('mergeAllConfirm'))) return
    setBusy('merge')
    try {
      const parent = {}
      const find = (x) => (parent[x] === undefined ? x : (parent[x] = find(parent[x])))
      const uni = (a, b) => { parent[find(a)] = find(b) }
      const seen = new Set()
      for (const m of opt.merge) { seen.add(m.a.path); seen.add(m.b.path); uni(m.a.path, m.b.path) }
      const groups = {}
      for (const p of seen) { const r = find(p); (groups[r] = groups[r] || []).push(p) }
      let n = 0
      for (const g of Object.values(groups)) {
        if (g.length < 2) continue
        const r = await fetch(`${API}/merge?paths=${encodeURIComponent(g.join(','))}`).then((x) => x.json())
        if (r.ok) n++
      }
      await fetchAll(); if (onReload) onReload()
    } catch (e) {}
    setBusy('')
  }, [opt, fetchAll, onReload, t])
  async function fetchAll() {
    try {
      // 不自动拉 optimize（避免挂载即扫描）——由「一键搜索和整理」按钮手动触发
      const rs = await Promise.all([
        fetch(`${API}/stats`),
        fetch(`${API}/budget`),
        // 自动沉淀日志：确认「agent 真的在写卡」
        fetch(`${API}/capture-log`),
        // 宿主自动沉淀的卡：服务端按署名过滤取 30 条（约 15KB），不再拉全量 500 卡
        fetch(`${API}/cards?status=all&limit=30&agent=${DSH_AGENT}`),
        // 健康概览：库状态 / 备份年龄（服务端已算好摘要）
        fetch(`${API}/overview`),
        // 记忆账本：近 7 天召回注入 / 蒸馏调用 / 召回有用率
        fetch(`${API}/ledger?days=7`),
      ])
      const [s, b, c, k, o, l] = await Promise.all(rs.map((r) => r.json()))
      if (s && s.ok) setStats(s)
      if (b && b.ok) setBudget(b)
      if (c && c.ok) setCaptureLog(c)
      if (k && k.ok) setAgentCards(k.cards || [])
      if (o && o.ok) setHealth({ db: o.db, backups: o.backups, total: o.total, version: o.version, degraded: o.degraded === true })
      setLedger(l && l.ok ? l : { ok: false, error: (l && l.error) || '' })
      setErr(!s || !s.ok ? t('adminLoadFail') : '')
    } catch (e) { setErr(t('adminLoadFail')) }
  }
  // 手动「一键搜索和整理」：扫描相似卡对 + 陈旧卡
  const scanOptimize = useCallback(async () => {
    setBusy('scan')
    try {
      const r = await fetch(`${API}/optimize`).then((x) => x.json())
      if (r.ok) setOpt(r)
    } catch { setErr(t('adminLoadFail')) }
    finally { setBusy('') }
  }, [t])
  // 矛盾扫描（#36）：宽召回候选对 → 逐对判别「重复 / 补充 / 矛盾 / 无关」→ **人拍板**
  // 扫描只读；apply 只做可恢复动作（keepA/keepB 把另一张送回收站），决策会被记住（不再重复打扰）。
  const [refine, setRefine] = useState(null)
  const scanRefine = useCallback(async () => {
    setBusy('refine')
    try {
      const r = await fetch(`${API}/refine-scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 8 }) }).then((x) => x.json())
      if (r && r.ok) setRefine(r)
      else notify((r && r.error) || t('refineFail'), false)
    } catch { notify(t('refineFail'), false) }
    finally { setBusy('') }
  }, [t])
  const applyRefine = async (x, action) => {
    if (action === 'merge' && !window.confirm(t('mergeConfirm'))) return
    setBusy('refineapply')
    try {
      const r = await fetch(`${API}/refine-apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: x.a.path, b: x.b.path, action, relation: x.relation }),
      }).then((y) => y.json())
      if (r && r.ok) {
        notify(t('refineApplied'))
        setRefine((prev) => (prev ? { ...prev, findings: (prev.findings || []).filter((z) => !(z.a.path === x.a.path && z.b.path === x.b.path)) } : prev))
        await fetchAll(); if (onReload) onReload()
      } else { notify((r && r.error) || t('refineFail'), false) }
    } catch { notify(t('refineFail'), false) }
    finally { setBusy('') }
  }
  // 存量「注入垃圾卡」（技能目录 / system-reminder 被沉淀成卡）：机器提议，人一键回收（进回收站，可还原）
  const [junk, setJunk] = useState(null)
  const scanJunk = useCallback(async () => {
    setBusy('junk')
    try {
      const r = await fetch(`${API}/refine-junk`).then((x) => x.json())
      if (r && r.ok) setJunk(r.items || [])
      else notify(t('junkFail'), false)
    } catch { notify(t('junkFail'), false) }
    finally { setBusy('') }
  }, [t])
  const purgeJunk = async (paths) => {
    if (!paths.length) return
    if (!window.confirm(t('junkRecycleAllConfirm'))) return
    setBusy('junkpurge')
    try {
      const r = await fetch(`${API}/refine-junk-purge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) }).then((x) => x.json())
      if (r && r.removed) {
        notify(t('junkDone') + '：' + r.removed.length + (r.failed?.length ? '（失败 ' + r.failed.length + '）' : ''))
        setJunk((prev) => (prev ? prev.filter((x) => !r.removed.includes(x.path)) : prev))
        await fetchAll(); if (onReload) onReload()
      } else { notify(t('junkFail'), false) }
    } catch { notify(t('junkFail'), false) }
    finally { setBusy('') }
  }
  // 「同目标、不同做法」聚类（#36 第三块）：模型先给每张卡抽一句「解决什么问题」（带缓存），再按目标聚类
  const [goals, setGoals] = useState(null)
  const scanGoals = useCallback(async () => {
    setBusy('goals')
    try {
      const r = await fetch(API + '/refine-goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 30 }) }).then((x) => x.json())
      if (r && r.ok) setGoals(r)
      else notify((r && r.error) || t('goalFail'), false)
    } catch { notify(t('goalFail'), false) }
    finally { setBusy('') }
  }, [t])
  const keepCluster = async (c) => {
    setBusy('goalskeep')
    try {
      const r = await fetch(API + '/refine-goals-keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: c.members.map((m) => m.path) }) }).then((x) => x.json())
      if (r && r.ok) {
        notify(t('goalDone'))
        setGoals((prev) => (prev ? { ...prev, clusters: (prev.clusters || []).filter((z) => z.goal !== c.goal) } : prev))
      } else { notify(t('goalFail'), false) }
    } catch { notify(t('goalFail'), false) }
    finally { setBusy('') }
  }
  const mergeCluster = async (c) => {
    if (!window.confirm(t('mergeConfirm'))) return
    setBusy('goalsmerge')
    try {
      const r = await fetch(API + '/merge?paths=' + encodeURIComponent(c.members.map((m) => m.path).join(','))).then((x) => x.json())
      if (r && r.ok) {
        notify(t('goalMerged'))
        setGoals((prev) => (prev ? { ...prev, clusters: (prev.clusters || []).filter((z) => z.goal !== c.goal) } : prev))
        await fetchAll(); if (onReload) onReload()
      } else { notify(t('mergeFail'), false) }
    } catch { notify(t('mergeFail'), false) }
    finally { setBusy('') }
  }
  useEffect(() => { fetchAll() }, [version])
  const doMerge = async (a, b) => {
    if (!window.confirm(t('mergeConfirm'))) return
    try { const r = await fetch(`${API}/merge?paths=${encodeURIComponent(a + ',' + b)}`).then((x) => x.json()); if (r.ok) { await fetchAll(); onReload && onReload() } } catch (e) {}
  }
  const doDelete = async (p) => {
    if (!window.confirm(t('deleteConfirm'))) return
    try { const r = await fetch(`${API}/delete?path=${encodeURIComponent(p)}`).then((x) => x.json()); if (r.ok) { await fetchAll(); onReload && onReload() } } catch (e) {}
  }
  const kinds = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake']
  const KN = ({ title, kind, updated, path }) => (
    <li style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px', borderBottom: '1px solid rgba(127,127,127,0.12)' }}>
      <span className="mc-kind" style={{ background: KG.colors[kind] || '#666' }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      <span style={{ opacity: 0.55, fontSize: 11 }}>{fmtDate(updated)}</span>
      <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} onClick={() => doDelete(path)}>{t('delete')} ✕</button>
    </li>
  )
  return (
    <div className="mc-admin" style={{ display: 'flex', flexDirection: 'column', overflow: 'auto', flex: 1, minHeight: 0 }}>
      <style>{CSS}</style>
      <div style={{ overflow: 'auto' }}>
          {err && <div className="mc-card" style={{ borderLeft: '4px solid #ef4444', background: 'rgba(239,68,68,0.08)', padding: '12px 14px', marginBottom: 10 }}>
            <div style={{ fontSize: 13, color: '#b91c1c', fontWeight: 600, marginBottom: 6 }}>⚠ {err}</div>
            <button type="button" className="mc-btn" onClick={fetchAll}>↻ {t('retry')}</button>
          </div>}
          {tab === 'stats' && (
            <div>
              <div className="mc-v5-pagehead">
                <div>
                  <div className="mc-v5-eyebrow">SYSTEM STATUS</div>
                  <h1>{t('runtimeTitle')}</h1>
                  <p>{t('runtimeSub')}</p>
                </div>
                <span className="mc-v5-pagecount">{health ? `${health.total || 0} ${t('cardsUnit')}` : ''}</span>
                <button type="button" className="mc-btn" onClick={() => fetchAll()}>↻ {t('refresh')}</button>
              </div>
              <div className="mc-v5-statusgrid">
                <div className="mc-v5-statuscard">
                  <span className="mc-v5-status-ico">🗄️</span>
                  <b>{health ? (health.total || 0) : '—'}</b>
                  <span>{t('dbTitle')}</span>
                  <small>{health?.db?.journalMode || health?.db?.journal_mode || 'SQLite'}</small>
                </div>
                <div className="mc-v5-statuscard">
                  <span className="mc-v5-status-ico">💾</span>
                  <b>{health?.backups?.count ?? '—'}</b>
                  <span>{t('backupTitle')}</span>
                  <small>{health?.backups?.newestAt ? `${Math.max(0, Math.floor((Date.now() - Number(health.backups.newestAt)) / 86400000))} 天前` : '—'}</small>
                </div>
                <div className="mc-v5-statuscard">
                  <span className="mc-v5-status-ico">✨</span>
                  <b>{captureLog?.available ? (captureLog.health?.ok ? '正常' : '异常') : '—'}</b>
                  <span>{t('captureTitle')}</span>
                  <small>{captureLog?.health?.lastAt ? fmtDate(new Date(captureLog.health.lastAt).toISOString()) : '—'}</small>
                </div>
                <div className="mc-v5-statuscard">
                  <span className="mc-v5-status-ico">🏷️</span>
                  <b>{health?.version || '—'}</b>
                  <span>{t('versionTitle')}</span>
                  <small>{t('v5Local')}</small>
                </div>
              </div>
              {/* 健康概览：把「看不见的状态」集中一处（库 / 备份 / 沉淀 / 版本） */}
              <div className="mc-card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 12 }}>🩺 {t('healthTitle')}</b>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>{t('healthHint')}</span>
                  <div style={{ flex: 1 }} />
                  <button type="button" className="mc-btn" onClick={() => fetchAll()}>↻ {t('refresh')}</button>
                </div>
                {!health ? <div style={{ opacity: 0.6, fontSize: 12, padding: '8px 0' }}>{t('loading')}</div> : (() => {
                  const db = health.db || {}
                  const dbOk = db.writable !== false && !db.corrupt
                  const bk = health.backups || { count: 0, newestAt: 0 }
                  const ageDays = bk.newestAt ? Math.floor((Date.now() - Number(bk.newestAt)) / 86400000) : -1
                  const bkLevel = !bk.count ? 'bad' : (ageDays > 7 ? 'warn' : 'ok')
                  const cap = captureLog && captureLog.available ? captureLog.health : null
                  const capLevel = !cap ? 'none' : (cap.ok ? 'ok' : 'warn')
                  const ver = align && align.findings ? (
                    align.onDisk && align.residentServed === align.onDisk && align.hostVersion === align.onDisk ? 'ok' : 'warn'
                  ) : 'none'
                  const ICO = { ok: ['✅', '#10b981'], warn: ['⚠', '#f59e0b'], bad: ['✗', '#ef4444'], none: ['•', 'inherit'] }
                  const rows = [
                    {
                      label: t('healthDb'),
                      level: dbOk ? 'ok' : 'bad',
                      text: dbOk
                        ? 'journal=' + (db.journalMode || '?') + (db.checkedAt ? ' · ' + new Date(db.checkedAt).toLocaleString() : '')
                        : (db.error || t('healthDbBad')) + ' → dsh-memory doctor',
                    },
                    {
                      label: t('healthBackups'),
                      level: bkLevel,
                      text: !bk.count
                        ? t('healthNoBackups')
                        : (ageDays <= 0 ? t('healthBackupToday').replace('{n}', String(bk.count)) : t('healthBackupAge').replace('{n}', String(bk.count)).replace('{d}', String(ageDays))) + (bk.files && bk.files.length ? ' · ' + bk.files[bk.files.length - 1] : ''),
                    },
                    {
                      label: t('healthCapture'),
                      level: capLevel,
                      text: !cap ? t('healthNoRecords') : (cap.ok ? t('healthCapOk') : t('healthCapFail') + '：' + (cap.reason || '')),
                    },
                    {
                      label: t('healthVersion'),
                      level: ver,
                      text: ver === 'none'
                        ? t('healthRunAlign')
                        : (t('vcOnDisk') + ' v' + (align.onDisk || '?') + ' · ' + t('vcResident') + ' v' + (align.residentServed || '?') + ' · ' + t('vcLoaded') + ' v' + (align.hostVersion || '?')),
                      action: ver === 'none' ? { label: t('alignRun'), run: runAlign } : null,
                    },
                  ]
                  return (
                    <div style={{ marginTop: 6 }}>
                      {rows.map((r) => (
                        <div key={r.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '3px 0', borderTop: '1px solid rgba(127,127,127,0.10)' }}>
                          <span style={{ width: 14, flex: '0 0 auto', color: ICO[r.level][1] }}>{ICO[r.level][0]}</span>
                          <b style={{ minWidth: 62, flex: '0 0 auto', opacity: 0.85 }}>{r.label}</b>
                          <span style={{ opacity: 0.82, wordBreak: 'break-word' }}>{r.text}</span>
                          {r.action && <button type="button" className="mc-btn" style={{ marginLeft: 6, padding: '0 6px', fontSize: 11 }} disabled={!!busy} onClick={r.action.run}>{r.action.label}</button>}
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
              {/* 记忆账本：回答「到底省不省 token」—— 记录召回注入与蒸馏调用，收益侧结合有用率判断 */}
              <div className="mc-card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 12 }}>🧾 {t('ledgerTitle')}</b>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>{t('ledgerHint')}</span>
                  <div style={{ flex: 1 }} />
                  <button type="button" className="mc-btn" onClick={() => fetchAll()}>↻ {t('refresh')}</button>
                </div>
                {!ledger
                  ? <div style={{ opacity: 0.6, fontSize: 12, padding: '8px 0' }}>{t('loading')}</div>
                  : ledger.ok === false
                    ? <div style={{ color: '#f59e0b', fontSize: 12, padding: '8px 0', lineHeight: 1.7 }}>⚠ {(/未知接口|404|not found/i.test(String(ledger.error || '')) ? t('ledgerNeedRestart') : (ledger.error || t('adminLoadFail')))}</div>
                    : (ledger.totals.recalls + ledger.totals.captures === 0
                      ? <div style={{ opacity: 0.6, fontSize: 12, padding: '8px 0' }}>{t('ledgerNoData')}</div>
                      : (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                            {[
                              { k: t('ledgerRecalls'), v: String(ledger.totals.recalls), s: t('ledgerInjected') + ' ' + Number(ledger.totals.injectedChars || 0).toLocaleString() + ' ' + t('ledgerChars') },
                              { k: t('ledgerCaptures'), v: String(ledger.totals.captures), s: t('ledgerLlmCalls') + ' ' + ledger.totals.llmCalls + (ledger.totals.captureFail ? ' · ✗ ' + ledger.totals.captureFail : '') },
                              { k: t('ledgerEstimate'), v: '≈ ' + Number(ledger.totals.estTokens || 0).toLocaleString(), s: t('ledgerEstimateHint') },
                              { k: t('ledgerUseful'), v: ledger.feedback.rate == null ? '—' : Math.round(ledger.feedback.rate * 100) + '%', s: t('ledgerUsefulHint') },
                            ].map((x) => (
                              <div key={x.k} style={{ border: '1px solid rgba(127,127,127,.16)', borderRadius: 10, padding: '8px 10px' }}>
                                <div style={{ fontSize: 11, opacity: 0.6 }}>{x.k}</div>
                                <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.35 }}>{x.v}</div>
                                <div style={{ fontSize: 10.5, opacity: 0.55, lineHeight: 1.5 }}>{x.s}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 8, lineHeight: 1.7 }}>{t('ledgerFormula')}</div>
                        </div>
                      ))}
              </div>
              {/* 版本对齐检查：插件迭代后「旧接口 / 旧接线」不会自己消失 —— 一眼看清差在哪、怎么对齐 */}
              <div className="mc-card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 12 }}>🔧 {t('alignTitle')}</b>
                  <button type="button" className="mc-btn" disabled={!!busy} onClick={runAlign}>{busy === 'align' ? t('exporting') : t('alignRun')}</button>
                  {align && align.counts && align.counts.fix > 0 && (
                    <button type="button" className="mc-btn me-on" disabled={!!busy} onClick={fixWiring}>{busy === 'alignfix' ? t('exporting') : t('alignFix')}</button>
                  )}
                  <span style={{ fontSize: 11, opacity: 0.6 }}>{t('alignHint')}</span>
                </div>
                {align && align.findings ? (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>
                      {t('alignDisk')} v{align.onDisk || '?'}{align.residentServed ? ' · ' + t('alignResident') + ' v' + align.residentServed : ''}{align.hostVersion ? ' · ' + t('alignHost') + ' v' + align.hostVersion : ''}
                    </div>
                    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                      {align.findings.map((x, i) => (
                        <li key={i} style={{ padding: '4px 2px', borderTop: i ? '1px solid rgba(127,127,127,0.12)' : 'none', fontSize: 12 }}>
                          <span style={{ fontWeight: 700, color: x.level === 'fix' ? '#ef4444' : x.level === 'warn' ? '#f59e0b' : '#10b981' }}>
                            {x.level === 'fix' ? '✗' : x.level === 'warn' ? '⚠' : '✓'}
                          </span>{' '}
                          <span>{x.title}</span>
                          {x.detail ? <div style={{ opacity: 0.75, marginLeft: 14 }}>{x.detail}</div> : null}
                          {x.command ? <div style={{ marginLeft: 14, opacity: 0.9 }}>→ <code>{x.command}</code></div> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>{t('alignIdle')}</div>}
              </div>
              <div className="mc-card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 12 }}>🪵 {t('captureLog')}</b>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>{t('captureLogHint')}</span>
                  <div style={{ flex: 1 }} />
                  <button type="button" className="mc-btn" onClick={() => fetchAll()}>↻ {t('refresh')}</button>
                </div>
                {!captureLog
                  ? <div style={{ opacity: 0.6, fontSize: 12, padding: '8px 0' }}>{t('loading')}</div>
                  : captureLog.available === false
                    ? <div style={{ opacity: 0.6, fontSize: 12, padding: '8px 0' }}>{t('captureLogUnavailable')}</div>
                    : (captureLog.entries || []).length === 0
                      ? <div style={{ opacity: 0.6, fontSize: 12, padding: '8px 0' }}>{t('captureLogEmpty')}</div>
                      : (
                        <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <tbody>
                              {(captureLog.entries || []).map((e, i) => {
                                const conf = CAPTURE_ACTIONS[e.action] || ['•', 'inherit']
                                return (
                                  <tr key={i} style={{ borderBottom: '1px solid rgba(127,127,127,0.12)' }}>
                                    <td style={{ padding: '4px 6px', opacity: 0.55, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtDate(e.time ? new Date(e.time).toISOString() : '')}</td>
                                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', color: conf[1], fontWeight: 600 }}>{conf[0]} {e.action}</td>
                                    <td style={{ padding: '4px 6px' }}>{e.reason || ''}</td>
                                    <td style={{ padding: '4px 6px', opacity: 0.55, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.preview || ''}>{e.preview || ''}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
              </div>
              <div className="mc-card" style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>🤖 {t('captureAgentCards')}（{agentCards.length}）</div>
                {agentCards.length ? (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {agentCards.map((c) => (
                      <li key={c.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px', borderBottom: '1px solid rgba(127,127,127,0.12)', fontSize: 12 }}>
                        <span className="mc-kind" style={{ background: KIND_COLORS[c.kind] || KIND_COLORS.other }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                        {c.status === 'pending' && <span className="mc-status" style={{ background: '#f59e0b' }}>⏳ {t('statusPending')}</span>}
                        <span style={{ opacity: 0.55, fontSize: 11 }}>{fmtDate(c.updated)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <div style={{ opacity: 0.6, fontSize: 12 }}>{t('noCards')}</div>}
              </div>
              {stats && (
                <>
                  {stats.trend && stats.trend.length > 0 && (() => {
                    const data = stats.trend; const max = Math.max(...data.map((d) => d.count), 1)
                    const w = 260, h = 50, cw = w / data.length
                    return (
                      <div className="mc-card" style={{ marginBottom: 10, padding: '10px 14px' }}>
                        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>📈 {t('trendLabel')}</div>
                        <svg width={w} height={h} style={{ display: 'block', width: '100%', height: 50 }}>
                          {data.map((d, i) => {
                            const bh = Math.round((d.count / max) * (h - 4))
                            return <rect key={d.date} x={i * cw + 1} y={h - bh} width={Math.max(cw - 2, 2)} height={bh} rx={1.5} fill={d.count > 0 ? 'var(--dsw-alias-accent, #3b82f6)' : 'var(--dsw-alias-border-l1, #e5e7eb)'} opacity={d.count > 0 ? 0.85 : 0.35} />
                          })}
                        </svg>
                      </div>
                    )
                  })()}
                  <div className="mc-stats">
                    <div className="mc-stat mc-card"><b>{stats.total}</b><span>{t('total')}</span></div>
                    <div className="mc-stat mc-card"><b>{stats.today}</b><span>{t('todayAdd')}</span></div>
                    <div className="mc-stat mc-card"><b>{stats.week}</b><span>{t('weekAdd')}</span></div>
                    <div className="mc-stat mc-card"><b>{stats.tags}</b><span>{t('tags')}</span></div>
                  </div>
                  <div className="mc-card" style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('byKind')}</div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{kinds.map((k) => <span key={k} style={{ fontSize: 12 }}><span className="mc-kind" style={{ background: KG.colors[k] || '#666' }} />{t(KIND_LABELS[k])}: {stats.byKind?.[k] || 0}</span>)}</div>
                  </div>
                  {(budget && (budget.budgetChars || budget.recallLimit || budget.embedding)) && (
                    <div className="mc-card" style={{ marginBottom: 10, fontSize: 12 }}>
                      <b>{t('budgetLabel')}</b>：{t('budgetChars')} <b>{budget.budgetChars || 80000}</b> · {t('recallLimitLabel')} <b>{budget.recallLimit || 5}</b> · {t('embeddingLabel')} {budget.embedding ? 'ON' : 'OFF'}
                    </div>
                  )}
                  <div className="mc-card">
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('todayList')}（{stats.todayCards?.length || 0}）</div>
                    {stats.todayCards?.length ? <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>{stats.todayCards.map((c) => <KN key={c.path} title={c.title} kind={c.kind} updated={c.updated} path={c.path} />)}</ul> : <div style={{ opacity: 0.6, fontSize: 12 }}>{t('noOptimize')}</div>}
                  </div>
                </>
              )}
            </div>
          )}
          {tab === 'optimize' && (
            <div>
              {/* 手动触发工具条：搜索扫描 + 一键优化（不自动执行） */}
              <div className="mc-card mc-audit-batchcard" style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <b style={{ fontSize: 12 }}>{t('organizeTitle')}</b>
                <div style={{ flex: 1 }} />
                <button type="button" className="mc-btn" disabled={!!busy} onClick={scanOptimize}>{busy === 'scan' ? t('exporting') : '🔍 ' + t('scanAndOrganize')}</button>
                {opt && opt.merge?.length > 0 && (
                  <button type="button" className="mc-btn me-on" disabled={!!busy} onClick={async () => {
                    if (!window.confirm(t('oneClickOptimizeConfirm'))) return
                    setBusy('oneclick')
                    try {
                      const body = JSON.stringify({ cleanupStale: oneClickCleanupStale })
                      const r = await fetch(`${API}/optimize-execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
                      const d = await r.json()
                      if (d && d.ok) {
                        notify(`${t('oneClickOptimizeDone')}：${d.plan.merged} ${t('optimizedMerged')}${oneClickCleanupStale ? ` · ${d.plan.staleDeleted} ${t('optimizedStaleDeleted')}` : ''}`)
                        await fetchAll(); if (onReload) onReload(); setOpt(null)
                      } else { notify(t('mergeFail'), false) }
                    } catch { notify(t('mergeFail'), false) }
                    finally { setBusy('') }
                  }}>{busy === 'oneclick' ? t('exporting') : '⚡ ' + t('oneClickOptimize')}</button>
                )}
                {opt && opt.merge?.length > 0 && (
                  <label style={{ fontSize: 11, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="checkbox" checked={oneClickCleanupStale} onChange={(e) => setOneClickCleanupStale(e.target.checked)} />
                    {t('oneClickAlsoStale')}
                  </label>
                )}
              </div>
              {!opt && <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 10 }}>{t('scanHint')}</div>}
              {opt && (
                <>
                  <div className="mc-card" style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <b style={{ fontSize: 12 }}>{t('mergePairs')}</b>
                      <div className="spacer" style={{ flex: 1 }} />
                      {opt.merge?.length > 0 && <button type="button" className="mc-btn me-on" disabled={!!busy} onClick={doBatchMerge}>{busy === 'merge' ? t('exporting') : t('batchMerge')}</button>}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('mergePairs')}</div>
                    {opt.merge?.length ? (
                      <ul style={{ margin: '0 0 12px', padding: 0, listStyle: 'none' }}>
                        {opt.merge.map((m, i) => (
                          <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px', borderBottom: '1px solid rgba(127,127,127,0.12)', fontSize: 12 }}>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.a.title} ⇄ {m.b.title}</span>
                            <span style={{ opacity: 0.6 }}>{Math.round(m.sim * 100)}%</span>
                            <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} onClick={() => doMerge(m.a.path, m.b.path)}>{t('mergeNow')}</button>
                          </li>
                        ))}
                      </ul>
                    ) : <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 12 }}>{t('noOptimize')}</div>}
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('staleCards')}（{opt.stale?.length || 0}）</div>
                    {opt.stale?.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <button type="button" className="mc-btn" style={{ color: '#f87171' }} disabled={!!busy} onClick={async () => {
                          if (!window.confirm(t('deleteConfirm'))) return
                          setBusy('clean')
                          let n = 0
                          for (const s of opt.stale) { try { await fetch(`${API}/delete?path=${encodeURIComponent(s.path)}`); n++ } catch (e) {} }
                          setBusy('')
                          notify(`${n} ${t('deletedStale')}`)
                          await fetchAll(); if (onReload) onReload()
                        }}>{t('cleanStale')}</button>
                      </div>
                    )}
                    {opt.stale?.length ? <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>{opt.stale.map((s) => <KN key={s.path} title={s.title} kind="other" updated={s.updated} path={s.path} />)}</ul> : <div style={{ opacity: 0.6, fontSize: 12 }}>{t('noOptimize')}</div>}
                  </div>
                </>
              )}
              {/* 矛盾扫描（#36）：与上面「相似度合并」互补 —— 相似可以合并，**矛盾必须人来判断** */}
              <div className="mc-card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <b style={{ fontSize: 12 }}>🧭 {t('refineTitle')}</b>
                  <button type="button" className="mc-btn" disabled={!!busy} onClick={scanRefine}>{busy === 'refine' ? t('exporting') : t('refineScan')}</button>
                  <span style={{ opacity: 0.6, fontSize: 11 }}>{t('refineHint')}</span>
                </div>
                {refine?.findings?.length ? refine.findings.map((x, i) => (
                  <div key={i} style={{ borderTop: i ? '1px solid rgba(127,127,127,0.14)' : 'none', padding: '7px 2px' }}>
                    <div style={{ fontSize: 12, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, color: x.relation === 'conflict' ? '#ef4444' : x.relation === 'duplicate' ? '#f59e0b' : '#10b981' }}>{t('refineRel_' + x.relation)}</span>
                      <span style={{ opacity: 0.55 }}> · sim {x.sim} · {x.useModel || ''}</span>
                      {x.conflict ? <span style={{ marginLeft: 6 }}>{x.conflict}</span> : null}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 5 }}>A：{x.a.title}<br />B：{x.b.title}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => applyRefine(x, 'keepA')}>{t('refineKeepA')}</button>
                      <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => applyRefine(x, 'keepB')}>{t('refineKeepB')}</button>
                      <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => applyRefine(x, 'keepBoth')}>{t('refineKeepBoth')}</button>
                      <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => applyRefine(x, 'merge')}>{t('refineMerge')}</button>
                    </div>
                  </div>
                )) : <div style={{ opacity: 0.6, fontSize: 12 }}>{refine ? t('refineNone') : t('refineIdle')}</div>}
              </div>
              {/* 存量注入垃圾卡：DSH 运行时文本（技能目录 / system-reminder）被沉淀成卡，机器提议、人回收 */}
              <div className="mc-card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <b style={{ fontSize: 12 }}>🧹 {t('junkTitle')}</b>
                  <button type="button" className="mc-btn" disabled={!!busy} onClick={scanJunk}>{busy === 'junk' ? t('exporting') : t('junkScan')}</button>
                  {junk?.length ? <button type="button" className="mc-btn" disabled={!!busy} onClick={() => purgeJunk(junk.map((x) => x.path))}>{busy === 'junkpurge' ? t('exporting') : t('junkRecycleAll')}</button> : null}
                  <span style={{ opacity: 0.6, fontSize: 11 }}>{t('junkHint')}</span>
                </div>
                {junk?.length ? (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {junk.map((x, i) => (
                      <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', borderTop: i ? '1px solid rgba(127,127,127,0.14)' : 'none', fontSize: 12 }}>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.reasons.join('；')}>{x.title || x.path}</span>
                        <span style={{ opacity: 0.55, fontSize: 11 }}>{x.reasons[0]}</span>
                        <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => purgeJunk([x.path])}>{t('junkRecycle')}</button>
                      </li>
                    ))}
                  </ul>
                ) : <div style={{ opacity: 0.6, fontSize: 12 }}>{junk ? t('junkNone') : t('junkIdle')}</div>}
              </div>
              {/* 同目标、不同做法：正文相似度抓不到这种关系（7z 压缩 / tar 分发 / npm 瘦身 字面差很远） */}
              <div className="mc-card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <b style={{ fontSize: 12 }}>🎯 {t('goalTitle')}</b>
                  <button type="button" className="mc-btn" disabled={!!busy} onClick={scanGoals}>{busy === 'goals' ? t('exporting') : t('goalScan')}</button>
                  {goals ? <span style={{ opacity: 0.6, fontSize: 11 }}>{t('goalStats')}：{goals.cached} / {goals.calls}</span> : null}
                  <span style={{ opacity: 0.6, fontSize: 11 }}>{t('goalHint')}</span>
                </div>
                {goals?.clusters?.length ? goals.clusters.map((c, i) => (
                  <div key={i} style={{ borderTop: i ? '1px solid rgba(127,127,127,0.14)' : 'none', padding: '7px 2px' }}>
                    <div style={{ fontSize: 12, marginBottom: 4 }}><b>{c.goal}</b> <span style={{ opacity: 0.55 }}>· {c.members.length} {t('goalCards')}</span></div>
                    <ul style={{ margin: '0 0 5px', padding: '0 0 0 16px', fontSize: 12, opacity: 0.85 }}>
                      {c.members.map((m, j) => <li key={j}>{m.title}</li>)}
                    </ul>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => keepCluster(c)}>{t('goalKeep')}</button>
                      <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => mergeCluster(c)}>{t('goalMerge')}</button>
                    </div>
                  </div>
                )) : <div style={{ opacity: 0.6, fontSize: 12 }}>{goals ? t('goalNone') : t('goalIdle')}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
  )
}

// 新建卡模板：label/tags/body 全部存词条 key，渲染时经 t() 解析（跟随界面语言）
const NEW_CARD_TEMPLATES = [
  { key: 'decision', label: 'tplDecision', kind: 'knowledge', tagKey: 'tplDecisionTags', bodyKey: 'tplDecisionBody' },
  { key: 'bug', label: 'tplBug', kind: 'mistake', tagKey: 'tplBugTags', bodyKey: 'tplBugBody' },
  { key: 'meeting', label: 'tplMeeting', kind: 'content', tagKey: 'tplMeetingTags', bodyKey: 'tplMeetingBody' },
  { key: 'weekly', label: 'tplWeekly', kind: 'content', tagKey: 'tplWeeklyTags', bodyKey: 'tplWeeklyBody' },
]

function NewCardModal({ t, newCard, setNewCard, onCreated }) {
  if (!newCard) return null
  const T = NEW_CARD_TEMPLATES.find((x) => x.key === newCard.template)
  const body = newCard.body || (T ? t(T.bodyKey) : '')
  const kind = newCard.kind || (T ? T.kind : 'knowledge')
  const tags = newCard.tags || (T ? t(T.tagKey) : '')
  const creating = newCard._creating
  const applyTemplate = (key) => { const tpl = NEW_CARD_TEMPLATES.find((x) => x.key === key); setNewCard((v) => ({ ...v, template: key, kind: tpl ? tpl.kind : v.kind, body: tpl ? t(tpl.bodyKey) : v.body, tags: tpl ? t(tpl.tagKey) : v.tags })) }
  const doCreate = async () => {
    if (!newCard.title && !body) return
    setNewCard((v) => ({ ...v, _creating: true }))
    try {
      const r = await fetch(`${API}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newCard.title || t('untitled'), kind, tags: tags.split(',').map((tg) => tg.trim()).filter(Boolean), body, source: 'manual' }) }).then((x) => x.json())
      if (r.ok) { setNewCard(null); onCreated && onCreated() }
      else setNewCard((v) => ({ ...v, _creating: false }))
    } catch (e) { setNewCard((v) => ({ ...v, _creating: false })) }
  }
  return (
    <div className="me-overlay" onClick={() => setNewCard(null)}>
      <style>{CSS}</style>
      <div className="me-dialog" style={{ maxWidth: 600, width: '92vw', maxHeight: '85vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="me-dialog-head">
          <h3>{t('newCard')}</h3>
          <button type="button" className="mc-btn" onClick={() => setNewCard(null)}>{t('close')}</button>
        </div>
        <div className="me-dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {NEW_CARD_TEMPLATES.map((tpl) => (
              <button key={tpl.key} type="button" className={`mc-btn${newCard.template === tpl.key ? ' me-on' : ''}`} onClick={() => applyTemplate(tpl.key)}>{t(tpl.label)}</button>
            ))}
            <button type="button" className={`mc-btn${newCard.template === '' ? ' me-on' : ''}`} onClick={() => setNewCard((v) => ({ ...v, template: '', body: '', tags: '', kind: 'knowledge' }))}>{t('tplBlank')}</button>
          </div>
          <select className="mc-btn" value={kind} onChange={(e) => setNewCard((v) => ({ ...v, kind: e.target.value }))} style={{ maxWidth: 180, background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #111)' }}>
            {['project','knowledge','content','prompt','business','tool','mistake'].map((k) => <option key={k} value={k} style={{ background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #111)' }}>{k}</option>)}
          </select>
          <input type="text" className="mc-btn" placeholder={t('cardTitle')} value={newCard.title || ''} onChange={(e) => setNewCard((v) => ({ ...v, title: e.target.value }))} />
          <input type="text" className="mc-btn" placeholder={t('tagsHint')} value={tags} onChange={(e) => setNewCard((v) => ({ ...v, tags: e.target.value }))} />
          <textarea className="mc-btn" placeholder={t('cardBody')} value={body} onChange={(e) => setNewCard((v) => ({ ...v, body: e.target.value }))} style={{ minHeight: 180, resize: 'vertical', fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="mc-btn me-on" disabled={creating} onClick={doCreate}>{creating ? t('exporting') : t('createCard')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// （旧 CardReader 片段已由新版替换。）
/**
 * 「反馈异常」弹窗。
 *
 * 为什么不是「点一下自动提交」：GitHub 不允许匿名创建 issue，插件里也不能内置 token
 * （asar/JS 反编译即可提取）。所以这里把标题 / 正文 / 诊断全部预填进 GitHub 的新建 issue 链接，
 * 用户点一次 Submit 才算提交；同时提供「复制给 AI 的提示词」，让 AI 用 gh 直接建 issue。
 */
/**
 * 复制到剪贴板。
 *
 * 为什么要兜底：记忆弹窗跑在 **iframe** 里，iframe 默认没有 clipboard-write 权限，
 * navigator.clipboard.writeText() 会直接 reject —— 用户看到的就是「复制失败」。
 * 所以先试 Clipboard API，失败再退到 document.execCommand('copy')（不需要权限，只要有用户手势）。
 * @returns {Promise<boolean>} 是否复制成功
 */
async function copyToClipboard(text) {
  const s = String(text || '')
  if (!s) return false
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(s); return true }
  } catch { /* 落到 execCommand */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = s
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = !!(document.execCommand && document.execCommand('copy'))
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

function FeedbackModal({ t, onClose }) {
  const [text, setText] = useState('')
  const [diag, setDiag] = useState('')
  const [version, setVersion] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [toast, setToast] = useState('')
  const [fallback, setFallback] = useState('')
  const taRef = useRef(null)
  const toastTimer = useRef(null)
  const selectAll = () => { const el = taRef.current; if (el) { try { el.focus(); el.select() } catch {} } }
  const notify = (msg) => { setToast(msg); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2400) }
  useEffect(() => {
    let alive = true
    fetch(API + '/diagnostics')
      .then((r) => r.json())
      .then((d) => { if (!alive) return; if (d && d.ok) { setDiag(String(d.diagnostics || '')); setVersion(String(d.version || '')) } else setFailed(true) })
      .catch(() => { if (alive) setFailed(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); if (toastTimer.current) clearTimeout(toastTimer.current) }
  }, [onClose])
  // 语言用于选提示词模板；DSH 未把 locale 传到这里，用浏览器语言兜底
  const lang = (() => { try { return String(navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'zh' } catch { return 'zh' } })()
  const openIssue = () => {
    const first = text.trim().split('\n')[0] || ''
    const url = buildIssueUrl({ title: '[Bug] ' + (first.slice(0, 60) || 'memory-eternal 问题'), body: buildIssueBody({ description: text, diagnostics: diag, version }) })
    try { window.open(url, '_blank', 'noopener') } catch { notify(t('fbCopyFail')) }
  }
  const copyDiag = async () => {
    const ok = await copyToClipboard(diag)
    if (ok) { setFallback(''); notify(t('fbCopiedDiag')) } else { setFallback(diag); notify(t('fbCopyManual')) }
  }
  const copyPrompt = async () => {
    const prompt = buildAgentPrompt({ lang, description: text, diagnostics: diag })
    const ok = await copyToClipboard(prompt)
    if (ok) { setFallback(''); notify(t('fbCopiedPrompt')) } else { setFallback(prompt); notify(t('fbCopyManual')) }
  }
  const inputStyle = { width: '100%', resize: 'vertical', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13 }
  const preStyle = { margin: 0, maxHeight: 170, overflow: 'auto', fontSize: 11.5, lineHeight: 1.55, padding: '8px 10px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowX: 'hidden' }
  return (
    <div className="me-overlay" onClick={onClose}>
      <style>{CSS}</style>
      <div className="me-dialog" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="me-dialog-head">
          <h3>🐞 {t('fbTitle')}</h3>
          <button type="button" className="mc-btn" onClick={onClose}>{t('close')}</button>
        </div>
        <div className="me-dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>{t('fbWhy')}</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t('fbDesc')} rows={5} style={inputStyle} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <b style={{ fontSize: 12 }}>{t('fbDiag')}</b>
              <div style={{ flex: 1 }} />
              <button type="button" className="mc-btn" onClick={copyDiag} disabled={!diag}>{t('fbCopyDiag')}</button>
            </div>
            <pre style={preStyle}>{loading ? t('fbLoading') : (failed ? t('fbDiagFail') : diag)}</pre>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="mc-btn" onClick={() => { if (!text.trim()) { notify(t('fbNeedDesc')); return } openIssue() }} style={{ borderColor: 'var(--dsw-alias-brand-primary, #3b82f6)', color: 'var(--dsw-alias-brand-primary, #3b82f6)', fontWeight: 600 }}>🚀 {t('fbOpenIssue')}</button>
            <span style={{ opacity: 0.5, fontSize: 12 }}>{t('fbOr')}</span>
            <button type="button" className="mc-btn" onClick={copyPrompt}>🤖 {t('fbCopyPrompt')}</button>
          </div>
          {toast && <div style={{ fontSize: 12, color: 'var(--dsw-alias-brand-primary, #3b82f6)' }}>{toast}</div>}
          {/* 复制被拦截时的兜底：把内容摊开，用户点「全选」再 Ctrl+C 一定能成 */}
          {fallback && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <b style={{ fontSize: 12, color: '#b45309' }}>⚠ {t('fbCopyFail')}</b>
                <span style={{ fontSize: 11.5, opacity: 0.75 }}>{t('fbCopyManual')}</span>
                <div style={{ flex: 1 }} />
                <button type="button" className="mc-btn" onClick={selectAll}>{t('fbSelectAll')}</button>
              </div>
              <textarea ref={taRef} readOnly value={fallback} rows={7} style={inputStyle} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SupportModal({ t, tab, onTab, onClose, onFeedback, onReplay }) {
  const [zoom, setZoom] = useState(null)
  useEffect(() => {
    if (!zoom) return
    const onKey = (e) => { if (e.key === 'Escape') setZoom(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])
  const tabs = [
    { id: 'group', label: t('supportGroup') },
    { id: 'sponsor', label: t('supportSponsor') },
    { id: 'legacy', label: t('supportLegacy') },
  ]
  const readme = 'https://github.com/EternalNight996/memory-eternal/blob/main/README.md'
  const qr = (src, caption) => (
    <figure>
      <img src={src} alt={caption} loading="lazy" title={t('clickToZoom')} onClick={(e) => setZoom(e.currentTarget.currentSrc || src)} onError={(e) => {
        const img = e.currentTarget
        if (img.dataset.fb) return
        img.dataset.fb = '1'
        img.src = 'https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/' + String(src).split('/').pop()
      }} />
      <figcaption>{caption}</figcaption>
    </figure>
  )
  return (
    <div className="me-overlay" onClick={onClose}>
      <style>{CSS}</style>
      <div className="me-dialog me-support" onClick={(e) => e.stopPropagation()}>
        <div className="me-dialog-head">
          <h3>💬 {t('supportTitle')}</h3>
          <div className="me-head-actions">
            <button type="button" className="mc-btn" onClick={onClose}>{t('close')}</button>
          </div>
        </div>
        <div className="me-support-tabs">
          {tabs.map((x) => <button key={x.id} type="button" className={`me-support-tab${tab === x.id ? ' active' : ''}`} onClick={() => onTab(x.id)}>{x.label}</button>)}
        </div>
        <div className="me-support-body">
          {tab === 'group' && (
            <>
              <p className="me-support-note">{t('supportGroupHint')}</p>
              <div className="me-support-qr">
                {qr('support/group-qr.jpg', t('supportGroup'))}
              </div>
              <p className="me-support-note" style={{ marginTop: 12 }}><a className="me-support-link" href={readme} target="_blank" rel="noreferrer">{t('supportReadme')} ↗</a></p>
            </>
          )}
          {tab === 'sponsor' && (
            <>
              <p className="me-support-note">{t('supportSponsorHint')}</p>
              <div className="me-support-qr">
                {qr('support/wechat-pay.jpg', '微信收款码')}
                {qr('support/wechat-reward.jpg', '微信赞赏码')}
              </div>
              <p className="me-support-note" style={{ marginTop: 12 }}>打赏完全自愿，不影响任何功能；插件本体始终开源免费（MIT）。<br /><a className="me-support-link" href="https://github.com/EternalNight996/memory-eternal/blob/main/SPONSOR.md" target="_blank" rel="noreferrer">SPONSOR.md ↗</a></p>
            </>
          )}
          {tab === 'legacy' && (
            <>
              <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{t('supportLegacyTitle')}</h3>
              <p className="me-support-note">{t('supportLegacyBody')}</p>
              <div className="me-support-actions">
                <a className="mc-btn" href={readme} target="_blank" rel="noreferrer">📖 {t('supportReadme')} ↗</a>
                <a className="mc-btn" href="https://github.com/EternalNight996/memory-eternal/releases" target="_blank" rel="noreferrer">🏷 {t('supportReleases')} ↗</a>
              </div>
            </>
          )}
        </div>
        <div className="me-support-actions" style={{ padding: '0 18px 16px', marginTop: 0 }}>
          <button type="button" className="mc-btn" onClick={onFeedback}>🐞 {t('supportFeedback')}</button>
          <button type="button" className="mc-btn" onClick={onReplay}>✨ {t('supportReplay')}</button>
        </div>
      </div>
      {zoom && (
        <div className="me-lightbox" role="dialog" aria-modal="true" aria-label={t('close')} onClick={(e) => { e.stopPropagation(); setZoom(null) }}>
          <button type="button" className="me-lightbox-close" onClick={(e) => { e.stopPropagation(); setZoom(null) }} aria-label={t('close')}>✕</button>
          <img src={zoom} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}

function Onboarding({ t, onDone }) {
  const [step, setStep] = useState(0)
  const repo = 'https://github.com/EternalNight996/memory-eternal'
  const steps = [
    { title: t('onboardStep0Title'), body: t('onboardStep0Body') },
    { title: t('onboardStep1Title'), body: t('onboardStep1Body') },
    { title: t('onboardStep2Title'), body: t('onboardStep2Body') },
    { title: t('onboardStep3Title'), body: t('onboardStep3Body') },
  ]
  const last = step === steps.length - 1
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onDone() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])
  return (
    <div className="me-overlay" style={{ zIndex: 1006 }}>
      <style>{CSS}</style>
      <div className="me-dialog me-guide">
        <div className="me-guide-head">
          <b>✨ {t('onboardTitle')}</b>
          <div className="spacer" />
          <span style={{ fontSize: 11, opacity: 0.55 }}>{t('onboardSub')}</span>
        </div>
        <div className="me-guide-dots">
          {steps.map((_, i) => <span key={i} className={`me-guide-dot${i <= step ? ' on' : ''}`} />)}
        </div>
        <div className="me-guide-body">
          <h3>{steps[step].title}</h3>
          <p>{steps[step].body}</p>
          {step === 0 && (
            <div className="me-guide-github">
              <button type="button" className="mc-btn me-on" onClick={() => openExternal(repo)}>★ {t('onboardStar')}</button>
              <button type="button" className="mc-btn" onClick={() => openExternal(repo + '/fork')}>⑂ {t('onboardFork')}</button>
              <span className="me-guide-github-hint">{t('onboardStarHint')}</span>
            </div>
          )}
          {step === 1 && <div className="me-guide-chips"><span>自动沉淀</span><span>先审后入</span><span>只召回相关小块</span></div>}
          {step === 2 && <div className="me-guide-like"><span className="me-guide-thumb">👍</span> 有用</div>}
          {step === 3 && <div className="me-guide-chips"><span>💬 {t('supportGroup')}</span><span>☕ {t('supportSponsor')}</span><span>🧩 {t('supportLegacy')}</span><span>🐞 {t('supportFeedback')}</span></div>}
        </div>
        <div className="me-guide-actions">
          <button type="button" className="mc-btn" onClick={onDone}>{t('onboardSkip')}</button>
          <div className="spacer" />
          <span className="me-guide-tip">{t('onboardTip')}</span>
          {step > 0 && <button type="button" className="mc-btn" onClick={() => setStep((v) => v - 1)}>{t('onboardBack')}</button>}
          {last
            ? <button type="button" className="mc-btn me-on" onClick={onDone}>{t('onboardStart')}</button>
            : <button type="button" className="mc-btn me-on" onClick={() => setStep((v) => v + 1)}>{step === 0 ? t('onboardStarred') : t('onboardNext')}</button>}
        </div>
      </div>
    </div>
  )
}

function CardReader({ t, card, query, onClose, onDelete, onFeedback, onNavigate, onTagClick, allCards, onOpenRelated, onKindChange }) {
  // 读卡进度（0–100）：长卡片下让人知道还剩多少
  const [progress, setProgress] = useState(0)
  // 复制反馈（1.5s 自动消失）：没有它用户点了按钮不知道成没成
  const [copyTip, setCopyTip] = useState('')
  // 阅读宽度（窄/中/宽）—— 存在 localStorage，跨会话记住偏好
  const [widthMode, setWidthMode] = useState(() => {
    try { const v = localStorage.getItem('me-read-width'); return ['narrow', 'mid', 'wide'].includes(v) ? v : 'mid' } catch { return 'mid' }
  })
  const WIDTH_PX = { narrow: 720, mid: 900, wide: 1180 }
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      // j/k 上下张（不用方向键：方向键要留给正文滚动）
      const tag = String((e.target && e.target.tagName) || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return
      if (e.key === 'j' && onNavigate) { e.preventDefault(); onNavigate(1) }
      else if (e.key === 'k' && onNavigate) { e.preventDefault(); onNavigate(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate])
  const copyText = async (text, label) => {
    const ok = await copyToClipboard(String(text || ''))
    setCopyTip(ok ? t('copied') + ' · ' + label : t('copyFail'))
    setTimeout(() => setCopyTip(''), 1500)
  }
  // frontmatter 单独渲染成 chips：直接丢进正文会露出一段 YAML，一眼就"像机器输出"。
  const { meta, body } = useMemo(() => splitFrontmatter(card.text || ''), [card.text])
  const metaOf = (key) => { const hit = meta.find(([k]) => String(k).toLowerCase() === key); return hit ? hit[1] : '' }
  const tags = parseTags(metaOf('tags'))
  const kind = card.kind || metaOf('kind') || 'knowledge'
  const status = (metaOf('status') || 'approved').toLowerCase()
  const kindColor = KIND_COLORS[kind] || '#6B7280'
  const long = (body || '').length > 460
  const cleanBody = useMemo(() => stripRepeatedTitle(body, card.title), [body, card.title])
  const readerLead = useMemo(() => {
    const summary = cardLead(card)
    if (summary) return summary
    const line = cleanBody.split(/\r?\n/).map((x) => x.trim()).find((x) => x && !/^#{1,2}\s/.test(x)) || ''
    const s = line.replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim()
    return s.length > 150 ? s.slice(0, 148) + '…' : s
  }, [card, cleanBody])
  const toc = useMemo(() => tocOfMarkdown(cleanBody), [cleanBody])
  const related = useMemo(() => {
    const set = new Set(tags)
    return (allCards || []).filter((c) => c.path !== card.path && (c.tags || []).some((x) => set.has(x))).slice(0, 3)
  }, [allCards, card.path, tags.join('|')])
  // 默认「全部展开」，可收起（用户要求：打开卡片即读全文，需要时再折起来）。
  const [expanded, setExpanded] = useState(true)
  return (
    <div className="me-overlay" onClick={onClose}>
      <style>{CSS}</style>
      <div className="me-dialog me-reader-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="me-dialog-head">
          <h3 title={card.title}><span style={{ marginRight: 6, flex: 'none' }}>{KIND_EMOJI[kind] || '📎'}</span>{card.title}</h3>
          <div className="me-head-actions">
            {copyTip && <span style={{ fontSize: 11.5, color: '#10b981', whiteSpace: 'nowrap' }}>{copyTip}</span>}
            <button type="button" className="mc-btn" title={t('copyBody')} onClick={() => copyText(body, t('copyBody'))}>📋 {t('copyBody')}</button>
            <button type="button" className="mc-btn" title={t('copyPath')} onClick={() => copyText(card.path, t('copyPath'))}>🔗 {t('copyPath')}</button>
            <button type="button" className="mc-btn" title={t('readWidth')} onClick={() => { const order = ['narrow', 'mid', 'wide']; const next = order[(order.indexOf(widthMode) + 1) % order.length]; setWidthMode(next); try { localStorage.setItem('me-read-width', next) } catch { /* 隐私模式忽略 */ } }}>{t('readWidth')} · {t(widthMode === 'narrow' ? 'widthNarrow' : widthMode === 'wide' ? 'widthWide' : 'widthMid')}</button>
            <button type="button" className="mc-btn" onClick={() => onFeedback && onFeedback(true)}>👍 {t('fbUseful')}</button>
            <button type="button" className="mc-btn" onClick={() => onFeedback && onFeedback(false)}>👎 {t('fbIrr')}</button>
            {long && <button type="button" className="mc-btn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>{expanded ? t('collapse') : t('expand')}</button>}
            <button type="button" className="mc-btn" style={{ color: '#f87171' }} onClick={() => { if (window.confirm(t('deleteConfirm'))) onDelete && onDelete(card.path) }}>{t('delete')}</button>
            {onKindChange && status === 'approved' && (kind === 'core'
              ? <button type="button" className="mc-btn" onClick={() => onKindChange(card.path, 'knowledge')}>{t('unsetCore')}</button>
              : <button type="button" className="mc-btn" onClick={() => onKindChange(card.path, 'core')}>⭐ {t('setCore')}</button>)}
            <button type="button" className="mc-btn" onClick={onClose}>{t('close')}</button>
          </div>
        </div>
        <div className="md-meta">
          <span className="md-chip md-chip-kind" style={{ color: kindColor, borderColor: kindColor + '59', background: kindColor + '1a' }}>{KIND_EMOJI[kind] || '📎'} {t(KIND_LABELS[kind] || 'kindKnowledge')}</span>
          <span className={'md-chip ' + (status === 'approved' ? 'md-chip-st-ok' : status === 'pending' ? 'md-chip-st-warn' : 'md-chip-st-bad')}>{status === 'approved' ? '✅' : status === 'pending' ? '⏳' : '⛔'} {t(status === 'approved' ? 'statusApproved' : status === 'pending' ? 'statusPending' : 'statusRejected')}</span>
          {(Array.isArray(tags) ? tags : []).slice(0, 8).map((tag) => <button key={tag} type="button" className="md-chip md-chip-tag mc-tag-click" title={tag} onClick={() => onTagClick && onTagClick(tag)}>🏷 {tag}</button>)}
          {!!metaOf('updated') && <span className="md-chip md-date">🕒 {t('updated')} {fmtDate(metaOf('updated'))}</span>}
          {!!metaOf('source') && <span className="md-chip md-date">📥 {metaOf('source')}</span>}
        </div>
        <div className="me-read-progress" aria-hidden="true"><i style={{ width: progress + '%' }} /></div>
        <div className="me-reader-body">
          <div className="me-dialog-body me-reader-main"
            style={{ maxWidth: WIDTH_PX[widthMode], margin: '0 auto', width: '100%', boxSizing: 'border-box', ...(expanded ? {} : { maxHeight: 300, overflow: 'hidden' }) }}
            onScroll={(e) => { const el = e.currentTarget; const max = el.scrollHeight - el.clientHeight; setProgress(max <= 0 ? 100 : Math.min(100, Math.max(0, (el.scrollTop / max) * 100))) }}
            onClick={expanded ? undefined : (e) => { e.stopPropagation(); setExpanded(true) }}>
            {!!readerLead && (
              <div className="me-reader-callout">
                <span className="me-reader-callout-k">{t(cardInsightKey(card))}</span>
                <p>{readerLead}</p>
              </div>
            )}
            <div className="md-doc" dangerouslySetInnerHTML={{ __html: renderMd(cleanBody) }} />
          </div>
          <aside className="me-reader-side">
            {toc.length > 0 && (
              <>
                <div className="side-label">{t('contents')}</div>
                <div className="me-reader-toc">
                  {toc.map((h, i) => (
                    <button key={h.id} type="button" className={`lv${h.level}`} onClick={() => { const el = document.getElementById(h.id); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}>
                      <span>{String(i + 1).padStart(2, '0')}</span>{h.text}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="side-label">{t('source')}</div>
            <div className="me-reader-side-val">{metaOf('source') || card.submittedBy || '—'}</div>
            <div className="side-label">{t('updated')}</div>
            <div className="me-reader-side-val">{fmtDate(metaOf('updated') || card.updated)}</div>
            <div className="side-label">{t('file')}</div>
            <div className="me-reader-side-val mono">{card.path}</div>
            {tags.length > 0 && (
              <>
                <div className="side-label">{t('tags')}</div>
                <div className="me-reader-tags">
                  {tags.slice(0, 8).map((tag) => <button key={tag} type="button" className="mc-chip" onClick={() => onTagClick && onTagClick(tag)}>#{tag}</button>)}
                </div>
              </>
            )}
            {related.length > 0 && (
              <>
                <div className="side-label">{t('related')}</div>
                <div className="me-reader-related">
                  {related.map((r) => (
                    <button key={r.path} type="button" onClick={() => onOpenRelated && onOpenRelated(r)}>
                      <span>{KIND_EMOJI[r.kind] || '📎'}</span>
                      <b>{r.title}</b>
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>
        </div>
        {!expanded && <div className="md-collapsed-hint" onClick={(e) => { e.stopPropagation(); setExpanded(true) }}>{t('expand')} ⌄</div>}
      </div>
    </div>
  )
}
// -- Enhanced knowledge graph ------------------------------------------------

function GraphView({ t, onOpen, all, onAllChange, onMutate, active, visible }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const loadedRef = useRef(false)
  const fitTrigger = useRef(0)
  // 主 effect 依赖 [nodes, edges]，语言切换不重跑 → 经 ref 读最新 t（tooltip 等 canvas 内文案）
  const tRef = useRef(t)
  tRef.current = t

  const reload = useCallback(async () => {
    try {
      loadedRef.current = false
      const r = await fetch(`${API}/graph${all ? '?all=1' : ''}`)
      const d = await r.json()
      if (d.ok) { setData(d); setError(''); loadedRef.current = true }
      else { setData(null); setError(d.error || t('error')) }
    } catch (e) {
      setError(String(e && e.message ? e.message : e))
    }
  }, [all, t])

  // 首次激活时加载，之后切走不清空（缓存），只有 all 变化或手动刷新才重新获取
  useEffect(() => {
    if (!active || loadedRef.current) return
    let alive = true
    fetch(`${API}/graph${all ? '?all=1' : ''}`)
      .then((r) => r.json())
      .then((d) => { if (alive) { if (d.ok) { setData(d); setError(''); loadedRef.current = true } else { setData(null); setError(d.error || t('error')) } } })
      .catch((e) => { if (alive) setError(String(e && e.message ? e.message : e)) })
    return () => { alive = false }
  }, [all, t, active])

  // 切换到图谱视图时触发一次 fit，让画布居中适配
  useEffect(() => {
    if (visible && data) fitTrigger.current++
  }, [visible, data])

  const del = useCallback(async (path) => {
    try {
      const r = await fetch(`${API}/delete?path=${encodeURIComponent(path)}`)
      const d = await r.json()
      if (d && d.ok) { await reload(); onMutate && onMutate(); return true }
      return false
    } catch (e) { return false }
  }, [reload])

  const merge = useCallback(async (paths) => {
    if (!paths || paths.length < 2) return false
    try {
      const r = await fetch(`${API}/merge?paths=${encodeURIComponent(paths.join(','))}`).then((x) => x.json())
      if (r && r.ok) { await reload(); onMutate && onMutate(); return true }
      return false
    } catch (e) { return false }
  }, [reload, onMutate])

  return (
    <div className="me-graph me-v5-graph">
      <style>{CSS}</style>
      <div className="mc-v5-pagehead mc-v5-graphhead">
        <div>
          <div className="mc-v5-eyebrow">KNOWLEDGE GRAPH</div>
          <h1>{t('graphTab')}</h1>
          <p>{t('graphHint')}</p>
        </div>
        <span className="mc-v5-pagecount">{data ? `${data.nodes.length} ${t('nodes')} · ${countEdges(data.edges)} ${t('edges')}` : ''}</span>
      </div>
      {error && <div className="mc-empty">{t('error')}：{error}</div>}
      {!data && !error && <LoadingNote text={t('loadingGraph')} />}
      {data && data.nodes.length === 0 && <div className="mc-empty">{t('emptyGraph')}</div>}
      {data && data.nodes.length > 0 && (
        <GraphCanvas
          nodes={data.nodes}
          edges={data.edges}
          onOpen={onOpen}
          onDelete={del}
          onMerge={merge}
          t={t}
          all={all}
          onAllChange={onAllChange}
          countLabel={`${data.nodes.length} ${t('nodes')} · ${countEdges(data.edges)} ${t('edges')}`}
          fitTrigger={fitTrigger.current}
        />
      )}
    </div>
  )
}

function countEdges(edges) {
  const seen = new Set()
  for (const e of edges || []) seen.add([e.source, e.target].sort().join('|'))
  return seen.size
}

// agentmemory 式图谱：canvas 力导向 + 按 kind 聚合 + 分型节点 + 渐变/发光 + 药丸标签 + 网格。
const KG = {
  colors: { project:'#3B82F6', knowledge:'#10B981', content:'#F59E0B', prompt:'#A855F7', business:'#EC4899', tool:'#06B6D4', mistake:'#EF4444', other:'#6B7280' },
  shapes: { project:'circle', knowledge:'circle', content:'rect', prompt:'diamond', business:'hexagon', tool:'circle', mistake:'diamond', other:'circle' },
}

// 图谱绘制异常兜底：渲染循环里的异常原来被空 catch 静默吞掉（表现是画布永远空白、
// Console 里也没有任何线索）；而 React effect 里的同步重绘一旦抛出又会卸载整棵组件树
// → 整页白屏。统一走这里：只告警一次（避免每帧刷屏），把线索留在 Console，但绝不往上抛。
function warnGraphDrawError(err, where) {
  try {
    const g = globalThis
    if (g.__meGraphDrawWarned) return
    g.__meGraphDrawWarned = true
    console.warn('[memory-eternal] 知识图谱绘制异常（已兜底，不再整页白屏）' + (where ? ' @ ' + where : ''), err)
  } catch (e) { /* 连 console 都不可用时彻底静默 */ }
}

/**
 * 进度条。value = 0~100 是确定进度（知道还剩多少时用）；不传就是不确定进度（网络阶段）。
 * role=progressbar + aria-valuenow：读屏和自动化都能读到真实进度。
 */
function ProgressBar({ value, small }) {
  const determinate = typeof value === 'number' && Number.isFinite(value)
  const pct = determinate ? Math.max(0, Math.min(100, value)) : 0
  return (
    <div
      className={'me-progress' + (small ? ' me-progress-sm' : '') + (determinate ? ' is-determinate' : '')}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      aria-label="加载进度"
    >
      <span className="me-progress-fill" style={determinate ? { width: Math.max(3, pct) + '%' } : undefined} />
    </div>
  )
}

/** 统一的「加载中」提示：进度条 + 文案。首屏 / 图谱数据 / 大图布局都用它。 */
function LoadingNote({ text, value }) {
  return (
    <div className="me-loading" role="status" aria-live="polite">
      <ProgressBar value={value} />
      <span className="me-loading-text">{text}</span>
    </div>
  )
}

function GraphCanvas({ nodes, edges, onOpen, onDelete, onMerge, t, countLabel, all, onAllChange, fitTrigger }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const simRef = useRef(null)
  const fitRef = useRef(null)
  const resetRef = useRef(null)
  const onOpenRef = useRef(onOpen)
  useEffect(() => { onOpenRef.current = onOpen }, [onOpen])
  const onDeleteRef = useRef(onDelete)
  useEffect(() => { onDeleteRef.current = onDelete }, [onDelete])
  const onMergeRef = useRef(onMerge)
  useEffect(() => { onMergeRef.current = onMerge }, [onMerge])
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState(null)
  // 预热进度：>0 表示「分帧布局」还没跑完（此时显示进度提示，且不启动常规 rAF 循环）
  // 布局预热进度（0~100）；null = 不在预热。这是**真实百分比**（预热 tick 是有限且可数的）
  const [warming, setWarming] = useState(null)
  const searchRef = useRef('')
  useEffect(() => { searchRef.current = search.trim().toLowerCase() }, [search])
  // 搜索定位：输入命中节点时，把画布居中到该节点并略微放大。
  useEffect(() => {
    const s = simRef.current
    if (!s) return
    const q = search.trim().toLowerCase()
    if (!q) return
    const best = s.nodes.find((n) => (n.name || '').toLowerCase().includes(q))
    if (best) { simRef.current.selectedId = best.id; setSel(best.id); s.panX = s.w / 2 - best.x * s.zoom; s.panY = s.h / 2 - best.y * s.zoom; try { if (s.render) s.render() } catch (e) { warnGraphDrawError(e, 'search-center') } }
  }, [search])
  const [filterKind, setFilterKind] = useState('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef('all')
  const [filterTag, setFilterTag] = useState('')
  const tagRef = useRef('')
  const [timeMode, setTimeMode] = useState(false)
  const timeRef = useRef(false)
  const [ctx, setCtx] = useState(null)
  useEffect(() => { filterRef.current = filterKind }, [filterKind])
  useEffect(() => { tagRef.current = filterTag }, [filterTag])
  useEffect(() => { timeRef.current = timeMode }, [timeMode])
  // 标签云：从节点聚合出高频标签（去重、按频次排序、上限 24）。
  const allTags = useMemo(() => {
    const m = new Map()
    for (const n of nodes) { for (const tg of (n.tags || [])) { const t0 = String(tg).trim(); if (t0) m.set(t0, (m.get(t0) || 0) + 1) } }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t0, n0]) => ({ tag: t0, n: n0 }))
  }, [nodes])
  const kindStats = useMemo(() => {
    const m = {}
    for (const n of nodes) m[n.kind || 'other'] = (m[n.kind || 'other'] || 0) + 1
    return m
  }, [nodes])
  const noMatch = (() => { const q = search.trim().toLowerCase(); return !!q && !nodes.some((n) => (n.title || n.name || '').toLowerCase().includes(q) || String(n.kind || '').toLowerCase().includes(q) || String(KIND_LABELS[n.kind] || '').toLowerCase().includes(q)) })()
  // 搜索变化时唤醒仿真重绘（否则布局停车后搜索不刷新）
  useEffect(() => { const s = simRef.current; if (s && s.wake) s.wake() }, [search])
  // 图例/标签/时间维 过滤变化时直接重绘（不重启布局）。
  // 必须兜住异常：这是 React effect 里的同步调用，一旦抛出就会把整棵组件树卸载 → 整页白屏。
  useEffect(() => { const s = simRef.current; if (!s || !s.render) return; try { s.render() } catch (e) { warnGraphDrawError(e, 'filter/timeDim') } }, [filterKind, filterTag, timeMode])
  const tooltipRef = useRef(null)
  const [multi, setMulti] = useState([])
  const [exportData, setExportData] = useState(null)
  const [exportFull, setExportFull] = useState(false)
  const [toast, setToast] = useState(null)
  const [exportDone, setExportDone] = useState('') // 'download' | 'copy' | 'tab' | 'full'
  const toastTimer = useRef(null)
  const exportTimer = useRef(null)
  const notify = (msg, ok = true) => { if (toastTimer.current) clearTimeout(toastTimer.current); setToast({ msg, ok }); toastTimer.current = setTimeout(() => setToast(null), 1900) }
  const markDone = (k) => { setExportDone(k); if (exportTimer.current) clearTimeout(exportTimer.current); exportTimer.current = setTimeout(() => setExportDone(''), 1600) }
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); if (exportTimer.current) clearTimeout(exportTimer.current) }, [])
  const nodeById = useMemo(() => nodes.reduce((m, n) => (m[n.id] = n, m), {}), [nodes])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || nodes.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1))
    const degrade = () => document.documentElement.getAttribute('data-theme') === 'dark'

    const deg = {}
    edges.forEach((e) => { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1 })
    const maxDeg = Math.max(1, ...Object.values(deg))

    const sim = {
      nodes: nodes.map((n) => ({ id: n.id, name: n.title || '', type: n.kind || 'other', r: 9 + Math.min(10, ((deg[n.id] || 0) / maxDeg) * 8), x: 0, y: 0, vx: 0, vy: 0 })),
      edges: edges.map((e) => ({ sourceNodeId: e.source, targetNodeId: e.target, weight: 1 })),
      panX: 0, panY: 0, zoom: 1, running: true, raf: 0, tickCount: 0, quietTicks: 0, dragNode: null, selectedId: null, mouseX: 0, mouseY: 0, w: 0, h: 0, dpr, ctx, multi: [], marquee: null,
    }
    sim.domain = nodes
    sim.domainById = nodes.reduce((m, n) => (m[n.id] = n, m), {})
    // 初始位形：黄金角螺旋（半径 ∝ √i）。原来是「半径 60 的圆等分」——1084 个节点全挤在
    // 一个小圆上，首帧就是一团墨点；螺旋铺开后首帧是一盘散点，预热过程也更自然。
    sim.nodes.forEach((n, i) => { const a = i * 2.399963229728653; const r = 12 * Math.sqrt(i); n.x = Math.cos(a) * r; n.y = Math.sin(a) * r })
    const types = [...new Set(sim.nodes.map((n) => n.type))]
    sim.clustered = types.length > 1
    sim.typeCenters = {}
    types.forEach((ty, i) => { const a = (i / types.length) * Math.PI * 2 - Math.PI / 2; sim.typeCenters[ty] = { x: Math.cos(a) * 160, y: Math.sin(a) * 160 } })
    simRef.current = sim

    let lastW = 0, lastH = 0
    let gridPath = null, gridKey = ''
    const resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight
      sim.w = w; sim.h = h
      canvas.width = w * dpr; canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // 容器从 0 变为有效尺寸时（display:none → flex），自动 fit 居中
      if ((lastW === 0 || lastH === 0) && w > 0 && h > 0 && sim.tickCount > 0) {
        requestAnimationFrame(() => fit())
      }
      lastW = w; lastH = h
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas.parentElement)

    const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s)

    const drawShape = (x, y, r, shape) => {
      ctx.beginPath()
      if (shape === 'rect') ctx.rect(x - r, y - r * 0.75, r * 2, r * 1.5)
      else if (shape === 'diamond') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath() }
      else if (shape === 'hexagon') { for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i - Math.PI / 2; const hx = x + r * Math.cos(a), hy = y + r * Math.sin(a); if (i === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy) } ctx.closePath() }
      else ctx.arc(x, y, r, 0, Math.PI * 2)
    }

    // 渐变缓存：原来每帧每节点都 createRadialGradient（593 卡 = 593 次/帧）。
    // 渐变对象在**填充时**按当前变换生效，所以按「颜色|半径」缓存一份局部坐标的渐变，
    // 绘制时把 ctx 平移到节点位置即可复用 —— 首帧之后基本零创建。
    const gradCache = new Map()
    const gradientFor = (color, r) => {
      const key = color + '|' + Math.round(r)
      let g = gradCache.get(key)
      if (!g) {
        const cr = parseInt(color.slice(1,3),16), cg = parseInt(color.slice(3,5),16), cb = parseInt(color.slice(5,7),16)
        g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r * 1.2)
        g.addColorStop(0, 'rgba(' + Math.min(255,cr+70) + ',' + Math.min(255,cg+70) + ',' + Math.min(255,cb+70) + ',0.95)')
        g.addColorStop(1, color)
        gradCache.set(key, g)
      }
      return g
    }

    // 滚轮/初始视图共用同一个「度」：一格 = ×ZOOM_STEP（滚轮、放大/缩小按钮、初始 fit 一致）。
    const ZOOM_STEP = 1.1
    // 初始视图比「刚好铺满」再**缩小三度**：节点不再挤到边缘，四周留出可拖拽/框选的余量。
    // 用户反馈：卡数量多时默认视图偏大、放大容易卡；再缩小一度，默认先看全局。
    const INITIAL_ZOOM_OUT_STEPS = 3
    const fit = () => {
      if (!sim.nodes.length) return
      let minX = 1/0, maxX = -1/0, minY = 1/0, maxY = -1/0
      sim.nodes.forEach((n) => { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y) })
      const pad = 20
      const spanX = (maxX - minX) + pad * 2, spanY = (maxY - minY) + pad * 2
      const z = Math.min(sim.w / spanX, sim.h / spanY)
      // 展示全部：按边界精确缩放（不放大裁剪），让所有节点一屏可见、无滚动。
      // 再叠一个「初始视图缩小三度」的系数（重置视图按钮也走这里，行为与首次打开一致）。
      const initialZoomOut = Math.pow(1 / ZOOM_STEP, INITIAL_ZOOM_OUT_STEPS)
      sim.zoom = Math.max(0.35, Math.min(1.8, z * initialZoomOut))
      sim.panX = sim.w / 2 - ((minX + maxX) / 2) * sim.zoom
      sim.panY = sim.h / 2 - ((minY + maxY) / 2) * sim.zoom
    }
    fitRef.current = fit

    const render = () => {
      ctx.clearRect(0, 0, sim.w, sim.h)
      sim.searchTerm = searchRef.current
      sim.kindFilter = filterRef.current
      sim.timeMode = timeRef.current
      sim.tagFilter = tagRef.current

      const kfTag = sim.tagFilter
      const kf = sim.kindFilter
      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // grid：只构建一次 Path2D，尺寸变化时重建；不再每帧 stroke 上百次
      ctx.save()
      const gk = sim.w + 'x' + sim.h
      if (!gridPath || gridKey !== gk) {
        gridPath = new Path2D()
        for (let gx = 0; gx < sim.w; gx += 24) { gridPath.moveTo(gx, 0); gridPath.lineTo(gx, sim.h) }
        for (let gy = 0; gy < sim.h; gy += 24) { gridPath.moveTo(0, gy); gridPath.lineTo(sim.w, gy) }
        gridKey = gk
      }
      ctx.strokeStyle = degrade() ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'
      ctx.lineWidth = 0.5
      ctx.stroke(gridPath)
      ctx.restore()
      ctx.save()
      ctx.translate(sim.panX, sim.panY); ctx.scale(sim.zoom, sim.zoom)
      const nodeMap = {}
      sim.nodes.forEach((n) => (nodeMap[n.id] = n))
      const dense = sim.nodes.length > 40
      const labelThreshold = dense ? 1.5 : 0.55
      const focusId = sim.selectedId || sim.hoverId
      // ---- LOD：先算出视口对应的世界矩形，后面节点/边/标签都按它剔除 ----
      const viewRect = visibleWorldRect({ panX: sim.panX, panY: sim.panY, zoom: sim.zoom, w: sim.w, h: sim.h, margin: 80 })
      const searchHits = (() => {
        const term = (sim.searchTerm || '').toLowerCase()
        if (!term) return null
        const ids = []
        for (const n of sim.nodes) {
          const info = sim.domainById[n.id] || {}
          const kind = info.kind || 'other'
          const hit = (n.name || '').toLowerCase().includes(term) || String(KIND_LABELS[kind] || '').toLowerCase().includes(term) || String(kind).toLowerCase().includes(term)
          if (hit) ids.push(n.id)
          if (ids.length > 200) break
        }
        return ids
      })()
      const labelIds = pickLabelIds(sim.nodes, { limit: labelBudget(sim.nodes.length), focusId, hoverId: sim.hoverId, searchHits, degree: deg })
      // 文本宽度缓存：原来每帧每个标签都要 measureText（589 个标签时是大头）
      const measureCache = new Map()
      const measureText = (font, text) => {
        const key = font + '|' + text
        let w = measureCache.get(key)
        if (w === undefined) { ctx.font = font; w = ctx.measureText(text).width; measureCache.set(key, w) }
        return w
      }
      // 大图关阴影：视觉损失可接受，换来成倍的帧时间（用户明确同意牺牲部分美化）
      const paintShadows = sim.nodes.length <= 250
      // 边按「颜色 + 透明度 + 线宽」分桶，用 Path2D 一次描边：
      // 原来每条边一次 beginPath/stroke（2.7k 条 = 2.7k 次绘制调用），现在只按配色桶数描边。
      const edgeBuckets = new Map()
      // 大图远景：先不画边，优先保证拖动/缩放帧率；放大后再显示关系
      const skipEdges = sim.nodes.length > 1200 && sim.zoom < 0.3
      sim.edges.forEach((e) => {
        if (skipEdges) return
        const s = nodeMap[e.sourceNodeId], t = nodeMap[e.targetNodeId]
        if (!s || !t) return
        // 视口剔除：两端都在屏幕外就不画（放大后大部分边都被剔掉）
        if (!inRect(s.x, s.y, 10, viewRect) && !inRect(t.x, t.y, 10, viewRect)) return
        if (kf !== 'all') { const sK = sim.domainById[e.sourceNodeId] && sim.domainById[e.sourceNodeId].kind; const tK = sim.domainById[e.targetNodeId] && sim.domainById[e.targetNodeId].kind; if (sK !== kf && tK !== kf) return }
        if (kfTag) { const sT = sim.domainById[e.sourceNodeId] && (sim.domainById[e.sourceNodeId].tags || []).includes(kfTag); const tT = sim.domainById[e.targetNodeId] && (sim.domainById[e.targetNodeId].tags || []).includes(kfTag); if (!sT && !tT) return }
        let dr = t.x - s.x, dy = t.y - s.y
        const len = Math.sqrt(dr * dr + dy * dy) || 1
        const curve = dense ? 12 : 18
        const ox = -dy / len * curve, oy = dr / len * curve
        const cpx = (s.x + t.x) / 2 + ox, cpy = (s.y + t.y) / 2 + oy
        const color = KG.colors[sim.domainById[s.id] ? (sim.domainById[s.id].kind || 'other') : 'other'] || KG.colors.other
        const focused = focusId && (e.sourceNodeId === focusId || e.targetNodeId === focusId)
        const alpha = focusId ? (focused ? 0.6 : 0.08) : (dense ? 0.14 : 0.24)
        const cr = parseInt(color.slice(1,3),16), cg = parseInt(color.slice(3,5),16), cb = parseInt(color.slice(5,7),16)
        const width = focused ? 1.6 + (e.weight||1) : 0.8 + (e.weight||1)*0.5
        const key = cr + ',' + cg + ',' + cb + ',' + alpha + ',' + width
        let bucket = edgeBuckets.get(key)
        if (!bucket) {
          bucket = { path: new Path2D(), stroke: 'rgba(' + cr + ',' + cg + ',' + cb + ',' + alpha + ')', width }
          edgeBuckets.set(key, bucket)
        }
        bucket.path.moveTo(s.x, s.y)
        bucket.path.quadraticCurveTo(cpx, cpy, t.x, t.y)
      })
      edgeBuckets.forEach((b) => { ctx.strokeStyle = b.stroke; ctx.lineWidth = b.width; ctx.stroke(b.path) })
      // 邻接索引：dim 判定原本是 O(节点 × 边) —— 593 卡 × 1.2 万条边、每帧几百万次比较，
      // 实测 52ms/帧。先把 focusId 的邻居收进 Set，判定降为 O(1)，每帧只多一次 O(E) 建表。
      let focusNeighbors = null
      if (focusId) {
        focusNeighbors = new Set()
        sim.edges.forEach((ed) => {
          if (ed.sourceNodeId === focusId) focusNeighbors.add(ed.targetNodeId)
          else if (ed.targetNodeId === focusId) focusNeighbors.add(ed.sourceNodeId)
        })
      }
      // nodes
      const drawn = []
      sim.nodes.forEach((n) => {
        // 视口剔除：屏幕外的节点连渐变/形状/标签都不必画
        if (!inRect(n.x, n.y, n.r + 2, viewRect)) return
        const info = sim.domainById[n.id] || {}
        const kind = info.kind || 'other'
        // kind 兜底：未知类型（历史卡/外部导入）以前会让 KG.colors[kind] 变成 undefined，
        // 随后 gradientFor 里 color.slice() 直接 TypeError —— 现在统一落到 other 的配色/圆点，
        // 坏数据最多画得朴素一点，不会再抛异常（并在兜底处告警一次）。
        const color = sim.timeMode ? recencyColor(info.updated) : (KG.colors[kind] || KG.colors.other)
        const shape = KG.shapes[kind] || 'circle'
        const isSel = sim.selectedId === n.id, isHov = sim.hoverId === n.id
        const searchTerm = sim.searchTerm || ''
        const searchHit = !searchTerm || (n.name || '').toLowerCase().includes(searchTerm) || String(KIND_LABELS[kind] || '').toLowerCase().includes(searchTerm) || String(kind).toLowerCase().includes(searchTerm)
        const kindOk = kf === 'all' || kind === kf
        const tagOk = !kfTag || ((info.tags || []).includes(kfTag))
        const dimmed = (focusId && n.id !== focusId && !(focusNeighbors && focusNeighbors.has(n.id))) || (searchTerm && !searchHit) || !kindOk || !tagOk
        ctx.save()
        ctx.globalAlpha = dimmed ? 0.08 : 1
        if ((isSel || isHov) && paintShadows) { ctx.shadowColor = color; ctx.shadowBlur = isSel ? 20 : 14 }
        ctx.translate(n.x, n.y) // 局部坐标 → 渐变可跨节点复用
        drawShape(0, 0, n.r, shape)
        ctx.fillStyle = gradientFor(color, n.r); ctx.fill(); ctx.restore()
        if (isSel) { ctx.save(); drawShape(n.x, n.y, n.r+3, shape); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.stroke(); ctx.restore() }
        else if (isHov) { ctx.save(); drawShape(n.x, n.y, n.r+2, shape); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); ctx.restore() }
        else if (searchTerm && searchHit) { ctx.save(); drawShape(n.x, n.y, n.r+2, shape); ctx.strokeStyle = '#e11d48'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore() }
        else if (sim.multi.indexOf(n.id) >= 0) { ctx.save(); drawShape(n.x, n.y, n.r+2, shape); ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2; ctx.shadowColor = '#60a5fa'; ctx.shadowBlur = 8; ctx.stroke(); ctx.restore() }
        // pill label
        const label = truncate(n.name, 16)
        // 标签预算：大图只画「焦点/悬停/搜索命中/度数最高」的若干节点。
        // 原来 zoom > labelThreshold 时 589 个标签全画（每个都要 measureText + 圆角矩形 + fillText），
        // 这正是「放大后卡顿、缩小正常」的原因。
        const showLab = (isSel || isHov || (labelIds.has(n.id) && sim.zoom > labelThreshold) || (!dense && sim.zoom > 0.6)) && kindOk && tagOk
        if (showLab) {
          const zi = 1 / sim.zoom
          const font = '500 ' + (12 * zi).toFixed(1) + 'px -apple-system,Segoe UI,sans-serif'
          ctx.font = font
          const tw = measureText(font, label)
          const lw = tw + 16 * zi, lh = 18 * zi
          const ly = n.y + n.r + 8 * zi
          let fits = true
          for (const r of drawn) { if (n.x - lw/2 < r.x + r.w && n.x + lw/2 > r.x && ly < r.y + r.h && ly + lh > r.y) { fits = false; break } }
          if (!fits && !isSel && !isHov) return
          drawn.push({ x: n.x - lw/2, y: ly, w: lw, h: lh })
          ctx.fillStyle = degrade() ? 'rgba(30,30,35,0.92)' : 'rgba(255,255,255,0.92)'
          ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(n.x - lw/2, ly, lw, lh, 4*zi); else ctx.rect(n.x - lw/2, ly, lw, lh); ctx.fill()
          ctx.strokeStyle = degrade() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
          ctx.lineWidth = 1 * zi; ctx.stroke()
          ctx.fillStyle = degrade() ? (isSel||isHov ? '#eee' : '#bbb') : (isSel||isHov ? '#111' : '#444')
          ctx.textAlign = 'center'; ctx.fillText(label, n.x, ly + 13 * zi)
        }
      })
      ctx.restore()
      // Marquee 框选矩形（屏幕坐标）
      if (sim.marquee) {
        const m = sim.marquee
        const mx = Math.min(m.sx, m.ex), my = Math.min(m.sy, m.ey), mw = Math.abs(m.ex - m.sx), mh = Math.abs(m.ey - m.sy)
        ctx.save()
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = 'rgba(96,165,250,0.9)'; ctx.lineWidth = 1
        ctx.fillStyle = 'rgba(96,165,250,0.12)'
        ctx.fillRect(mx, my, mw, mh); ctx.strokeRect(mx, my, mw, mh)
        ctx.restore()
      }
      // 玻璃拟态 tooltip
      if (sim.hoverId && tooltipRef.current) {
        const hn = sim.domainById[sim.hoverId]
        const sn = sim.nodes.find(function (x) { return x.id === sim.hoverId })
        if (hn && sn) {
          const conn = sim.edges.filter(function (ed) { return ed.sourceNodeId === hn.id || ed.targetNodeId === hn.id }).length
          const lx = sn.x * sim.zoom + sim.panX, ly = sn.y * sim.zoom + sim.panY
          tooltipRef.current.style.display = 'block'
          tooltipRef.current.style.left = (lx + 14) + 'px'
          tooltipRef.current.style.top = (ly - 6) + 'px'
          tooltipRef.current.innerHTML = '<b>' + esc(hn.title || hn.name || '') + '</b><br/><span style="opacity:.8">' + esc(hn.kind || '') + ' · ' + tRef.current('connCount').replace('{n}', conn) + '</span>'
        }
      } else if (tooltipRef.current) tooltipRef.current.style.display = 'none'
    }

    // 预热期间不启动常规 rAF 循环（预热自己驱动 rAF），避免同一帧里跑两遍 tick。
    let warmLeft = 0
    const wake = () => { if (warmLeft > 0) return; sim.running = true; if (!sim.raf) sim.raf = requestAnimationFrame(step) }
    sim.wake = wake
    sim.render = render

    const tick = () => {
      const nn = sim.nodes.length
      sim.tickCount++
      const cool = Math.min(0.4, sim.tickCount / 1500)
      const damping = 0.9 - cool
      const repulsion = nn > 1000 ? 3000 : nn > 100 ? 2000 : nn > 50 ? 1200 : 800
      const attraction = nn > 100 ? 0.002 : 0.005
      const centerGravity = nn > 1000 ? 0.012 : nn > 100 ? 0.005 : 0.01
      const velCap = nn > 1000 ? 6 : nn > 200 ? 12 : 24
      const map = {}; sim.nodes.forEach((n) => (map[n.id] = n))
      for (let i = 0; i < nn; i++) {
        if (sim.dragNode === sim.nodes[i]) continue
        const n = sim.nodes[i]; let fx = 0, fy = 0
        for (let j = 0; j < nn; j++) { if (i === j) continue; const dx = n.x - sim.nodes[j].x, dy = n.y - sim.nodes[j].y; const d = Math.sqrt(dx*dx+dy*dy)||1; const f = repulsion/(d*d); fx += dx/d*f; fy += dy/d*f }
        if (sim.clustered && sim.typeCenters[n.type]) { const tc = sim.typeCenters[n.type]; fx += (tc.x - n.x) * 0.006; fy += (tc.y - n.y) * 0.006 }
        else { fx -= n.x * centerGravity; fy -= n.y * centerGravity }
        let nvx = (n.vx + fx) * damping, nvy = (n.vy + fy) * damping
        nvx = Math.max(-velCap, Math.min(velCap, nvx)); nvy = Math.max(-velCap, Math.min(velCap, nvy))
        n.vx = nvx; n.vy = nvy
      }
      sim.edges.forEach((e) => {
        const s = map[e.sourceNodeId], t = map[e.targetNodeId]; if (!s || !t) return
        const dx = t.x - s.x, dy = t.y - s.y; const d = Math.sqrt(dx*dx+dy*dy)||1
        const f = (d - 100) * attraction; const fx = dx/d*f, fy = dy/d*f
        if (sim.dragNode !== s) { s.vx += fx; s.vy += fy }
        if (sim.dragNode !== t) { t.vx -= fx; t.vy -= fy }
      })
      let kinetic = 0
      sim.nodes.forEach((n) => { if (sim.dragNode === n) return; n.x += n.vx; n.y += n.vy; kinetic += n.vx*n.vx + n.vy*n.vy })
      if (sim.autoFitPending && sim.tickCount > 45) { sim.autoFitPending = false; fit() }
      const rms = nn ? Math.sqrt(kinetic / nn) : 0
      if (rms < 0.05 && sim.tickCount > 60 && !sim.dragNode) sim.quietTicks = (sim.quietTicks|0)+1; else sim.quietTicks = 0
    }

    const step = () => {
      if (!sim.running) return
      try { tick(); render() } catch (er) { warnGraphDrawError(er, 'step') }
      if (sim.quietTicks > 30) { sim.raf = 0; return }
      sim.raf = requestAnimationFrame(step)
    }

    // interactions
    const toWorld = (cx, cy) => { const r = canvas.getBoundingClientRect(); return { x: (cx - r.left - sim.panX) / sim.zoom, y: (cy - r.top - sim.panY) / sim.zoom } }
    const nodeVisible = (id) => { const info = sim.domainById[id]; if (!info) return false; if (filterRef.current !== 'all' && info.kind !== filterRef.current) return false; if (tagRef.current && !(info.tags || []).includes(tagRef.current)) return false; return true }
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
    const onMove = (e) => { sim.mouseX = e.clientX; sim.mouseY = e.clientY; const w = toWorld(e.clientX, e.clientY); let hov = null; for (let i = sim.nodes.length-1; i>=0; i--) { const n = sim.nodes[i]; if (!nodeVisible(n.id)) continue; const dx = n.x - w.x, dy = n.y - w.y; if (dx*dx + dy*dy < n.r*n.r + 36) { hov = n.id; break } } if (hov !== sim.hoverId) { sim.hoverId = hov; wake() } }
    const onDown = (e) => {
      if (e.button !== 0) return
      const w = toWorld(e.clientX, e.clientY); let hit = null
      for (let i = sim.nodes.length-1; i>=0; i--) { const n = sim.nodes[i]; if (!nodeVisible(n.id)) continue; const dx = n.x - w.x, dy = n.y - w.y; if (dx*dx + dy*dy < n.r*n.r + 25) { hit = n; break } }
      if (e.shiftKey) {
        // shift+点击节点 = 单点凸显（并入 multi）；shift+点击空白 = 拖拽框选
        if (hit) { sim.shiftClick = hit.id; return }
        sim.marquee = { sx: e.clientX, sy: e.clientY, ex: e.clientX, ey: e.clientY }; return
      }
      sim.userTouched = true
      sim.dragStart = { x: e.clientX, y: e.clientY, px: sim.panX, py: sim.panY }
      sim.dragging = false; sim.dragNode = hit || null
      if (hit) sim.dragOffset = { dx: hit.x - w.x, dy: hit.y - w.y }
    }
    const onDrag = (e) => {
      if (sim.marquee) { sim.marquee.ex = e.clientX; sim.marquee.ey = e.clientY; wake(); return }
      if (!sim.dragStart) return
      const dx = e.clientX - sim.dragStart.x, dy = e.clientY - sim.dragStart.y
      if (Math.abs(dx) + Math.abs(dy) > 3) sim.dragging = true
      if (sim.dragNode) { const w = toWorld(e.clientX, e.clientY); sim.dragNode.x = w.x + sim.dragOffset.dx; sim.dragNode.y = w.y + sim.dragOffset.dy; wake() }
      else if (sim.dragging) { sim.panX = clamp(sim.dragStart.px + dx, -1e5, 1e5); sim.panY = clamp(sim.dragStart.py + dy, -1e5, 1e5); wake() }
    }
    const onUp = (e) => {
      if (sim.marquee) {
        const m = sim.marquee; sim.marquee = null
        const rect = canvas.getBoundingClientRect()
        const x1 = Math.min(m.sx, m.ex) - rect.left, x2 = Math.max(m.sx, m.ex) - rect.left
        const y1 = Math.min(m.sy, m.ey) - rect.top, y2 = Math.max(m.sy, m.ey) - rect.top
        const ids = sim.nodes.filter((n) => { const wx = n.x * sim.zoom + sim.panX, wy = n.y * sim.zoom + sim.panY; return wx >= x1 && wx <= x2 && wy >= y1 && wy <= y2 }).map((n) => n.id)
        sim.multi = ids; setMulti(ids)
        wake(); return
      }
      const wasClick = sim.dragStart && !sim.dragging
      if (sim.shiftClick) {
        // shift 单点凸显：把该节点并入 multi（累积选择）
        const id = sim.shiftClick; sim.shiftClick = null
        const cur = Array.isArray(sim.multi) ? sim.multi.slice() : []
        if (!cur.includes(id)) cur.push(id)
        sim.multi = cur; setMulti(cur); wake(); return
      }
      if (wasClick) {
        const w = toWorld(e.clientX, e.clientY); let hit = null
        for (let i = sim.nodes.length-1; i>=0; i--) { const n = sim.nodes[i]; if (!nodeVisible(n.id)) continue; const dx = n.x - w.x, dy = n.y - w.y; if (dx*dx + dy*dy < n.r*n.r + 20) { hit = n; break } }
        if (hit) { sim.selectedId = hit.id; setSel(hit.id); wake() }
        else { sim.selectedId = null; sim.hoverId = null; if (!e.shiftKey) { sim.multi = []; setMulti([]) } setSel(null); wake() }
      }
      sim.dragStart = null; sim.dragging = false; sim.dragNode = null
    }
    const onCtx = (e) => {
      e.preventDefault()
      const w = toWorld(e.clientX, e.clientY); let hit = null
      for (let i = sim.nodes.length-1; i>=0; i--) { const n = sim.nodes[i]; if (!nodeVisible(n.id)) continue; const dx = n.x - w.x, dy = n.y - w.y; if (dx*dx + dy*dy < n.r*n.r + 25) { hit = n; break } }
      if (hit) { const d = sim.domainById[hit.id]; if (d) setCtx({ x: e.clientX, y: e.clientY, id: hit.id, path: d.id, title: d.title }) }
      else setCtx(null)
    }
    const onWheel = (e) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const wx = (e.clientX - rect.left - sim.panX) / sim.zoom
      const wy = (e.clientY - rect.top - sim.panY) / sim.zoom
      const newZoom = Math.max(0.3, Math.min(3, sim.zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)))
      sim.panX = clamp(sim.panX + wx * (sim.zoom - newZoom), -1e5, 1e5)
      sim.panY = clamp(sim.panY + wy * (sim.zoom - newZoom), -1e5, 1e5)
      sim.zoom = newZoom
      sim.userTouched = true
      wake()
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onDrag)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onCtx)

    resetRef.current = () => { sim.selectedId = null; sim.hoverId = null; sim.multi = []; setMulti([]); sim.userTouched = false; fit(); wake() }
    // ---- 稳定初始化：分帧预热 ---------------------------------------------------
    // 旧实现是一次性循环 tick 200 次：1084 个节点时单次 tick 是 O(n²)，实测同步阻塞
    // 主线程 1–2 秒（4× CPU 降速下 5–7 秒），期间画面完全空白 —— 用户看到的就是「打开知识星图一片空白」。
    // 现在改成：
    //   ① 先同步画一帧（不依赖 requestAnimationFrame，窗口未聚焦/被遮挡时也有内容）；
    //   ② 预热按「每帧 ≤ WARM_FRAME_BUDGET_MS」分帧跑，帧间让出主线程（点击/滚动立刻响应）；
    //   ③ 预热期间显示「正在布局 N 个节点…」，不再是无声空白；
    //   ④ 每帧按当前布局重新 fit（用户没手动缩放/拖动过时），节点不会飞出视口。
    warmLeft = warmTicksFor(sim.nodes.length)
    const totalWarm = warmLeft
    // 预热进度直接映射到进度条（tick 数可数 → 真百分比，不是假动画）
    const warmPct = () => (totalWarm > 0 ? Math.round(((totalWarm - warmLeft) / totalWarm) * 100) : 100)
    if (warmLeft > 0) setWarming(0)
    // 预热中途只补 3 帧（75% / 50% / 25%），让布局看起来是「逐渐铺开」而不是卡住再跳变。
    const renderMarks = totalWarm > 0 ? [0.75, 0.5, 0.25].map((f) => Math.round(totalWarm * f)) : []
    const warmStep = () => {
      if (!sim.running) return
      const t0 = performance.now()
      while (warmLeft > 0 && performance.now() - t0 < WARM_FRAME_BUDGET_MS) { tick(); warmLeft-- }
      setWarming(warmLeft > 0 ? Math.min(99, warmPct()) : 100)
      if (renderMarks.length && warmLeft <= renderMarks[0]) {
        renderMarks.shift()
        if (!sim.userTouched) fit()
        try { render() } catch (e) { warnGraphDrawError(e, 'warm-frame') }
      }
      if (warmLeft > 0) {
        if (!sim.userTouched) fit()
        sim.warmRaf = requestAnimationFrame(warmStep)
        return
      }
      sim.warmRaf = 0
      if (!sim.userTouched) fit()
      try { render() } catch (e) { warnGraphDrawError(e, 'warm-final') }
      setWarming(null)
      wake()
    }
    sim.warmStep = warmStep
    fit()
    try { render() } catch (e) { warnGraphDrawError(e, 'first-frame') }
    if (warmLeft > 0) sim.warmRaf = requestAnimationFrame(warmStep)
    else { setWarming(0); wake() }

    const onDocMouseDown = () => setFilterOpen(false)
    window.addEventListener('mousedown', onDocMouseDown)

    return () => { sim.running = false; if (sim.raf) cancelAnimationFrame(sim.raf); if (sim.warmRaf) cancelAnimationFrame(sim.warmRaf); ro.disconnect(); canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mousedown', onDown); window.removeEventListener('mousemove', onDrag); window.removeEventListener('mouseup', onUp); canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', onCtx); window.removeEventListener('mousedown', onDocMouseDown) }
  }, [nodes, edges])

  // 切换到图谱视图时重新 fit，让画布居中适配当前容器尺寸
  useEffect(() => {
    if (fitTrigger !== undefined && fitRef.current) {
      requestAnimationFrame(() => { try { fitRef.current() } catch (e) { warnGraphDrawError(e, 'fit') } })
    }
  }, [fitTrigger])

  return (
    <div className="me-graph" ref={wrapRef}>
      <div className="me-graph-toolbar">
        <span className="me-graph-count">{nodes.length} {t('nodes')} · {edges.length} {t('edges')}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <input type="text" placeholder={t('search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <button type="button" className="mc-btn" onClick={() => setFilterOpen((v) => !v)} aria-expanded={filterOpen} title={t('filterLabel')} style={{ borderRadius: 8 }}>
            🔍 {t('filterLabel')} {filterKind !== 'all' || timeMode || filterTag ? '●' : '▾'}
          </button>
          {filterOpen && <div className="me-graph-legend-pop" onMouseDown={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50, background: 'rgba(28,28,32,0.92)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', color: '#eee', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: 8, minWidth: 240, boxShadow: '0 12px 34px rgba(0,0,0,.35)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button type="button" className={`lg${filterKind === 'all' && !timeMode ? ' active' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => { setFilterKind('all'); setTimeMode(false) }}>{t('all')}</button>
              {Object.keys(KIND_COLORS).map((k) => (
                <button key={k} type="button" className={`lg${filterKind === k ? ' active' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => setFilterKind((f) => (f === k ? 'all' : k))}>
                  <span className="mc-kind" style={{ background: KG.colors[k] || KIND_COLORS[k] }} />{t(KIND_LABELS[k])}
                </button>
              ))}
              <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
              <button type="button" className={`lg${timeMode ? ' active' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => setTimeMode((v) => !v)}>⏱ {t('timeDim')}</button>
              {allTags.length > 0 && (
                <>
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
                  <div style={{ maxHeight: 130, overflow: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {allTags.map((o) => (
                      <button key={o.tag} type="button" className={`lg${filterTag === o.tag ? ' active' : ''}`} style={{ color: '#ddd', padding: '2px 7px', fontSize: 11 }} onClick={() => setFilterTag((f) => (f === o.tag ? '' : o.tag))} title={o.tag}>
                        #{o.tag} <span style={{ opacity: 0.55 }}>{o.n}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {(filterKind !== 'all' || timeMode || filterTag) && <button type="button" className="lg lg-clear" style={{ justifyContent: 'flex-start', color: '#f87171' }} onClick={() => { setFilterKind('all'); setTimeMode(false); setFilterTag('') }}>{t('clearFilter')} ✕</button>}
            </div>
          </div>}
        </span>
        <label className="mc-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title={t('crossVault')}><input type="checkbox" checked={!!all} onChange={(e) => onAllChange && onAllChange(e.target.checked)} />{t('crossVault')}</label>
        <button type="button" className={`mc-btn${timeMode ? ' me-on' : ''}`} onClick={() => setTimeMode((v) => !v)}>{t('timeDim')}</button>
        <button type="button" className="mc-btn" onClick={() => { const c = canvasRef.current; if (!c) return; try { c.toBlob((blob) => { if (!blob) return; setExportData({ url: URL.createObjectURL(blob), blob }) }, 'image/png') } catch (e) { /* 预览兜底 */ } }}>{t('exportGraph')}</button>
        <button type="button" className="mc-btn" onClick={() => fitRef.current && fitRef.current()}>{t('fit')}</button>
        <button type="button" className="mc-btn" onClick={() => { setSel(null); setFilterKind('all'); resetRef.current && resetRef.current() }}>{t('reset')}</button>
      </div>
      <div className="me-graph-canvas" style={{ position: 'relative', overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />
{warming !== null && <div role="status" aria-live="polite" style={{ position: 'absolute', left: '50%', top: 10, transform: 'translateX(-50%)', zIndex: 3, display: 'flex', alignItems: 'center', gap: 9, padding: '6px 12px', borderRadius: 999, background: 'rgba(28,28,32,0.86)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: '#eee', fontSize: 11.5, fontWeight: 600, letterSpacing: '.02em', pointerEvents: 'none', boxShadow: '0 6px 18px rgba(0,0,0,.22)' }}><ProgressBar value={warming} small /><span>{t('graphWarming').replace('{n}', nodes.length)} · {Math.round(warming)}%</span></div>}
        <div className="mc-v5-graph-legend">
          <div className="mc-v5-graph-legend-title">连接簇</div>
          {Object.keys(KG.colors).filter((k) => kindStats[k]).map((k) => (
            <div key={k} className="mc-v5-graph-legend-row"><i style={{ background: KG.colors[k] }} /><span>{t(KIND_LABELS[k] || 'kindKnowledge')}</span><b>{kindStats[k]}</b></div>
          ))}
        </div>
        <div className="me-graph-tooltip" ref={tooltipRef} style={{ display: 'none', position: 'absolute', zIndex: 4, pointerEvents: 'none', background: 'rgba(28,28,32,0.88)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', color: '#eee', borderRadius: 8, padding: '7px 10px', fontSize: 12, maxWidth: 220, boxShadow: '0 8px 24px rgba(0,0,0,.2)' }} />
        {noMatch && <div className="mc-empty" style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)' }}>{t('noMatch')}</div>}
        {ctx && <div className="me-graph-ctx-back" style={{ position: 'fixed', inset: 0, zIndex: 30 }} onMouseDown={() => setCtx(null)} />}
        {ctx && (
          <div className="me-graph-ctxmenu" style={{ position: 'fixed', left: ctx.x, top: ctx.y, zIndex: 31 }} onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => { onOpenRef.current({ path: ctx.path, title: ctx.title }); setCtx(null) }}>{t('openCard')}</button>
            <button type="button" onClick={() => { if (ctx.id) { simRef.current.selectedId = ctx.id; setSel(ctx.id) } setCtx(null); const s = simRef.current; if (s && s.wake) s.wake() }}>{t('focusNeighbors')}</button>
            <button type="button" onClick={() => { try { if (navigator.clipboard) navigator.clipboard.writeText(ctx.title || '') } catch (e) {} setCtx(null); notify(t('copied')) }}>{t('copyName')}</button>
            <button type="button" onClick={() => { const s = simRef.current; const ps = (s && Array.isArray(s.multi) ? s.multi.slice() : []); const id = ctx.id; if (id && !ps.includes(id)) ps.push(id); setCtx(null); if (ps.length < 2) { notify(t('mergeNeed'), false); return } if (!window.confirm(t('mergeConfirm'))) return; const pr = onMergeRef.current && onMergeRef.current(ps); if (pr && pr.then) pr.then((ok) => ok ? notify(t('merged')) : notify(t('mergeFail'), false)).catch(() => notify(t('mergeFail'), false)); else if (pr) notify(t('merged')); }}>{t('merge')}</button>
            <button type="button" style={{ color: '#f87171' }} onClick={() => { const p = ctx.path; setCtx(null); if (window.confirm(t('deleteConfirm'))) { (async () => { try { const ok = onDeleteRef.current ? await onDeleteRef.current(p) : false; if (ok) { notify(t('deleted')) } else { notify(t('deleteFail'), false) } } catch (e) { notify(t('deleteFail'), false) } })() } }}>{t('delete')}</button>
          </div>
        )}
        {multi.length > 0 && (
          <div style={{ position: 'absolute', left: 10, top: 10, zIndex: 3, display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(28,28,32,0.92)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', color: '#eee', borderRadius: 10, padding: '6px 10px', fontSize: 12, boxShadow: '0 10px 30px rgba(0,0,0,.25)' }}>
            <span style={{ fontWeight: 700 }}>{multi.length} {t('nodes')}</span>
            <button type="button" className="mc-btn" onClick={() => { const ns = multi.map((id) => nodeById[id]).filter(Boolean); const txt = ns.map((n) => n.title || n.name).join('\n'); const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'memory-selected.txt'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000); notify(multi.length + t('exportedSel')) }}>{t('exportSel')}</button>
            <button type="button" className="mc-btn" onClick={() => { if (multi.length < 2) { notify(t('mergeNeed'), false); return } const paths = multi.map((id) => (nodeById[id] ? nodeById[id].id : id)); if (!window.confirm(t('mergeConfirm'))) return; setMulti([]); const st = simRef.current; if (st) { st.multi = [] } fetch(`${API}/merge?paths=${encodeURIComponent(paths.join(','))}`).then((r) => r.json()).then((d) => { if (d && d.ok) { notify(t('merged')) } else { notify(t('mergeFail'), false) } }).catch(() => notify(t('mergeFail'), false)) }}>{t('merge')}</button>
            <button type="button" className="mc-btn" style={{ color: '#f87171' }} onClick={() => { if (!window.confirm(t('deleteConfirm'))) return; const paths = multi.map((id) => (nodeById[id] ? nodeById[id].id : id)); setMulti([]); const s = simRef.current; if (s) { s.multi = [] } (async () => { let n = 0; for (const p of paths) { try { const ok = onDeleteRef.current ? await onDeleteRef.current(p) : false; if (ok) n++ } catch (e) {} } notify(n + t('deletedSelected'), n > 0) })() }}>{t('deleteSelected')}</button>
            <button type="button" className="mc-btn" onClick={() => { const s = simRef.current; if (s) { s.multi = [] } setMulti([]); const s2 = simRef.current; if (s2 && s2.render) s2.render() }}>{t('clearSelection')}</button>
          </div>
        )}
        {sel && <div className="me-graph-sidebar" style={{ position: 'absolute', right: 10, top: 10, zIndex: 3, maxWidth: 240, background: 'rgba(28,28,32,0.92)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', color: '#eee', borderRadius: 10, padding: 12, fontSize: 12, boxShadow: '0 10px 30px rgba(0,0,0,.25)' }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{nodeById[sel] ? (nodeById[sel].title || nodeById[sel].name) : sel}</div>
          <div style={{ opacity: .8, marginBottom: 8 }}>{nodeById[sel] ? t(KIND_LABELS[nodeById[sel].kind] || 'kindKnowledge') : '—'}</div>
          <div style={{ fontSize: 11, opacity: .65, letterSpacing: '.04em', marginBottom: 6 }}>{t('graphHint')}</div>
          {(edges.filter((e) => e.source === sel || e.target === sel) || []).slice(0, 8).map((e, i) => {
            const o = e.source === sel ? e.target : e.source
            const nn = nodeById[o]
            return <div key={i} style={{ padding: '4px 6px', cursor: 'pointer', borderRadius: 6 }} onMouseDown={(ev) => { ev.preventDefault(); const s = simRef.current; if (s) { s.selectedId = o; s.hoverId = o; if (s.wake) s.wake() } setSel(o) }}>{nn ? (nn.title || nn.name).slice(0, 28) : o}</div>
          })}
        </div>}
      </div>
      <div className="me-graph-tip">{t('graphTip')}</div>
      {toast && <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'fixed', left: '50%', transform: 'translateX(-50%)', top: 22, zIndex: 70, background: 'rgba(20,22,26,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: '#f5f5f5', borderRadius: 12, padding: '10px 20px', fontSize: 13.5, fontWeight: 600, boxShadow: '0 14px 44px rgba(0,0,0,.5)', pointerEvents: 'none', animation: 'me-pop .22s ease', borderLeft: '4px solid ' + (toast.ok ? '#22c55e' : '#ef4444'), maxWidth: '90vw' }}><span style={{ color: toast.ok ? '#34d399' : '#f87171', fontWeight: 800, fontSize: 15 }}>{toast.ok ? '✓' : '✕'}</span><span style={{ wordBreak: 'break-all' }}>{toast.msg}</span></div>}
      {exportData && (
        <div className="me-overlay" onClick={() => { if (exportData.url) URL.revokeObjectURL(exportData.url); setExportData(null); setExportFull(false) }}>
          <style>{CSS}</style>
          <div className="me-dialog" style={{ maxWidth: exportFull ? '100vw' : 900, width: exportFull ? '100vw' : '92vw', maxHeight: exportFull ? '100%' : '90vh', height: exportFull ? '100%' : undefined, borderRadius: exportFull ? 0 : 14 }} onClick={(e) => e.stopPropagation()}>
            <div className="me-dialog-head">
              <h3>{t('exportGraph')}</h3>
              <div className="me-head-actions">
                <a className="mc-btn" href={exportData.url} download="memory-graph.png" onClick={() => { markDone('download'); notify(t('downloaded') + ' · ' + t('defaultDownloads')) }} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>{exportDone === 'download' ? t('done') : t('download')}</a>
                <button type="button" className="mc-btn" onClick={() => { markDone('full'); setExportFull((f) => !f); notify(t('fullscreen')) }}>{exportDone === 'full' ? t('done') : (exportFull ? t('exitFull') : t('fullscreen'))}</button>
                <button type="button" className="mc-btn" onClick={() => { const cb = exportData.blob; if (cb && window.ClipboardItem && navigator.clipboard) { navigator.clipboard.write([new window.ClipboardItem({ 'image/png': cb })]).then(() => { markDone('copy'); notify(t('copied')) }).catch(() => { notify(t('copyFail'), false) }) } else { notify(t('copyFail'), false) } }}>{exportDone === 'copy' ? t('done') : t('copyImage')}</button>
                <button type="button" className="mc-btn" onClick={() => { if (exportData.url) URL.revokeObjectURL(exportData.url); setExportData(null); setExportFull(false) }}>{t('close')}</button>
              </div>
            </div>
            <div className="me-dialog-body" style={{ display: 'flex', justifyContent: 'center', background: exportFull ? 'var(--dsw-alias-bg-base, #0b0d10)' : 'var(--dsw-alias-bg-base, #f3f4f6)' }}>
              <img src={exportData.url} alt={t('exportGraph')} style={{ maxWidth: '100%', maxHeight: exportFull ? 'calc(100% - 64px)' : '70vh', borderRadius: exportFull ? 0 : 8, cursor: 'zoom-in' }} onClick={() => setExportFull((f) => !f)} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 布局：力导向（发散、大范围）并强制最小间距；大规模（>140）用多环径向 + 最小间距。O(n)~O(n²)，几千节点不卡。
function computeLayout(nodes, edges, width, height) {
  const n = nodes.length
  if (n === 0) return []
  const minD = 42
  let pts = n > 140 ? radialLayout(nodes, edges, width, height) : forceLayout(nodes, edges, width, height)
  return enforceMinDist(pts, minD, width, height, 24)
}

// 力导向：斥力主导 + 弱弹力 + 轻向心，节点向四周发散；最后归一化铺满视口（范围更大）。
function forceLayout(nodes, edges, width, height) {
  const n = nodes.length
  if (n === 0) return []
  const iters = 260
  const init = Math.max(4, Math.sqrt(n) * 2.0)
  const pos = nodes.map((_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    return { x: init * Math.cos(a), y: init * Math.sin(a) }
  })
  const vel = pos.map(() => ({ x: 0, y: 0 }))
  const adj = nodes.map(() => [])
  edges.forEach((e) => {
    const si = nodes.findIndex((x) => x.id === e.source)
    const ti = nodes.findIndex((x) => x.id === e.target)
    if (si >= 0 && ti >= 0 && si !== ti) { adj[si].push(ti); adj[ti].push(si) }
  })
  const repulse = 3.8, attract = 0.015, center = 0.01, damping = 0.86
  for (let iter = 0; iter < iters; iter++) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y
      const d2 = dx * dx + dy * dy || 0.02
      const d = Math.sqrt(d2)
      const f = repulse / d2
      const ux = dx / d, uy = dy / d
      vel[i].x += ux * f; vel[i].y += uy * f; vel[j].x -= ux * f; vel[j].y -= uy * f
    }
    for (let i = 0; i < n; i++) for (const j of adj[i]) {
      vel[i].x += (pos[j].x - pos[i].x) * attract
      vel[i].y += (pos[j].y - pos[i].y) * attract
    }
    for (let i = 0; i < n; i++) { vel[i].x -= pos[i].x * center; vel[i].y -= pos[i].y * center }
    for (let i = 0; i < n; i++) {
      vel[i].x = Math.max(-0.4, Math.min(0.4, vel[i].x * damping))
      vel[i].y = Math.max(-0.4, Math.min(0.4, vel[i].y * damping))
      pos[i].x += vel[i].x; pos[i].y += vel[i].y
    }
  }
  // 归一化铺满视口（范围更大）
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
  pos.forEach((p) => { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y) })
  const pad = 40
  const scale = Math.min((width - 2 * pad) / (maxx - minx || 1), (height - 2 * pad) / (maxy - miny || 1))
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2
  return pos.map((p) => ({ x: width / 2 + (p.x - cx) * scale, y: height / 2 + (p.y - cy) * scale }))
}

// 多环径向：按 kind 分扇区、枢纽内圈，O(n)；供大规模（>140）使用，随后也会做最小间距处理。
function radialLayout(nodes, edges, width, height) {
  const n = nodes.length
  const cx = width / 2, cy = height / 2
  const maxR = Math.min(width, height) / 2 - 46
  const deg = {}
  edges.forEach((e) => { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1 })
  const byKind = {}
  nodes.forEach((nd, i) => { const k = nd.kind || 'other'; (byKind[k] = byKind[k] || []).push(i) })
  const kinds = Object.keys(byKind)
  const pos = new Array(n)
  let angle = -Math.PI / 2
  const SPACING = 44, RINGSTEP = 54
  for (const kind of kinds) {
    const group = byKind[kind].sort((a, b) => (deg[nodes[b].id] || 0) - (deg[nodes[a].id] || 0))
    const span = (group.length / n) * Math.PI * 2
    const start = angle
    let placed = 0, ringIdx = 0
    while (placed < group.length && ringIdx < 60) {
      const radius = Math.min(60 + ringIdx * RINGSTEP, maxR)
      const cap = Math.max(1, Math.floor(radius * span / SPACING))
      const count = Math.min(cap, group.length - placed)
      for (let j = 0; j < count; j++) {
        const a = start + (span * (placed + j + 0.5)) / group.length
        pos[group[placed + j]] = { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) }
      }
      placed += count; ringIdx++
    }
    let guard = 0
    while (placed < group.length && guard < group.length) {
      const a = start + (span * (placed + 0.5)) / group.length
      pos[group[placed]] = { x: cx + maxR * Math.cos(a), y: cy + maxR * Math.sin(a) }
      placed++; guard++
    }
    angle += span
  }
  return pos
}

// 强制最小间距：把靠太近的点沿连线推开到 minD，最后夹在画布内 —— 保证任意两点距离 >= minD，发散不重叠。
function enforceMinDist(pts, minD, width, height, pad) {
  const n = pts.length
  const w = width || 0, h = height || 0, p = pad || 20
  const arr = pts
  for (let s = 0; s < 8; s++) {
    let moved = false
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = arr[j].x - arr[i].x, dy = arr[j].y - arr[i].y
      let d = Math.sqrt(dx * dx + dy * dy)
      if (d < minD) {
        if (d < 1e-4) { dx = Math.cos(i * 1.3 + j); dy = Math.sin(i * 0.7 + j); d = 1 }
        const push = (minD - d) / 2, ux = dx / d, uy = dy / d
        arr[i].x -= ux * push; arr[i].y -= uy * push
        arr[j].x += ux * push; arr[j].y += uy * push
        moved = true
      }
    }
    if (!moved) break
  }
  if (w && h) return arr.map((pt) => ({ x: Math.max(p, Math.min(w - p, pt.x)), y: Math.max(p, Math.min(h - p, pt.y)) }))
  return arr
}

// 曲线连线（二次贝塞尔），让点之间不那么生硬。
function edgePath(a, b) {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x, dy = b.y - a.y
  const dist = Math.sqrt(dx * dx + dy * dy) || 1
  const bend = Math.min(38, dist * 0.18)
  const cx = mx - (dy / dist) * bend
  const cy = my + (dx / dist) * bend
  return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`
}

// 颜色工具
// 时间维配色：按最后更新时间距今天数着色（新→旧）。
function recencyColor(updated) {
  const t = new Date(updated || 0).getTime()
  if (!t) return '#94a3b8'
  const days = (Date.now() - t) / 86400000
  if (days < 3) return '#10b981'
  if (days < 14) return '#f59e0b'
  if (days < 30) return '#f97316'
  return '#94a3b8'
}
function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
}
function lighten(hex, amt) {
  const [r, g, b] = hexToRgb(hex)
  return `rgb(${Math.round(r + (255 - r) * amt)}, ${Math.round(g + (255 - g) * amt)}, ${Math.round(b + (255 - b) * amt)})`
}
function darken(hex, amt) {
  const [r, g, b] = hexToRgb(hex)
  return `rgb(${Math.round(r * (1 - amt))}, ${Math.round(g * (1 - amt))}, ${Math.round(b * (1 - amt))})`
}

const kindKey = (k) => KIND_LABELS[k] || 'kindKnowledge'

/** 点击展开的多选下拉（勾选 checkbox），用于免审智能体/免审类型等配置。value 为数组，__all__ 表示免审全部。 */
function MultiDD({ label, value = [], options, onChange, placeholder, z = 20 }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const val = Array.isArray(value) ? value : []
  const hasAll = val.includes('__all__')
  const text = hasAll ? (options.find((o) => o.value === '__all__')?.label || '') : (val.length ? val.map((v) => options.find((o) => o.value === v)?.label || v).join('、') : '')
  const setSelected = (opt, checked) => {
    if (opt.value === '__all__') { onChange(checked ? ['__all__'] : []); return }
    const n = new Set(val); if (n.has('__all__')) n.delete('__all__')
    if (checked) n.add(opt.value); else n.delete(opt.value)
    onChange([...n])
  }
  const allOpt = options.find((o) => o.value === '__all__')
  const normalOpts = options.filter((o) => o.value !== '__all__')
  return (
    <label className="mc-field">
      <span className="mc-field-label">{label}</span>
      <div ref={boxRef} style={{ position: 'relative', minWidth: 0 }}>
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text || placeholder || '—'}</span>
          <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
        </button>
        {open && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: z, marginTop: 2, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', boxShadow: '0 6px 20px rgba(0,0,0,0.14)', maxHeight: 180, overflow: 'auto' }}>
            {allOpt && (
              <label onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer', borderBottom: '1px solid rgba(127,127,127,0.12)' }}>
                <input type="checkbox" checked={hasAll} onChange={(e) => setSelected(allOpt, e.target.checked)} />
                <span>{allOpt.label}</span>
              </label>
            )}
            {normalOpts.map((o) => (
              <label key={o.value} onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer' }}>
                <input type="checkbox" checked={val.includes(o.value)} onChange={(e) => setSelected(o, e.target.checked)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </label>
  )
}

function isNewCard(updated) { const t = new Date(updated || 0).getTime(); return !!t && (Date.now() - t) / 86400000 < 3 }

// 保存 Blob：selfPick=true 时用系统「另存为」对话框（Chromium 可用），否则默认下载。返回 {ok, picked, name}。
async function saveFile(blob, filename, selfPick) {
  if (selfPick && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename })
      const w = await handle.createWritable()
      await w.write(blob); await w.close()
      return { ok: true, picked: true, name: handle.name }
    } catch (e) { if (e && e.name === 'AbortError') return { ok: false, aborted: true }; return { ok: false, err: String(e.message || e) } }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { ok: true, picked: false, name: filename }
}

// 搜索命中高亮（大小写不敏感，拆分文本并在命中处包 <mark>）。
function highlightMatches(text, q) {
  if (!q || !text) return text
  const lower = text.toLowerCase(); const ql = q.toLowerCase()
  const out = []; let i = 0
  while (i < text.length) {
    const idx = lower.indexOf(ql, i)
    if (idx < 0) { out.push(text.slice(i)); break }
    if (idx > i) out.push(text.slice(i, idx))
    out.push(<mark key={idx} className="mc-hl">{text.slice(idx, idx + ql.length)}</mark>)
    i = idx + ql.length
  }
  return out
}

// renderMd / splitFrontmatter / parseTags 已抽到 ./markdown.js（便于单测，宿主与独立 web 共用同一套排版）。

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const pad = (n) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}
