// 记忆核心（client 侧）：设置 → 记忆 图形化知识库页面 + 侧边栏「记忆」按钮。
//
// 提供：
// - 侧边栏底部 footer 新增「记忆」按钮（sidebar.footer.action），一键打开完整记忆库弹窗；
// - 完整记忆库弹窗：统计概览 + 检索 + 分类筛选 + 知识卡网格 + 知识图谱（比设置页内嵌更开阔）；
// - 增强版知识图谱（力导向布局 / 渐变发光节点 / 曲线渐变连线 / 节点按度数放大 / 悬停高亮 / 入场动画）；
// - 设置 → 记忆 内嵌页面（复用同一套 MemoryLibrary）。
//
// 数据全部来自 host 的 /memory-eternal/api/* JSON 路由（同源 fetch），不引入额外依赖。

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { renderMd, splitFrontmatter, parseTags } from './markdown.js'
import brandIcon from '../../assets/icon.png'
import residentThemeArt from '../../assets/theme/resident.jpg'
import spiderThemeArt from '../../assets/theme/spider.jpg'
import { snippetAround } from './snippet.js'
import { auditMatches } from './audit-filter.js'
import { versionCardState } from './version-state.js'
// issue #55：卡片时间一律按运行环境本地时区显示（DB 里存的是 UTC ISO，不能直接 slice）
import { localDateKey, localDateTime, localClock, toLocalDate } from './datetime.js'
// 「反馈异常」纯函数层（与宿主/独立 web 共用同一套脱敏与预填逻辑）
import { buildIssueUrl, buildIssueBody, buildAgentPrompt } from '../../lib/feedback.js'
// 图谱 LOD：视口剔除 + 标签预算（放大后卡顿的根治手段）
import { visibleWorldRect, inRect, pickLabelIds, labelBudget } from './graph-lod.js'
// 图谱预热策略：分帧 + 时间预算（替代原来「200 次同步 tick」造成的 1s+ 主线程冻结/空白）
import { WARM_FRAME_BUDGET_MS, warmTicksFor } from './graph-warmup.js'
// 力导向内核：Barnes–Hut 四叉树斥力（替代每 tick 的 O(n²) 全对斥力，2049 节点 20–40ms → 3–4ms）
import { stepSimulation, forceParamsFor, QUIET_TICKS } from './graph-force.js'
// 星球分层：按层请求 + 层级缓存 + 图元→画布节点 + 资源账本（20 轮下钻不泄漏）
import {
  LEVEL_TIMEOUT_MS, LEVEL_MAX_ITEMS, LEVEL_PAYLOAD_LIMIT, PLANET_MIN_RADIUS,
  pathKey, segmentsOf, urlForLevel, levelItemToNode, planetLayerParams,
  describeLevelError, createLevelCache, createResourceTracker, validateLevelPayload, formatCount,
} from './graph-planet.js'
// 保存后不闪烁：宿主 volatile 回流滞后期间，用本地叠加层顶住输入框的值
import { mergeLocalOverlay } from './config-merge.js'

const NS = 'memory-eternal'
const API = '/memory-eternal/api'

// 《蛊真人》作者语录：左侧栏底部轮播，README 底部同源。
// 原始粘贴里有两段互相覆盖的串行（同一句被接了两遍），这里按完整诗节归并为 6 首，去重后保留原标点。
const QUOTES = [
  '落魄谷中寒风吹，春秋蝉鸣少年归。荡魂山处石人泪，定仙游走魔向北。逆流河上万仙退，爱情不敌坚持泪。宿命天成命中败，仙尊悔而我不悔。',
  '早岁已知世事艰，仍许飞鸿荡云间。',
  '男儿不展凌云志，空负天生八尺躯。',
  '千古地仙随风逝，昔日三王归青冢。阳莽悍陨谁无败？卷土重来再称王。',
  '天河一挂淘龙鱼，逆天独行顾八荒。今朝暂且展翼去，明朝飞仙笞凤凰！',
  '独帜入渊深未知，身似浮萍命难持。千舟皆朝归海处，一苇青拨戏浪巅。惊鸿四散鱼逃尽，唯有残帆傲此间。待到天开云雾散，负手直望笑苍天。',
]
// 语录出处：书名 + 尊号
const QUOTE_SOURCE = '《蛊真人》· 大爱仙尊'

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
  kindOther: '其他',
  kindContent: '内容',
  kindPrompt: '提示词',
  kindBusiness: '业务',
  kindTool: '工具',
  kindMistake: '教训',
  kindCore: '核心记忆',
  kindSkill: '技能',
  newsTab: '新闻',
  newsTitle: '新闻',
  newsHint: '每日 AI 新闻、本月榜单，以及你自己的发布。',
  newsNew: '写一条',
  newsSearch: '搜索标题 / 正文 / 标签…',
  newsUnreadOnly: '只看未读',
  newsEmpty: '还没有新闻。写第一条发布、决策或团队简报。',
  newsNoMatch: '没有匹配的新闻',
  newsPinned: '置顶',
  newsRead: '已读',
  newsUnread: '未读',
  newsMarkRead: '标记已读',
  newsMarkUnread: '标记未读',
  newsEdit: '编辑',
  newsDeleteConfirm: '删除这条新闻？',
  newsDeleted: '已删除',
  newsSave: '保存',
  newsSaving: '保存中…',
  newsSaved: '已保存',
  newsSaveFail: '保存失败',
  newsTitleField: '标题',
  newsBodyField: '正文（Markdown）',
  newsCategoryField: '分类',
  newsSourceField: '来源',
  newsUrlField: '链接',
  newsTagsField: '标签（逗号分隔）',
  newsDateField: '日期',
  newsPinField: '置顶',
  newsPreview: '预览',
  newsEditBody: '编辑正文',
  newsOpenLink: '打开链接',
  newsToday: '今天',
  newsYesterday: '昨天',
  newsEarlier: '更早',
  newsTitlePlaceholder: '例如：v0.20.0 发布说明',
  newsBodyPlaceholder: '写点值得留下的内容…支持 Markdown',
  newsCountUnit: '条',
  cancel: '取消',
  newsDaily: '今日新闻',
  newsMonthly: '本月',
  newsMine: '我的新闻',
  newsDailySub: '每日最新的 AI 新闻，中文优先',
  newsMonthlySub: '本月 AI 新闻：中文按时间归档，英文按 Hacker News 热度',
  newsMineSub: '你自定义的发布、决策和团队简报',
  newsLoading: '正在拉取资讯…',
  newsFeedError: '资讯源暂时不可用',
  newsHeat: '热度',
  newsComments: '评论',
  newsOriginal: '阅读原文',
  newsUpdatedAt: '更新于',
  newsPartialFail: '部分来源失败',
  newsFeedEmpty: '今天还没有抓到资讯，点刷新再试。',
  newsFeedRefresh: '刷新资讯',
  newsLoadingHint: '首次加载会抓取多个中文资讯源，可能需要几秒…',
  newsRetry: '重试',
  newsSearchGo: '搜索',
  newsFollow: '关注',
  newsFollowPreview: '我这样理解，要关注吗？',
  newsFollowConfirm: '开始关注',
  newsFollowAdded: '已关注',
  newsFollowExists: '已经在关注了',
  newsFollowRemoved: '已取消关注',
  newsFollowFail: '关注失败',
  newsFollowNoQuery: '先输入一个主题词',
  newsFollowDomains: '在这些来源里找',
  newsFollowEmpty: '还没有关注任何主题。搜一个词后点「关注」，以后它自己会更新。',
  newsIntentHint: '这看起来是一句指令 —— 点「＋ 关注」让它持续去对应来源里找；下面的列表不再按字面过滤。',
  newsFollowing: '关注动态',
  newsDigest: '关注摘要推送',
  newsDigestHint: '开启后，宿主按间隔抓取「新闻关注」，只有出现「新」内容时才会让 Agent 在下一轮提一句。默认关闭；关掉就不打扰。',
  newsDigestEnabled: '启用推送',
  newsDigestInterval: '抓取间隔（分钟）',
  newsDigestMaxItems: '每条摘要最多几条',
  newsDigestNow: '立即生成并预览',
  newsDigestNowHint: '开启前可以先点它，看看到底会推送什么。',
  newsDigestBuilding: '生成中…',
  newsDigestDone: '摘要已生成',
  newsDigestEmpty: '当前没有新的关注内容',
  newsDigestFail: '生成摘要失败',
  newsSortRec: '为你推荐',
  newsSortTime: '最新',
  newsPersonalized: '已按你的喜爱定制排序',
  newsLastQuery: '上次搜索',
  newsResetPrefs: '重置偏好',
  newsHeroEye: 'NEWSROOM · AI 情报站',
  newsHeroHint: '搜索一次就会被记住，下次打开自动按你的口味排序；只在本页首次打开时拉取一次数据。',
  newsMatched: '条命中',
  newsNoMatch: '没有匹配的资讯',
  newsNoMatchHint: '这批数据里没有命中当前关键词 + 分类 + 语言的条目，清除筛选就能看回全部。',
  newsClearFilters: '清除筛选',
  newsJustNow: '刚刚',
  newsMinutesAgo: '分钟前',
  newsHoursAgo: '小时前',
  newsDaysAgo: '天前',
  newsLangZh: '中文',
  newsLangEn: '英文',
  newsLangAll: '不限',
  newsZhArchive: '中文月榜按时间归档（中文源暂无公开热度分数）',
  newsEnRanking: '英文月榜按 Hacker News 分数排名',

  skillCards: '技能卡',
  skillCardsHint: '从本机实际安装/可用的技能生成卡片，强制进入审核；不由 Agent 对话沉淀。',
  skillAutoSync: '自动同步技能卡',
  syncSkills: '同步技能',
  syncingSkills: '正在同步技能…',
  skillsSyncDone: '技能卡同步完成',
  skillsScanned: '扫描',
  skillsCreated: '新增',
  skillsUpdated: '更新',
  skillsPendingUpdates: '待审更新',
  skillsSyncFail: '技能卡同步失败',
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
  graphLegendTitle: '卡片分布',
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
  // 星球分层（按层请求）
  graphAllCrumb: '全部',
  graphOther: '其他',
  graphItems: '图元',
  graphCardsUnit: '卡',
  graphPlanetCards: '{n} 张卡',
  graphToFlat: '平铺卡片图',
  graphToPlanet: '星球分层视图',
  graphFlatAll: '显示全部',
  graphFlatOnly: '只看主要',
  graphEnter: '进入该层',
  graphLevelLoading: '正在加载层级…',
  graphLevelTimeout: '层加载超时（{ms}ms）· 已保留当前层',
  graphLevelError: '层加载失败 · 已保留当前层',
  graphRetry: '重试',
  graphEmptyLevel: '这一层没有卡片。',
  graphLevelHint: '点大星球进入该层 · Shift+点击选中 · 拖拽移动 · 滚轮缩放',
  graphBreadcrumbAria: '层级面包屑',
  // 星球球心大数字的紧凑单位（≥1 万才用）：中文「万」；locale 决定 Intl 紧凑写法
  graphCountWan: '万',
  graphCountLocale: 'zh-CN',
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
  mcpNeedsRepair: '⚠ 需修复（旧配置会拉起 GUI）',
  repairMcp: '修复配置',
  healthy: '配置正常',
  mcpSetupHint: '「自动挂载 MCP」= 让 Claude Code / Codex / Cursor 这些工具能调用记忆库。开启后自动把它们配置好；关掉就不动你电脑上任何配置文件，需要时手动跑 dsh-memory setup。',
  mcpManageHint: '每个 agent 用下方按钮单独安装/卸载 MCP',
  workTitle: '本会话工作区',
  workHint: '临时草稿 · 不进入知识库 · 不参与召回',
  workLines: '行',
  workExpand: '展开',
  workCollapse: '收起',
  workPlaceholder: '记下这个任务现在做到哪、下一步做什么…（会话结束自动归档）',
  workSave: '保存草稿',
  workPromote: '存为待审卡',
  workClear: '清空',
  workClearConfirm: '清空本会话工作区？此操作不可恢复。',
  workSaved: '已保存会话工作区',
  workCleared: '已清空会话工作区',
  workPromoted: '已提交审核，请在「待审」里处理',
  workLimitHint: '上限 200 行 / 24KB，超出截断',
  workPromoteHint: '选中一段时只晋升选中部分',
  workPromoteEmpty: '没有可晋升的内容',
  starAskTitle: '记忆已经用起来了',
  starAskBody: '已召回 {recalls} 次 · 沉淀 {cards} 张卡。如果它帮你省过时间，给个 Star 会让更多人找到它。',
  starAskGo: '去 Star',
  starAskLater: '晚点再说',
  starAskNever: '不再提示',
  tabConfig: '记忆配置',
  configPageSub: '写入、路由、审核与服务的本地配置',
  paneGeneral: '通用',
  paneMemory: '记忆',
  paneAdvanced: '高级',
  paneService: '服务',
  paneGeneralSub: '一键方案、基础开关与日常偏好',
  paneMemorySub: '库目录、召回与核心记忆',
  paneAdvancedSub: '成本控制与自动审核',
  paneServiceSub: '服务守护、版本与 MCP 挂载',
  basicSwitches: '基础开关',
  basicSwitchesHint: '记忆核心的总开关与自动沉淀 / 召回',
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
  approveAndCore: '批准并设为核心',
  approveCore: '批准为核心记忆',
  approveAsNormal: '批准为普通卡',
  coreSuggested: '核心记忆（待审核）',
  reclassify: '重新识别类型',
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
  workingMemoryEnabled: '启用会话工作区（草稿本）',
  coreMemoryLimit: '核心记忆上限（张）',
  coreMemoryMaxChars: '核心记忆总字符上限',
  setCore: '设为核心记忆',
  unsetCore: '取消核心记忆',
  coreSetOk: '已设为核心记忆',
  coreUnsetOk: '已取消核心记忆',
  coreSetFail: '设置失败',
  coreActiveHint: '这张卡每次会话都会强制注入；与普通记忆冲突时以它为准。',
  coreInactiveHint: '普通知识卡可以提升为核心记忆；提升后每次会话自动生效。',
  coreNeedApproval: '先批准这张卡，才能设为核心记忆。',
  coreShort: '核心',
  setCoreShort: '设核心',
  uiLayout: '布局大小',
  themeSkin: '主题皮肤',
  themeSkinHint: '一键切换整个记忆界面（含设置页），点选即生效并保存',
  themeDefault: '默认暗色',
  themeDefaultDesc: '原版深色界面',
  themePop: '波普 Pop',
  themePopDesc: '撞色 + 粗黑描边 + 硬阴影',
  themeLight: '明亮',
  themeLightDesc: '暖纸面 + 衬线标题',
  themeResident: '生化危机',
  themeResidentDesc: 'Umbrella 实验室 · 绿色扫描线',
  themeSpider: '蜘蛛侠',
  themeSpiderDesc: '红蓝漫画 · 蛛网与半调',
  themeApplied: '主题已切换',
  uiLayoutHint: '调整记忆界面整体大小（只影响显示，不影响记忆数据）',
  uiCompact: '紧凑',
  uiNormal: '标准',
  uiLarge: '大',
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
  auditSearchPlaceholder: '搜索标题 / 标签 / 路径…',
  auditNoMatch: '没有匹配的审核卡',
  auditUndo: '批准与驳回都可撤销',
  auditSelected: '已选',
  auditRevision: '修改',
  auditRevisionFrom: '修改原卡',
  auditClearSelection: '清空',
  preview: '预览',
  supportGroup: '交流群',
  supportGroupQQ: 'QQ 交流群',
  supportGroupWechat: '微信交流群',
  supportSponsor: '赞助',
  supportLegacy: '旧程序',
  supportTitle: '支持与交流',
  clickToZoom: '点击放大',
  supportGroupHint: '扫码进交流群（QQ / 微信），遇到问题可以直接问。',
  supportSponsorHint: '如果这个插件帮你省了时间，可以请作者喝杯咖啡。完全自愿，不影响任何功能。',
  supportAlipay: '支付宝',
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
  navQuotes: '作者语录',
  quoteHint: '点击换一句',
  v5Local: '本地运行',
  v5Star: '去 GitHub 点 Star',
  runtimeTitle: '运行状态',
  runtimeSub: '知识库、备份、自动沉淀与版本',
  dbTitle: '知识库',
  backupTitle: '备份',
  captureTitle: '自动沉淀',
  versionTitle: '版本',
  cardsUnit: '张卡',
  cardsSectionTitle: '知识卡片',
  cardsSectionHint: '按更新时间',
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
  recyclePurgeAllConfirm: '永久删除回收站里的全部 {n} 张卡片？此操作不可恢复。',
  toastPurgeAll: '已永久删除 {n} 张',
  bucketDeleted: '已删除',
  restoreToQueue: '退回审核',
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
  captureAlertHint: '打开左栏「用量/今日」看自动沉淀日志；AUTH/401 等鉴权失败 → 更新对应 provider 的 Key 或换蒸馏模型；确认是接口/版本不匹配，再更新 memory-eternal。',
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
  editCard: '编辑',
  editHint: '只改标题 / 标签 / 正文；状态与类型仍由审核与系统流转决定，手动编辑不会绕过审核。',
  editTitle: '标题',
  editTags: '标签（逗号分隔）',
  editTagsHint: '例如：记忆, 检索, 性能',
  editBody: '正文（Markdown）',
  editSave: '保存',
  editSaving: '保存中…',
  editCancel: '取消',
  editSaved: '已保存',
  editFail: '保存失败',
  editTitleEmpty: '标题不能为空',
  editBodyEmpty: '正文不能为空',
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
  kindOther: 'Other',
  kindContent: 'Content',
  kindPrompt: 'Prompts',
  kindBusiness: 'Business',
  kindTool: 'Tools',
  kindMistake: 'Mistakes',
  kindCore: 'Core memory',
  kindSkill: 'Skills',
  newsTab: 'News',
  newsTitle: 'News',
  newsHint: 'Your own updates, decisions and team briefs, kept separate from memory cards.',
  newsNew: 'Write one',
  newsSearch: 'Search title / body / tags…',
  newsUnreadOnly: 'Unread only',
  newsEmpty: 'No news yet. Write the first update, decision or team brief here.',
  newsNoMatch: 'No matching news',
  newsPinned: 'Pinned',
  newsRead: 'Read',
  newsUnread: 'Unread',
  newsMarkRead: 'Mark read',
  newsMarkUnread: 'Mark unread',
  newsEdit: 'Edit',
  newsDeleteConfirm: 'Delete this news item?',
  newsDeleted: 'Deleted',
  newsSave: 'Save',
  newsSaving: 'Saving…',
  newsSaved: 'Saved',
  newsSaveFail: 'Save failed',
  newsTitleField: 'Title',
  newsBodyField: 'Body (Markdown)',
  newsCategoryField: 'Category',
  newsSourceField: 'Source',
  newsUrlField: 'URL',
  newsTagsField: 'Tags (comma separated)',
  newsDateField: 'Date',
  newsPinField: 'Pin to top',
  newsPreview: 'Preview',
  newsEditBody: 'Edit body',
  newsOpenLink: 'Open link',
  newsToday: 'Today',
  newsYesterday: 'Yesterday',
  newsEarlier: 'Earlier',
  newsTitlePlaceholder: 'e.g. v0.20.0 release notes',
  newsBodyPlaceholder: 'Write something worth keeping… Markdown supported',
  newsCountUnit: 'items',
  cancel: 'Cancel',
  newsDaily: 'Daily AI',
  newsMonthly: 'Monthly top',
  newsMine: 'My updates',
  newsDailySub: 'Latest AI news, aggregated by source',
  newsMonthlySub: 'This month\'s AI discussion ranking (Hacker News points)',
  newsMineSub: 'Your own releases, decisions and team briefs',
  newsLoading: 'Fetching news…',
  newsFeedError: 'News sources are unavailable',
  newsHeat: 'heat',
  newsComments: 'comments',
  newsOriginal: 'Read original',
  newsUpdatedAt: 'Updated',
  newsPartialFail: 'Some sources failed',
  newsFeedEmpty: 'No news fetched today. Try refresh.',
  newsFeedRefresh: 'Refresh news',
  newsLoadingHint: 'First load fetches several Chinese sources; this can take a few seconds.',
  newsRetry: 'Retry',
  newsSearchGo: 'Search',
  newsFollow: 'Follow',
  newsFollowPreview: 'Here is what I understood — follow it?',
  newsFollowConfirm: 'Start following',
  newsFollowAdded: 'Following',
  newsFollowExists: 'Already following',
  newsFollowRemoved: 'Unfollowed',
  newsFollowFail: 'Follow failed',
  newsFollowNoQuery: 'Type a topic first',
  newsFollowDomains: 'Search in these sources',
  newsFollowEmpty: 'No topics followed yet. Search for something, then hit "Follow".',
  newsIntentHint: 'That looks like an instruction — hit "＋ Follow" to keep pulling it from the right sources; the list below is no longer filtered literally.',
  newsFollowing: 'From your follows',
  newsDigest: 'Follow digest push',
  newsDigestHint: 'When on, the host refreshes your news follows on an interval and lets the agent surface NEW items on the next turn. Off by default.',
  newsDigestEnabled: 'Enable push',
  newsDigestInterval: 'Interval (minutes)',
  newsDigestMaxItems: 'Max items per digest',
  newsDigestNow: 'Generate & preview now',
  newsDigestNowHint: 'Try it before enabling — see exactly what would be pushed.',
  newsDigestBuilding: 'Generating…',
  newsDigestDone: 'Digest generated',
  newsDigestEmpty: 'No new items from your follows',
  newsDigestFail: 'Failed to generate digest',
  newsSortRec: 'For you',
  newsSortTime: 'Latest',
  newsPersonalized: 'Ordered by your taste',
  newsLastQuery: 'Last search',
  newsResetPrefs: 'Reset taste',
  newsHeroEye: 'NEWSROOM · AI FEED',
  newsHeroHint: 'One search is remembered — the next visit is ordered by your taste. Data is fetched once per page open.',
  newsMatched: 'hits',
  newsNoMatch: 'No matching news',
  newsNoMatchHint: 'Nothing in this dataset matches the current keyword, category and language. Clear the filters to see everything.',
  newsClearFilters: 'Clear filters',
  newsJustNow: 'just now',
  newsMinutesAgo: 'min ago',
  newsHoursAgo: 'h ago',
  newsDaysAgo: 'd ago',
  newsLangZh: '中文',
  newsLangEn: 'English',
  newsLangAll: 'All',
  newsZhArchive: 'Chinese monthly archive by date (no public heat score)',
  newsEnRanking: 'English monthly ranking by Hacker News points',

  skillCards: 'Skill cards',
  skillCardsHint: 'Generated from the skills actually installed/available on this machine; always reviewed. Never deposited by agent chat.',
  skillAutoSync: 'Auto-sync skill cards',
  syncSkills: 'Sync skills',
  syncingSkills: 'Syncing skills…',
  skillsSyncDone: 'Skill cards synced',
  skillsScanned: 'scanned',
  skillsCreated: 'created',
  skillsUpdated: 'updated',
  skillsPendingUpdates: 'pending updates',
  skillsSyncFail: 'Skill sync failed',
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
  graphLegendTitle: 'Card types',
  graphTip: 'Left-click highlights · Shift+drag box-select · right-click menu · scroll zoom · drag to pan',
  graphWarming: 'Laying out {n} nodes…',
  // Planet levels (per-level requests)
  graphAllCrumb: 'All',
  graphOther: 'Other',
  graphItems: 'items',
  graphCardsUnit: 'cards',
  graphPlanetCards: '{n} cards',
  graphToFlat: 'Flat cards',
  graphToPlanet: 'Planet layers',
  graphFlatAll: 'Show all',
  graphFlatOnly: 'Top only',
  graphEnter: 'Open this level',
  graphLevelLoading: 'Loading level…',
  graphLevelTimeout: 'Level load timed out ({ms}ms) · current level kept',
  graphLevelError: 'Level load failed · current level kept',
  graphRetry: 'Retry',
  graphEmptyLevel: 'No cards in this level.',
  graphLevelHint: 'Click a planet to enter · Shift+click to select · drag to move · scroll to zoom',
  graphBreadcrumbAria: 'Level breadcrumb',
  // Compact unit for the big number inside a planet (only used from 10k up): English K/M
  graphCountWan: 'K',
  graphCountLocale: 'en-US',
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
  mcpNeedsRepair: '⚠ Needs repair (old config launches GUI)',
  repairMcp: 'Repair',
  healthy: 'healthy',
  mcpSetupHint: '"Auto-mount MCP" = lets Claude Code / Codex / Cursor use the memory vault. On = auto-configures them; Off = never touches your machine config, run dsh-memory setup manually when needed.',
  mcpManageHint: 'Use each agent row to install/uninstall MCP individually',
  workTitle: 'This session\'s workspace',
  workHint: 'scratch note · not knowledge · never recalled',
  workLines: 'lines',
  workExpand: 'Expand',
  workCollapse: 'Collapse',
  workPlaceholder: 'Where this task stands, what is next… (archived when the session ends)',
  workSave: 'Save draft',
  workPromote: 'Save as pending card',
  workClear: 'Clear',
  workClearConfirm: 'Clear this session workspace? This cannot be undone.',
  workSaved: 'Session workspace saved',
  workCleared: 'Session workspace cleared',
  workPromoted: 'Submitted for review',
  workLimitHint: 'capped at 200 lines / 24KB, truncated',
  workPromoteHint: 'select a passage to promote only that',
  workPromoteEmpty: 'Nothing to promote',
  starAskTitle: 'Memory is being used',
  starAskBody: 'Recalled {recalls} times · {cards} cards captured. If it saved you time, a Star helps others find it.',
  starAskGo: 'Star on GitHub',
  starAskLater: 'Later',
  starAskNever: "Don't ask again",
  tabConfig: 'Memory Config',
  configPageSub: 'Local write, routing, audit and service settings',
  paneGeneral: 'General',
  paneMemory: 'Memory',
  paneAdvanced: 'Advanced',
  paneService: 'Service',
  paneGeneralSub: 'Presets, core switches and daily preferences',
  paneMemorySub: 'Vault, recall and core memory',
  paneAdvancedSub: 'Cost control and auto-audit',
  paneServiceSub: 'Service watchdog, version and MCP status',
  basicSwitches: 'Core switches',
  basicSwitchesHint: 'Master switch plus auto-capture / auto-recall',
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
  approveAndCore: 'Approve as core',
  approveCore: 'Approve as core memory',
  approveAsNormal: 'Approve as normal card',
  coreSuggested: 'Core memory (pending review)',
  reclassify: 'Reclassify types',
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
  workingMemoryEnabled: 'Enable session workspace (scratchpad)',
  coreMemoryLimit: 'Core-memory limit (cards)',
  coreMemoryMaxChars: 'Core-memory total character limit',
  setCore: 'Set as core memory',
  unsetCore: 'Remove from core memory',
  coreSetOk: 'Set as core memory',
  coreUnsetOk: 'Removed from core memory',
  coreSetFail: 'Failed to update',
  coreActiveHint: 'This card is injected into every session; it wins conflicts with normal memory.',
  coreInactiveHint: 'Any approved knowledge card can be promoted to core memory and applies to every session.',
  coreNeedApproval: 'Approve this card before making it core memory.',
  coreShort: 'Core',
  setCoreShort: 'Set core',
  uiLayout: 'Layout size',
  themeSkin: 'Theme',
  themeSkinHint: 'Switch the whole memory UI (settings included) — applies and saves on click',
  themeDefault: 'Default dark',
  themeDefaultDesc: 'Original dark interface',
  themePop: 'Pop',
  themePopDesc: 'Bold colors, black outlines, hard shadows',
  themeLight: 'Light',
  themeLightDesc: 'Warm paper with serif titles',
  themeResident: 'Resident Evil',
  themeResidentDesc: 'Umbrella lab · green scanlines',
  themeSpider: 'Spider-Man',
  themeSpiderDesc: 'Red/blue comic · webs and halftone',
  themeApplied: 'Theme applied',
  uiLayoutHint: 'Scale the memory UI only; memory data is unchanged',
  uiCompact: 'Compact',
  uiNormal: 'Normal',
  uiLarge: 'Large',
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
  auditSearchPlaceholder: 'Search title, tag or path…',
  auditNoMatch: 'No matching review cards',
  auditUndo: 'Approve and reject are both undoable',
  auditSelected: 'Selected',
  auditRevision: 'Revision',
  auditRevisionFrom: 'Revises',
  auditClearSelection: 'Clear',
  preview: 'Preview',
  supportGroup: 'Community',
  supportGroupQQ: 'QQ group',
  supportGroupWechat: 'WeChat group',
  supportSponsor: 'Sponsor',
  supportLegacy: 'Legacy app',
  supportTitle: 'Support & community',
  clickToZoom: 'Click to enlarge',
  supportGroupHint: 'Scan to join the QQ or WeChat community; ask questions directly.',
  supportSponsorHint: 'If this plugin saved you time, you can buy the author a coffee. Completely optional.',
  supportAlipay: 'Alipay',
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
  navQuotes: "Author's Quotes",
  quoteHint: 'Click for the next verse',
  v5Local: 'Local',
  v5Star: 'Star on GitHub',
  runtimeTitle: 'Runtime status',
  runtimeSub: 'Vault, backups, capture and version',
  dbTitle: 'Vault',
  backupTitle: 'Backups',
  captureTitle: 'Auto capture',
  versionTitle: 'Version',
  cardsUnit: 'cards',
  cardsSectionTitle: 'Knowledge cards',
  cardsSectionHint: 'Newest first',
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
  recyclePurgeAllConfirm: 'Permanently delete all {n} cards in the recycle bin? This cannot be undone.',
  toastPurgeAll: 'Permanently deleted {n}',
  bucketDeleted: 'Deleted',
  restoreToQueue: 'Back to review',
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
  captureAlertHint: 'Open "Usage / Today" for the capture log; on AUTH/401 (bad key) update that provider\'s key or switch the distillation model; only update memory-eternal on a confirmed API/version mismatch.',
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
  editCard: 'Edit',
  editHint: 'Only title / tags / body are editable. Status and kind still flow through audit and system rules — manual edits never bypass review.',
  editTitle: 'Title',
  editTags: 'Tags (comma separated)',
  editTagsHint: 'e.g. memory, recall, performance',
  editBody: 'Body (Markdown)',
  editSave: 'Save',
  editSaving: 'Saving…',
  editCancel: 'Cancel',
  editSaved: 'Saved',
  editFail: 'Save failed',
  editTitleEmpty: 'Title cannot be empty',
  editBodyEmpty: 'Body cannot be empty',
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

const KIND_IDS = ['all', 'core', 'project', 'knowledge', 'skill', 'content', 'prompt', 'business', 'tool', 'mistake']
// 新建卡 / 统计里可选的普通类型（core 是审核时单独提升，不出现在普通创建下拉里）
const FORM_KINDS = KIND_IDS.filter((k) => k !== 'all' && k !== 'core')
const KIND_COLORS = { core: '#FF7A45', skill: '#8B5CF6', project: '#3B82F6', knowledge: '#10B981', content: '#F59E0B', prompt: '#A855F7', business: '#EC4899', tool: '#06B6D4', mistake: '#EF4444', other: '#6B7280' }
// issue #41：畸形卡（tags 是字符串 / undefined）曾让整页黑屏（React 根组件挂载失败）——
// 渲染层一律走这个兜底，坏数据最多少显示几个标签，不能把整棵树带走。
const tagsOf = (c) => (Array.isArray(c && c.tags) ? c.tags : [])
const KIND_EMOJI = { core: '⭐', skill: '🧩', project: '📁', knowledge: '📚', content: '📝', prompt: '💬', business: '💼', tool: '🔧', mistake: '⚠️', other: '📎' }
const KIND_LABELS = { core: 'kindCore', skill: 'kindSkill', project: 'kindProject', knowledge: 'kindKnowledge', content: 'kindContent', prompt: 'kindPrompt', business: 'kindBusiness', tool: 'kindTool', mistake: 'kindMistake', other: 'kindOther' }
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

const ZOMBIE_ART = residentThemeArt

const SPIDER_ART = spiderThemeArt
const GRIP_ART = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 520 340'>
<g fill='#030604' stroke='#3d6b45' stroke-width='3' stroke-linejoin='round' stroke-linecap='round'>
<path d='M520 20 L520 230 Q480 245 450 220 L410 180 Q380 150 390 110 Q398 75 440 60 Z'/>
<path d='M390 110 Q340 80 295 105 Q255 130 250 175 Q246 220 280 250 Q320 285 370 262 Q410 244 420 200 L440 60 Q420 82 390 110 Z'/>
<path d='M292 122 Q262 160 258 208 Q255 252 272 286 Q286 302 298 288 Q282 252 292 210 Q302 170 322 140 Z'/>
<path d='M324 142 Q300 182 296 228 Q294 270 310 306 Q324 320 334 304 Q318 268 326 230 Q336 188 356 160 Z'/>
<path d='M356 160 Q336 198 334 240 Q332 280 348 312 Q362 326 371 310 Q356 276 364 242 Q374 206 390 182 Z'/>
<path d='M390 182 Q374 216 374 252 Q374 288 389 318 Q403 332 411 315 Q396 282 402 250 Q410 218 422 198 Z'/>
<path d='M272 286 Q268 312 278 332 Q288 312 286 292 Z'/>
<path d='M310 306 Q306 330 316 340 Q326 320 324 308 Z'/>
<path d='M348 312 Q346 334 356 340 Q366 322 362 312 Z'/>
<path d='M389 318 Q390 336 400 340 Q408 326 404 316 Z'/>
</g>
<g fill='none' stroke='#7cff3f' stroke-width='2' opacity='.45'>
<path d='M390 110 Q340 80 295 105'/>
<path d='M292 122 Q262 160 258 208'/>
<path d='M324 142 Q300 182 296 228'/>
<path d='M356 160 Q336 198 334 240'/>
<path d='M390 182 Q374 216 374 252'/>
</g>
<g fill='#7cff3f' opacity='.30'>
<path d='M300 120 Q320 138 322 162 Q310 148 300 120 Z'/>
<path d='M332 140 Q352 160 354 184 Q342 168 332 140 Z'/>
<path d='M364 158 Q382 180 384 204 Q372 186 364 158 Z'/>
</g>
<g stroke='#b32424' stroke-width='4' opacity='.7' stroke-linecap='round'>
<path d='M278 300 L270 330'/><path d='M316 318 L312 340'/><path d='M356 324 L352 340'/>
</g>
</svg>`)
const CHARM_ART = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 150'>
<path d='M40 0 V66' stroke='#0b0b0f' stroke-width='2'/>
<g transform='translate(40,96) rotate(-7)'>
<ellipse cx='0' cy='12' rx='10' ry='14' fill='#e62429' stroke='#0b0b0f' stroke-width='2'/>
<circle cx='0' cy='-6' r='8' fill='#1b3b8b' stroke='#0b0b0f' stroke-width='2'/>
<g stroke='#0b0b0f' stroke-width='2' fill='none' stroke-linecap='round'>
<path d='M-8 6 Q-24 -2 -31 7'/><path d='M-9 14 Q-27 14 -33 24'/><path d='M-7 24 Q-23 30 -27 42'/>
<path d='M8 6 Q24 -2 31 7'/><path d='M9 14 Q27 14 33 24'/><path d='M7 24 Q23 30 27 42'/>
</g>
<path d='M-6 12 Q0 18 6 12' stroke='#fff' stroke-width='2' fill='none' opacity='.8'/>
<circle cx='-3' cy='10' r='1.4' fill='#fff'/><circle cx='3' cy='10' r='1.4' fill='#fff'/>
</g>
</svg>`)

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
/* 只有「真正填内容」的控件才占满一行。多选下拉里的 checkbox 一旦被这条命中，
   会被撑成整行宽 —— 选项文字被挤到最右缘、逐字换行（用户截图里的下拉框 BUG）。 */
.mc-field input:not([type="checkbox"]):not([type="radio"]), .mc-field select { width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 12px; transition: border-color .15s, box-shadow .15s; }
.mc-field input:not([type="checkbox"]):not([type="radio"]):focus, .mc-field select:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #3b82f6); box-shadow: 0 0 0 3px rgba(59,130,246,.14); }
.mc-field input:not([type="checkbox"]):not([type="radio"]):disabled, .mc-field select:disabled { opacity: .55; cursor: not-allowed; }
/* 复选框：固定尺寸、不参与拉伸，并跟随主题强调色 */
.mc-field input[type="checkbox"], .mc-field input[type="radio"] { width: 15px; height: 15px; flex: none; margin: 0; padding: 0; accent-color: #ff7a45; cursor: pointer; }
/* 多选下拉的选项行：一行一个，不换行，hover 有反馈 */
.mc-dd-opt { display: flex; align-items: center; gap: 8px; padding: 7px 9px; cursor: pointer; white-space: nowrap; min-width: 0; }
.mc-dd-opt:hover { background: rgba(127,127,127,.10); }
.mc-dd-opt span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* 深色主题下让原生复选框走深色渲染（默认是白底方块，在黑卡上非常刺眼） */
.me-v5 .mc-dd-opt input[type="checkbox"] { color-scheme: dark; }
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
/* ---- 记忆配置页 v2：统一列宽 + 开关成组 + 折叠次要面板 ---- */
.mc-cfg-page { width: 100%; max-width: 1280px; margin: 0 auto; }
.mc-cfg-layout { display: grid; grid-template-columns: 196px minmax(0, 1fr); gap: 22px; align-items: start; width: 100%; }
.mc-cfg-toc { position: sticky; top: 6px; display: flex; flex-direction: column; gap: 2px; padding: 8px; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: var(--dsw-alias-bg-layer-1, #fff); }
.mc-cfg-toc-title { font-size: 10px; letter-spacing: .1em; opacity: .42; padding: 6px 10px 8px; text-transform: uppercase; }
.mc-cfg-toc button { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 10px; border: 0; background: transparent; color: inherit; border-radius: 9px; font-size: 12px; cursor: pointer; text-align: left; opacity: .7; }
.mc-cfg-toc button:hover { background: rgba(127,127,127,.10); opacity: 1; }
.mc-cfg-toc button.on { background: rgba(255,122,69,.14); opacity: 1; font-weight: 600; }
.mc-cfg-toc-ico { flex: none; width: 18px; text-align: center; }
.mc-cfg-main { min-width: 0; }
.mc-cfg-layout.compact { grid-template-columns: minmax(0, 1fr); }
.mc-cfg-sec { scroll-margin-top: 10px; }
.me-v5 .mc-cfg-toc { background: #21252c; border-color: #333943; }
.me-v5 .mc-cfg-toc button.on { background: rgba(255,122,69,.18); }
@media (max-width: 1100px) {
  .mc-cfg-layout { grid-template-columns: minmax(0, 1fr); }
  .mc-cfg-toc { display: none; }
}
/* 弹窗分页：四段式胶囊导航 + 页头 + 卡片分组 */
.mc-pagenav { position: sticky; top: 0; z-index: 23; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 4px; margin: 0 0 12px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: rgba(127,127,127,.06); }
.mc-pagebtn { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; padding: 7px 4px; border: 0; border-radius: 9px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; opacity: .66; white-space: nowrap; }
.mc-pagebtn:hover { opacity: 1; background: rgba(127,127,127,.10); }
.mc-pagebtn.on { opacity: 1; font-weight: 650; color: #fff; background: linear-gradient(135deg, #ff8a4d, #ff6a2b); box-shadow: 0 4px 14px rgba(255,106,43,.35); }
.mc-pagebtn.on:hover { background: linear-gradient(135deg, #ff8a4d, #ff6a2b); }
.mc-pagebtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.mc-pagebtn-ico { font-size: 13px; }
.mc-panehead { display: flex; align-items: center; gap: 12px; padding: 2px 4px 14px; }
.mc-panehead-ico { flex: none; width: 42px; height: 42px; border-radius: 13px; display: flex; align-items: center; justify-content: center; font-size: 20px; background: linear-gradient(135deg, rgba(255,122,69,.30), rgba(255,122,69,.07)); border: 1px solid rgba(255,122,69,.24); }
.mc-panehead-title { font-size: 15.5px; font-weight: 700; letter-spacing: .2px; }
.mc-panehead-sub { font-size: 11.5px; opacity: .55; margin-top: 3px; line-height: 1.5; }
.me-v5 .mc-embed .mc-pagenav { background: rgba(33,37,44,.92); border-color: #333943; }
/* 嵌入式（DSH 设置弹窗）：卡片分组 + 细线开关行 */
.mc-embed .mc-cfg-page { max-width: 760px; }
.mc-embed .mc-cfg-layout { grid-template-columns: minmax(0, 1fr); gap: 0; }
.mc-embed .mc-cfg-sec { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 14px; background: rgba(127,127,127,.045); padding: 14px 16px !important; margin: 0 0 12px !important; }
.me-v5 .mc-embed .mc-cfg-sec { background: rgba(255,255,255,.035); border-color: rgba(255,255,255,.09); }
.mc-embed .mc-cfg-sec-head { padding: 0; margin-bottom: 12px; }
.mc-embed .mc-cfg-sec-body { padding: 0; }
.mc-embed .mc-cfg-switches { grid-template-columns: minmax(0, 1fr); gap: 0; }
.mc-embed .mc-cfg-switches .mc-switch { border: 0; border-bottom: 1px solid rgba(127,127,127,.10); border-radius: 0; background: transparent; padding: 9px 2px; }
.mc-embed .mc-cfg-switches .mc-switch:last-child { border-bottom: 0; }
.mc-env-fold > summary { list-style: none; cursor: pointer; }
.mc-env-fold > summary::-webkit-details-marker { display: none; }
.mc-env-fold[open] > summary .mc-fold-caret { transform: rotate(180deg); }
.mc-env-rest { padding-top: 2px; }
.mc-embed .mc-env, .mc-embed .mc-env-fold { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 14px; background: rgba(127,127,127,.045); padding: 12px 16px !important; margin-bottom: 12px !important; }
.me-v5 .mc-embed .mc-env, .me-v5 .mc-embed .mc-env-fold { background: rgba(255,255,255,.035); border-color: rgba(255,255,255,.09); }
.mc-embed .mc-fold { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 14px; background: rgba(127,127,127,.045); margin-bottom: 12px !important; }
.me-v5 .mc-embed .mc-fold { background: rgba(255,255,255,.035); border-color: rgba(255,255,255,.09); }
.mc-embed .mc-fold > summary { padding: 13px 16px; }
.mc-embed .mc-fold-body { padding: 0 16px 14px; }
.mc-embed .mc-cfg-grid { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 16px; }
.mc-embed .mc-plan-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; }
.mc-embed .mc-plan { flex-direction: row; align-items: center; gap: 10px; padding: 10px 12px; }
.mc-embed .mc-plan b { flex: none; }
.mc-embed .mc-plan span { flex: 1; min-width: 0; text-align: left; }
.mc-embed .mc-cfg-actions { margin: 2px 0 0; border-radius: 12px; }
.mc-embed .mc-plan-grid { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.mc-embed { max-width: 800px; margin: 0 auto; }
.mc-cfg-sec { margin-bottom: 14px; padding: 18px 20px !important; border-radius: 14px; }
.mc-cfg-sec-head { margin-bottom: 16px; }
.mc-cfg-sec-body { display: flex; flex-direction: column; gap: 16px; }
.mc-cfg-switches { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mc-cfg-switches .mc-switch { flex-direction: row-reverse; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; background: rgba(127,127,127,.04); }
.mc-cfg-switches .mc-switch input { margin-top: 0; }
.mc-cfg-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 18px; }
.mc-field-wide { grid-column: 1 / -1; }
.mc-field { gap: 6px; }
.mc-field input:not([type="checkbox"]):not([type="radio"]), .mc-field select { height: 34px; padding: 0 10px; border-radius: 9px; }
.mc-field input[type="number"] { max-width: 220px; }
.mc-cfg-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mc-cfg-switches.is-single { grid-template-columns: minmax(0, 1fr); }
.mc-cfg-actions { position: sticky; bottom: 0; z-index: 24; margin: 16px 0 0; padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 12px 32px rgba(0,0,0,.22); }
.me-v5 .mc-cfg-actions { background: #21252c; border-color: #333943; }
.mc-fold { padding: 0 !important; }
.mc-fold > summary { list-style: none; cursor: pointer; padding: 16px 20px; margin: 0; }
.mc-fold > summary::-webkit-details-marker { display: none; }
.mc-fold-body { padding: 0 20px 18px; display: flex; flex-direction: column; gap: 10px; }
.mc-fold-caret { font-size: 11px; opacity: .5; transition: transform .15s; }
.mc-fold[open] .mc-fold-caret { transform: rotate(90deg); }
.mc-seg { display: inline-flex; gap: 4px; padding: 4px; width: fit-content; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: rgba(127,127,127,.06); }
.mc-seg button { border: 0; background: transparent; color: inherit; padding: 6px 16px; border-radius: 8px; font-size: 12px; cursor: pointer; opacity: .68; }
.mc-seg button.on { opacity: 1; font-weight: 600; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 4px rgba(0,0,0,.14); }
.me-v5 .mc-seg button.on { background: #2b3038; }
.mc-vault-head, .mc-vault-row { display: grid; grid-template-columns: 1fr 1.6fr 1.5fr auto; gap: 8px; align-items: center; }
.mc-vault-head { font-size: 10.5px; opacity: .45; padding: 0 2px; }
.mc-vault-row { margin-bottom: 8px; }
.mc-vault-row input { width: 100%; box-sizing: border-box; }
.mc-env { padding: 12px 16px !important; }
.mc-env-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mc-env-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
@media (max-width: 860px) {
  .mc-cfg-switches, .mc-cfg-grid { grid-template-columns: minmax(0, 1fr); }
  .mc-cfg-sec { padding: 14px !important; }
  .mc-fold > summary { padding: 14px; }
  .mc-fold-body { padding: 0 14px 14px; }
  .mc-vault-head { display: none; }
  .mc-vault-row { grid-template-columns: 1fr auto; }
}
/* ===== 记忆配置：H5 / PC / DSH 弹窗三端响应式（页面导航 + 卡片 + 粘性保存） ===== */
.mc-cfg-page { width: 100%; max-width: 820px; margin: 0 auto; padding: 4px 2px 0; box-sizing: border-box; }
.mc-cfg-layout { display: block; width: 100%; }
.mc-cfg-main { min-width: 0; }
.mc-pagenav { position: sticky; top: 0; z-index: 23; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 4px; margin: 0 0 12px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: rgba(127,127,127,.06); }
.mc-pagebtn { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; padding: 8px 4px; border: 0; border-radius: 9px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; opacity: .66; white-space: nowrap; }
.mc-pagebtn:hover { opacity: 1; background: rgba(127,127,127,.10); }
.mc-pagebtn.on { opacity: 1; font-weight: 650; color: #fff; background: linear-gradient(135deg, #ff8a4d, #ff6a2b); box-shadow: 0 4px 14px rgba(255,106,43,.35); }
.mc-pagebtn.on:hover { background: linear-gradient(135deg, #ff8a4d, #ff6a2b); }
.mc-pagebtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.mc-pagebtn-ico { font-size: 13px; flex: none; }
.mc-pagebtn-txt { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.mc-pagebtn-sub { display: none; }
.mc-panehead { display: flex; align-items: center; gap: 12px; padding: 2px 4px 14px; }
.mc-panehead-ico { flex: none; width: 42px; height: 42px; border-radius: 13px; display: flex; align-items: center; justify-content: center; font-size: 20px; background: linear-gradient(135deg, rgba(255,122,69,.30), rgba(255,122,69,.07)); border: 1px solid rgba(255,122,69,.24); }
.mc-panehead-title { font-size: 15.5px; font-weight: 700; letter-spacing: .2px; }
.mc-panehead-sub { font-size: 11.5px; opacity: .55; margin-top: 3px; line-height: 1.5; }
.mc-cfg-sec { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 14px; background: rgba(127,127,127,.045); padding: 14px 16px !important; margin: 0 0 12px !important; }
.me-v5 .mc-cfg-sec { background: rgba(255,255,255,.035); border-color: rgba(255,255,255,.09); }
.mc-cfg-sec-head { padding: 0; margin-bottom: 12px; }
.mc-cfg-sec-body { padding: 0; }
.mc-cfg-switches { grid-template-columns: minmax(0, 1fr); gap: 0; }
.mc-cfg-switches .mc-switch { flex-direction: row-reverse; justify-content: space-between; align-items: center; gap: 12px; border: 0; border-bottom: 1px solid rgba(127,127,127,.10); border-radius: 0; background: transparent; padding: 10px 2px; }
.mc-cfg-switches .mc-switch:last-child { border-bottom: 0; }
.mc-cfg-grid { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 16px; }
.mc-env, .mc-env-fold { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 14px; background: rgba(127,127,127,.045); padding: 12px 16px !important; margin-bottom: 12px !important; }
.mc-fold { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 14px; background: rgba(127,127,127,.045); margin-bottom: 12px !important; }
.me-v5 .mc-env, .me-v5 .mc-env-fold, .me-v5 .mc-fold { background: rgba(255,255,255,.035); border-color: rgba(255,255,255,.09); }
.mc-fold > summary { padding: 13px 16px; }
.mc-fold-body { padding: 0 16px 14px; }
.mc-cfg-actions { position: sticky; bottom: 0; z-index: 24; margin: 2px 0 0; border-radius: 12px; }
.mc-plan-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; }
.mc-plan { flex-direction: row; align-items: center; gap: 10px; padding: 10px 12px; }
.mc-plan b { flex: none; }
.mc-plan span { flex: 1; min-width: 0; text-align: left; }
/* PC：左侧页面导航 + 更宽内容 */
@media (min-width: 1100px) {
  .mc-cfg-page { max-width: 1200px; padding-top: 6px; }
  .mc-cfg-layout { display: grid; grid-template-columns: 224px minmax(0, 1fr); gap: 24px; align-items: start; }
  .mc-pagenav { position: sticky; top: 8px; display: flex; flex-direction: column; gap: 2px; padding: 8px; margin: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
  .me-v5 .mc-pagenav { background: #21252c; border-color: #333943; }
  .mc-pagebtn { justify-content: flex-start; padding: 10px 12px; gap: 10px; text-align: left; }
  .mc-pagebtn.on { background: rgba(255,122,69,.14); color: inherit; box-shadow: none; }
  .me-v5 .mc-pagebtn.on { background: rgba(255,122,69,.18); }
  .mc-pagebtn-txt { flex-direction: column; align-items: flex-start; gap: 2px; }
  .mc-pagebtn-sub { display: block; font-size: 10.5px; opacity: .55; line-height: 1.4; white-space: normal; }
  .mc-cfg-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mc-cfg-actions { margin-top: 4px; }
}
/* H5：紧凑内边距 + 触控尺寸 + 底部安全区 */
@media (max-width: 720px) {
  .mc-cfg-page { max-width: 100%; padding: 2px 2px 0; }
  .mc-pagenav { margin-bottom: 10px; }
  .mc-pagebtn { padding: 10px 2px; font-size: 12px; }
  .mc-panehead { padding: 4px 2px 12px; }
  .mc-panehead-ico { width: 38px; height: 38px; font-size: 18px; border-radius: 11px; }
  .mc-panehead-title { font-size: 15px; }
  .mc-cfg-sec { padding: 12px 12px !important; border-radius: 12px; margin-bottom: 10px !important; }
  .mc-field input:not([type="checkbox"]):not([type="radio"]), .mc-field select { height: 42px; font-size: 13px; }
  .mc-cfg-switches .mc-switch { padding: 12px 2px; font-size: 12.5px; }
  .mc-cfg-switches .mc-switch input { width: 40px; height: 24px; }
  .mc-cfg-switches .mc-switch input::after { width: 20px; height: 20px; }
  .mc-cfg-switches .mc-switch input:checked::after { transform: translateX(16px); }
  .mc-cfg-actions { padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
  .mc-cfg-actions { flex-wrap: wrap; row-gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); }
  .mc-cfg-actions > .mc-cfg-clean, .mc-cfg-actions > .mc-cfg-dirty { flex: 0 1 auto; width: 100%; }
  .mc-cfg-actions .mc-cfg-spacer { display: none; }
  .mc-cfg-actions .mc-btn { flex: 1 1 0; justify-content: center; white-space: nowrap; padding: 9px 10px; }
  .mc-cfg-actions > span { font-size: 11px; }
  .mc-plan { padding: 11px 12px; }
  .mc-vault-head { display: none; }
  .mc-vault-row { grid-template-columns: 1fr auto; }
}
@media (max-width: 900px) {
  .me-audit-main { flex-direction: column; }
  .me-audit-preview:not(.drawer-open) { display: none; }
  .me-audit-bulk { flex-wrap: wrap; }
}
@media (max-width: 520px) {
  .mc-audit-batchcard { grid-template-columns: minmax(0, 1fr) !important; }
  .mc-audit-batchcard > .mc-btn { width: 100%; }
}
@media (max-width: 720px) {
  .me-v5 .mc-v5-pagehead { flex-wrap: wrap; align-items: flex-start; }
  .me-health-row { flex-wrap: wrap; }
  .me-health-row > b { min-width: 56px; }
  .me-health-row > div:last-child, .me-health-row > span:last-of-type { flex: 0 1 auto; width: 100%; padding-left: 22px; }
  .mc-term-grid { grid-template-columns: minmax(0, 1fr) !important; }
  .mc-term-guide { padding: 14px 12px 24px !important; }
  .me-v5 .mc-rail, .me-v5 .mc-rail.open { width: 50px; padding: 8px 5px; }
}
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
/* ---- 作者语录（左侧栏底部，margin-top:auto 贴底）----
   按钮语义：整块可点，点一次换下一句；折叠态与窄屏隐藏，避免挤坏图标栏。 */
/* 作者语录：做成一张「题词卡」，不是又一块 UI 面板。
   三条设计理由：
   ① 诗句用衬线（宋体族）——黑体读诗像公告栏，横细竖粗才有古意；
   ② 纸感暖白 + 右下角 13% 透明度的引号水印 —— 卡片只有 ~200px 宽，纯文字容易糊成一块，
      一个水印 + 一点留白就能把它压成"题词"而不是"卡片"；
   ③ 层次靠颜色区分而不是字号堆叠：眉标用琥珀色、诗句用墨色、出处用褪色的褐。 */
.mc-quote { position: relative; margin-top: auto; flex: none; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 7px; padding: 12px 13px 11px; text-align: left; font: inherit; cursor: pointer; overflow: hidden; border: 1px solid rgba(120, 105, 85, .16); border-radius: 13px; background: linear-gradient(158deg, #fffdf9 0%, #f6f1e7 100%); color: #4a443c; transition: border-color .18s ease, background .18s ease, box-shadow .18s ease, transform .18s ease; }
.mc-quote::before { content: '❝'; position: absolute; top: 3px; right: 8px; font-family: Georgia, 'Times New Roman', serif; font-size: 30px; line-height: 1; color: rgba(180, 83, 9, .13); pointer-events: none; }
.mc-quote:hover { border-color: rgba(180, 83, 9, .42); background: linear-gradient(158deg, #fffefb 0%, #f8f2e6 100%); box-shadow: 0 6px 18px rgba(120, 90, 50, .10); transform: translateY(-1px); }
.mc-quote-tag { position: relative; font-size: 9px; font-weight: 700; letter-spacing: .16em; color: #b45309; opacity: .9; }
.mc-quote-text { position: relative; font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', serif; font-size: 12px; line-height: 1.95; letter-spacing: .015em; color: #3f3a33; word-break: break-word; }
.mc-quote-src { position: relative; align-self: flex-end; font-size: 9.5px; letter-spacing: .04em; color: #a08b6b; }
.mc-quote-src::before { content: '— '; opacity: .7; }
@keyframes me-quote-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
.mc-quote-text { animation: me-quote-in .26s ease both; }
.mc-rail:not(.open) .mc-quote { display: none; }
@media (max-width: 720px) { .mc-quote { display: none; } }
/* 深色主题：暖墨底 + 琥珀色描边。诗句用 #ece6dc 而不是继承的 #b0b7c1 ——
   后者是"说明文字"的灰度，读诗会显得脏且发青。 */
.me-v5 .mc-quote { border-color: rgba(255, 122, 69, .16); background: linear-gradient(158deg, #262a31 0%, #1d2127 100%); color: #b0b7c1; }
.me-v5 .mc-quote::before { color: rgba(255, 122, 69, .14); }
.me-v5 .mc-quote:hover { border-color: rgba(255, 122, 69, .45); background: linear-gradient(158deg, #2b3038 0%, #22262d 100%); box-shadow: 0 8px 22px rgba(0, 0, 0, .35); }
.me-v5 .mc-quote-tag { color: #ff9d6e; }
.me-v5 .mc-quote-text { color: #ece6dc; }
.me-v5 .mc-quote-src { color: rgba(255, 157, 110, .62); }
@media (max-width: 1100px) { .me-v5 .mc-quote { display: none; } }
@container (max-width: 1100px) { .me-v5 .mc-quote { display: none; } }
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
.me-audit-row.core { background: rgba(255,122,69,.08); border-left: 3px solid #ff7a45; }
.me-audit-row:last-child { border-bottom: 0; }
.me-audit-row:hover { background: rgba(127,127,127,.035); }\n.me-audit-row.active { background: rgba(255,122,69,.055); box-shadow: inset 2px 0 0 #ff7a45; }\n.me-audit-row-main { cursor: pointer; }
.me-audit-row-main { display: flex; align-items: flex-start; gap: 9px; padding: 10px 8px; min-width: 0; }
.me-audit-row-main > input { margin-top: 7px; flex: none; }
.me-audit-row-expand { padding: 2px 5px !important; flex: none; margin-top: 4px; opacity: .55; }
.me-audit-row-tile { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid; border-radius: 8px; font-size: 14px; flex: none; margin-top: 1px; }
.me-audit-row-copy { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.me-audit-row-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.me-audit-row-kind { font-size: 10px; color: #b0b7c1; }
.me-audit-row-kind.core { color: #ff9a72; font-weight: 700; }
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
/* ---- 动态 / News ---- */
.mc-news { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.mc-news-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.mc-news-search { flex: 1 1 220px; min-width: 160px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 12px; }
.mc-news-main { display: flex; gap: 10px; align-items: flex-start; }
.mc-news-list { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.mc-news-group { display: flex; flex-direction: column; gap: 8px; }
.mc-news-group-label { margin: 10px 0 0; font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-card { position: relative; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; padding: 13px 15px; cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .1s; }
.mc-news-card:hover { border-color: var(--dsw-alias-border-l2, #d1d5db); box-shadow: 0 10px 26px rgba(0,0,0,.08); }
.mc-news-card:active { transform: translateY(1px); }
.mc-news-card.pinned { border-color: rgba(255,122,69,.5); background: linear-gradient(135deg, rgba(255,122,69,.07), transparent 60%); }
.mc-news-card.unread { border-left: 3px solid var(--dsw-alias-accent, #2563eb); }
.mc-news-card.active { border-color: var(--dsw-alias-accent, #2563eb); box-shadow: 0 0 0 1px var(--dsw-alias-accent, #2563eb) inset; }
.mc-news-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.mc-news-cat { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 650; color: var(--dsw-alias-accent, #2563eb); background: rgba(37,99,235,.10); border: 1px solid rgba(37,99,235,.18); }
.mc-news-pin { font-size: 10px; color: #f59e0b; font-weight: 650; }
.mc-news-time { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-secondary, #6b7280); white-space: nowrap; }
.mc-news-title { margin: 7px 0 0; font-size: 14.5px; font-weight: 650; line-height: 1.45; letter-spacing: -.01em; }
.mc-news-excerpt { margin: 5px 0 0; font-size: 11.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary, #6b7280); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mc-news-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 8px; font-size: 10px; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-accent, #2563eb); box-shadow: 0 0 0 3px rgba(37,99,235,.12); flex: none; }
.mc-news-actions { display: flex; align-items: center; gap: 4px; }
.mc-news-actions .mc-btn { padding: 2px 7px; font-size: 10.5px; }
.mc-news-reader { flex: 0 0 440px; width: 440px; max-height: calc(100vh - 170px); overflow: auto; position: sticky; top: 0; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; padding: 16px 18px; }
.mc-news-reader-head { display: flex; align-items: flex-start; gap: 8px; }
.mc-news-reader h2 { margin: 10px 0 0; font-size: 20px; line-height: 1.35; letter-spacing: -.02em; }
.mc-news-reader-meta { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 8px; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-reader .md-doc { font-size: 12.5px; line-height: 1.8; }
.mc-news-reader-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1, #e5e7eb); }
.mc-news-empty { padding: 30px 16px; text-align: center; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12.5px; line-height: 1.8; }
.mc-news-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mc-news-form .full { grid-column: 1 / -1; }
.mc-news-input, .mc-news-textarea { width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 12px; }
.mc-news-textarea { min-height: 220px; resize: vertical; font-family: var(--mono, monospace); line-height: 1.7; }
.mc-news-preview { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 8px; padding: 12px; max-height: 260px; overflow: auto; }
.mc-news-form label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-form label > input, .mc-news-form label > textarea { font-size: 12px; color: var(--dsw-alias-label-primary, #1f2937); }
@media (max-width: 1100px) { .mc-news-main { flex-direction: column; } .mc-news-reader { position: static; width: 100%; flex-basis: auto; max-height: none; } }
@media (max-width: 720px) { .mc-news-form { grid-template-columns: 1fr; } }

/* ---- 动态 / News：模式切换 + 资讯流 ---- */
.mc-news-modes { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
.mc-news-mode { border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: transparent; color: inherit; border-radius: 999px; padding: 6px 13px; font-size: 11.5px; cursor: pointer; transition: background .15s, border-color .15s, color .15s; }
.mc-news-mode:hover { border-color: var(--dsw-alias-accent, #2563eb); }
.mc-news-mode.active { background: var(--dsw-alias-accent, #2563eb); border-color: transparent; color: #fff; font-weight: 650; }
.mc-news-feed-list { display: flex; flex-direction: column; gap: 8px; }
.mc-news-feed-card { display: flex; gap: 10px; align-items: flex-start; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; padding: 12px 14px; text-decoration: none; color: inherit; transition: border-color .15s, box-shadow .15s; }
.mc-news-feed-card:hover { border-color: var(--dsw-alias-accent, #2563eb); box-shadow: 0 8px 22px rgba(0,0,0,.08); }
.mc-news-rank { flex: 0 0 30px; text-align: center; font: 700 18px/1.2 var(--mono, monospace); color: var(--dsw-alias-accent, #2563eb); padding-top: 1px; }
.mc-news-feed-body { flex: 1; min-width: 0; }
.mc-news-feed-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 10px; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-feed-title { margin: 4px 0 0; font-size: 14px; font-weight: 650; line-height: 1.45; }
.mc-news-feed-summary { margin: 4px 0 0; font-size: 11.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #6b7280); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mc-news-feed-bottom { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 7px; font-size: 10px; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-feed-heat { color: #d97706; font-weight: 650; }
.mc-news-feed-warn { margin-bottom: 10px; padding: 7px 10px; border-radius: 8px; font-size: 11px; color: #b45309; background: rgba(245,158,11,.10); border: 1px solid rgba(245,158,11,.28); }
.mc-news-feed-empty { padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12.5px; }
.mc-news-loading-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 34px 16px; min-height: 120px; }
.mc-news-loading-card > span { font-size: 12.5px; color: var(--dsw-alias-label-primary, #1f2937); }
.mc-news-loading-card > small { max-width: 46ch; font-size: 10.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-feed-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
/* ---- 新闻美术增强：Hero 搜索 / 缩略图卡片网格 / 胶囊分类 ---- */
.mc-news-hero, .mc-news-pref, .mc-news-feed-toolbar, .mc-news-feed-meta, .mc-news-grid, .mc-news-loading-card { flex: 0 0 auto; }
.mc-news-hero { position: relative; overflow: hidden; margin-bottom: 12px; padding: 15px 16px 13px; border-radius: 16px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: radial-gradient(120% 140% at 0% 0%, rgba(56,189,248,.16), transparent 58%), radial-gradient(120% 140% at 100% 0%, rgba(139,92,246,.16), transparent 58%), var(--dsw-alias-bg-layer-1, #fff); }
.mc-news-hero-eye { margin-bottom: 9px; font-size: 10px; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; color: var(--dsw-alias-accent, #2563eb); }
.mc-news-hero-search { position: relative; display: flex; align-items: center; gap: 8px; padding: 4px 5px 4px 14px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); transition: box-shadow .35s ease, border-color .25s ease, transform .25s ease; }
.mc-news-hero-search:focus-within { border-color: transparent; transform: translateY(-1px); box-shadow: 0 0 0 3px rgba(56,189,248,.20), 0 0 24px rgba(56,189,248,.38), 0 0 52px rgba(139,92,246,.26); }
.mc-news-hero-eye + .mc-news-hero-search, .mc-news-hero-search.is-focus { animation: mc-news-hero-glow 3.6s ease-in-out infinite; }
@keyframes mc-news-hero-glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(56,189,248,0); } 50% { box-shadow: 0 0 22px rgba(139,92,246,.16); } }
.mc-news-hero-search input { flex: 1; min-width: 0; padding: 10px 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 14px; }
.mc-news-hero-search input::placeholder { color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-hero-go { flex: none; padding: 9px 18px; border: 0; border-radius: 999px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 650; color: #04101f; background: linear-gradient(120deg, #67e8f9, #38bdf8 45%, #a78bfa); box-shadow: 0 8px 20px -10px rgba(56,189,248,.9); transition: transform .18s ease, filter .2s ease; }
.mc-news-hero-go:hover { transform: translateY(-1px); filter: brightness(1.06); }
.mc-news-hero-go:active { transform: scale(.98); }
/* ---- 关注（Follow）：hero 里的订阅入口 + 预览卡 + 关注 chips ---- */
.mc-news-hero-follow { flex: none; padding: 9px 15px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: 999px; cursor: pointer; font-family: inherit; font-size: 12.5px; font-weight: 650; color: inherit; background: var(--dsw-alias-bg-layer-1, #fff); transition: all .16s ease; }
.mc-news-hero-follow:hover { border-color: var(--dsw-alias-brand-primary, #3b82f6); color: var(--dsw-alias-brand-primary, #3b82f6); transform: translateY(-1px); }
.mc-news-hero-follow:disabled { opacity: .55; cursor: not-allowed; transform: none; }
/* 预览卡：落库前的「我理解对了吗」。留白大一点，让人真的读一遍再点确认。 */
.mc-news-follow-draft { margin: 0 0 12px; padding: 12px 13px; border-radius: 12px; border: 1px solid rgba(59,130,246,.35); background: rgba(59,130,246,.06); font-size: 12px; display: flex; flex-direction: column; gap: 9px; }
.mc-news-follow-draft .draft-head { font-size: 11px; font-weight: 700; letter-spacing: .04em; opacity: .8; }
.mc-news-follow-draft .draft-q { opacity: .75; margin-left: 4px; }
.mc-news-follow-draft .draft-doms { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mc-news-follow-draft .draft-lbl { font-size: 10.5px; opacity: .6; }
.mc-news-follow-draft .draft-opt { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-size: 11.5px; white-space: nowrap; }
.mc-news-follow-draft .draft-opt input { width: 14px; height: 14px; margin: 0; accent-color: #3b82f6; }
.mc-news-follow-draft .draft-note { font-size: 10.5px; line-height: 1.7; opacity: .68; }
.mc-news-follow-draft .draft-actions { display: flex; gap: 8px; justify-content: flex-end; }
/* 关注 chips：点主体 = 只看这个主题；点 ✕ = 取消关注 */
.mc-news-follows { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin: 0 0 10px; }
.mc-news-follow-chip { display: inline-flex; align-items: center; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: 999px; overflow: hidden; font-size: 11.5px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mc-news-follow-chip.on { border-color: #3b82f6; color: #3b82f6; background: rgba(59,130,246,.10); }
.mc-news-follow-chip .chip-main { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 5px 9px; font-family: inherit; font-size: inherit; }
.mc-news-follow-chip .chip-main i { font-style: normal; opacity: .55; margin-left: 5px; }
.mc-news-follow-chip .chip-x { border: 0; border-left: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: transparent; color: inherit; cursor: pointer; padding: 5px 8px; font-size: 10px; opacity: .5; }
.mc-news-follow-chip .chip-x:hover { opacity: 1; color: #ef4444; }
.mc-news-tile-follow { font-size: 9.5px; padding: 1px 6px; border-radius: 999px; background: rgba(59,130,246,.12); color: #3b82f6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
/* 关注专区：单独一栏，不和新闻抢新鲜度排序 */
.mc-news-follow-sec { margin: 0 0 14px; padding: 10px 11px 12px; border-radius: 13px; border: 1px solid rgba(59,130,246,.22); background: rgba(59,130,246,.045); }
.mc-news-follow-sec-head { display: flex; align-items: center; gap: 8px; margin: 0 2px 9px; font-size: 11px; font-weight: 700; letter-spacing: .03em; color: var(--dsw-alias-brand-primary, #3b82f6); }
.mc-news-follow-sec-head em { font-style: normal; font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(59,130,246,.14); }
/* 摘要预览：让用户在开启推送前先看清「会推什么」 */
.mc-digest-preview { margin: 0; padding: 10px 12px; border-radius: 9px; background: var(--dsw-alias-bg-base, #f3f4f6); color: inherit; font-size: 11.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
.mc-news-hero-clear { flex: none; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: rgba(127,127,127,.08); color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11px; line-height: 1; cursor: pointer; transition: all .2s ease; }
.mc-news-hero-clear:hover { color: var(--dsw-alias-label-primary, #111827); border-color: var(--dsw-alias-border-l2, #d1d5db); }
.mc-news-hero-hint { margin-top: 8px; font-size: 10.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-pref { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; padding: 7px 10px; border-radius: 10px; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #6b7280); background: linear-gradient(96deg, rgba(56,189,248,.10), rgba(139,92,246,.10)); border: 1px solid rgba(56,189,248,.24); }
.mc-news-pref b { color: var(--dsw-alias-label-primary, #111827); font-weight: 650; }
.mc-news-pref .mc-news-pref-actions { margin-left: auto; display: flex; gap: 6px; }
.mc-news-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.mc-news-pill { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: rgba(127,127,127,.06); color: var(--dsw-alias-label-secondary, #6b7280); font-family: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; transition: transform .2s ease, color .2s ease, background .25s ease, border-color .2s ease, box-shadow .25s ease; }
.mc-news-pill:hover { transform: translateY(-1px); color: var(--dsw-alias-label-primary, #111827); border-color: var(--dsw-alias-border-l2, #d1d5db); }
.mc-news-pill.on { color: #04101f; border-color: transparent; background: linear-gradient(120deg, #7dd3fc, #a78bfa); box-shadow: 0 6px 16px -8px rgba(125,211,252,.95); }
.mc-news-pill-count { font-size: 10px; opacity: .62; font-variant-numeric: tabular-nums; }
.mc-news-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 12px; transition: opacity .16s ease, transform .16s ease; }
.mc-news-grid.is-swapping { opacity: 0; transform: translateY(6px); }
.mc-news-tile { position: relative; display: flex; flex-direction: column; overflow: hidden; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; text-decoration: none; box-shadow: 0 1px 3px rgba(0,0,0,.06); transition: transform .34s cubic-bezier(.22,1,.36,1), box-shadow .34s ease, border-color .3s ease; animation: mc-news-tile-in .42s cubic-bezier(.22,1,.36,1) both; animation-delay: calc(var(--i, 0) * 38ms); }
@keyframes mc-news-tile-in { from { opacity: 0; transform: translateY(14px) scale(.985); } to { opacity: 1; transform: none; } }
.mc-news-tile:hover { transform: translateY(-6px) scale(1.015); border-color: var(--dsw-alias-accent, #2563eb); box-shadow: 0 18px 38px -14px rgba(15,23,42,.45), 0 6px 16px rgba(15,23,42,.14); z-index: 2; }
.mc-news-tile:focus-visible { outline: 2px solid var(--dsw-alias-accent, #2563eb); outline-offset: 2px; }
.mc-news-tile-cover { position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; background: #0b1024; }
.mc-news-tile-img { display: block; width: 100%; height: 100%; object-fit: cover; transition: transform .6s cubic-bezier(.22,1,.36,1), filter .4s ease; }
.mc-news-tile:hover .mc-news-tile-img { transform: scale(1.08); filter: saturate(1.1) brightness(1.03); }
.mc-news-tile-cover::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(4,8,18,0) 45%, rgba(4,8,18,.72) 100%); pointer-events: none; }
.mc-news-tile-gen { position: absolute; inset: 0; display: grid; place-items: center; gap: 2px; background: radial-gradient(120% 120% at 18% 12%, hsl(var(--hue, 210) 92% 62% / .55), transparent 60%), radial-gradient(120% 120% at 82% 88%, hsl(calc(var(--hue, 210) + 46) 88% 58% / .45), transparent 58%), linear-gradient(150deg, #101a33 5%, #0a1024 92%); }
.mc-news-tile-gen b { font-size: 28px; font-weight: 800; color: rgba(255,255,255,.92); text-shadow: 0 6px 20px rgba(0,0,0,.4); }
.mc-news-tile-gen small { font-size: 9px; letter-spacing: .3em; color: rgba(255,255,255,.66); }
.mc-news-tile-gen em { position: absolute; left: 9px; bottom: 7px; display: inline-flex; align-items: center; gap: 5px; font-style: normal; font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: rgba(255,255,255,.62); }
.mc-news-tile-gen em i { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 5px; font-style: normal; font-size: 8.5px; font-weight: 700; letter-spacing: 0; color: #eaf6ff; background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.22); }
.mc-news-tile-badge { position: absolute; top: 8px; left: 8px; z-index: 2; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; color: #04101f; background: linear-gradient(120deg, #7dd3fc, #a5b4fc); }
.mc-news-tile-badge.hot { background: linear-gradient(120deg, #fdba74, #f472b6); }
.mc-news-tile-time { position: absolute; right: 8px; bottom: 7px; z-index: 2; padding: 1px 7px; border-radius: 999px; font-size: 10px; color: #e8ecf8; background: rgba(6,10,20,.55); border: 1px solid rgba(255,255,255,.10); }
.mc-news-tile-body { display: flex; flex-direction: column; gap: 5px; flex: 1; padding: 10px 11px 9px; }
.mc-news-tile-title { font-size: 13px; font-weight: 650; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mc-news-tile-summary { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #6b7280); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mc-news-tile-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 3px; font-size: 10px; color: var(--dsw-alias-label-secondary, #6b7280); }
.mc-news-tile-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-accent, #2563eb); flex: none; }
.mc-news-tile-open { margin-left: auto; color: var(--dsw-alias-accent, #2563eb); opacity: .7; transition: transform .2s ease, opacity .2s ease; }
.mc-news-tile:hover .mc-news-tile-open { opacity: 1; transform: translate(2px, -2px); }
@media (max-width: 760px) { .mc-news-grid { grid-template-columns: 1fr; } .mc-news-hero-search { flex-wrap: wrap; border-radius: 18px; } .mc-news-hero-go { width: 100%; } }

.mc-news-feed-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #6b7280); margin-left: auto; }

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
.me-reader-toc button.active { background: rgba(255,122,69,.14); color: #ff9a72; font-weight: 650; }
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
.me-graph { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
.me-graph-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.me-graph-search { position: relative; flex: 1 1 220px; min-width: 170px; display: flex; align-items: center; }
.me-graph-search .ico { position: absolute; left: 11px; width: 13px; height: 13px; color: #8b939f; opacity: .85; pointer-events: none; }
.me-graph-search input { width: 100%; height: 32px; padding: 0 12px 0 32px; border-radius: 9px; border: 1px solid #343b45; background: #1b1f25; color: #e9edf3; font: inherit; font-size: 12px; outline: none; transition: border-color .15s, box-shadow .15s; }
.me-graph-search input::placeholder { color: #7d8695; }
.me-graph-search input:focus { border-color: rgba(255,122,69,.55); box-shadow: 0 0 0 3px rgba(255,122,69,.1); }
.me-graph-count { font-size: 12px; opacity: 0.7; }
.me-gtool { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid #343b45; border-radius: 9px; background: rgba(38,43,51,.55); color: #cdd4de; font: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: border-color .15s, color .15s, background .15s; }
.me-gtool:hover { border-color: rgba(255,122,69,.5); color: #fff; background: rgba(255,122,69,.06); }
.me-gtool:focus-visible, .me-gswitch:focus-within, .me-graph-search input:focus-visible { outline: 2px solid rgba(255,122,69,.55); outline-offset: 2px; }
.me-gtool.on { border-color: rgba(255,122,69,.55); background: rgba(255,122,69,.13); color: #ffb08a; }
.me-gtool .caret { font-size: 9px; opacity: .55; margin-left: 1px; }
.me-gtool .badge { width: 5px; height: 5px; border-radius: 50%; background: #ff7a45; box-shadow: 0 0 0 3px rgba(255,122,69,.16); }
.me-gswitch { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid #343b45; border-radius: 9px; background: rgba(38,43,51,.55); color: #cdd4de; font-size: 11.5px; font-weight: 500; cursor: pointer; user-select: none; white-space: nowrap; }
.me-gswitch:hover { border-color: rgba(255,122,69,.4); color: #fff; }
.me-gswitch .track { position: relative; width: 24px; height: 13px; border-radius: 999px; background: #3a414b; transition: background .16s; flex: none; }
.me-gswitch .track::after { content: ''; position: absolute; left: 2px; top: 2px; width: 9px; height: 9px; border-radius: 50%; background: #9aa3b0; transition: transform .16s, background .16s; }
.me-gswitch input { position: absolute; opacity: 0; pointer-events: none; }
.me-gswitch.on { border-color: rgba(255,122,69,.5); background: rgba(255,122,69,.1); color: #ffb08a; }
.me-gswitch.on .track { background: rgba(255,122,69,.3); }
.me-gswitch.on .track::after { transform: translateX(11px); background: #ff7a45; }
.me-gdiv { width: 1px; height: 18px; background: #343b45; margin: 0 2px; flex: none; }
.me-graph-canvas { position: relative; flex: 1; min-height: 300px; border-radius: 16px; overflow: hidden; background: radial-gradient(120% 92% at 50% 0%, #1d222a 0%, #171b21 54%, #14171c 100%); border: 1px solid #2f353e; box-shadow: inset 0 1px 0 rgba(255,255,255,.035); cursor: grab; touch-action: none; user-select: none; }
.me-graph-canvas.dragging { cursor: grabbing; }
.me-graph-tip { font-size: 10.5px; letter-spacing: .01em; color: #8b939f; }
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
/* 图谱筛选下拉：暗色浮层 + 橙色强调（与 v5 皮肤一致） */
.me-graph-legend-pop { color: #e5e9ef; }
.me-graph-legend-pop .lg { display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 8px; border: 0; border-radius: 7px; background: transparent; color: #cdd4de; font: inherit; font-size: 11.5px; text-align: left; cursor: pointer; }
.me-graph-legend-pop .lg:hover { background: rgba(255,255,255,0.06); color: #fff; }
.me-graph-legend-pop .lg.active { background: rgba(255,122,69,0.16); color: #ffb08a; box-shadow: inset 0 0 0 1px rgba(255,122,69,0.28); }
.me-graph-legend-pop .lg.lg-clear { color: #f87171; }
.me-graph-ctxmenu { min-width: 160px; padding: 6px; background: rgba(24,28,34,0.96); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #e6eaf0; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; box-shadow: 0 16px 40px rgba(0,0,0,.42); font-size: 12px; }
.me-graph-ctxmenu button { display: block; width: 100%; text-align: left; padding: 7px 9px; border: none; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 11.5px; cursor: pointer; }
.me-graph-ctxmenu button:hover { background: rgba(255,255,255,0.07); }
.me-graph-hint { font-size: 11px; opacity: 0.6; margin-left: auto; }
/* 星球分层：图内面包屑（可点任意层级返回）+ 层级状态条 + 加载/失败提示 */
.me-graph-crumbs { position: absolute; left: 14px; bottom: 14px; z-index: 4; display: flex; align-items: center; gap: 2px; max-width: calc(100% - 32px); padding: 3px 5px; border-radius: 10px; background: rgba(23,27,33,0.78); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,0.07); box-shadow: 0 10px 26px rgba(0,0,0,.25); overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.me-graph-crumbs::-webkit-scrollbar { display: none; }
.me-graph-crumbs button { flex: none; border: none; background: transparent; color: #98a1ad; font: inherit; font-size: 11px; font-weight: 500; letter-spacing: .01em; padding: 4px 9px; border-radius: 7px; cursor: pointer; white-space: nowrap; transition: background .14s, color .14s; }
.me-graph-crumbs button:hover { background: rgba(255,255,255,0.07); color: #fff; }
.me-graph-crumbs button.current { background: rgba(255,122,69,0.14); color: #ffb08a; box-shadow: inset 0 0 0 1px rgba(255,122,69,0.26); cursor: default; }
.me-graph-crumbs .sep { flex: none; color: #4f5762; font-size: 10px; }
.me-graph-crumbs .home { color: #c6ccd6; }
.me-graph-levelbusy { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); z-index: 6; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: rgba(23,27,33,0.9); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #e8ebf0; font-size: 11px; font-weight: 500; border: 1px solid rgba(255,255,255,0.07); box-shadow: 0 10px 26px rgba(0,0,0,.3); pointer-events: none; }
.me-graph-levelbusy .me-progress { width: 54px; flex: none; }
.me-graph-levelerr { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); z-index: 7; display: flex; align-items: center; gap: 10px; max-width: min(560px, calc(100% - 32px)); padding: 8px 12px; border-radius: 12px; background: rgba(66,22,24,0.94); border: 1px solid rgba(248,113,113,0.5); color: #fee2e2; font-size: 12px; box-shadow: 0 10px 26px rgba(0,0,0,.34); }
.me-graph-levelerr .msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-graph-levelerr button { flex: none; border: 1px solid rgba(254,226,226,0.45); background: rgba(255,255,255,0.06); color: #fff5f5; font: inherit; font-size: 11.5px; font-weight: 700; padding: 4px 10px; border-radius: 999px; cursor: pointer; }
.me-graph-levelerr button:hover { background: rgba(255,255,255,0.16); }
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
.me-v5 .mc-v5-top.in-host { padding-right: 108px; position: relative; }
/* 右侧安全区做成明确的「窗口控制区」：一条细分隔 + 极淡的底，避免 Star/? 与关闭键之间像一块空洞。 */
.me-v5 .mc-v5-top.in-host::before { content: ''; position: absolute; right: 0; top: 0; bottom: 0; width: 108px; background: linear-gradient(90deg, transparent, rgba(255,255,255,.028)); pointer-events: none; }
.me-v5 .mc-v5-top.in-host::after { content: ''; position: absolute; right: 108px; top: 13px; bottom: 13px; width: 1px; background: rgba(255,255,255,.07); pointer-events: none; }
.me-v5 .mc-v5-top.in-host .mc-v5-top-actions { position: relative; z-index: 1; gap: 6px; }
@media (max-width: 900px) { .me-v5 .mc-v5-top.in-host { padding-right: 92px; } .me-v5 .mc-v5-top.in-host::before { width: 92px; } .me-v5 .mc-v5-top.in-host::after { right: 92px; } }
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
.me-v5 .mc-v5-core-badge { display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border: 1px solid rgba(255,122,69,.55); border-radius: 999px; background: rgba(255,122,69,.16); color: #ff9a72; font-size: 9px; font-weight: 700; white-space: nowrap; }
.me-v5 .mc-v5-pin { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; font-size: 9px; opacity: .35; flex: none; }
.me-v5 .mc-v5-core { display: inline-flex; align-items: center; gap: 3px; height: 20px; padding: 0 7px; border: 1px solid rgba(255,122,69,.35); border-radius: 5px; background: rgba(255,122,69,.08); color: #ff9a72; font-size: 9.5px; font-weight: 650; cursor: pointer; flex: none; }
.me-v5 .mc-v5-core:hover { border-color: rgba(255,122,69,.65); background: rgba(255,122,69,.16); }
.me-v5 .mc-v5-core.on { border-color: rgba(255,122,69,.7); background: rgba(255,122,69,.2); color: #ffb08a; }
.me-core-banner { display: flex; align-items: center; gap: 10px; margin: 10px 18px 0; padding: 10px 12px; border: 1px solid rgba(255,122,69,.35); border-radius: 10px; background: rgba(255,122,69,.08); }
.me-core-banner.on { border-color: rgba(255,122,69,.65); background: rgba(255,122,69,.14); }
.me-core-banner-k { color: #ff9a72; font-weight: 700; white-space: nowrap; font-size: 12px; }
.me-core-banner-desc { flex: 1; min-width: 0; font-size: 11.5px; line-height: 1.6; opacity: .78; }
.me-core-btn { background: #ff7a45 !important; border-color: #ff7a45 !important; color: #1b120e !important; font-weight: 700; white-space: nowrap; }
.me-v5 .mc-v5-pin:hover, .me-v5 .mc-v5-pin.on { opacity: 1; background: rgba(255,122,69,.12); }
.me-v5 .mc-v5-card.pinned { border-color: rgba(255,122,69,.32); }
.me-v5 .mc-v5-card.core { border-color: rgba(255,122,69,.52); box-shadow: inset 0 0 0 1px rgba(255,122,69,.16); }
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
.me-v5 .mc-v5-graph-legend { transition: opacity .18s ease, transform .18s ease; }
.me-graph[data-zoom="in"] .mc-v5-graph-legend { opacity: 0; transform: translateY(-4px); }
.me-v5 .mc-v5-graph-legend { position: absolute; left: 14px; top: 14px; z-index: 2; min-width: 150px; padding: 11px 12px 9px; border: 1px solid rgba(255,255,255,.07); border-radius: 12px; background: rgba(23,27,33,.74); backdrop-filter: blur(14px) saturate(120%); -webkit-backdrop-filter: blur(14px) saturate(120%); box-shadow: 0 12px 30px rgba(0,0,0,.28); pointer-events: none; }
.me-v5 .mc-v5-graph-legend-title { margin-bottom: 8px; font-size: 9px; letter-spacing: .16em; color: #8b939f; font-weight: 600; }
.me-v5 .mc-v5-graph-legend-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 10.5px; color: #aab1bb; }
.me-v5 .mc-v5-graph-legend-row i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.me-v5 .mc-v5-graph-legend-row span { flex: 1; letter-spacing: .01em; }
.me-v5 .mc-v5-graph-legend-row b { color: #e6eaf0; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 10.5px; }
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
/* ================= 主题皮肤框架（data-skin） =================
   新增皮肤：① Config 的 theme union 加 id；② 这里加 [data-skin="id"] 变量 + 少量表面覆盖；
   ③ client 的 SKINS 列表加一项（name/desc/三色预览）。所有页面共用同一套变量。 */
.memory-eternal-root[data-skin="pop"], .mc-admin[data-skin="pop"] {
  --dsw-alias-bg-base: #fff6e5;
  --dsw-alias-bg-layer-1: #fffdf7;
  --dsw-alias-bg-layer-2: #ffefc4;
  --dsw-alias-border-l1: #111111;
  --dsw-alias-border-l2: #111111;
  --dsw-alias-label-primary: #141414;
  --dsw-alias-label-secondary: #4c4c4c;
  --dsw-alias-accent: #ff2e63;
  --dsw-alias-brand-primary: #ff2e63;
}
.memory-eternal-root[data-skin="pop"] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.mc-admin[data-skin="pop"] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
[data-skin="pop"] .mc-main {
  background-color: #fff6e5;
  background-image: radial-gradient(rgba(17,17,17,.10) 1px, transparent 1.2px);
  background-size: 14px 14px;
  color: #141414;
}
[data-skin="pop"] .mc-rail { background: #ffd83d; border-right: 3px solid #111; }
[data-skin="pop"] .mc-v5-top { background: #fffdf7; border-bottom: 3px solid #111; color: #111; }
[data-skin="pop"] .mc-v5-crumb, [data-skin="pop"] .mc-v5-crumb b, [data-skin="pop"] .mc-v5-sys,
[data-skin="pop"] .mc-v5-ver, [data-skin="pop"] .mc-v5-star, [data-skin="pop"] .mc-v5-railbrand b { color: #111; }
[data-skin="pop"] .mc-railbtn { color: #111; border-radius: 6px; }
[data-skin="pop"] .mc-railbtn:hover { background: #fff; border: 2px solid #111; box-shadow: 3px 3px 0 #111; color: #111; }
[data-skin="pop"] .mc-railbtn.active { background: var(--dsw-alias-accent); border: 2px solid #111; color: #fff; box-shadow: 3px 3px 0 #111; }
[data-skin="pop"] .mc-v5-sys, [data-skin="pop"] .mc-v5-ver, [data-skin="pop"] .mc-v5-star { background: #fff; border: 2px solid #111; border-radius: 999px; }
[data-skin="pop"] .mc-card { background: #fffdf7; border: 2px solid #111; border-radius: 8px; box-shadow: 4px 4px 0 #111; }
[data-skin="pop"] .mc-btn { background: #ffd83d !important; border: 2px solid #111 !important; border-radius: 6px; color: #111 !important; box-shadow: 2px 2px 0 #111; font-weight: 700; }
[data-skin="pop"] .mc-btn:hover { opacity: 1; transform: translate(-1px,-1px); box-shadow: 4px 4px 0 #111; }
[data-skin="pop"] .mc-btn.me-on { background: var(--dsw-alias-accent) !important; color: #fff !important; border-color: #111 !important; }
[data-skin="pop"] .mc-toolbar input[type=text], [data-skin="pop"] .mc-news-search,
[data-skin="pop"] .mc-field input:not([type="checkbox"]):not([type="radio"]), [data-skin="pop"] .mc-field select {
  background: #fff; border: 2px solid #111; border-radius: 6px; color: #111;
}
[data-skin="pop"] .mc-field input:focus, [data-skin="pop"] .mc-field select:focus { border-color: #111; box-shadow: 0 0 0 3px rgba(255,46,99,.28); }
[data-skin="pop"] .mc-chip { background: #fff; border: 2px solid #111; color: #111; }
[data-skin="pop"] .mc-chip.active { background: var(--dsw-alias-accent); color: #fff; }
[data-skin="pop"] .mc-v5-pagehead h1 { color: #111; font-weight: 900; letter-spacing: -.03em; text-shadow: 3px 3px 0 #ffd83d; }
[data-skin="pop"] .mc-v5-pagehead p, [data-skin="pop"] .mc-v5-eyebrow, [data-skin="pop"] .mc-v5-pagecount { color: #111; opacity: .78; }
[data-skin="pop"] .mc-quote { background: #fff; border-top: 2px solid #111; color: #111; }
[data-skin="pop"] .mc-pagenav { background: #fff; border: 2px solid #111; border-radius: 8px; }
[data-skin="pop"] .mc-pagebtn.on { background: var(--dsw-alias-accent); color: #fff; box-shadow: 3px 3px 0 #111; }
[data-skin="pop"] .mc-panehead-ico { background: #ffd83d; border: 2px solid #111; }
[data-skin="pop"] .mc-cfg-sec, [data-skin="pop"] .mc-env, [data-skin="pop"] .mc-env-fold,
[data-skin="pop"] .mc-fold, [data-skin="pop"] .mc-cfg-actions { background: #fffdf7; border: 2px solid #111; border-radius: 8px; box-shadow: 4px 4px 0 #111; }
[data-skin="pop"] .mc-cfg-sec-ico { background: #ffd83d; border: 1px solid #111; }
[data-skin="pop"] .mc-cfg-switches .mc-switch { border-bottom-color: rgba(17,17,17,.18); }
[data-skin="pop"] .mc-seg button.on { background: #ffd83d; color: #111; }
[data-skin="pop"] .mc-plan:hover { border-color: #111; transform: none; }
[data-skin="pop"] .mc-plan.on { background: #ffe1ea; border-color: #111; box-shadow: 3px 3px 0 #111; }
[data-skin="pop"] .mc-news-hero, [data-skin="pop"] .mc-news-card, [data-skin="pop"] .mc-news-tile,
[data-skin="pop"] .mc-news-feed-card, [data-skin="pop"] .mc-news-reader { border: 2px solid #111; box-shadow: 4px 4px 0 #111; border-radius: 8px; }
[data-skin="pop"] .me-audit-kinds, [data-skin="pop"] .me-audit-preview, [data-skin="pop"] .me-audit-bulk { border: 2px solid #111; border-radius: 8px; box-shadow: 4px 4px 0 #111; }
[data-skin="pop"] .mc-toolbar input::placeholder, [data-skin="pop"] .mc-news-search::placeholder { color: #777; }
[data-skin="pop"] :is(.mc-v5-crumb, .mc-v5-crumb b, .mc-v5-pagehead h1, .mc-v5-pagehead p, .mc-v5-eyebrow,
  .mc-v5-pagecount, .mc-v5-pagehead-stats span, .mc-v5-pagehead-stats b,
  .mc-v5-card-title, .mc-v5-card-lead, .mc-v5-card-kind-name, .mc-v5-card-time, .mc-v5-card-foot,
  .mc-v5-author, .mc-v5-conn, .mc-v5-conn b,
  .mc-v5-feature h3, .mc-v5-feature p, .mc-v5-feature-meta, .mc-v5-feature-side span,
  .me-audit-row-title, .me-audit-row-kind, .me-audit-row-time, .me-audit-row-meta,
  .me-audit-row-reason, .mc-v5-graph-legend, .mc-v5-graph-legend-row b, .md-doc, .md-doc h1, .md-doc h2, .md-doc h3) { color: #141414; }
[data-skin="pop"] .mc-v5-feature { background: #fff; border: 2px solid #111; box-shadow: 4px 4px 0 #111; }
[data-skin="pop"] .mc-v5-feature-side b { color: #ff2e63; }
[data-skin="pop"] .mc-v5-feature-open { color: #ff2e63 !important; }
[data-skin="pop"] .mc-news-hero { background: #fff !important; border: 2px solid #111; box-shadow: 4px 4px 0 #111; }
[data-skin="pop"] .mc-news-hero-hint { color: #444 !important; }
[data-skin="pop"] .mc-tag { background: #fff !important; border: 1.5px solid #111; color: #141414 !important; }
[data-skin="pop"] .mc-tag.more { background: #ffd83d !important; }
[data-skin="pop"] .mc-quote-text { color: #141414; }
[data-skin="pop"] .mc-quote-src { color: #8a6a2f; }

/* 明亮皮肤：浅纸面 + 橙色强调 */
.memory-eternal-root[data-skin="light"], .mc-admin[data-skin="light"] {
  --dsw-alias-bg-base: #f7f5f0;
  --dsw-alias-bg-layer-1: #fffdf9;
  --dsw-alias-bg-layer-2: #efece5;
  --dsw-alias-border-l1: #e4e0d8;
  --dsw-alias-border-l2: #d6d0c4;
  --dsw-alias-label-primary: #26221c;
  --dsw-alias-label-secondary: #7a7266;
  --dsw-alias-accent: #e36a36;
  --dsw-alias-brand-primary: #e36a36;
}
.memory-eternal-root[data-skin="light"] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.mc-admin[data-skin="light"] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
[data-skin="light"] .mc-main { background-color: #f7f5f0; background-image: radial-gradient(rgba(120,100,70,.05) 1px, transparent 1.1px); background-size: 18px 18px; color: #26221c; }
[data-skin="light"] .mc-rail { background: #ffffff; border-right: 1px solid #dcdcd8; }
[data-skin="light"] .mc-v5-top { background: #ffffff; border-bottom: 1px solid #dcdcd8; color: #1c1c1e; }
[data-skin="light"] .mc-v5-crumb, [data-skin="light"] .mc-v5-crumb b, [data-skin="light"] .mc-v5-sys,
[data-skin="light"] .mc-v5-ver, [data-skin="light"] .mc-v5-star, [data-skin="light"] .mc-v5-railbrand b { color: #1c1c1e; }
[data-skin="light"] .mc-railbtn { color: #333; }
[data-skin="light"] .mc-railbtn:hover { background: #f0f0ec; color: #111; }
[data-skin="light"] .mc-railbtn.active { background: #ffe3d5; color: #b8410f; }
[data-skin="light"] .mc-v5-sys, [data-skin="light"] .mc-v5-ver, [data-skin="light"] .mc-v5-star { background: #f4f4f1; border-color: #dcdcd8; }
[data-skin="light"] .mc-card { background: #ffffff; border-color: #dcdcd8; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
[data-skin="light"] .mc-btn { background: #fff !important; border-color: #cfcfca !important; color: #1c1c1e !important; }
[data-skin="light"] .mc-btn.me-on { background: #e36a36 !important; color: #fff !important; }
[data-skin="light"] .mc-toolbar input[type=text], [data-skin="light"] .mc-news-search,
[data-skin="light"] .mc-field input:not([type="checkbox"]):not([type="radio"]), [data-skin="light"] .mc-field select { background: #fff; border-color: #cfcfca; color: #1c1c1e; }
[data-skin="light"] .mc-chip { background: #fff; border-color: #dcdcd8; color: #333; }
[data-skin="light"] .mc-chip.active { background: #ffe3d5; border-color: #ff7a45; color: #b8410f; }
[data-skin="light"] .mc-v5-pagehead h1 { color: #1c1c1e; }
[data-skin="light"] .mc-v5-pagehead p, [data-skin="light"] .mc-v5-eyebrow, [data-skin="light"] .mc-v5-pagecount { color: #555; }
[data-skin="light"] .mc-quote { background: #fff; border-color: #dcdcd8; color: #444; }
[data-skin="light"] .mc-pagenav { background: #fff; border-color: #dcdcd8; }
[data-skin="light"] .mc-pagebtn.on { background: #e36a36; color: #fff; box-shadow: 0 4px 12px rgba(227,106,54,.28); }
[data-skin="light"] .mc-panehead-ico { background: #ffe3d5; border-color: #ffc4a8; }
[data-skin="light"] .mc-cfg-sec, [data-skin="light"] .mc-env, [data-skin="light"] .mc-env-fold,
[data-skin="light"] .mc-fold, [data-skin="light"] .mc-cfg-actions { background: #ffffff; border-color: #dcdcd8; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
[data-skin="light"] .mc-cfg-sec-ico { background: #ffe3d5; }
[data-skin="light"] .mc-seg button.on { background: #fff; color: #1c1c1e; }
[data-skin="light"] .mc-plan.on { background: #fff4ee; border-color: #ff7a45; }
[data-skin="light"] .mc-news-hero, [data-skin="light"] .mc-news-card, [data-skin="light"] .mc-news-tile,
[data-skin="light"] .mc-news-feed-card, [data-skin="light"] .mc-news-reader { border-color: #dcdcd8; }
[data-skin="light"] :is(.mc-v5-crumb, .mc-v5-crumb b, .mc-v5-pagehead h1, .mc-v5-pagehead p, .mc-v5-eyebrow,
  .mc-v5-pagecount, .mc-v5-pagehead-stats span, .mc-v5-pagehead-stats b,
  .mc-v5-card-title, .mc-v5-card-lead, .mc-v5-card-kind-name, .mc-v5-card-time, .mc-v5-card-foot,
  .mc-v5-author, .mc-v5-conn, .mc-v5-conn b,
  .mc-v5-feature h3, .mc-v5-feature p, .mc-v5-feature-meta, .mc-v5-feature-side span,
  .me-audit-row-title, .me-audit-row-kind, .me-audit-row-time, .me-audit-row-meta,
  .me-audit-row-reason, .mc-v5-graph-legend, .mc-v5-graph-legend-row b, .md-doc, .md-doc h1, .md-doc h2, .md-doc h3) { color: #1c1c1e; }
[data-skin="light"] .mc-v5-feature { background: #fff; border-color: #ffd3bd; }
[data-skin="light"] .mc-v5-feature-side b { color: #ff7a45; }
[data-skin="light"] .mc-news-hero { background: #fff !important; }
[data-skin="light"] .mc-tag { background: #f0f0ec !important; color: #1c1c1e !important; }
[data-skin="light"] .mc-quote-text { color: #3f3a33; }
/* 主题选择卡 */
.mc-theme-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.mc-theme-card { display: flex; flex-direction: column; gap: 6px; text-align: left; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; padding: 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.mc-theme-card:hover { border-color: var(--dsw-alias-brand-primary, #ff7a45); }
.mc-theme-card.on { border-color: var(--dsw-alias-brand-primary, #ff7a45); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary, #ff7a45) inset; }
.mc-theme-card b { font-size: 12.5px; }
.mc-theme-card > span:last-child { font-size: 10.5px; opacity: .55; line-height: 1.45; }
.mc-theme-swatch { display: flex; height: 40px; border-radius: 8px; overflow: hidden; border: 1px solid rgba(127,127,127,.25); }
.mc-theme-swatch i { flex: 1; }
.mc-theme-swatch i:first-child { flex: 1.45; }
[data-skin="pop"] .mc-theme-card { background: #fff; border: 2px solid #111; }
[data-skin="pop"] .mc-theme-card.on { background: #ffe1ea; box-shadow: 3px 3px 0 #111; }
[data-skin="light"] .mc-theme-card { background: #fff; }
/* —— 皮肤细节强化：字体 / 质感 / 微交互 —— */
[data-skin="pop"] .mc-v5-pagehead h1,
[data-skin="pop"] .mc-panehead-title,
[data-skin="pop"] .mc-v5-feature h3 { font-family: 'Arial Black', 'Arial Bold', 'Noto Sans SC', 'Microsoft YaHei', sans-serif; font-weight: 900; letter-spacing: -.025em; }
[data-skin="pop"] .mc-v5-pagehead h1 { display: block; width: fit-content; padding: 2px 9px; margin-top: 2px; background: #ffd83d; border: 2px solid #111; box-shadow: 4px 4px 0 #111; text-shadow: none; }
[data-skin="pop"] .mc-v5-eyebrow { display: inline-block; margin-bottom: 6px; padding: 2px 9px; background: #111; color: #ffd83d !important; letter-spacing: .18em; font-weight: 800; }
[data-skin="pop"] .mc-pagebtn.on .mc-pagebtn-sub { color: rgba(255,255,255,.86) !important; }
[data-skin="light"] .mc-pagebtn.on .mc-pagebtn-sub { color: rgba(255,255,255,.88) !important; }
[data-skin="light"] .mc-v5-pagehead h1 { width: fit-content; padding-bottom: 4px; border-bottom: 3px solid #e8c7b4; }
[data-skin="pop"] .mc-v5-pagecount { padding: 1px 9px; background: #ffd83d; border: 2px solid #111; border-radius: 999px; color: #111; }
[data-skin="pop"] .mc-v5-pagehead-stats b { background: #ffd83d; padding: 0 4px; }
[data-skin="pop"] .mc-cardrow { transition: transform .14s ease, box-shadow .14s ease; }
[data-skin="pop"] .mc-cardrow:hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 #111; }
[data-skin="pop"] .mc-tag:nth-child(3n+1) { background: #ffd83d !important; }
[data-skin="pop"] .mc-tag:nth-child(3n+2) { background: #9be7ff !important; }
[data-skin="pop"] .mc-tag:nth-child(3n) { background: #ffb3d4 !important; }
[data-skin="pop"] .mc-tag.more { background: #fff !important; }
[data-skin="pop"] .mc-btn:active { transform: translate(2px, 2px); box-shadow: none; }
[data-skin="pop"] .mc-switch input { border: 2px solid #111; }
[data-skin="pop"] .mc-switch input::after { background: #111; }
[data-skin="pop"] .mc-switch input:checked::after { background: #fff; }
[data-skin="pop"] .mc-news-hero-go { background: #00c2ff !important; border: 2px solid #111; color: #111 !important; box-shadow: 2px 2px 0 #111; font-weight: 800; }
[data-skin="pop"] .mc-news-hero-go:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 #111; filter: none; }
[data-skin="pop"] .mc-v5-graph-legend { background: #fff; border: 2px solid #111; box-shadow: 4px 4px 0 #111; }
[data-skin="pop"] .me-graph-search input { background: #fff; border: 2px solid #111; color: #111; }
[data-skin="pop"] .mc-v5-graph-legend-title { color: #111; }
[data-skin="pop"] .mc-v5-graph-legend-row { color: #333; }
[data-skin="pop"] .mc-v5-graph-legend-row b { color: #111; }
[data-skin="pop"] .me-graph-tip { color: #444; }
[data-skin="pop"] .mc-cfg-sec-title { font-weight: 800; }
[data-skin="light"] .mc-v5-pagehead h1,
[data-skin="light"] .mc-v5-feature h3,
[data-skin="light"] .mc-panehead-title { font-family: 'Noto Serif SC', 'Songti SC', 'STSong', 'SimSun', serif; font-weight: 700; letter-spacing: .01em; }
[data-skin="light"] .mc-v5-pagehead h1 { color: #26221c; }
[data-skin="light"] .mc-v5-eyebrow { color: #9a6b4a !important; letter-spacing: .18em; }
[data-skin="light"] .mc-v5-pagecount { padding: 1px 9px; background: #f1ece2; border-radius: 999px; color: #6b5f4e; }
[data-skin="light"] .mc-railbtn.active { position: relative; }
[data-skin="light"] .mc-railbtn.active::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 3px; background: #e36a36; }
[data-skin="light"] .mc-cardrow { transition: box-shadow .16s ease, transform .16s ease; }
[data-skin="light"] .mc-cardrow:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(60,45,30,.10); }
[data-skin="light"] .mc-v5-graph-legend { background: #fffdf9; border: 1px solid #e4e0d8; }
[data-skin="light"] .me-graph-search input { background: #fffdf9; border-color: #e4e0d8; color: #26221c; }
[data-skin="light"] .mc-news-hero-go { background: #e36a36; color: #fff; }
[data-skin="light"] .mc-v5-feature { background: linear-gradient(135deg, #fffdf9, #fbf3ea); }
[data-skin="light"] .mc-cfg-sec-title { font-weight: 700; }
/* ===== 波普 v2：蓝 / 红 / 黄三色海报系统（更有识别度） ===== */
.memory-eternal-root[data-skin="pop"], .mc-admin[data-skin="pop"] {
  --pop-ink: #17130b;
  --pop-paper: #fff3dc;
  --pop-paper2: #ffe9c2;
  --pop-red: #ff3b2f;
  --pop-teal: #0f766e;
  --pop-yellow: #ffd23f;
  --dsw-alias-bg-base: #fff3dc;
  --dsw-alias-bg-layer-1: #fff9ef;
  --dsw-alias-bg-layer-2: #ffe9c2;
  --dsw-alias-border-l1: #17130b;
  --dsw-alias-border-l2: #17130b;
  --dsw-alias-label-primary: #17130b;
  --dsw-alias-label-secondary: #5a5044;
  --dsw-alias-accent: #ff3b2f;
  --dsw-alias-brand-primary: #ff3b2f;
}
.memory-eternal-root[data-skin="pop"] { background: var(--pop-paper); color: var(--pop-ink); }
.mc-admin[data-skin="pop"] { background: var(--pop-paper); color: var(--pop-ink); }
[data-skin="pop"] .mc-main { background-color: var(--pop-paper); background-image: radial-gradient(rgba(23,19,11,.13) 1.1px, transparent 1.2px); background-size: 13px 13px; color: var(--pop-ink); }
[data-skin="pop"] .mc-rail { background: var(--pop-teal); border-right: 3px solid var(--pop-ink); }
[data-skin="pop"] .mc-v5-railbrand b { color: var(--pop-paper); }
[data-skin="pop"] .mc-v5-railbrand span { color: rgba(255,243,220,.7); }
[data-skin="pop"] .mc-rail-sec { color: rgba(255,243,220,.62); opacity: 1; }
[data-skin="pop"] .mc-railbtn { background: transparent; color: var(--pop-paper); border: 0; }
[data-skin="pop"] .mc-railbtn:hover { background: var(--pop-paper); color: var(--pop-ink); border: 2px solid var(--pop-ink); box-shadow: 3px 3px 0 var(--pop-ink); }
[data-skin="pop"] .mc-railbtn.active { background: var(--pop-yellow); color: var(--pop-ink); border: 2px solid var(--pop-ink); box-shadow: 3px 3px 0 var(--pop-ink); }
[data-skin="pop"] .mc-dot { background: var(--pop-yellow); color: var(--pop-ink); }
[data-skin="pop"] .mc-quote { background: var(--pop-paper); border: 2px solid var(--pop-ink); box-shadow: 3px 3px 0 var(--pop-ink); color: var(--pop-ink); }
[data-skin="pop"] .mc-quote-tag { color: var(--pop-red); }
[data-skin="pop"] .mc-quote-src { color: var(--pop-teal); }
[data-skin="pop"] .mc-v5-top { position: relative; background: var(--pop-paper); border-bottom: 3px solid var(--pop-ink); }
[data-skin="pop"] .mc-v5-top::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 5px; background: linear-gradient(90deg, var(--pop-red) 0 33%, var(--pop-yellow) 33% 66%, var(--pop-teal) 66% 100%); }
[data-skin="pop"] .mc-v5-sys, [data-skin="pop"] .mc-v5-ver, [data-skin="pop"] .mc-v5-star { background: var(--pop-paper); border: 2px solid var(--pop-ink); color: var(--pop-ink); }
[data-skin="pop"] .mc-v5-pagehead h1 { padding: 2px 10px; background: var(--pop-yellow); border: 3px solid var(--pop-ink); box-shadow: 6px 6px 0 var(--pop-red); }
[data-skin="pop"] .mc-v5-eyebrow { display: inline-block; margin-bottom: 6px; padding: 2px 9px; background: var(--pop-teal); color: var(--pop-paper) !important; border: 2px solid var(--pop-ink); box-shadow: 2px 2px 0 var(--pop-ink); }
[data-skin="pop"] .mc-v5-eyebrow::before { content: '★ '; color: var(--pop-yellow); }
[data-skin="pop"] .mc-v5-pagecount { padding: 1px 9px; background: var(--pop-red); border: 2px solid var(--pop-ink); border-radius: 999px; color: var(--pop-paper); box-shadow: 2px 2px 0 var(--pop-ink); }
[data-skin="pop"] .mc-v5-pagehead-stats b { background: var(--pop-yellow); padding: 0 4px; }
[data-skin="pop"] .mc-card { background: #fff9ef; border: 2px solid var(--pop-ink); border-radius: 4px; box-shadow: 5px 5px 0 var(--pop-ink); }
[data-skin="pop"] .mc-cardrow:hover { transform: translate(-2px, -2px); box-shadow: 7px 7px 0 var(--pop-red); }
[data-skin="pop"] .mc-btn { background: var(--pop-yellow); border: 2px solid var(--pop-ink); border-radius: 4px; color: var(--pop-ink); box-shadow: 2px 2px 0 var(--pop-ink); }
[data-skin="pop"] .mc-btn:hover { background: var(--pop-paper); box-shadow: 4px 4px 0 var(--pop-ink); }
[data-skin="pop"] .mc-btn.me-on { background: var(--pop-red) !important; color: var(--pop-paper) !important; border-color: var(--pop-ink) !important; box-shadow: 3px 3px 0 var(--pop-teal); }
[data-skin="pop"] .mc-chip { background: var(--pop-paper); border: 2px solid var(--pop-ink); color: var(--pop-ink); }
[data-skin="pop"] .mc-chip.active { background: var(--pop-red); color: var(--pop-paper); }
[data-skin="pop"] .mc-field input:not([type="checkbox"]):not([type="radio"]), [data-skin="pop"] .mc-field select, [data-skin="pop"] .mc-toolbar input[type=text], [data-skin="pop"] .mc-news-search { background: #fffdf5; border: 2px solid var(--pop-ink); }
[data-skin="pop"] .mc-field input:focus, [data-skin="pop"] .mc-field select:focus { border-color: var(--pop-ink); box-shadow: 0 0 0 3px rgba(47,91,255,.3); }
[data-skin="pop"] .mc-v5-feature { background-color: var(--pop-teal); background-image: radial-gradient(rgba(255,243,220,.16) 1px, transparent 1.1px); background-size: 12px 12px; border: 3px solid var(--pop-ink); box-shadow: 6px 6px 0 var(--pop-ink); color: var(--pop-paper); }
[data-skin="pop"] .mc-v5-feature h3 { color: var(--pop-paper); }
[data-skin="pop"] .mc-v5-feature p { color: rgba(255,243,220,.86); }
[data-skin="pop"] .mc-v5-feature-meta { color: rgba(255,243,220,.7); }
[data-skin="pop"] .mc-v5-feature-side { border-left-color: rgba(255,243,220,.25); }
[data-skin="pop"] .mc-v5-feature-side b { color: var(--pop-yellow); }
[data-skin="pop"] .mc-v5-feature-side span { color: rgba(255,243,220,.7); }
[data-skin="pop"] .mc-v5-feature-open { color: var(--pop-yellow) !important; }
[data-skin="pop"] .mc-v5-feature-shuffle { color: var(--pop-yellow); border-color: rgba(255,243,220,.4); }
[data-skin="pop"] .mc-tag { border: 1.5px solid var(--pop-ink); }
[data-skin="pop"] .mc-switch input:checked { background: var(--pop-red); }
[data-skin="pop"] .mc-pagenav { background: var(--pop-paper); border: 2px solid var(--pop-ink); }
[data-skin="pop"] .mc-pagebtn { color: var(--pop-ink); }
[data-skin="pop"] .mc-pagebtn.on { background: var(--pop-red); color: var(--pop-paper); box-shadow: 3px 3px 0 var(--pop-ink); }
[data-skin="pop"] .mc-cfg-sec, [data-skin="pop"] .mc-env, [data-skin="pop"] .mc-env-fold, [data-skin="pop"] .mc-fold, [data-skin="pop"] .mc-cfg-actions { background: #fff9ef; border: 2px solid var(--pop-ink); border-radius: 4px; box-shadow: 5px 5px 0 var(--pop-ink); }
[data-skin="pop"] .mc-cfg-sec-ico { background: var(--pop-yellow); border: 2px solid var(--pop-ink); box-shadow: 2px 2px 0 var(--pop-ink); }
[data-skin="pop"] .mc-panehead-ico { background: var(--pop-teal); border: 2px solid var(--pop-ink); color: var(--pop-paper); box-shadow: 3px 3px 0 var(--pop-ink); }
[data-skin="pop"] .mc-news-hero { background: var(--pop-paper); border: 2px solid var(--pop-ink); box-shadow: 5px 5px 0 var(--pop-ink); }
[data-skin="pop"] .mc-news-hero-go { background: var(--pop-teal) !important; color: var(--pop-paper) !important; border: 2px solid var(--pop-ink); box-shadow: 3px 3px 0 var(--pop-red); }
[data-skin="pop"] .mc-v5-graph-legend { background: var(--pop-paper); border: 2px solid var(--pop-ink); box-shadow: 4px 4px 0 var(--pop-ink); }
[data-skin="pop"] .me-graph-search input { background: var(--pop-paper); }
[data-skin="pop"] .mc-theme-card { background: var(--pop-paper); border: 2px solid var(--pop-ink); }
[data-skin="pop"] .mc-theme-card.on { background: #ffe1ea; box-shadow: 3px 3px 0 var(--pop-teal); }
/* ===== 波普 v3：去掉冷蓝，黄扶手 + 青绿主视觉 + 更高纸面亮度 ===== */
.memory-eternal-root[data-skin="pop"], .mc-admin[data-skin="pop"] {
  --pop-paper: #fff7e6;
  --pop-paper2: #ffedc9;
  --dsw-alias-bg-base: #fff7e6;
  --dsw-alias-bg-layer-1: #fffcf4;
  --dsw-alias-bg-layer-2: #ffedc9;
  --dsw-alias-label-primary: #1a140b;
  --dsw-alias-label-secondary: #5a4a33;
}
[data-skin="pop"] .mc-main { background-color: #fff7e6; color: #1a140b; }
[data-skin="pop"] .mc-card { background: #fffcf4; }
[data-skin="pop"] .mc-rail { background: var(--pop-yellow); border-right: 3px solid var(--pop-ink); }
[data-skin="pop"] .mc-v5-railbrand b { color: var(--pop-ink); }
[data-skin="pop"] .mc-v5-railbrand span, [data-skin="pop"] .mc-rail-sec { color: #7a6320; }
[data-skin="pop"] .mc-railbtn { color: var(--pop-ink); }
[data-skin="pop"] .mc-railbtn:hover { background: #fff7e6; color: var(--pop-ink); border: 2px solid var(--pop-ink); box-shadow: 3px 3px 0 var(--pop-ink); }
[data-skin="pop"] .mc-railbtn.active { background: var(--pop-red); color: var(--pop-paper); border: 2px solid var(--pop-ink); box-shadow: 3px 3px 0 var(--pop-ink); }
[data-skin="pop"] .mc-v5-pagehead-stats b { background: #ffe07a; color: #1a140b; }
[data-skin="pop"] .mc-v5-pagehead p { color: #1a140b; opacity: .82; }
[data-skin="pop"] .mc-v5-feature { background-color: var(--pop-teal); background-image: radial-gradient(rgba(255,248,232,.22) 1px, transparent 1.1px); }
[data-skin="pop"] .mc-v5-feature h3, [data-skin="pop"] .mc-v5-feature p { color: #fff8e8; }
[data-skin="pop"] .mc-v5-feature-meta, [data-skin="pop"] .mc-v5-feature-side span { color: #ffe9c2; }
[data-skin="pop"] .mc-v5-feature-side b { color: #ffe07a; }
[data-skin="pop"] .mc-v5-card-title { color: #1a140b; }
[data-skin="pop"] .mc-v5-card-lead { color: #3a3226; }
[data-skin="pop"] .mc-v5-card-kind-name, [data-skin="pop"] .mc-v5-card-time, [data-skin="pop"] .mc-v5-card-foot { color: #6b5f4e; }
[data-skin="pop"] .mc-v5-insight-k { background: #ffe07a; color: #1a140b; }
[data-skin="pop"] .mc-v5-conn { color: #0f766e; }
[data-skin="pop"] .mc-v5-conn b { color: var(--pop-red); }
[data-skin="pop"] .mc-tag:nth-child(3n+2) { background: #a8e6cf !important; }
[data-skin="pop"] .mc-tag:nth-child(3n) { background: #ffc2a1 !important; }
[data-skin="pop"] .mc-v5-eyebrow { background: var(--pop-teal); color: #fff8e8 !important; }
[data-skin="pop"] .mc-panehead-ico { background: var(--pop-teal); }
[data-skin="pop"] .mc-news-hero-go { background: var(--pop-teal) !important; color: #fff8e8 !important; box-shadow: 3px 3px 0 var(--pop-red); }
[data-skin="pop"] .mc-theme-card.on { background: #fff1dc; box-shadow: 3px 3px 0 var(--pop-teal); }
[data-skin="pop"] .mc-rail, [data-skin="pop"] .mc-v5-feature, [data-skin="pop"] .mc-v5-pagehead h1 { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
/* —— 知识卡片区：区块标题 + 卡面品类强调条 + 标题字号 —— */
.mc-v5-card { position: relative; }
.mc-v5-card::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--card-accent, #ff7a45); border-radius: 12px 12px 0 0; pointer-events: none; }
.mc-cards-head { display: flex; align-items: center; gap: 8px; margin: 8px 2px 10px; }
.mc-cards-head-ico { font-size: 14px; opacity: .75; }
.mc-cards-head h2 { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
.mc-cards-head-count { padding: 1px 8px; border-radius: 999px; background: rgba(127,127,127,.14); font-size: 10.5px; font-weight: 600; }
.mc-cards-head-hint { margin-left: auto; font-size: 10.5px; opacity: .5; }
.mc-v5-card-title { font-size: 15px; font-weight: 650; }
.mc-cardrow:hover .mc-v5-card-title { color: var(--dsw-alias-brand-primary, #ff7a45); }
.mc-v5-feature h3 { font-size: 22px; }
@media (max-width: 720px) { .mc-v5-feature h3 { font-size: 18px; } .mc-cards-head h2 { font-size: 14px; } }
[data-skin="pop"] .mc-cards-head { border-bottom: 2px solid var(--pop-ink); padding-bottom: 8px; }
[data-skin="pop"] .mc-cards-head h2 { font-family: 'Arial Black', 'Arial Bold', 'Noto Sans SC', sans-serif; font-size: 16px; font-weight: 900; }
[data-skin="pop"] .mc-cards-head-count { background: var(--pop-yellow); border: 2px solid var(--pop-ink); color: var(--pop-ink); box-shadow: 2px 2px 0 var(--pop-ink); }
[data-skin="pop"] .mc-cards-head-hint { color: #6b5f4e; opacity: 1; }
[data-skin="pop"] .mc-v5-card::before { height: 4px; border-radius: 2px 2px 0 0; }
[data-skin="pop"] .mc-v5-card-title { font-size: 16px; font-weight: 800; letter-spacing: -.01em; }
[data-skin="pop"] .mc-cardrow:hover .mc-v5-card-title { color: var(--pop-red); }
[data-skin="light"] .mc-cards-head h2 { font-family: 'Noto Serif SC', 'Songti SC', 'STSong', serif; font-size: 18px; font-weight: 700; }
[data-skin="light"] .mc-cards-head-count { background: #f1ece2; color: #6b5f4e; }
[data-skin="light"] .mc-cards-head-hint { color: #8a7f70; opacity: 1; }
[data-skin="light"] .mc-v5-card-title { font-family: 'Noto Serif SC', 'Songti SC', 'STSong', serif; font-size: 15.5px; }
[data-skin="light"] .mc-v5-card::before { height: 3px; border-radius: 11px 11px 0 0; }
/* ===== 全面波普：弹层 / 终端 / 图谱 / 横幅 / 表单 ===== */
[data-skin="pop"] .me-graph-canvas { background: #fff7e6; border: 2px solid var(--pop-ink); box-shadow: 5px 5px 0 var(--pop-ink); }
[data-skin="pop"] .me-graph-tip { color: #5a4a33; }
[data-skin="pop"] .me-graph-search input { background: #fffcf4; border: 2px solid var(--pop-ink); color: var(--pop-ink); }
[data-skin="pop"] .me-graph-crumbs { background: #fff7e6; border: 2px solid var(--pop-ink); box-shadow: 3px 3px 0 var(--pop-ink); }
[data-skin="pop"] .me-graph-crumbs button { color: var(--pop-ink); }
[data-skin="pop"] .me-graph-crumbs button:hover, [data-skin="pop"] .me-graph-crumbs button.current { background: #ffe07a; color: var(--pop-ink); box-shadow: none; }
[data-skin="pop"] .me-graph-crumbs .sep, [data-skin="pop"] .me-graph-crumbs .home { color: #6b5f4e; }
[data-skin="pop"] .me-graph-ctxmenu { background: #fff7e6; border: 2px solid var(--pop-ink); box-shadow: 4px 4px 0 var(--pop-ink); color: var(--pop-ink); }
[data-skin="pop"] .me-graph-ctxmenu button:hover { background: #ffe07a; }
[data-skin="pop"] .me-graph-levelbusy, [data-skin="pop"] .me-graph-levelerr { background: #fff7e6; color: var(--pop-ink); border: 2px solid var(--pop-ink); }
[data-skin="pop"] .me-graph-levelerr button { background: var(--pop-yellow); color: var(--pop-ink); border-color: var(--pop-ink); }
[data-skin="pop"] .me-dialog, [data-skin="pop"] .me-modal { background: #fffcf4; color: var(--pop-ink); border: 2px solid var(--pop-ink); box-shadow: 6px 6px 0 var(--pop-ink); }
[data-skin="pop"] .me-dialog-head, [data-skin="pop"] .me-modal-head { background: #ffefc9; border-bottom: 2px solid var(--pop-ink); }
[data-skin="pop"] .me-dialog-body h3, [data-skin="pop"] .me-dialog-body h4, [data-skin="pop"] .me-modal-title h2 { color: var(--pop-ink); }
[data-skin="pop"] .me-support-tabs { border-bottom-color: var(--pop-ink); }
[data-skin="pop"] .me-support-tab.active { border-bottom-color: var(--pop-red); }
[data-skin="pop"] .me-support-qr img { border: 2px solid var(--pop-ink); }
[data-skin="pop"] .me-guide-github-hint { color: #6b5f4e; }
[data-skin="pop"] .me-guide-dot { background: #e8dcc5; }
[data-skin="pop"] .me-guide-dot.on { background: var(--pop-red); }
[data-skin="pop"] .me-modal-close { border: 2px solid var(--pop-ink); background: var(--pop-yellow); color: var(--pop-ink); }
[data-skin="pop"] .md-doc, [data-skin="pop"] .md-doc h1, [data-skin="pop"] .md-doc h2, [data-skin="pop"] .md-doc h3 { color: var(--pop-ink); }
[data-skin="pop"] .mc-starask { background: #ffe07a !important; border: 2px solid var(--pop-ink) !important; box-shadow: 3px 3px 0 var(--pop-ink); color: var(--pop-ink) !important; }
[data-skin="pop"] .mc-starask span { color: var(--pop-ink) !important; }
[data-skin="pop"] .mc-work-textarea { background: #fffcf4 !important; border: 2px solid var(--pop-ink) !important; color: var(--pop-ink) !important; }
[data-skin="pop"] .mc-term-guide { color: var(--pop-ink) !important; }
[data-skin="pop"] .mc-term-guide > p { color: #3a3226 !important; }
[data-skin="pop"] .mc-term-card { background: #fffcf4 !important; border: 2px solid var(--pop-ink) !important; border-radius: 6px !important; box-shadow: 5px 5px 0 var(--pop-ink); color: var(--pop-ink) !important; }
[data-skin="pop"] .mc-term-card div { color: #3a3226 !important; }
[data-skin="pop"] .mc-term-code { background: #fff7e6 !important; border: 2px solid var(--pop-ink) !important; color: var(--pop-ink) !important; }
[data-skin="pop"] .mc-term-btn { background: var(--pop-yellow) !important; border: 2px solid var(--pop-ink) !important; color: var(--pop-ink) !important; box-shadow: 2px 2px 0 var(--pop-ink); border-radius: 4px; }
[data-skin="pop"] .mc-new { background: var(--pop-yellow); color: var(--pop-ink); border: 1.5px solid var(--pop-ink); }
[data-skin="pop"] .mc-v5-card-status.pending, [data-skin="pop"] .me-audit-row-state { background: #ffe07a; color: var(--pop-ink); }
[data-skin="pop"] .mc-v5-core, [data-skin="pop"] .mc-v5-pin { color: var(--pop-ink); }
[data-skin="pop"] .mc-v5-core.on { background: #ffe07a; border-color: var(--pop-ink); color: var(--pop-ink); }
[data-skin="pop"] .mc-v5-audit-trust { border-color: var(--pop-ink); background: #ffe07a; color: var(--pop-ink); }
[data-skin="pop"] .me-audit-kinds { border: 2px solid var(--pop-ink); background: #fffcf4; }
[data-skin="pop"] .me-audit-kind.active { background: #ffe07a; border-color: var(--pop-ink); color: var(--pop-ink); }
[data-skin="pop"] .me-audit-preview { box-shadow: 5px 5px 0 var(--pop-ink); }
[data-skin="pop"] .me-audit-preview-actions { border-top-color: rgba(23,19,11,.2); }
[data-skin="pop"] .mc-news-reader { border: 2px solid var(--pop-ink); box-shadow: 5px 5px 0 var(--pop-ink); }
[data-skin="pop"] .mc-news-follow-draft, [data-skin="pop"] .mc-news-follow-sec { background: #fffcf4; border: 2px solid var(--pop-ink); }
[data-skin="pop"] .mc-news-pill { border: 2px solid var(--pop-ink); background: #fffcf4; }
[data-skin="pop"] .mc-news-tile-follow { background: #ffe07a; color: var(--pop-ink); }
[data-skin="pop"] .mc-news-hero-search { border: 2px solid var(--pop-ink); background: #fffcf4; }
[data-skin="pop"] .mc-news-hero-hint { color: #5a4a33 !important; }
[data-skin="light"] .me-graph-canvas { background: #fffdf9; border-color: #e4e0d8; }
[data-skin="light"] .me-graph-search input { background: #fffdf9; border-color: #e4e0d8; color: #26221c; }
[data-skin="light"] .me-graph-crumbs { background: #fffdf9; border-color: #e4e0d8; }
[data-skin="light"] .me-graph-crumbs button { color: #26221c; }
[data-skin="light"] .me-dialog, [data-skin="light"] .me-modal { background: #fffdf9; color: #26221c; }
[data-skin="light"] .me-dialog-head, [data-skin="light"] .me-modal-head { background: #fff; border-bottom-color: #e4e0d8; }
[data-skin="light"] .mc-term-guide { color: #26221c !important; }
[data-skin="light"] .mc-term-card { background: #fff !important; border-color: #e4e0d8 !important; color: #26221c !important; }
[data-skin="light"] .mc-term-code { background: #fbf4ea !important; border-color: #e4e0d8 !important; color: #26221c !important; }
[data-skin="light"] .mc-term-btn { background: #fff !important; border-color: #d6d0c4 !important; color: #26221c !important; }
[data-skin="light"] .mc-starask { background: #fff4ee !important; border-color: #ffd3bd !important; color: #26221c !important; }
[data-skin="light"] .mc-starask span { color: #26221c !important; }
[data-skin="light"] .mc-work-textarea { background: #fff !important; border-color: #d6d0c4 !important; color: #26221c !important; }
/* 波普：图谱工具条 / 统计卡 / 回收列表 / 终端文字 */
[data-skin="pop"] .mc-v5-pagecount { color: var(--pop-paper) !important; }
[data-skin="pop"] .me-gtool { background: #fffcf4; border: 2px solid var(--pop-ink); color: var(--pop-ink); border-radius: 4px; box-shadow: 2px 2px 0 var(--pop-ink); }
[data-skin="pop"] .me-gtool:hover, [data-skin="pop"] .me-gtool.on { background: #ffe07a; color: var(--pop-ink); border-color: var(--pop-ink); }
[data-skin="pop"] .me-gswitch { background: #fffcf4; border: 2px solid var(--pop-ink); color: var(--pop-ink); border-radius: 4px; }
[data-skin="pop"] .me-gswitch.on { background: #ffe07a; color: var(--pop-ink); border-color: var(--pop-ink); }
[data-skin="pop"] .me-gswitch .track { background: #e8dcc5; }
[data-skin="pop"] .me-gswitch.on .track { background: var(--pop-red); }
[data-skin="pop"] .me-gswitch.on .track::after { background: #fff7e6; }
[data-skin="pop"] .me-graph-count { color: #5a4a33; opacity: 1; }
[data-skin="pop"] .me-graph-search .ico { color: var(--pop-ink); }
[data-skin="pop"] .me-graph-legend-pop { background: #fff7e6 !important; border: 2px solid var(--pop-ink) !important; color: var(--pop-ink) !important; box-shadow: 4px 4px 0 var(--pop-ink) !important; }
[data-skin="pop"] .me-graph-legend-pop .lg { color: var(--pop-ink); }
[data-skin="pop"] .me-graph-legend-pop .lg:hover, [data-skin="pop"] .me-graph-legend-pop .lg.active { background: #ffe07a; color: var(--pop-ink); }
[data-skin="pop"] .me-graph-legend-pop .lg.lg-clear { color: var(--pop-red); }
[data-skin="pop"] .mc-v5-statuscard { background: #fffcf4; border: 2px solid var(--pop-ink); border-radius: 6px; box-shadow: 4px 4px 0 var(--pop-ink); }
[data-skin="pop"] .mc-v5-statuscard b { color: var(--pop-ink); }
[data-skin="pop"] .mc-v5-statuscard > span:not(.mc-v5-status-ico), [data-skin="pop"] .mc-v5-statuscard small { color: #6b5f4e; }
[data-skin="pop"] .mc-stat b { color: var(--pop-ink); }
[data-skin="pop"] .mc-stat span { color: #6b5f4e; }
[data-skin="pop"] .mc-v5-recycle-hint { color: #6b5f4e; }
[data-skin="pop"] .mc-v5-recycle-copy b { color: var(--pop-ink); }
[data-skin="pop"] .mc-v5-recycle-copy span { color: #6b5f4e; }
[data-skin="pop"] .mc-v5-recycle-row:hover { background: #fff1dc; }
[data-skin="pop"] .mc-term-guide > p { color: #3a3226 !important; }
[data-skin="pop"] .mc-term-guide > div:last-child { color: #3a3226 !important; }
[data-skin="pop"] .md-doc h2, [data-skin="pop"] .md-doc h3, [data-skin="pop"] .md-doc h4 { color: var(--pop-ink) !important; }
[data-skin="light"] .mc-v5-statuscard { background: #fffdf9; border-color: #e4e0d8; }
[data-skin="light"] .mc-v5-statuscard b, [data-skin="light"] .mc-v5-recycle-copy b { color: #26221c; }
[data-skin="light"] .mc-v5-statuscard > span:not(.mc-v5-status-ico), [data-skin="light"] .mc-v5-statuscard small, [data-skin="light"] .mc-v5-recycle-copy span, [data-skin="light"] .mc-v5-recycle-hint { color: #6b5f4e; }
[data-skin="light"] .me-gtool, [data-skin="light"] .me-gswitch { background: #fffdf9; border-color: #e4e0d8; color: #26221c; }
/* ================= 生化危机：Umbrella 实验档案 ================= */
.memory-eternal-root[data-skin="resident"], .mc-admin[data-skin="resident"] {
  --re-bg: #070b08;
  --re-panel: #0c130e;
  --re-panel2: #101a12;
  --re-line: #244a2c;
  --re-green: #7cff3f;
  --re-red: #e23a3a;
  --re-amber: #f0b429;
  --re-ink: #c9e8c9;
  --re-dim: #7fa383;
  --dsw-alias-bg-base: #070b08;
  --dsw-alias-bg-layer-1: #0c130e;
  --dsw-alias-bg-layer-2: #101a12;
  --dsw-alias-border-l1: #244a2c;
  --dsw-alias-border-l2: #2f5f37;
  --dsw-alias-label-primary: #c9e8c9;
  --dsw-alias-label-secondary: #7fa383;
  --dsw-alias-accent: #7cff3f;
  --dsw-alias-brand-primary: #7cff3f;
}
.memory-eternal-root[data-skin="resident"] { background: #070b08; color: #c9e8c9; }
.mc-admin[data-skin="resident"] { background: #070b08; color: #c9e8c9; }
[data-skin="resident"] .mc-main {
  background-color: #070b08;
  background-image:
    repeating-linear-gradient(180deg, rgba(124,255,63,.035) 0 1px, transparent 1px 4px),
    radial-gradient(120% 80% at 50% 0%, rgba(124,255,63,.07), transparent 60%);
  color: #c9e8c9;
}
[data-skin="resident"] .mc-rail { background: #0a110c; border-right: 1px solid #1f3a25; }
[data-skin="resident"] .mc-v5-railbrand b, [data-skin="resident"] .mc-railbtn { color: #c9e8c9; }
[data-skin="resident"] .mc-v5-railbrand span, [data-skin="resident"] .mc-rail-sec { color: #6f9276; }
[data-skin="resident"] .mc-railbtn { border-radius: 3px; }
[data-skin="resident"] .mc-railbtn:hover { background: rgba(124,255,63,.08); color: #d6ffd9; border: 1px solid #2f5f37; }
[data-skin="resident"] .mc-railbtn.active { background: #7cff3f; color: #041006; border: 1px solid #7cff3f; box-shadow: 0 0 16px rgba(124,255,63,.35); }
[data-skin="resident"] .mc-dot { background: var(--re-red); color: #fff; }
[data-skin="resident"] .mc-v5-top { position: relative; background: #050806; border-bottom: 1px solid #1f3a25; }
[data-skin="resident"] .mc-v5-top::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: repeating-linear-gradient(90deg, #e23a3a 0 14px, #070b08 14px 20px, #7cff3f 20px 34px, #070b08 34px 40px); opacity: .85; }
[data-skin="resident"] .mc-v5-crumb, [data-skin="resident"] .mc-v5-crumb b { color: #a9c7ad; }
[data-skin="resident"] .mc-v5-sys, [data-skin="resident"] .mc-v5-ver, [data-skin="resident"] .mc-v5-star { background: #0a110c; border: 1px solid #244a2c; color: #9fe8a8; border-radius: 3px; }
[data-skin="resident"] .mc-v5-pagehead h1 { margin: 2px 0 0; padding-left: 12px; border-left: 4px solid var(--re-red); color: #d6ffd9; font-family: Consolas, 'Microsoft YaHei', 'Courier New', monospace; font-weight: 700; letter-spacing: .08em; text-shadow: 0 0 16px rgba(124,255,63,.3); }
[data-skin="resident"] .mc-v5-eyebrow { display: inline-block; padding: 2px 8px; border: 1px solid #2f5f37; color: #7cff3f; background: rgba(124,255,63,.06); font-family: Consolas, monospace; letter-spacing: .22em; }
[data-skin="resident"] .mc-v5-eyebrow::before { content: '☣ '; color: var(--re-red); }
[data-skin="resident"] .mc-v5-pagehead p { color: #8fb394; }
[data-skin="resident"] .mc-v5-pagecount { padding: 1px 9px; background: var(--re-red); color: #fff; border: 1px solid #ff6b6b; border-radius: 3px; box-shadow: 0 0 12px rgba(226,58,58,.35); }
[data-skin="resident"] .mc-v5-pagehead-stats b { color: #7cff3f; }
[data-skin="resident"] .mc-card { background: #0c130e; border: 1px solid #244a2c; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(124,255,63,.04), 0 0 18px rgba(0,0,0,.35); }
[data-skin="resident"] .mc-cardrow { transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
[data-skin="resident"] .mc-cardrow:hover { border-color: #4d9a56; box-shadow: 0 0 22px rgba(124,255,63,.12), inset 0 0 0 1px rgba(124,255,63,.08); transform: translateY(-1px); }
[data-skin="resident"] .mc-v5-card-title { color: #d6ffd9; font-family: Consolas, 'Courier New', monospace; font-weight: 700; letter-spacing: .01em; }
[data-skin="resident"] .mc-v5-card-lead { color: #a9c7ad; }
[data-skin="resident"] .mc-v5-card-kind-name, [data-skin="resident"] .mc-v5-card-time, [data-skin="resident"] .mc-v5-card-foot { color: #6f9276; }
[data-skin="resident"] .mc-v5-insight-k { background: rgba(124,255,63,.1); border: 1px solid #2f5f37; color: #7cff3f; }
[data-skin="resident"] .mc-v5-conn { color: #9fe8a8; }
[data-skin="resident"] .mc-v5-conn b { color: var(--re-red); }
[data-skin="resident"] .mc-btn { background: #0e1a10; border: 1px solid #2c5a35; border-radius: 3px; color: #b7ffc4; box-shadow: none; }
[data-skin="resident"] .mc-btn:hover { background: rgba(124,255,63,.08); border-color: #7cff3f; color: #d6ffd9; }
[data-skin="resident"] .mc-btn.me-on { background: var(--re-red) !important; border-color: #ff6b6b !important; color: #fff !important; box-shadow: 0 0 16px rgba(226,58,58,.35); }
[data-skin="resident"] .mc-chip { background: #0a110c; border: 1px solid #244a2c; color: #a9c7ad; border-radius: 3px; }
[data-skin="resident"] .mc-chip.active { background: #7cff3f; border-color: #7cff3f; color: #041006; }
[data-skin="resident"] .mc-toolbar input[type=text], [data-skin="resident"] .mc-field input:not([type="checkbox"]):not([type="radio"]), [data-skin="resident"] .mc-field select, [data-skin="resident"] .mc-news-search { background: #060a07; border: 1px solid #244a2c; color: #c9e8c9; }
[data-skin="resident"] .mc-field input:focus, [data-skin="resident"] .mc-field select:focus { border-color: #7cff3f; box-shadow: 0 0 0 3px rgba(124,255,63,.12); }
[data-skin="resident"] .mc-v5-feature { position: relative; overflow: hidden; flex: none; background: linear-gradient(135deg, #0c1a0f, #07110a); border: 1px solid #2b5a33; box-shadow: inset 0 0 50px rgba(124,255,63,.05); color: #c9e8c9; }
[data-skin="resident"] .mc-v5-feature::after { content: '☣'; position: absolute; right: 18px; bottom: -26px; font-size: 112px; line-height: 1; color: rgba(124,255,63,.06); pointer-events: none; }
[data-skin="resident"] .mc-v5-feature h3 { color: #d6ffd9; font-family: Consolas, 'Microsoft YaHei', monospace; letter-spacing: .04em; }
[data-skin="resident"] .mc-v5-feature p { color: #a9c7ad; }
[data-skin="resident"] .mc-v5-feature-meta, [data-skin="resident"] .mc-v5-feature-side span { color: #7fa383; }
[data-skin="resident"] .mc-v5-feature-side { border-left-color: #244a2c; }
[data-skin="resident"] .mc-v5-feature-side b { color: var(--re-red); text-shadow: 0 0 12px rgba(226,58,58,.4); }
[data-skin="resident"] .mc-v5-feature-open { color: #7cff3f !important; }
[data-skin="resident"] .mc-tag { background: #0a110c !important; border: 1px solid #2f5f37; color: #9fe8a8 !important; border-radius: 3px; }
[data-skin="resident"] .mc-tag:nth-child(3n+2) { border-color: #7a2a2a; color: #ff9a9a !important; }
[data-skin="resident"] .mc-new { background: var(--re-red); color: #fff; border: 1px solid #ff6b6b; }
[data-skin="resident"] .mc-switch input { border: 1px solid #2f5f37; background: #0a110c; }
[data-skin="resident"] .mc-switch input:checked { background: #7cff3f; }
[data-skin="resident"] .mc-switch input::after { background: #7fa383; }
[data-skin="resident"] .mc-switch input:checked::after { background: #041006; }
[data-skin="resident"] .mc-cards-head { border-bottom: 1px solid #244a2c; padding-bottom: 8px; }
[data-skin="resident"] .mc-cards-head h2 { color: #d6ffd9; font-family: Consolas, monospace; letter-spacing: .08em; }
[data-skin="resident"] .mc-cards-head-count { background: rgba(124,255,63,.1); border: 1px solid #2f5f37; color: #7cff3f; }
[data-skin="resident"] .mc-cards-head-hint { color: #6f9276; opacity: 1; }
[data-skin="resident"] .mc-pagenav { background: #0a110c; border: 1px solid #244a2c; }
[data-skin="resident"] .mc-pagebtn { color: #a9c7ad; }
[data-skin="resident"] .mc-pagebtn.on { background: #7cff3f; color: #041006; box-shadow: 0 0 16px rgba(124,255,63,.25); }
[data-skin="resident"] .mc-panenhead-ico, [data-skin="resident"] .mc-panehead-ico { background: #7cff3f; border: 1px solid #7cff3f; color: #041006; }
[data-skin="resident"] .mc-cfg-sec, [data-skin="resident"] .mc-env, [data-skin="resident"] .mc-env-fold, [data-skin="resident"] .mc-fold, [data-skin="resident"] .mc-cfg-actions { background: #0c130e; border: 1px solid #244a2c; box-shadow: none; }
[data-skin="resident"] .mc-cfg-sec-ico { background: rgba(124,255,63,.1); border: 1px solid #2f5f37; }
[data-skin="resident"] .mc-quote { background: #0a110c; border: 1px solid #244a2c; color: #a9c7ad; }
[data-skin="resident"] .mc-quote-tag { color: #7cff3f; }
[data-skin="resident"] .mc-quote-src { color: #6f9276; }
[data-skin="resident"] .me-graph-canvas { background: #050806; border: 1px solid #244a2c; box-shadow: inset 0 0 60px rgba(124,255,63,.04); }
[data-skin="resident"] .me-graph-tip { color: #6f9276; }
[data-skin="resident"] .me-graph-search input { background: #060a07; border: 1px solid #244a2c; color: #c9e8c9; }
[data-skin="resident"] .me-gtool, [data-skin="resident"] .me-gswitch { background: #0a110c; border: 1px solid #244a2c; color: #a9c7ad; border-radius: 3px; }
[data-skin="resident"] .me-gtool:hover, [data-skin="resident"] .me-gtool.on { background: rgba(124,255,63,.08); border-color: #7cff3f; color: #d6ffd9; }
[data-skin="resident"] .me-gswitch.on { border-color: #7cff3f; color: #7cff3f; }
[data-skin="resident"] .me-gswitch .track { background: #1f3a25; }
[data-skin="resident"] .me-gswitch.on .track { background: #7cff3f; }
[data-skin="resident"] .me-gswitch.on .track::after { background: #041006; }
[data-skin="resident"] .me-graph-crumbs { background: rgba(5,8,6,.9); border: 1px solid #244a2c; }
[data-skin="resident"] .me-graph-crumbs button { color: #9fe8a8; }
[data-skin="resident"] .me-graph-crumbs button.current { background: rgba(124,255,63,.12); color: #7cff3f; box-shadow: none; }
[data-skin="resident"] .me-graph-legend-pop { background: #0a110c !important; border: 1px solid #244a2c !important; color: #c9e8c9 !important; box-shadow: 0 16px 40px rgba(0,0,0,.5) !important; }
[data-skin="resident"] .me-graph-legend-pop .lg { color: #a9c7ad; }
[data-skin="resident"] .me-graph-legend-pop .lg.active { background: rgba(124,255,63,.1); color: #7cff3f; box-shadow: none; }
[data-skin="resident"] .me-graph-ctxmenu { background: #0a110c; border: 1px solid #244a2c; color: #c9e8c9; }
[data-skin="resident"] .me-graph-ctxmenu button:hover { background: rgba(124,255,63,.1); }
[data-skin="resident"] .mc-v5-graph-legend { background: rgba(5,8,6,.86); border: 1px solid #244a2c; box-shadow: 0 12px 30px rgba(0,0,0,.4); }
[data-skin="resident"] .mc-v5-graph-legend-title, [data-skin="resident"] .mc-v5-graph-legend-row { color: #6f9276; }
[data-skin="resident"] .mc-v5-graph-legend-row b { color: #d6ffd9; }
[data-skin="resident"] .me-dialog, [data-skin="resident"] .me-modal { background: #0a110c; color: #c9e8c9; border: 1px solid #244a2c; box-shadow: 0 0 40px rgba(124,255,63,.06); }
[data-skin="resident"] .me-dialog-head, [data-skin="resident"] .me-modal-head { background: #0c1a10; border-bottom: 1px solid #7a2a2a; }
[data-skin="resident"] .me-modal-title h2, [data-skin="resident"] .me-dialog-body h2, [data-skin="resident"] .me-dialog-body h3, [data-skin="resident"] .me-dialog-body h4 { color: #d6ffd9; }
[data-skin="resident"] .md-doc, [data-skin="resident"] .md-doc h1, [data-skin="resident"] .md-doc h2, [data-skin="resident"] .md-doc h3 { color: #c9e8c9; }
[data-skin="resident"] .me-support-tabs { border-bottom-color: #244a2c; }
[data-skin="resident"] .me-support-tab.active { border-bottom-color: #7cff3f; }
[data-skin="resident"] .mc-starask { background: #0c130e !important; border: 1px solid #7a2a2a !important; color: #c9e8c9 !important; }
[data-skin="resident"] .mc-starask span { color: #c9e8c9 !important; }
[data-skin="resident"] .mc-work-textarea { background: #060a07 !important; border: 1px solid #244a2c !important; color: #c9e8c9 !important; }
[data-skin="resident"] .mc-term-card { background: #0c130e !important; border: 1px solid #244a2c !important; color: #c9e8c9 !important; }
[data-skin="resident"] .mc-term-card div { color: #a9c7ad !important; }
[data-skin="resident"] .mc-term-code { background: #050806 !important; border: 1px solid #244a2c !important; color: #9fe8a8 !important; }
[data-skin="resident"] .mc-term-btn { background: #0e1a10 !important; border: 1px solid #2c5a35 !important; color: #b7ffc4 !important; border-radius: 3px; }
[data-skin="resident"] .mc-v5-statuscard { background: #0c130e; border: 1px solid #244a2c; border-radius: 4px; box-shadow: none; }
[data-skin="resident"] .mc-v5-statuscard b { color: #d6ffd9; }
[data-skin="resident"] .mc-v5-statuscard > span:not(.mc-v5-status-ico), [data-skin="resident"] .mc-v5-statuscard small { color: #7fa383; }
[data-skin="resident"] .mc-stat b { color: #d6ffd9; }
[data-skin="resident"] .mc-stat span { color: #7fa383; }
[data-skin="resident"] .mc-v5-recycle-copy b { color: #d6ffd9; }
[data-skin="resident"] .mc-v5-recycle-copy span, [data-skin="resident"] .mc-v5-recycle-hint { color: #7fa383; }
[data-skin="resident"] .mc-v5-recycle-row:hover { background: rgba(124,255,63,.04); }
[data-skin="resident"] .mc-news-hero { background: #0c130e !important; border: 1px solid #244a2c; }
[data-skin="resident"] .mc-news-hero-go { background: #7cff3f !important; color: #041006 !important; border: 1px solid #7cff3f; }
[data-skin="resident"] .mc-news-reader, [data-skin="resident"] .mc-news-follow-draft, [data-skin="resident"] .mc-news-follow-sec { background: #0c130e; border: 1px solid #244a2c; }
[data-skin="resident"] .mc-v5-audit-trust { border-color: #244a2c; color: #9fe8a8; background: rgba(124,255,63,.06); }
[data-skin="resident"] .me-audit-kind.active { background: rgba(124,255,63,.12); border-color: #7cff3f; color: #7cff3f; }
[data-skin="resident"] .me-audit-row-state, [data-skin="resident"] .mc-v5-card-status.pending { background: rgba(240,180,41,.12); color: #f0b429; }
[data-skin="resident"] .mc-v5-card-status.rejected { background: rgba(226,58,58,.12); color: #ff8a8a; }
[data-skin="resident"] .mc-v5-pagehead-stats span { color: #8fb394; }

/* ================= 蜘蛛侠：红蓝蛛网漫画 ================= */
.memory-eternal-root[data-skin="spider"], .mc-admin[data-skin="spider"] {
  --sp-bg: #f4f1e8;
  --sp-panel: #fffdf7;
  --sp-red: #e62429;
  --sp-blue: #1b3b8b;
  --sp-ink: #0b0b0f;
  --sp-yellow: #ffd34e;
  --dsw-alias-bg-base: #f4f1e8;
  --dsw-alias-bg-layer-1: #fffdf7;
  --dsw-alias-bg-layer-2: #ece6d7;
  --dsw-alias-border-l1: #0b0b0f;
  --dsw-alias-border-l2: #0b0b0f;
  --dsw-alias-label-primary: #0b0b0f;
  --dsw-alias-label-secondary: #55555f;
  --dsw-alias-accent: #e62429;
  --dsw-alias-brand-primary: #e62429;
}
.memory-eternal-root[data-skin="spider"] { background: var(--sp-bg); color: var(--sp-ink); }
.mc-admin[data-skin="spider"] { background: var(--sp-bg); color: var(--sp-ink); }
[data-skin="spider"] .mc-main {
  background-color: #f4f1e8;
  background-image: radial-gradient(rgba(27,59,139,.09) 1px, transparent 1.2px);
  background-size: 16px 16px;
  color: var(--sp-ink);
}
[data-skin="spider"] .mc-v5-pagehead { position: relative; }
[data-skin="spider"] .mc-v5-pagehead::after {
  content: '';
  position: absolute; right: 18px; top: 6px; width: 130px; height: 130px; opacity: .5; pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cg fill='none' stroke='%23e62429' stroke-opacity='.28' stroke-width='1'%3E%3Cpath d='M0 0L120 120M0 30L90 120M0 60L60 120M30 0L120 90M60 0L120 60'/%3E%3Ccircle cx='0' cy='0' r='40'/%3E%3Ccircle cx='0' cy='0' r='80'/%3E%3C/g%3E%3C/svg%3E");
  background-size: contain; background-repeat: no-repeat;
}
[data-skin="spider"] .mc-rail { background: var(--sp-blue); border-right: 3px solid var(--sp-ink); }
[data-skin="spider"] .mc-v5-railbrand b { color: #fff; }
[data-skin="spider"] .mc-v5-railbrand span, [data-skin="spider"] .mc-rail-sec { color: rgba(255,255,255,.66); }
[data-skin="spider"] .mc-railbtn { color: #e9ecff; border-radius: 4px; }
[data-skin="spider"] .mc-railbtn:hover { background: #fff; color: var(--sp-blue); border: 2px solid var(--sp-ink); box-shadow: 3px 3px 0 var(--sp-red); }
[data-skin="spider"] .mc-railbtn.active { background: var(--sp-red); color: #fff; border: 2px solid var(--sp-ink); box-shadow: 3px 3px 0 var(--sp-ink); }
[data-skin="spider"] .mc-dot { background: var(--sp-yellow); color: var(--sp-ink); }
[data-skin="spider"] .mc-v5-top { position: relative; background: var(--sp-panel); border-bottom: 3px solid var(--sp-ink); }
[data-skin="spider"] .mc-v5-top::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 5px; background: linear-gradient(90deg, var(--sp-red) 0 50%, var(--sp-blue) 50% 100%); }
[data-skin="spider"] .mc-v5-crumb, [data-skin="spider"] .mc-v5-crumb b { color: var(--sp-ink); }
[data-skin="spider"] .mc-v5-sys, [data-skin="spider"] .mc-v5-ver, [data-skin="spider"] .mc-v5-star { background: #fff; border: 2px solid var(--sp-ink); color: var(--sp-blue); border-radius: 999px; }
[data-skin="spider"] .mc-v5-pagehead h1 { display: block; width: fit-content; padding: 2px 8px; color: var(--sp-red); font-family: Impact, 'Arial Black', 'Noto Sans SC', sans-serif; font-weight: 900; letter-spacing: -.01em; text-shadow: 3px 3px 0 var(--sp-ink); }
[data-skin="spider"] .mc-v5-eyebrow { display: inline-block; padding: 2px 9px; background: var(--sp-blue); color: #fff; border: 2px solid var(--sp-ink); font-family: Impact, 'Arial Black', sans-serif; letter-spacing: .16em; }
[data-skin="spider"] .mc-v5-eyebrow::before { content: '🕷 '; }
[data-skin="spider"] .mc-v5-pagehead p { color: #3d3d46; }
[data-skin="spider"] .mc-v5-pagecount { padding: 1px 9px; background: var(--sp-blue); color: #fff; border: 2px solid var(--sp-ink); border-radius: 999px; }
[data-skin="spider"] .mc-v5-pagehead-stats b { color: var(--sp-red); }
[data-skin="spider"] .mc-card { background: #fffdf7; border: 2px solid var(--sp-ink); border-radius: 6px; box-shadow: 5px 5px 0 var(--sp-red); }
[data-skin="spider"] .mc-cardrow { transition: transform .14s ease, box-shadow .14s ease; }
[data-skin="spider"] .mc-cardrow:hover { transform: translate(-2px, -2px); box-shadow: 7px 7px 0 var(--sp-blue); }
[data-skin="spider"] .mc-v5-card-title { color: var(--sp-ink); font-weight: 900; }
[data-skin="spider"] .mc-v5-card-lead { color: #3d3d46; }
[data-skin="spider"] .mc-v5-card-kind-name, [data-skin="spider"] .mc-v5-card-time, [data-skin="spider"] .mc-v5-card-foot { color: #5b5b66; }
[data-skin="spider"] .mc-v5-insight-k { background: var(--sp-yellow); border: 1px solid var(--sp-ink); color: var(--sp-ink); }
[data-skin="spider"] .mc-v5-conn { color: var(--sp-blue); }
[data-skin="spider"] .mc-v5-conn b { color: var(--sp-red); }
[data-skin="spider"] .mc-btn { background: var(--sp-yellow); border: 2px solid var(--sp-ink); border-radius: 5px; color: var(--sp-ink); box-shadow: 2px 2px 0 var(--sp-ink); font-weight: 700; }
[data-skin="spider"] .mc-btn:hover { background: #fff; box-shadow: 4px 4px 0 var(--sp-ink); }
[data-skin="spider"] .mc-btn.me-on { background: var(--sp-red) !important; color: #fff !important; border-color: var(--sp-ink) !important; box-shadow: 3px 3px 0 var(--sp-blue); }
[data-skin="spider"] .mc-chip { background: #fff; border: 2px solid var(--sp-ink); color: var(--sp-ink); border-radius: 999px; }
[data-skin="spider"] .mc-chip.active { background: var(--sp-blue); color: #fff; }
[data-skin="spider"] .mc-toolbar input[type=text], [data-skin="spider"] .mc-field input:not([type="checkbox"]):not([type="radio"]), [data-skin="spider"] .mc-field select, [data-skin="spider"] .mc-news-search { background: #fff; border: 2px solid var(--sp-ink); color: var(--sp-ink); }
[data-skin="spider"] .mc-field input:focus, [data-skin="spider"] .mc-field select:focus { border-color: var(--sp-red); box-shadow: 0 0 0 3px rgba(230,36,41,.2); }
[data-skin="spider"] .mc-v5-feature { position: relative; overflow: hidden; flex: none; background: var(--sp-red); border: 3px solid var(--sp-ink); box-shadow: 6px 6px 0 var(--sp-ink); color: #fff; }
[data-skin="spider"] .mc-v5-feature::after {
  content: ''; position: absolute; right: -20px; bottom: -30px; width: 180px; height: 180px; opacity: .4; pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cg fill='none' stroke='%23ffffff' stroke-opacity='.4' stroke-width='1'%3E%3Cpath d='M0 0L120 120M0 30L90 120M0 60L60 120M30 0L120 90M60 0L120 60'/%3E%3Ccircle cx='0' cy='0' r='40'/%3E%3Ccircle cx='0' cy='0' r='80'/%3E%3C/g%3E%3C/svg%3E");
  background-size: contain; background-repeat: no-repeat;
}
[data-skin="spider"] .mc-v5-feature::before { content: 'THWIP!'; position: absolute; right: 16px; top: 12px; padding: 3px 8px; background: var(--sp-yellow); color: var(--sp-ink); border: 2px solid var(--sp-ink); transform: rotate(-6deg); font-family: Impact, 'Arial Black', sans-serif; font-size: 11px; letter-spacing: .06em; }
[data-skin="spider"] .mc-v5-feature h3 { color: #fff; font-family: Impact, 'Arial Black', 'Noto Sans SC', sans-serif; letter-spacing: .01em; }
[data-skin="spider"] .mc-v5-feature p { color: #fff; }
[data-skin="spider"] .mc-v5-feature-meta, [data-skin="spider"] .mc-v5-feature-side span { color: rgba(255,255,255,.8); }
[data-skin="spider"] .mc-v5-feature-side { border-left-color: rgba(255,255,255,.3); }
[data-skin="spider"] .mc-v5-feature-side b { color: var(--sp-yellow); }
[data-skin="spider"] .mc-v5-feature-open { color: var(--sp-yellow) !important; }
[data-skin="spider"] .mc-tag { background: #fff !important; border: 1.5px solid var(--sp-ink); color: var(--sp-ink) !important; }
[data-skin="spider"] .mc-tag:nth-child(3n+1) { background: var(--sp-yellow) !important; }
[data-skin="spider"] .mc-tag:nth-child(3n+2) { background: #cfe0ff !important; }
[data-skin="spider"] .mc-new { background: var(--sp-red); color: #fff; border: 1px solid var(--sp-ink); }
[data-skin="spider"] .mc-switch input { border: 2px solid var(--sp-ink); background: #ddd8ca; }
[data-skin="spider"] .mc-switch input:checked { background: var(--sp-red); }
[data-skin="spider"] .mc-switch input::after { background: #fff; }
[data-skin="spider"] .mc-cards-head { border-bottom: 2px solid var(--sp-ink); padding-bottom: 8px; }
[data-skin="spider"] .mc-cards-head h2 { color: var(--sp-red); font-family: Impact, 'Arial Black', 'Noto Sans SC', sans-serif; font-size: 17px; letter-spacing: .02em; }
[data-skin="spider"] .mc-cards-head-count { background: var(--sp-blue); color: #fff; border: 2px solid var(--sp-ink); }
[data-skin="spider"] .mc-cards-head-hint { color: #5b5b66; opacity: 1; }
[data-skin="spider"] .mc-pagenav { background: #fff; border: 2px solid var(--sp-ink); }
[data-skin="spider"] .mc-pagebtn { color: var(--sp-ink); }
[data-skin="spider"] .mc-pagebtn.on { background: var(--sp-red); color: #fff; box-shadow: 3px 3px 0 var(--sp-ink); }
[data-skin="spider"] .mc-panehead-ico { background: var(--sp-blue); border: 2px solid var(--sp-ink); color: #fff; box-shadow: 3px 3px 0 var(--sp-red); }
[data-skin="spider"] .mc-cfg-sec, [data-skin="spider"] .mc-env, [data-skin="spider"] .mc-env-fold, [data-skin="spider"] .mc-fold, [data-skin="spider"] .mc-cfg-actions { background: #fff; border: 2px solid var(--sp-ink); box-shadow: 5px 5px 0 var(--sp-red); border-radius: 6px; }
[data-skin="spider"] .mc-cfg-sec-ico { background: var(--sp-yellow); border: 2px solid var(--sp-ink); }
[data-skin="spider"] .mc-quote { background: #fff; border: 2px solid var(--sp-ink); color: var(--sp-ink); }
[data-skin="spider"] .mc-quote-tag { color: var(--sp-red); }
[data-skin="spider"] .mc-quote-text { color: var(--sp-ink); }
[data-skin="spider"] .mc-quote-src { color: var(--sp-blue); }
[data-skin="spider"] .mc-quote:hover { background: #fff6e0; border-color: var(--sp-red); box-shadow: 5px 5px 0 var(--sp-blue); color: var(--sp-ink); }
[data-skin="spider"] .mc-quote:hover .mc-quote-text { color: var(--sp-ink); }
[data-skin="pop"] .mc-quote:hover { background: var(--pop-paper); border-color: var(--pop-ink); box-shadow: 4px 4px 0 var(--pop-ink); color: var(--pop-ink); }
[data-skin="light"] .mc-quote:hover { background: #fff; border-color: #e36a36; box-shadow: 0 8px 22px rgba(0,0,0,.08); color: #444; }
[data-skin="resident"] .mc-quote:hover { background: #0c1810; border-color: #7cff3f; box-shadow: 0 0 0 1px rgba(124,255,63,.25), 0 8px 22px rgba(0,0,0,.35); }
[data-skin="resident"] .mc-quote:hover .mc-quote-text { color: #d6ffd9; }
[data-skin="spider"] .me-graph-canvas { background: #fffdf7; border: 2px solid var(--sp-ink); box-shadow: 5px 5px 0 var(--sp-blue); }
[data-skin="spider"] .me-graph-tip { color: #5b5b66; }
[data-skin="spider"] .me-graph-search input { background: #fff; border: 2px solid var(--sp-ink); color: var(--sp-ink); }
[data-skin="spider"] .me-gtool, [data-skin="spider"] .me-gswitch { background: #fff; border: 2px solid var(--sp-ink); color: var(--sp-ink); border-radius: 5px; box-shadow: 2px 2px 0 var(--sp-red); }
[data-skin="spider"] .me-gtool:hover, [data-skin="spider"] .me-gtool.on { background: var(--sp-yellow); color: var(--sp-ink); }
[data-skin="spider"] .me-gswitch.on { background: var(--sp-blue); color: #fff; }
[data-skin="spider"] .me-gswitch .track { background: #d8d3c5; }
[data-skin="spider"] .me-gswitch.on .track { background: var(--sp-red); }
[data-skin="spider"] .me-graph-crumbs { background: #fff; border: 2px solid var(--sp-ink); box-shadow: 3px 3px 0 var(--sp-red); }
[data-skin="spider"] .me-graph-crumbs button { color: var(--sp-ink); }
[data-skin="spider"] .me-graph-crumbs button.current { background: var(--sp-blue); color: #fff; box-shadow: none; }
[data-skin="spider"] .me-graph-legend-pop { background: #fff !important; border: 2px solid var(--sp-ink) !important; color: var(--sp-ink) !important; box-shadow: 4px 4px 0 var(--sp-red) !important; }
[data-skin="spider"] .me-graph-legend-pop .lg { color: var(--sp-ink); }
[data-skin="spider"] .me-graph-legend-pop .lg.active { background: var(--sp-yellow); color: var(--sp-ink); }
[data-skin="spider"] .me-graph-ctxmenu { background: #fff; border: 2px solid var(--sp-ink); color: var(--sp-ink); }
[data-skin="spider"] .mc-v5-graph-legend { background: #fffdf7; border: 2px solid var(--sp-ink); box-shadow: 4px 4px 0 var(--sp-red); }
[data-skin="spider"] .mc-v5-graph-legend-title, [data-skin="spider"] .mc-v5-graph-legend-row { color: #5b5b66; }
[data-skin="spider"] .mc-v5-graph-legend-row b { color: var(--sp-ink); }
[data-skin="spider"] .me-dialog, [data-skin="spider"] .me-modal { background: #fffdf7; color: var(--sp-ink); border: 2px solid var(--sp-ink); box-shadow: 6px 6px 0 var(--sp-blue); }
[data-skin="spider"] .me-dialog-head, [data-skin="spider"] .me-modal-head { background: var(--sp-blue); color: #fff; border-bottom: 2px solid var(--sp-ink); }
[data-skin="spider"] .me-dialog-body h2, [data-skin="spider"] .me-dialog-body h3, [data-skin="spider"] .me-dialog-body h4 { color: var(--sp-ink); }
[data-skin="spider"] .md-doc, [data-skin="spider"] .md-doc h1, [data-skin="spider"] .md-doc h2, [data-skin="spider"] .md-doc h3 { color: var(--sp-ink); }
[data-skin="spider"] .me-support-tab.active { border-bottom-color: var(--sp-red); }
[data-skin="spider"] .mc-starask { background: var(--sp-yellow) !important; border: 2px solid var(--sp-ink) !important; color: var(--sp-ink) !important; box-shadow: 3px 3px 0 var(--sp-red); }
[data-skin="spider"] .mc-starask span { color: var(--sp-ink) !important; }
[data-skin="spider"] .mc-work-textarea { background: #fff !important; border: 2px solid var(--sp-ink) !important; color: var(--sp-ink) !important; }
[data-skin="spider"] .mc-term-guide { color: var(--sp-ink) !important; }
[data-skin="spider"] .mc-term-card { background: #fff !important; border: 2px solid var(--sp-ink) !important; box-shadow: 4px 4px 0 var(--sp-red); color: var(--sp-ink) !important; }
[data-skin="spider"] .mc-term-card div { color: #3d3d46 !important; }
[data-skin="spider"] .mc-term-code { background: #fff !important; border: 2px solid var(--sp-ink) !important; color: var(--sp-ink) !important; }
[data-skin="spider"] .mc-term-btn { background: var(--sp-yellow) !important; border: 2px solid var(--sp-ink) !important; color: var(--sp-ink) !important; box-shadow: 2px 2px 0 var(--sp-ink); }
[data-skin="spider"] .mc-v5-statuscard { background: #fff; border: 2px solid var(--sp-ink); border-radius: 6px; box-shadow: 4px 4px 0 var(--sp-red); }
[data-skin="spider"] .mc-v5-statuscard b { color: var(--sp-red); }
[data-skin="spider"] .mc-v5-statuscard > span:not(.mc-v5-status-ico), [data-skin="spider"] .mc-v5-statuscard small { color: #5b5b66; }
[data-skin="spider"] .mc-stat b { color: var(--sp-red); }
[data-skin="spider"] .mc-stat span { color: #5b5b66; }
[data-skin="spider"] .mc-v5-recycle-copy b { color: var(--sp-ink); }
[data-skin="spider"] .mc-v5-recycle-copy span, [data-skin="spider"] .mc-v5-recycle-hint { color: #5b5b66; }
[data-skin="spider"] .mc-v5-recycle-row:hover { background: #fbf3e0; }
[data-skin="spider"] .mc-news-hero { background: #fff !important; border: 2px solid var(--sp-ink); box-shadow: 5px 5px 0 var(--sp-red); }
[data-skin="spider"] .mc-news-hero-go { background: var(--sp-red) !important; color: #fff !important; border: 2px solid var(--sp-ink); box-shadow: 3px 3px 0 var(--sp-blue); }
[data-skin="spider"] .mc-news-reader, [data-skin="spider"] .mc-news-follow-draft, [data-skin="spider"] .mc-news-follow-sec { background: #fff; border: 2px solid var(--sp-ink); }
[data-skin="spider"] .mc-v5-audit-trust { border-color: var(--sp-ink); color: var(--sp-blue); background: #eef3ff; }
[data-skin="spider"] .me-audit-kind.active { background: var(--sp-yellow); border-color: var(--sp-ink); color: var(--sp-ink); }
[data-skin="spider"] .me-audit-row-state, [data-skin="spider"] .mc-v5-card-status.pending { background: var(--sp-yellow); color: var(--sp-ink); }
[data-skin="spider"] .mc-v5-pagehead-stats span { color: #3d3d46; }
/* 新皮肤补充：浅底蜘蛛侠的审核行文字、生化危机的审核行绿色 */
[data-skin="spider"] :is(.me-audit-row-title, .me-audit-row-kind, .me-audit-row-time, .me-audit-row-meta, .me-audit-row-reason) { color: var(--sp-ink); }
[data-skin="spider"] .me-audit-row-time, [data-skin="spider"] .me-audit-row-kind, [data-skin="spider"] .me-audit-row-meta { color: #5b5b66; }
[data-skin="spider"] .me-audit-row:hover { background: #fbf3e0; }
[data-skin="spider"] .me-audit-row.core { background: #fff6e0; border-left-color: var(--sp-red); }
[data-skin="resident"] .me-audit-row-title { color: #d6ffd9; }
[data-skin="resident"] .me-audit-row-kind, [data-skin="resident"] .me-audit-row-time, [data-skin="resident"] .me-audit-row-meta, [data-skin="resident"] .me-audit-row-reason { color: #7fa383; }
/* ===== 角色与氛围：丧尸剪影 / 蜘蛛侠悬丝 ===== */
[data-skin="resident"] .mc-v5-pagehead { position: relative; }
[data-skin="resident"] .mc-v5-pagehead > * { position: relative; z-index: 1; }
/* ===== 主题头图：整块电影 / 漫画 Banner ===== */
[data-skin="resident"] .mc-v5-pagehead {
  position: relative; display: flex; align-items: flex-end;
  min-height: 196px; margin: 8px 0 14px; padding: 20px 26px 18px;
  border: 1px solid #244a2c; border-bottom: 6px solid #e23a3a;
  border-radius: 6px; overflow: visible;
  background: linear-gradient(90deg, #040705 0%, #07110a 52%, #0b1a0f 100%);
  box-shadow: inset 0 0 70px rgba(124,255,63,.05), 0 14px 30px rgba(0,0,0,.45);
}
[data-skin="resident"] .mc-v5-pagehead::before {
  content: ''; position: absolute; right: 0; top: 0; width: 64%; height: 100%;
  background-image:
    linear-gradient(90deg, rgba(5,8,6,.97) 0 32%, rgba(5,8,6,.16) 52%, transparent 72%),
    repeating-linear-gradient(180deg, rgba(124,255,63,.05) 0 1px, transparent 1px 4px),
    radial-gradient(circle at 88% 16%, rgba(226,58,58,.12), transparent 48%),
    url("${ZOMBIE_ART}");
  background-size: 100% 100%, auto, auto, 100% auto;
  background-position: 0 0, 0 0, 0 0, center 30%;
  background-repeat: no-repeat;
  opacity: .99; filter: brightness(1.55) contrast(1.02) saturate(1);
  -webkit-mask-image: linear-gradient(to left, #000 40%, transparent 100%);
  mask-image: linear-gradient(to left, #000 52%, transparent 100%);
  clip-path: inset(0 round 6px);
  pointer-events: none; z-index: 0;
}
[data-skin="resident"] .mc-v5-pagehead::after {
  content: '☣ CONTAINMENT BREACH // T-002 TYRANT';
  position: absolute; left: 0; right: 0; top: 0; bottom: 0; z-index: 3; padding: 16px 20px;
  color: #ff8a8a; font: 9px Consolas, 'Courier New', monospace; letter-spacing: .16em;
  pointer-events: none;
}
[data-skin="resident"] .mc-v5-pagehead > * { position: relative; z-index: 2; }
[data-skin="resident"] .mc-v5-pagehead h1 { font-size: 34px; line-height: 1.15; }
[data-skin="resident"] .mc-v5-pagehead p { max-width: 46%; }
[data-skin="resident"] .mc-v5-pagecount { position: absolute; right: 16px; top: 14px; z-index: 3; }
[data-skin="resident"] .mc-v5-feature {
  background-image:
    linear-gradient(90deg, rgba(226,58,58,.85) 0 61%, rgba(226,58,58,.16) 61% 100%),
    linear-gradient(135deg, #0c1a0f, #07110a);
  background-size: 100% 5px, 100% 100%;
  background-position: left bottom, center;
  background-repeat: no-repeat;
}
[data-skin="resident"] .mc-v5-feature::before {
  content: 'B.O.W. // LEVEL 4';
  position: absolute; top: 10px; right: 14px; z-index: 2;
  padding: 2px 7px; border: 1px solid rgba(226,58,58,.8);
  background: rgba(226,58,58,.08); color: #ff8a8a;
  font: 9px Consolas, 'Courier New', monospace; letter-spacing: .14em;
  transform: rotate(-2deg);
}
[data-skin="spider"] .mc-v5-pagehead {
  position: relative; display: flex; align-items: flex-end;
  min-height: 196px; margin: 8px 0 14px; padding: 20px 26px 18px;
  border: 3px solid var(--sp-ink); border-radius: 6px; overflow: hidden;
  background: #f4f1e8; box-shadow: 8px 8px 0 var(--sp-red);
}
[data-skin="spider"] .mc-v5-pagehead::before {
  content: ''; position: absolute; right: 0; top: 0; width: 62%; height: 100%;
  background: url("${SPIDER_ART}") center 24% / 100% auto no-repeat;
  opacity: 1; filter: saturate(1.05) contrast(1.02);
  -webkit-mask-image: linear-gradient(to left, #000 48%, transparent 100%);
  mask-image: linear-gradient(to left, #000 48%, transparent 100%);
  pointer-events: none; z-index: 0;
}
[data-skin="spider"] .mc-v5-pagehead > * { position: relative; z-index: 2; }
[data-skin="spider"] .mc-v5-pagehead h1 { font-size: 38px; line-height: 1.1; }
[data-skin="spider"] .mc-v5-pagehead h1::after { content: '!'; color: var(--sp-yellow); -webkit-text-stroke: 2px var(--sp-ink); margin-left: 2px; }
[data-skin="spider"] .mc-v5-pagehead p { max-width: 46%; }
[data-skin="spider"] .mc-v5-pagecount { position: absolute; right: 16px; top: 14px; z-index: 3; }
[data-skin="spider"] .mc-v5-feature::before { z-index: 2; }
[data-skin="spider"] .mc-theme-charm {
  display: block; position: fixed; top: 58px; left: 190px; width: 64px; height: 128px;
  background: url("${CHARM_ART}") center top / contain no-repeat;
  pointer-events: none; z-index: 45; filter: drop-shadow(0 8px 12px rgba(0,0,0,.28));
}
.mc-theme-charm { display: none; }
@media (prefers-reduced-motion: no-preference) {
  [data-skin="spider"] .mc-theme-charm { animation: charm-swing 5.5s ease-in-out infinite; transform-origin: 50% 0; }
}
@keyframes charm-swing { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
@media (max-width: 720px) { .mc-theme-charm { display: none !important; } }
@media (prefers-reduced-motion: no-preference) {
  [data-skin="resident"] .mc-v5-pagehead::before { animation: re-alert 6s ease-in-out infinite; }
  [data-skin="spider"] .mc-v5-pagehead::before { animation: sp-hero-breath 7s ease-in-out infinite; }
  [data-skin="resident"] .mc-cardrow:hover { animation: re-glitch .38s steps(2) 1; }
}
@keyframes re-alert {
  0%, 100% { filter: brightness(1.35) contrast(1.1) saturate(1.1); }
  48% { filter: brightness(1.52) contrast(1.15) saturate(1.2); }
  50% { filter: brightness(1.08) contrast(1.05) saturate(1); }
}
@keyframes sp-hero-breath {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-4px) scale(1.015); }
}
@keyframes re-glitch {
  0%, 100% { filter: none; }
  40% { filter: brightness(1.14) hue-rotate(-8deg); }
  60% { filter: brightness(.96); }
}
@media (max-width: 720px) {
  [data-skin="resident"] .mc-v5-pagehead, [data-skin="spider"] .mc-v5-pagehead { min-height: 0; padding: 14px 16px; display: block; }
  [data-skin="resident"] .mc-v5-pagehead::before,
  [data-skin="spider"] .mc-v5-pagehead::before { display: none; }
  [data-skin="resident"] .mc-v5-pagehead h1,
  [data-skin="spider"] .mc-v5-pagehead h1 { font-size: 24px; }
  [data-skin="resident"] .mc-v5-pagehead p,
  [data-skin="spider"] .mc-v5-pagehead p { max-width: none; }
  [data-skin="resident"] .mc-v5-pagehead::after { background-image: none; bottom: 0; filter: none; }
}
/* ===== 全皮肤 hover / 次级文字对比度兜底 ===== */
[data-skin="spider"] .mc-btn:not(.me-on):hover { color: var(--sp-ink); }
[data-skin="light"] .mc-btn:not(.me-on):hover { color: #1c1c1e; }
[data-skin="pop"] .mc-btn:not(.me-on):hover { color: var(--pop-ink); }
[data-skin="spider"] .mc-btn.me-on:hover,
[data-skin="light"] .mc-btn.me-on:hover,
[data-skin="pop"] .mc-btn.me-on:hover { color: #fff; }
[data-skin="spider"] .mc-pagebtn { opacity: .9; }
[data-skin="pop"] .mc-pagebtn { opacity: .9; }
[data-skin="light"] .mc-pagebtn { opacity: .9; }
[data-skin="spider"] .mc-pagebtn-sub,
[data-skin="pop"] .mc-pagebtn-sub,
[data-skin="light"] .mc-pagebtn-sub { opacity: .75; }
/* 危险操作按钮：浅色皮肤用更深的红，hover 也保持红色 */
.mc-btn-danger { color: #f87171; }
[data-skin="spider"] .mc-btn-danger { color: #b3121a; }
[data-skin="light"] .mc-btn-danger { color: #b91c1c; }
[data-skin="pop"] .mc-btn-danger { color: #991b1b; }
[data-skin="resident"] .mc-btn-danger { color: #ff7b7b; }
[data-skin="spider"] .mc-btn-danger:hover { color: #b3121a !important; }
[data-skin="light"] .mc-btn-danger:hover { color: #b91c1c !important; }
[data-skin="pop"] .mc-btn-danger:hover { color: #991b1b !important; }
[data-skin="resident"] .mc-btn-danger:hover { color: #ff9a9a !important; }
/* 顶栏 Star / 帮助按钮：浅色皮肤 hover 用深色强调，避免橙字发虚 */
[data-skin="spider"] .mc-v5-star:hover, [data-skin="spider"] .mc-v5-help:hover { color: var(--sp-red); border-color: var(--sp-ink); }
[data-skin="light"] .mc-v5-star:hover, [data-skin="light"] .mc-v5-help:hover { color: #b91c1c; border-color: #cfcfca; }
[data-skin="pop"] .mc-v5-star:hover, [data-skin="pop"] .mc-v5-help:hover { color: var(--pop-red); border-color: var(--pop-ink); }

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
    <div className="mc-term-guide" style={{ padding: '22px 26px 34px', maxWidth: 1040, color: '#f3f5f8' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 24, letterSpacing: '-.02em' }}>{t('terminalTitle')}</h2>
        <span style={{ color: '#99a1ac', fontSize: 12 }}>TUI · LIVE · dsh-tui</span>
      </div>
      <p style={{ margin: '9px 0 20px', color: '#aeb5bf', fontSize: 13.5, lineHeight: 1.8 }}>{t('terminalIntro')}</p>

      <div className="mc-term-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, .9fr)', gap: 14 }}>
        <div className="mc-term-card" style={card}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>▸ {t('terminalRun')}</div>
          <pre className="mc-term-code" style={code}>{runCmd}</pre>
          <button type="button" className="mc-term-btn" style={button} onClick={() => copy(runCmd, 'run')}>{copied === 'run' ? '✓ ' + t('terminalCopied') : '⧉ ' + t('terminalCopy')}</button>
          <div style={{ marginTop: 12, color: '#99a1ac', fontSize: 12, lineHeight: 1.7 }}>
            默认读取真实记忆库与待审队列；只读，确认后才用 `--write`。示例数据用 `--demo`。
            <br />没有 `dsh-memory` 命令时：`npx -p memory-eternal dsh-memory tui`
          </div>
        </div>
        <div className="mc-term-card" style={card}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>▸ {t('terminalTui')}</div>
          <pre className="mc-term-code" style={code}>{tuiCmd}</pre>
          <button type="button" className="mc-term-btn" style={button} onClick={() => copy(tuiCmd, 'tui')}>{copied === 'tui' ? '✓ ' + t('terminalCopied') : '⧉ ' + t('terminalCopy')}</button>
          <div style={{ marginTop: 12, color: '#99a1ac', fontSize: 12, lineHeight: 1.7 }}>
            真实批准/驳回；不确定时先用只读模式。
          </div>
        </div>
      </div>

      <div className="mc-term-card" style={{ ...card, marginTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>▸ {t('terminalPreview')}</div>
        <pre className="mc-term-code mc-term-preview" style={{ ...code, marginTop: 10, color: '#d7dce3', fontSize: 12, lineHeight: 1.5 }}>
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


/**
 * 会话工作区（草稿本）：按会话隔离的临时笔记，**不进入知识库**。
 * 这里只做三件事：看/改这份草稿、清空、以及把值得保留的内容「存为待审卡」。
 */
function WorkingNoteCard({ t, notify, onPromoted }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [meta, setMeta] = useState(null)
  const [busy, setBusy] = useState('')
  const taRef = useRef(null)
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/working`)
      const j = await r.json().catch(() => null)
      if (j && j.ok) { setMeta(j); setText(j.text || '') }
    } catch { /* 工作区坏了不影响面板 */ }
  }, [])
  useEffect(() => { load() }, [load])
  const post = async (path, body) => {
    const r = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    return r.json().catch(() => null)
  }
  const save = async () => {
    setBusy('save')
    const j = await post('/working', { text, mode: 'replace' })
    setBusy('')
    if (j && j.ok) { notify(true, t('workSaved')); await load() } else notify(false, (j && j.error) || 'save failed')
  }
  const clear = async () => {
    if (!window.confirm(t('workClearConfirm'))) return
    setBusy('clear')
    const j = await post('/working/clear', {})
    setBusy('')
    if (j && j.ok) { setText(''); notify(true, t('workCleared')); await load() } else notify(false, (j && j.error) || 'clear failed')
  }
  const promote = async () => {
    // 有选中内容时**只晋升选中部分**：草稿里常有半成品，整篇进审核队列只会给审核添乱
    const ta = taRef.current
    const picked = ta && ta.selectionEnd > ta.selectionStart
      ? ta.value.slice(ta.selectionStart, ta.selectionEnd)
      : text
    if (!String(picked || '').trim()) { notify(false, t('workPromoteEmpty')); return }
    setBusy('promote')
    const j = await post('/working/promote', { text: picked })
    setBusy('')
    if (j && j.ok) { notify(true, t('workPromoted')); if (onPromoted) onPromoted() } else notify(false, (j && j.error) || 'promote failed')
  }
  const lines = text ? text.split('\n').length : 0
  return (
    <div className="mc-card" style={{ margin: '0 0 10px', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 12.5 }}>📝 {t('workTitle')}</b>
        <span style={{ fontSize: 11, opacity: 0.65 }}>{t('workHint')}</span>
        <span style={{ fontSize: 11, opacity: 0.5 }}>{lines} {t('workLines')}</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="mc-btn" onClick={() => setOpen((v) => !v)}>{open ? t('workCollapse') : t('workExpand')}</button>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            placeholder={t('workPlaceholder')}
            className="mc-work-textarea"
            style={{ width: '100%', boxSizing: 'border-box', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.6, background: 'rgba(0,0,0,0.18)', color: 'inherit', border: '1px solid rgba(140,148,160,0.35)', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" className="mc-btn me-on" disabled={!!busy} onClick={save}>{busy === 'save' ? '…' : t('workSave')}</button>
            <button type="button" className="mc-btn" disabled={!!busy} onClick={promote}>{busy === 'promote' ? '…' : t('workPromote')}</button>
            <button type="button" className="mc-btn mc-danger" disabled={!!busy || !text.trim()} onClick={clear}>{t('workClear')}</button>
            <span style={{ fontSize: 11, opacity: 0.55 }}>
              {(meta && meta.maxLines ? meta.maxLines + ' 行 / ' + Math.round((meta.maxBytes || 0) / 1024) + 'KB ' : '')}{t('workLimitHint')} · {t('workPromoteHint')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export function MemoryLibrary(props) {
  return <PanelErrorBoundary><MemoryLibraryInner {...props} /></PanelErrorBoundary>
}
function MemoryLibraryInner({ t, inModal, onClose }) {
  const inHost = typeof window !== 'undefined' && (!!window.__DSH_BOOT__ || String(location.pathname || '').includes('/memory-eternal/api/ui/app'))
  const [overview, setOverview] = useState(null)
  // 布局大小：宿主配置 uiScale + 本地即时事件；默认 standard
  const [uiScale, setUiScale] = useState(() => {
    try {
      const v = localStorage.getItem('me-ui-scale')
      return ['compact', 'normal', 'large'].includes(v) ? v : 'normal'
    } catch { return 'normal' }
  })
  // 主题皮肤：宿主配置 theme + 本地即时事件；切换在「设置 → 通用 → 主题皮肤」。
  const SKIN_IDS = ['default', 'pop', 'light', 'resident', 'spider']
  const [skin, setSkin] = useState(() => {
    try {
      const v = localStorage.getItem('me-skin')
      return SKIN_IDS.includes(v) ? v : 'default'
    } catch { return 'default' }
  })
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
  // 'cards' | 'graph' | 'news' | 'stats' | 'audit' | 'optimize' | 'config' | 'terminal'
  const [view, setView] = useState(() => {
    try {
      const tab = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('tab')
      const map = { cards: 'cards', graph: 'graph', news: 'news', usage: 'stats', stats: 'stats', audit: 'audit', recycle: 'optimize', optimize: 'optimize', config: 'config', terminal: 'terminal' }
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
  // Star 提示：只在账本里已有真实数据（召回 ≥8 次或 ≥15 张卡）时问一次，
  // 问之前不打扰；7 天冷却、最多 3 次、「不再提示」永久关闭。判定在服务端做。
  const [starAsk, setStarAsk] = useState(null)
  const starAct = useCallback((action) => {
    setStarAsk(null)
    try {
      fetch(`${API}/star/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      }).catch(() => {})
    } catch { /* 面板不能因为提示失败而崩 */ }
  }, [])
  useEffect(() => {
    let alive = true
    fetch(`${API}/star/status`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive || !j || !j.shouldAsk) return
        setStarAsk(j)
        // 展示即计数，避免用户什么都不点时下次又弹
        fetch(`${API}/star/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'shown' }),
        }).catch(() => {})
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const libToastTimer = useRef(null)
  const importRef = useRef(null)
  const [exporting, setExporting] = useState(false)
  const [skillBusy, setSkillBusy] = useState(false)
  const [newsUnread, setNewsUnread] = useState(0)
  const [reader, setReader] = useState(null)
  const [allVaults, setAllVaults] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [supportTab, setSupportTab] = useState('group')
  const [onboardOpen, setOnboardOpen] = useState(false)
  useEffect(() => {
    const onScale = (e) => {
      const v = e && e.detail
      if (!['compact', 'normal', 'large'].includes(v)) return
      setUiScale(v)
      try { localStorage.setItem('me-ui-scale', v) } catch { /* ignore */ }
    }
    window.addEventListener('me-ui-scale', onScale)
    return () => window.removeEventListener('me-ui-scale', onScale)
  }, [])
  // 皮肤切换：设置页点一下 → 全界面即时换肤（保存配置后持久）。
  useEffect(() => {
    const onSkin = (e) => {
      const v = e && e.detail
      if (!SKIN_IDS.includes(v)) return
      setSkin(v)
      try { localStorage.setItem('me-skin', v) } catch { /* ignore */ }
    }
    window.addEventListener('me-skin', onSkin)
    return () => window.removeEventListener('me-skin', onSkin)
  }, [])
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
  // 作者语录轮播下标（不持久化：每次打开从头开始，避免“上次停在哪”成为隐形状态）
  const [quoteIdx, setQuoteIdx] = useState(0)
  const [newCard, setNewCard] = useState(null)
  const [dataVer, setDataVer] = useState(0)
  const bump = useCallback(() => setDataVer((v) => v + 1), [])
  // 两套存储：隔离区计数（审核中心 / 回收中心徽标）。overview.quarantine 由服务端给出。
  const quarantinePending = overview?.quarantine?.pending ?? 0
  // issue #57：回收中心现在同时收「已删除」与「已驳回」，徽标必须一起算 ——
  // 否则面板里列着 5 张驳回卡、左边却显示 0，用户依旧找不到入口。
  const quarantineDeleted = (overview?.quarantine?.deleted ?? 0) + (overview?.quarantine?.rejected ?? 0)
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
      const [ov, capRes, cfgRes, newsRes] = await Promise.all([
        fetch(`${API}/overview`).then((r) => r.json()),
        fetch(`${API}/capture-log`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/config`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/news?unread=1&limit=1`).then((r) => r.json()).catch(() => null),
      ])
      if (ov.ok) setOverview(ov)
      if (newsRes && newsRes.ok) setNewsUnread(Number((newsRes.counts || {}).unread) || 0)
      const nextScale = cfgRes && cfgRes.ok && cfgRes.config && cfgRes.config.uiScale
      if (['compact', 'normal', 'large'].includes(nextScale)) {
        setUiScale(nextScale)
        try { localStorage.setItem('me-ui-scale', nextScale) } catch { /* ignore */ }
      }
      const nextSkin = cfgRes && cfgRes.ok && cfgRes.config && cfgRes.config.theme
      // 默认值不覆盖本机已选皮肤：独立服务直写共享配置时 getSettings 可能还是旧值，
      // 让显式选过的非默认皮肤（localStorage）优先，避免刷新后跳回默认。
      if (SKIN_IDS.includes(nextSkin) && (nextSkin !== 'default' || !localStorage.getItem('me-skin'))) {
        setSkin(nextSkin)
        try { localStorage.setItem('me-skin', nextSkin) } catch { /* ignore */ }
      }
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
      if (data.ok) setReader({ path: data.path, title: card.title, text: data.text, kind: card.kind || 'knowledge', status: st || 'approved' })
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

  // 技能卡同步：从本机实际技能生成/刷新待审技能卡（kind=skill）。
  // 不是 agent 沉淀；服务端强制 pending，同步完只会看到审核队列数量变化。
  const syncSkills = async () => {
    if (skillBusy) return
    setSkillBusy(true)
    try {
      const r = await fetch(`${API}/skills/sync`, { method: 'POST' }).then((x) => x.json()).catch(() => null)
      if (r && r.ok) {
        const msg = t('skillsSyncDone') + ' · ' + t('skillsScanned') + ' ' + (r.total || 0) +
          ' · ' + t('skillsCreated') + ' ' + (r.created || 0) +
          ' · ' + t('skillsUpdated') + ' ' + (r.updated || 0) +
          ' · ' + t('skillsPendingUpdates') + ' ' + (r.pendingUpdates || 0)
        setLibToast({ ok: true, msg })
        await loadAll()
        bump()
      } else {
        setLibToast({ ok: false, msg: (r && r.error) || t('skillsSyncFail') })
      }
    } catch (e) {
      setLibToast({ ok: false, msg: t('skillsSyncFail') })
    } finally {
      setSkillBusy(false)
    }
    if (libToastTimer.current) clearTimeout(libToastTimer.current)
    libToastTimer.current = setTimeout(() => setLibToast(null), 3600)
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

  const uiZoom = uiScale === 'large' ? 1.15 : uiScale === 'compact' ? 0.92 : 1.06
  return (
    <div
      className="memory-eternal-root me-v5"
      data-ui-scale={uiScale}
      data-skin={skin}
      style={{
        height: '100%',
        width: '100%',
        zoom: uiZoom,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <style>{CSS}</style>
      <div className="mc-theme-charm" aria-hidden="true" />
      {!inModal && (
        <div className={`mc-v5-top${inHost ? ' in-host' : ''}`}>
          <img className="mc-v5-logo" src={brandIcon} alt="" />
          <span className="mc-v5-crumb"><b>{t('memoryTitle')}</b><i>/</i><span>{t(view === 'cards' ? 'cardsTab' : view === 'graph' ? 'graphTab' : view === 'news' ? 'newsTab' : view === 'stats' ? 'tabUsage' : view === 'audit' ? 'tabAudit' : view === 'optimize' ? 'tabRecycle' : view === 'terminal' ? 'terminalTab' : 'tabConfig')}</span></span>
          <div className="spacer" />
          <div className="mc-v5-top-actions">
            <span className="mc-v5-sys"><i />{t('v5Local')}</span>
            <span className="mc-v5-ver">v{CLIENT_VERSION}</span>
            <button type="button" className="mc-v5-star" onClick={() => openExternal('https://github.com/EternalNight996/memory-eternal')} title={t('v5Star')}>★ <span className="mc-v5-star-label">Star</span></button>
            <button type="button" className="mc-v5-help" onClick={() => openSupport('group')} title={t('supportTitle')} aria-label={t('supportTitle')}>?</button>
          </div>
        </div>
      )}
      {starAsk && (
        <div className="mc-starask" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 14px 0', padding: '10px 14px', borderRadius: 10, background: 'linear-gradient(90deg, rgba(255,122,69,0.14), rgba(255,122,69,0.03))', border: '1px solid rgba(255,122,69,0.32)', color: 'var(--dsw-alias-label-primary, #e5e7eb)', fontSize: 12.5, lineHeight: 1.55 }}>
          <span style={{ fontSize: 15, color: '#FF7A45' }}>★</span>
          <span style={{ flex: 1 }}>
            <b>{t('starAskTitle')}</b>
            <span style={{ opacity: 0.82, marginLeft: 8 }}>
              {t('starAskBody').replace('{recalls}', String(starAsk.evidence?.recalls ?? 0)).replace('{cards}', String(starAsk.evidence?.cards ?? 0))}
            </span>
          </span>
          <button type="button" className="mc-btn me-on" onClick={() => { openExternal('https://github.com/EternalNight996/memory-eternal'); starAct('never') }}>★ {t('starAskGo')}</button>
          <button type="button" className="mc-btn" onClick={() => starAct('later')}>{t('starAskLater')}</button>
          <button type="button" className="mc-btn" onClick={() => starAct('never')}>{t('starAskNever')}</button>
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
          <button type="button" className={`mc-railbtn${view === 'news' ? ' active' : ''}`} onClick={() => goView('news')} title={t('newsTab')}>
            <span className="mc-rail-ico">📰</span>
            {railOpen && <span className="mc-rail-label">{t('newsTab')}</span>}
            {newsUnread > 0 && <span className="mc-dot">{newsUnread > 99 ? '99+' : newsUnread}</span>}
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
          {/* 作者语录：贴左栏底部（CSS margin-top:auto），点击换一句；折叠/窄屏由 CSS 隐藏。 */}
          {railOpen && (
            <button
              type="button"
              className="mc-quote"
              onClick={() => setQuoteIdx((i) => (i + 1) % QUOTES.length)}
              title={`${QUOTES[quoteIdx]}\n${QUOTE_SOURCE}\n${t('quoteHint')}`}
            >
              <span className="mc-quote-tag">{t('navQuotes')} · {quoteIdx + 1}/{QUOTES.length}</span>
              <span className="mc-quote-text" key={quoteIdx}>{QUOTES[quoteIdx]}</span>
              <span className="mc-quote-src">{QUOTE_SOURCE}</span>
            </button>
          )}
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
          <WorkingNoteCard
            t={t}
            notify={(ok, msg) => setLibToast({ ok, msg })}
            onPromoted={() => { loadAll(); bump() }}
          />
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
            <button type="button" className="mc-btn" disabled={skillBusy} onClick={syncSkills} title={t('skillCardsHint')}>{skillBusy ? '⏳ ' + t('syncingSkills') : '🧩 ' + t('syncSkills')}</button>
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
              : <>{/* 卡片区标题：让「知识卡片」成为独立区块，而不是直接铺网格 */}
                <div className="mc-cards-head">
                  <span className="mc-cards-head-ico" aria-hidden="true">🗂️</span>
                  <h2>{t('cardsSectionTitle')}</h2>
                  <span className="mc-cards-head-count">{sortedCards.length} {t('cardsUnit')}</span>
                  <span className="mc-cards-head-hint">{t('cardsSectionHint')}</span>
                </div>
                {showFeature && (
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
              )}<div className="mc-grid">{sortedCards.filter((card) => !showFeature || card.path !== featuredCard.path).map((card) => <CardRow key={card.path} card={card} t={t} query={query.trim()} onOpen={openCard} onDelete={deleteMemory} onTagClick={onTagPick} pinned={pinned.has(card.path)} onPin={togglePin} onCore={changeCardKind} links={connMap[card.path] || 0} />)}</div>{cards.length < cardTotal && <div ref={sentinelRef} style={{ height: 1 }} />}{loadingMore && <div className="mc-empty" style={{ padding: '10px 0' }}>{t('loading')}（{cards.length} / {cardTotal}）</div>}</>
          }
        </div>
        <div style={{ display: view === 'graph' ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          {/* active 必须跟着视图走：以前恒为 true → 打开任何视图都拉 890KB 图谱（约 3.5s） */}
          {visited.has('graph') && <GraphView t={t} onOpen={openCard} all={allVaults} onAllChange={setAllVaults} onMutate={bump} active={view === 'graph'} visible={view === 'graph'} skin={skin} />}
        </div>
        <div style={{ display: view === 'news' ? 'contents' : 'none' }}>
          {visited.has('news') && <NewsHub t={t} version={dataVer} onUnreadChange={setNewsUnread} />}
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
          {visited.has('audit') && <AuditPanel t={t} onReload={() => { loadAll(); bump() }} version={dataVer} />}
        </div>
        <div style={{ display: view === 'optimize' ? 'contents' : 'none' }}>
          {visited.has('optimize') && <RecoverPanel t={t} onReload={() => { loadAll(); bump() }} version={dataVer} />}
        </div>

        {feedbackOpen && <FeedbackModal t={t} onClose={() => setFeedbackOpen(false)} />}
        {supportOpen && <SupportModal t={t} tab={supportTab} onTab={setSupportTab} onClose={() => setSupportOpen(false)} onFeedback={() => { setSupportOpen(false); setFeedbackOpen(true) }} onReplay={() => { setSupportOpen(false); setOnboardOpen(true) }} />}
        {onboardOpen && <Onboarding t={t} onDone={finishOnboard} />}
        {reader && <CardReader t={t} card={reader} query={query.trim()} onNavigate={(d) => { const i = sortedCards.findIndex((c) => c.path === reader.path); const next = sortedCards[i + d]; if (next) openCard(next) }} onTagClick={onTagPick} onClose={() => setReader(null)} onDelete={(p) => { setReader(null); deleteMemory(p) }} onFeedback={(useful) => { const p = reader.path; fetch(`${API}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query.trim(), path: p, useful }) }).then(() => setLibToast({ ok: true, msg: useful ? t('fbUseful') : t('fbIrr') })).catch(() => {}); if (libToastTimer.current) clearTimeout(libToastTimer.current); libToastTimer.current = setTimeout(() => setLibToast(null), 2000) }} allCards={sortedCards} onOpenRelated={(c) => openCard(c)} onKindChange={changeCardKind} onSaved={async ({ path, status, title }) => {
          try {
            const qs = status && status !== 'approved' ? `&status=${encodeURIComponent(status)}` : ''
            const data = await fetch(`${API}/card?path=${encodeURIComponent(path)}${qs}`).then((x) => x.json())
            if (data && data.ok) setReader((prev) => (prev && prev.path === path ? { ...prev, title: title || data.title || prev.title, text: data.text } : prev))
          } catch { /* 重新拉取失败时保留编辑结果：本地已保存，刷新即见 */ }
          await loadAll(); bump()
          setLibToast({ ok: true, msg: t('editSaved') })
          if (libToastTimer.current) clearTimeout(libToastTimer.current)
          libToastTimer.current = setTimeout(() => setLibToast(null), 2000)
        }} />}
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
const CfgFormContext = createContext({ form: null, set: () => {} })
const BOOL_DEFAULT_ON = new Set(['autoRestartOnDrift', 'coreMemoryEnabled', 'skillCardsAutoSync', 'workingMemoryEnabled'])

/** 配置字段：必须在模块顶层定义。放在 ConfigPanel 里会在每次输入重渲染时换组件类型，
 *  React 于是整棵表单卸载重建 —— 输入框失焦、滚动条回跳（用户反馈根因）。 */
function F({ k, label, hint, type = 'text', step, min, max, wide }) {
  const { form, set } = useContext(CfgFormContext)
  return (
    <label className={'mc-field' + (wide ? ' mc-field-wide' : '')}>
      <span className="mc-field-label">{label || k}</span>
      <input
        type={type}
        step={step} min={min} max={max}
        value={form ? (form[k] ?? '') : ''}
        onChange={(e) => {
          const raw = e.target.value
          set(k, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw)
        }}
      />
      {hint ? <span className="mc-field-hint">{hint}</span> : null}
    </label>
  )
}

function Bool({ k, label }) {
  const { form, set } = useContext(CfgFormContext)
  const raw = form ? form[k] : undefined
  const on = raw === undefined ? BOOL_DEFAULT_ON.has(k) : !!raw
  return (
    <label className="mc-switch">
      <input type="checkbox" checked={on} onChange={(e) => set(k, e.target.checked)} />
      <span>{label || k}</span>
    </label>
  )
}

// 主题皮肤注册表：新增皮肤时在这里加一项（id 必须与 Config.theme 的 union、CSS 的 [data-skin="id"] 对齐）。
const SKINS = [
  ['default', 'themeDefault', 'themeDefaultDesc', ['#1e2228', '#ff7a45', '#f3f5f8']],
  ['pop', 'themePop', 'themePopDesc', ['#fff7e6', '#0f766e', '#ff3b2f']],
  ['light', 'themeLight', 'themeLightDesc', ['#f7f5f0', '#e36a36', '#26221c']],
  ['resident', 'themeResident', 'themeResidentDesc', ['#070b08', '#7cff3f', '#e23a3a']],
  ['spider', 'themeSpider', 'themeSpiderDesc', ['#f2efe6', '#e62429', '#1b3b8b']],
]
function ThemePicker({ t }) {
  const { form, set, applyTheme } = useContext(CfgFormContext)
  const cur = (form && form.theme) || 'default'
  const pick = (id) => {
    if (applyTheme) { applyTheme(id); return }
    set('theme', id)
    try { window.dispatchEvent(new CustomEvent('me-skin', { detail: id })) } catch { /* ignore */ }
  }
  return (
    <div className="mc-theme-grid">
      {SKINS.map(([id, nameKey, descKey, sw]) => (
        <button
          key={id}
          type="button"
          className={'mc-theme-card' + (cur === id ? ' on' : '')}
          aria-pressed={cur === id}
          onClick={() => pick(id)}
        >
          <span className="mc-theme-swatch" style={{ background: sw[0] }} aria-hidden="true">
            <i style={{ background: sw[1] }} />
            <i style={{ background: sw[2] }} />
          </span>
          <b>{t(nameKey)}</b>
          <span>{t(descKey)}</span>
        </button>
      ))}
    </div>
  )
}

function CfgSection({ icon, title, sub, id, children, hidden }) {
  return (
    <section className="mc-card mc-cfg-sec" id={id} data-cfg-sec={id || ''} hidden={hidden || undefined}>
      <div className="mc-cfg-sec-head">
        <div className="mc-cfg-sec-ico">{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div className="mc-cfg-sec-title">{title}</div>
          {sub ? <div className="mc-cfg-sec-sub">{sub}</div> : null}
        </div>
      </div>
      <div className="mc-cfg-sec-body">{children}</div>
    </section>
  )
}

function ConfigPanel({ t, onReload, version, compact }) {
  // 弹窗形态：分页导航（只保留 4 个核心分类）
  const [page, setPage] = useState('general')
  const PAGE_OF = {
    'sec-preset': 'general', 'sec-theme': 'general', 'sec-basic': 'general', 'sec-skills': 'general', 'sec-digest': 'general', 'sec-ui': 'general',
    'sec-memory': 'memory', 'sec-core': 'memory', 'sec-vault': 'memory',
    'sec-cost': 'advanced', 'sec-audit': 'advanced',
    'sec-service': 'service',
  }
  const PAGES = [
    ['general', t('paneGeneral'), t('paneGeneralSub'), '⚙️'],
    ['memory', t('paneMemory'), t('paneMemorySub'), '🧠'],
    ['advanced', t('paneAdvanced'), t('paneAdvancedSub'), '✨'],
    ['service', t('paneService'), t('paneServiceSub'), '🛠'],
  ]
  const curPage = PAGES.find((x) => x[0] === page) || PAGES[0]
  const gotoPage = (p) => {
    setPage(p)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    const btn = typeof document !== 'undefined' ? document.querySelector('.mc-pagebtn[data-page="' + p + '"]') : null
    if (btn) btn.scrollIntoView({ inline: 'center', block: 'nearest' })
  }
  const secProps = (id) => ({ hidden: PAGE_OF[id] !== page })
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
  // 关注摘要：开启前的预览（null = 还没生成过）
  const [digestPreview, setDigestPreview] = useState(null)
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
  // 配置页滚动位置：编辑/保存/按钮触发的重渲染不能把视图弹回顶部。
  const scrollRef = useRef(null)
  const scrollTopRef = useRef(0)
  const onScroll = (e) => { scrollTopRef.current = e.currentTarget.scrollTop }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (Math.abs(el.scrollTop - scrollTopRef.current) > 1) el.scrollTop = scrollTopRef.current
  })
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
  const NUM_KEYS_LIKE = new Set(['dedupThreshold', 'captureMinChars', 'captureCooldownMs', 'maxCardsPerDay', 'captureMaxTokens', 'recallMinScore', 'recallLimit', 'recallSummaryLen', 'recycleRetentionDays', 'webPort', 'webCheckIntervalMs', 'webMaxRestart', 'sessionBudgetChars', 'coreMemoryLimit', 'coreMemoryMaxChars'])
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
      sessionBudgetChars: [0, 1000000000], coreMemoryLimit: [1, 20], coreMemoryMaxChars: [200, 10000],
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
  // 主题皮肤「一键切换」：本地即时换肤 + 只提交 theme 一个字段（不碰其他未保存项）。
  const applyTheme = (id) => {
    if (!['default', 'pop', 'light', 'resident', 'spider'].includes(id)) return
    set('theme', id)
    try { window.dispatchEvent(new CustomEvent('me-skin', { detail: id })) } catch { /* ignore */ }
    // 本地已生效：即便宿主的配置 schema 还是旧版（没有 theme 字段），也绝不弹「无法写入字段」。
    try {
      const base = (cfg && cfg.config) || {}
      const restClean = Object.keys(form || {}).every((k) => k === 'theme' || JSON.stringify(form[k]) === JSON.stringify(base[k]))
      if (restClean) setDirty(false)
    } catch { /* ignore */ }
    setSaved(t('themeApplied'))
    notify(t('themeApplied'), true)
    if (readonly) return
    // 后台尽力把 theme 写进配置（新宿主会持久化；旧宿主拒绝时静默，localStorage 兜底）。
    fetch(`${API}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { theme: id }, expectedRevision: revision }),
    }).then((r) => r.json()).then((d) => {
      if (d && d.ok) savedOverlayRef.current = { ...savedOverlayRef.current, theme: id }
    }).catch(() => { /* 旧宿主没有 theme 字段：本地已生效 */ })
  }
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

  const mcpList = (setupStatus && Array.isArray(setupStatus.agents)) ? setupStatus.agents : []
  const mcpInstalled = mcpList.filter((a) => a.installed)
  const mcpServersAll = [...new Set(mcpInstalled.flatMap((a) => (Array.isArray(a.servers) ? a.servers : [])))]
  const mcpMounted = mcpList.filter((a) => a.mcpConfigured && !a.isDsh).length
  const mcpHasServerData = mcpList.some((a) => Array.isArray(a.servers))
  return (
    <CfgFormContext.Provider value={{ form, set, applyTheme }}>
    <div className="mc-admin" data-skin={(form && form.theme) || 'default'} style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: compact ? '0 0 auto' : 1, minHeight: 0, maxHeight: compact ? '52vh' : undefined }}>
      <style>{CSS}</style>
      {toast && <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'fixed', left: '50%', transform: 'translateX(-50%)', top: 22, zIndex: 70, background: 'rgba(20,22,26,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: '#f5f5f5', borderRadius: 12, padding: '10px 20px', fontSize: 13.5, fontWeight: 600, boxShadow: '0 14px 44px rgba(0,0,0,.5)', pointerEvents: 'none', animation: 'me-pop .22s ease', borderLeft: '4px solid ' + (toast.ok ? '#22c55e' : '#ef4444'), maxWidth: '90vw' }}><span style={{ color: toast.ok ? '#34d399' : '#f87171', fontWeight: 800, fontSize: 15 }}>{toast.ok ? '✓' : '✕'}</span><span style={{ wordBreak: 'break-all' }}>{toast.msg}</span></div>}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable', padding: 4 }}>
        <div className="mc-cfg-page">
          <div className={'mc-cfg-layout' + (compact ? ' compact' : '')}>
            <nav className="mc-pagenav" role="tablist" aria-label={t('tabConfig')}>
              {PAGES.map(([p, label, sub, ico]) => (
                <button key={p} type="button" role="tab" data-page={p} aria-selected={page === p} className={'mc-pagebtn' + (page === p ? ' on' : '')} onClick={() => gotoPage(p)}>
                  <span className="mc-pagebtn-ico" aria-hidden="true">{ico}</span>
                  <span className="mc-pagebtn-txt">
                    <span>{label}</span>
                    <span className="mc-pagebtn-sub">{sub}</span>
                  </span>
                </button>
              ))}
            </nav>
            <div className="mc-cfg-main">
              <div className="mc-panehead">
                <div className="mc-panehead-ico" aria-hidden="true">{curPage[3]}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="mc-panehead-title">{curPage[1]}</div>
                  <div className="mc-panehead-sub">{curPage[2]}</div>
                </div>
              </div>
        {err && <div className="mc-card" style={{ borderLeft: '4px solid #ef4444', background: 'rgba(239,68,68,0.08)', padding: '12px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: '#b91c1c', fontWeight: 600, marginBottom: 6 }}>⚠ {err}</div>
          <button type="button" className="mc-btn" onClick={load}>↻ {t('retry')}</button>
        </div>}
        {readonly && <div className="mc-card" style={{ borderLeft: '4px solid #f59e0b', background: 'rgba(245,158,11,0.08)', padding: '10px 14px', marginBottom: 10, fontSize: 12, color: '#b45309' }}>ℹ️ {t('configNeedsDsh')} —— {t('editInSetting')}</div>}
        {saved && <div className="mc-card" style={{ borderLeft: '4px solid #10b981', background: 'rgba(16,185,129,0.08)', padding: '10px 14px', marginBottom: 10, fontSize: 12, color: '#059669' }}>✓ {saved}</div>}
        {/* 插件信息：版本跟踪（运行中 / 磁盘 / npm 最新）+ 记忆库目录 */}
        {page === 'service' && (cfg && (cfg.version || cfg.dsh?.vaultDir)) && (
          <details className="mc-card mc-env mc-env-fold" open>
            <summary className="mc-env-top">
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
              <span className="mc-fold-caret">▾</span>
            </summary>
            <div className="mc-env-rest">
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
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
          </details>
        )}
        {/* 环境与 MCP 挂载：默认折叠，让页面主体只留配置 */}
        {page === 'service' && setupStatus && setupStatus.agents && (
          <details className="mc-card mc-cfg-sec mc-fold" style={{ marginBottom: 10 }}>
            <summary className="mc-cfg-sec-head">
              <div className="mc-cfg-sec-ico">🔌</div>
              <div style={{ minWidth: 0 }}>
                <div className="mc-cfg-sec-title">{t('mcpSetupStatus')}</div>
                <div className="mc-cfg-sec-sub">
                  {mcpHasServerData ? tf('mcpSummary', { agents: mcpInstalled.length, servers: mcpServersAll.length, mounted: mcpMounted }) + ' · ' : ''}{t('mcpAutoHint')}
                </div>
              </div>
              <span className="mc-cfg-spacer" />
              <span className="mc-fold-caret">▾</span>
            </summary>
            <div className="mc-fold-body">
              <div className="mc-cfg-tools">
                <button type="button" className="mc-btn" style={{ padding: '2px 8px', flex: 'none' }} onClick={refreshSetup}>{t('mcpRefresh')}</button>
                {runSetup && <code style={{ padding: '2px 6px', background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', borderRadius: 4, fontSize: 11 }}>{runSetup}</code>}
              </div>
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
                      {(a.needsRepair || a.mcpNeedsRepair) && <span className="mc-mcp-badge" style={{ color: '#f59e0b' }}>{t('mcpNeedsRepair')}</span>}
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
                    {!a.isDsh && !a.detectedOnly && a.installed && (a.needsRepair || a.mcpNeedsRepair || a.mcpMatchesCurrentNode === false) && (
                      <button type="button" className="mc-btn me-on" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => mcpAction(a.name, 'install')}>{t('repairMcp')}</button>
                    )}
                    {!a.isDsh && !a.detectedOnly && a.installed && a.mcpConfigured === true && (
                      <button type="button" className="mc-btn mc-btn-danger" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => { if (window.confirm(t('uninstallConfirm'))) mcpAction(a.name, 'uninstall') }}>{t('uninstallMcp')}</button>
                    )}
                  </div>
                </div>
              )
            })}
              <div style={{ fontSize: 11, opacity: 0.55 }}>{t('mcpSetupHint')}</div>
            </div>
          </details>
        )}
        {/* 可编辑配置表单 */}
        {form ? (
          <div className="mc-cfg">
            {/* 一键推荐配置：三方案填充 */}
            <CfgSection {...secProps('sec-preset')} id="sec-preset" icon="🎯" title={t('presetConfig')} sub={t('presetHint')}>
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
            {/* 主题皮肤：一键切换整个记忆界面 */}
            <CfgSection {...secProps('sec-theme')} id="sec-theme" icon="🎨" title={t('themeSkin')} sub={t('themeSkinHint')}>
              <ThemePicker t={t} />
            </CfgSection>
            {/* 基础开关（总开关 / 自动沉淀 / 自动召回） */}
            <CfgSection {...secProps('sec-basic')} id="sec-basic" icon="⚡" title={t('basicSwitches')} sub={t('basicSwitchesHint')}>
              <div className="mc-cfg-switches">
                <Bool k="enabled" label={t('enabledLabel')} />
                <Bool k="autoCapture" label={t('autoCapture')} />
                <Bool k="autoRecall" label={t('autoRecall')} />
              </div>
            </CfgSection>
            {/* DSH 记忆配置 */}
            <CfgSection {...secProps('sec-memory')} id="sec-memory" icon="🧠" title={t('dshMemoryConfig')} sub={t('cfgSubCore')}>
              <div className="mc-cfg-switches is-single">
                <Bool k="recallIncludeBody" label={t('recallBody')} />
              </div>
              <div className="mc-cfg-grid">
                <F k="vaultDir" label={t('vaultDirLabel')} wide />
                <F k="recallLimit" label={t('recallLimit')} type="number" />
                <F k="recallSummaryLen" label={t('recallSummaryLen')} hint={t('unitChars')} type="number" />
                <F k="captureMinChars" label={t('captureMinChars')} hint={t('unitChars')} type="number" />
                <F k="maxCardsPerDay" label={t('maxCardsPerDay')} hint={t('unitPerDay')} type="number" />
                <F k="dedupThreshold" label={t('dedupThreshold')} type="number" step="0.01" min="0" max="1" />
                {/* 凭证取用提示：一句自己写的约定，会被注入到每个会话的 systemPrompt（触发 agent 去查目录卡） */}
                <F k="secretHint" label={t('secretHint')} wide />
                <F k="recallEmbedding" label={t('recallEmbedding')} wide />
              </div>
            </CfgSection>
            {/* 核心记忆（前置强制注入） */}
            <CfgSection {...secProps('sec-core')} id="sec-core" icon="⭐" title={t('coreMemory')} sub={t('coreMemoryHint')}>
              <div className="mc-cfg-switches">
                <Bool k="coreMemoryEnabled" label={t('coreMemoryEnabled')} />
                <Bool k="workingMemoryEnabled" label={t('workingMemoryEnabled')} />
              </div>
              <div className="mc-cfg-grid">
                <F k="coreMemoryLimit" label={t('coreMemoryLimit')} type="number" />
                <F k="coreMemoryMaxChars" label={t('coreMemoryMaxChars')} type="number" />
              </div>
            </CfgSection>
            {/* 技能卡（从实际技能生成，强制待审；不由 agent 沉淀） */}
            <CfgSection {...secProps('sec-skills')} id="sec-skills" icon="🧩" title={t('skillCards')} sub={t('skillCardsHint')}>
              <div className="mc-cfg-switches is-single">
                <Bool k="skillCardsAutoSync" label={t('skillAutoSync')} />
              </div>
              <div className="mc-cfg-tools">
                <button type="button" className="mc-btn" disabled={!!busy} onClick={async () => {
                  setBusy('skills')
                  try {
                    const r = await fetch(API + '/skills/sync', { method: 'POST' }).then((x) => x.json()).catch(() => null)
                    if (r && r.ok) {
                      notify(t('skillsSyncDone') + '：' + t('skillsScanned') + ' ' + (r.total || 0) + ' · ' + t('skillsCreated') + ' ' + (r.created || 0) + ' · ' + t('skillsUpdated') + ' ' + (r.updated || 0) + ' · ' + t('skillsPendingUpdates') + ' ' + (r.pendingUpdates || 0))
                    } else notify((r && r.error) || t('skillsSyncFail'), false)
                  } catch (e) { notify(t('skillsSyncFail'), false) } finally { setBusy('') }
                }}>{busy === 'skills' ? '⏳ ' + t('syncingSkills') : '🧩 ' + t('syncSkills')}</button>
              </div>
            </CfgSection>
            {/* 关注摘要：默认关闭，开启后由宿主按间隔抓取并注入 systemPrompt */}
            <CfgSection {...secProps('sec-digest')} id="sec-digest" icon="📬" title={t('newsDigest')} sub={t('newsDigestHint')}>
              <div className="mc-cfg-switches is-single">
                <Bool k="newsDigestEnabled" label={t('newsDigestEnabled')} />
              </div>
              <div className="mc-cfg-grid">
                <F k="newsDigestIntervalMinutes" label={t('newsDigestInterval')} type="number" />
                <F k="newsDigestMaxItems" label={t('newsDigestMaxItems')} type="number" />
              </div>
              <div className="mc-cfg-tools">
                <button type="button" className="mc-btn" disabled={!!busy} onClick={async () => {
                  setBusy('digest')
                  try {
                    const r = await fetch(API + '/news/digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then((x) => x.json()).catch(() => null)
                    if (r && r.ok) {
                      setDigestPreview(r.text || '')
                      notify((r.digest && r.digest.items && r.digest.items.length) ? t('newsDigestDone') : t('newsDigestEmpty'), true)
                    } else notify((r && r.error) || t('newsDigestFail'), false)
                  } catch (e) { notify(t('newsDigestFail'), false) } finally { setBusy('') }
                }}>{busy === 'digest' ? '⏳ ' + t('newsDigestBuilding') : '📬 ' + t('newsDigestNow')}</button>
                <span className="mc-field-hint">{t('newsDigestNowHint')}</span>
              </div>
              {digestPreview !== null ? (
                <pre className="mc-digest-preview">{digestPreview || t('newsDigestEmpty')}</pre>
              ) : null}
            </CfgSection>
            {/* 布局大小：只影响界面显示 */}
            <CfgSection {...secProps('sec-ui')} id="sec-ui" icon="🔠" title={t('uiLayout')} sub={t('uiLayoutHint')}>
              <div className="mc-field">
                <div className="mc-seg">
                  {[['compact', t('uiCompact')], ['normal', t('uiNormal')], ['large', t('uiLarge')]].map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      className={((form && form.uiScale) || 'normal') === v ? 'on' : ''}
                      onClick={() => {
                        set('uiScale', v)
                        try { window.dispatchEvent(new CustomEvent('me-ui-scale', { detail: v })) } catch { /* ignore */ }
                      }}
                    >{label}</button>
                  ))}
                </div>
              </div>
            </CfgSection>
            {/* 多库（按项目隔离记忆）—— #10 */}
            <CfgSection {...secProps('sec-vault')} id="sec-vault" icon="🗂️" title={t('vaultMulti')} sub={t('cfgSubMulti')}>
              <div style={{ fontSize: 11.5, opacity: 0.85, marginBottom: 8, lineHeight: 1.7 }}>
                {t('vaultNow')}：<code>{dsh?.vaultDir || '—'}</code>
                {dsh?.vaultName ? `（${dsh.vaultName}）` : ''}
                {' · '}{t('vaultSource')}：{t(VAULT_SRC_KEYS[dsh?.vaultSource] || 'vaultSrcDefault')}
                {dsh?.workspace ? <><br />{t('vaultWorkspace')}：<code>{dsh.workspace}</code></> : null}
              </div>
              {profilesOf(form).length ? (
                <div className="mc-vault-head">
                  <span>{t('vaultNamePh')}</span>
                  <span>{t('vaultPathPh')}</span>
                  <span>{t('vaultMatchPh')}</span>
                  <span />
                </div>
              ) : null}
              {profilesOf(form).map((p, i) => (
                <div key={i} className="mc-vault-row">
                  <input value={p.name || ''} placeholder={t('vaultNamePh')} onChange={(e) => updateProfile(i, 'name', e.target.value)} style={vaultInput} disabled={readonly} />
                  <input value={p.path || ''} placeholder={t('vaultPathPh')} onChange={(e) => updateProfile(i, 'path', e.target.value)} style={vaultInput} disabled={readonly} />
                  <input value={(p.match && p.match.workspace) || ''} placeholder={t('vaultMatchPh')} onChange={(e) => updateProfile(i, 'match', e.target.value)} style={vaultInput} disabled={readonly} />
                  <button type="button" className="mc-btn" onClick={() => removeProfile(i)} disabled={readonly} title={t('delete')}>✕</button>
                </div>
              ))}
              <div className="mc-cfg-tools" style={{ marginTop: 4 }}>
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
            <CfgSection {...secProps('sec-cost')} id="sec-cost" icon="💰" title={t('costControl')} sub={t('costHint')}>
              <div className="mc-cfg-switches">
                <Bool k="distillEnabled" label={t('distillEnabled')} />
                <Bool k="dedupByLLM" label={t('dedupByLLM')} />
                <Bool k="captureFollowSession" label={t('captureFollowSession')} />
                <Bool k="captureFirstOnly" label={t('captureFirstOnly')} />
              </div>
              <div className="mc-cfg-grid">
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
                <F k="sessionBudgetChars" label={t('sessionBudgetChars')} type="number" />
              </div>
              <div className="mc-cfg-tools">
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
            </CfgSection>
            {/* 自动审核配置 */}
            <CfgSection {...secProps('sec-audit')} id="sec-audit" icon="🛡️" title={t('auditConfig')} sub={t('auditHint')}>
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
                  options={[{ value: '__all__', label: t('allExempt') }, ...KIND_IDS.filter((k) => k !== 'all' && k !== 'core' && k !== 'skill').map((k) => ({ value: k, label: t(KIND_LABELS[k]) }))]}
                  onChange={(v) => set('auditExemptKinds', v)}
                />
                <F k="recycleRetentionDays" label={t('recycleDays')} hint={t('unitDays')} type="number" />
              </div>
            </CfgSection>
            {/* 服务自管理配置 */}
            <CfgSection {...secProps('sec-service')} id="sec-service" icon="🛠" title={t('serviceConfig')} sub={t('cfgSubService')}>
              <div className="mc-cfg-switches">
                <Bool k="autoWeb" label={t('autoWeb')} />
                <Bool k="watchdogAutoSpawn" label={t('watchdogAutoSpawn')} />
                <Bool k="autoRestartOnDrift" label={t('autoRestartOnDrift')} />
                <Bool k="autoMcpSetup" label={t('autoMcpSetup')} />
              </div>
              <div className="mc-cfg-grid">
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
        </div>
      </div>
    </div>
    </CfgFormContext.Provider>
  )
}

/** 审核中心：待审核/驳回卡清单 + 筛选（日期/类型/智能体/全选）+ 批准/驳回。 */
function AuditPanel({ t, onReload, version }) {
  const [pending, setPending] = useState([])
  const [rejected, setRejected] = useState([])
  const [kindF, setKindF] = useState('all')
  const [agentF, setAgentF] = useState('all')
  const [dateF, setDateF] = useState('')
  const [search, setSearch] = useState('')
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
    if (!auditMatches(c, search)) return false
    if (kindF !== 'all' && c.kind !== kindF) return false
    if (agentF !== 'all' && normAgent(c.submittedBy) !== agentF) return false
    // issue #55：日期筛选按**本地**日历日比较（c.created 是 UTC，slice 会错一天）
    if (dateF) { const d = localDateKey(c.created); if (d && d !== dateF) return false }
    return true
  })
  // 左侧类型栏的计数：只按 agent/date 收窄，不按当前 kind，否则切到某类型后其他类型都变 0。
  const kindCounts = useMemo(() => {
    const base = tab === 'pending' ? pending : rejected
    const m = { all: 0 }
    base.forEach((c) => {
      if (!auditMatches(c, search)) return
      if (agentF !== 'all' && normAgent(c.submittedBy) !== agentF) return
      if (dateF) { const d = localDateKey(c.created); if (d && d !== dateF) return }
      m.all++
      m[c.kind || 'other'] = (m[c.kind || 'other'] || 0) + 1
    })
    return m
  }, [pending, rejected, tab, agentF, dateF, search])
  const toggle = (p) => setSel((s) => { const n = new Set(s); if (n.has(p)) { n.delete(p) } else { n.add(p) }; return n })
  const applyStatus = async (status, paths, opts = {}) => {
    const list = paths || [...sel]
    if (!list.length) { notify(t('noSelection'), false); return }
    setBusy('apply')
    const verb = status === 'approved' ? (opts.kind === 'core' ? t('approveCore') : t('toastApproved')) : status === 'rejected' ? t('toastRejected') : t('toastCardDeleted')
    try {
      let failed = 0
      for (const p of list) {
        const ep = status === 'approved' ? 'audit/approve' : status === 'rejected' ? 'audit/reject' : 'delete'
        try {
          const body = status === 'approved' && opts.kind ? { path: p, kind: opts.kind } : null
          const r = await fetch(API + '/' + ep + (body ? '' : '?path=' + encodeURIComponent(p) + (status === 'delete' ? '&permanent=0' : '')), body ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          } : undefined)
          if (!r.ok) failed++
        } catch { failed++ }
      }
      await load(); if (onReload) onReload()
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
  const reclassify = async () => {
    if (!window.confirm(t('reclassify') + '？只处理自动沉淀的待审原文卡，不改人工卡。')) return
    setBusy('reclassify')
    try {
      const r = await fetch(API + '/reclassify').then((x) => x.json())
      if (r && r.ok) notify(t('reclassify') + '：' + r.changed + ' / ' + r.scanned)
      else notify(t('toastFailed') + ': ' + ((r && r.error) || 'HTTP'), false)
      await load(); if (onReload) onReload()
    } catch (e) { notify(t('toastFailed') + ': ' + String((e && e.message) || e), false) } finally { setBusy('') }
  }
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
              <input
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); clearSel(); setPreviewPath(null) }}
                placeholder={t('auditSearchPlaceholder')}
                aria-label={t('auditSearchPlaceholder')}
                style={{ flex: '1 1 220px', minWidth: 160, padding: '5px 9px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', fontSize: 12 }}
              />
              {search && <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} onClick={() => { setSearch(''); clearSel(); setPreviewPath(null) }} title={t('clearFilter')}>✕</button>}
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
              {tab === 'pending' && <button type="button" className="mc-btn" disabled={!!busy} onClick={reclassify}>🔧 {t('reclassify')}</button>}
              <button type="button" className="mc-btn me-on" disabled={!toggled.length || !!busy} onClick={() => applyStatus('approved')}>✓ {tab === 'rejected' ? t('restore') : t('approve')}</button>
              {tab === 'pending'
                ? <button type="button" className="mc-btn mc-btn-danger" disabled={!toggled.length || !!busy} onClick={() => applyStatus('rejected')}>✕ {t('reject')}</button>
                : <button type="button" className="mc-btn mc-btn-danger" disabled={!toggled.length || !!busy} onClick={() => { if (window.confirm(t('recycleDeleteConfirm'))) applyStatus('delete') }}>🗑 {t('restoreDelete')}</button>}
              {toggled.length > 0 && <button type="button" className="mc-btn" onClick={clearSel}>{t('auditClearSelection')}</button>}
            </div>
            {items.length ? (
              <div className="mc-card" style={{ display: 'flex', flexDirection: 'column' }}>
                {items.map((c) => {
                  const color = KIND_COLORS[c.kind] || '#6B7280'
                  return (
                    <div key={c.path} className={`me-audit-row${c.kind === 'core' ? ' core' : ''}${previewCard && previewCard.path === c.path ? " active" : ""}`}>
                      <div className="me-audit-row-main" onClick={() => setPreviewPath(c.path)}>
                        <input type="checkbox" checked={sel.has(c.path)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(c.path)} />
                        <span className="me-audit-row-tile" style={{ color, borderColor: color + '38', background: color + '18' }}>{KIND_EMOJI[c.kind] || '📎'}</span>
                        <div className="me-audit-row-copy">
                          <div className="me-audit-row-top">
                            <span className={`me-audit-row-kind${c.kind === 'core' ? ' core' : ''}`}>{c.kind === 'core' ? '⭐ ' + t('kindCore') : t(KIND_LABELS[c.kind] || 'kindKnowledge')}</span>
                            {c.revision && <span className="me-audit-row-state" style={{ color: '#a78bfa', filter: 'saturate(1.2)' }}>✏️ {t('auditRevision')}</span>}
                            <span className={`me-audit-row-state ${tab === 'pending' ? 'pending' : 'rejected'}`}>{tab === 'pending' ? '⏳ ' + t('statusPending') : '⛔ ' + t('statusRejected')}</span>
                            <span className="me-audit-row-time">{localDateTime(c.created) || '-'}</span>
                          </div>
                          <button type="button" className="me-audit-row-title" title={c.title} onClick={() => setPreviewPath(c.path)}>{c.title}</button>
                          {c.revision && <p className="me-audit-row-reason" style={{ color: '#a78bfa' }}>✏️ {t('auditRevisionFrom')}：{c.revision.targetTitle || c.revision.targetPath}</p>}
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
                              <button type="button" className="mc-btn mc-btn-danger" style={{ padding: '2px 8px' }} onClick={() => applyStatus('rejected', [c.path])}>✕</button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} title={t('restore')} onClick={() => applyStatus('approved', [c.path])}>✓</button>
                              <button type="button" className="mc-btn mc-btn-danger" style={{ padding: '2px 8px' }} title={t('restoreDelete')} onClick={() => { if (window.confirm(t('recycleDeleteConfirm'))) applyStatus('delete', [c.path]) }}>🗑</button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : <div style={{ opacity: 0.6, fontSize: 12, padding: 20, textAlign: 'center' }}>{search ? t('auditNoMatch') : t('noAuditItems')}</div>}
            </div>
            <aside className="me-audit-preview">
              {previewCard ? (
                <>
                  <div className="me-audit-preview-head">
                    <div className="me-audit-preview-top">
                      <span className="me-audit-kind-badge" style={{ color: KIND_COLORS[previewCard.kind] || '#6B7280', borderColor: (KIND_COLORS[previewCard.kind] || '#6B7280') + '59', background: (KIND_COLORS[previewCard.kind] || '#6B7280') + '1a' }}>{KIND_EMOJI[previewCard.kind] || '📎'} {t(KIND_LABELS[previewCard.kind] || 'kindKnowledge')}</span>
                      <span className={`md-chip ${tab === 'pending' ? 'md-chip-st-warn' : 'md-chip-st-bad'}`}>{tab === 'pending' ? (previewCard.kind === 'core' ? '⭐ ' + t('coreSuggested') : '⏳ ' + t('statusPending')) : '⛔ ' + t('statusRejected')}</span>
                      <span className="spacer" style={{ flex: 1 }} />
                      <span style={{ fontSize: 10, opacity: 0.55 }}>{localDateTime(previewCard.created)}</span>
                    </div>
                    <h3>{previewCard.title}</h3>
                    {previewCard.revision && <div className="me-audit-preview-reason" style={{ color: '#a78bfa', marginBottom: 6 }}>✏️ {t('auditRevisionFrom')}：{previewCard.revision.targetTitle || previewCard.revision.targetPath}</div>}
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
                    <button type="button" className="mc-btn me-on" disabled={!!busy} onClick={() => applyStatus('approved', [previewCard.path])}>✓ {tab === 'rejected' ? t('restore') : previewCard.kind === 'core' ? t('approveCore') : t('approve')}</button>
                    {tab === 'pending' && previewCard.kind !== 'core' && !previewCard.revision && (
                      <button type="button" className="mc-btn me-core-btn" disabled={!!busy} onClick={() => applyStatus('approved', [previewCard.path], { kind: 'core' })}>⭐ {t('approveAndCore')}</button>
                    )}
                    {tab === 'pending' && previewCard.kind === 'core' && (
                      <button type="button" className="mc-btn" disabled={!!busy} onClick={() => applyStatus('approved', [previewCard.path], { kind: 'knowledge' })}>{t('approveAsNormal')}</button>
                    )}
                    {tab === 'pending'
                      ? <button type="button" className="mc-btn mc-btn-danger" disabled={!!busy} onClick={() => applyStatus('rejected', [previewCard.path])}>✕ {t('reject')}</button>
                      : <button type="button" className="mc-btn mc-btn-danger" disabled={!!busy} onClick={() => { if (window.confirm(t('recycleDeleteConfirm'))) applyStatus('delete', [previewCard.path]) }}>🗑 {t('restoreDelete')}</button>}
                  </div>
                </>
              ) : <div className="me-audit-preview-empty">{search ? t('auditNoMatch') : t('noAuditItems')}</div>}
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 回收中心：软删卡列表 + 恢复/永久删除 + 30天自动清理提示。 */
const NEWS_EMPTY = { title: '', date: '', category: '', source: '', url: '', tags: '', pinned: false, body: '' }

function newsToday() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function safeNewsUrl(raw) {
  try {
    const u = new URL(String(raw || ''))
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch { return '' }
}

function newsDateGroup(date, t) {
  const d = String(date || '').slice(0, 10)
  if (!d) return t('newsEarlier')
  if (d === newsToday()) return t('newsToday')
  const y = new Date()
  y.setDate(y.getDate() - 1)
  const yd = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0')
  return d === yd ? t('newsYesterday') : d
}

function NewsCard({ item, t, active, onOpen, onEdit, onToggleRead, onDelete }) {
  return (
    <article className={'mc-news-card' + (item.pinned ? ' pinned' : '') + (item.read ? '' : ' unread') + (active ? ' active' : '')} onClick={() => onOpen(item)}>
      <div className="mc-news-top">
        {!item.read && <span className="mc-news-dot" title={t('newsUnread')} />}
        <span className="mc-news-cat">{item.category || t('newsCategoryField')}</span>
        {item.pinned && <span className="mc-news-pin">📌 {t('newsPinned')}</span>}
        <span className="mc-news-time">{item.date || (item.updated || '').slice(0, 10)}</span>
      </div>
      <h3 className="mc-news-title">{item.title}</h3>
      {item.excerpt && <p className="mc-news-excerpt">{item.excerpt}</p>}
      <div className="mc-news-meta">
        {item.source && <span>{item.source}</span>}
        {(item.tags || []).slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}
        <span style={{ marginLeft: 'auto', opacity: .72 }}>{item.read ? t('newsRead') : t('newsUnread')}</span>
        <span className="mc-news-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="mc-btn" onClick={() => onToggleRead(item)}>{item.read ? t('newsMarkUnread') : t('newsMarkRead')}</button>
          <button type="button" className="mc-btn" onClick={() => onEdit(item)}>{t('newsEdit')}</button>
          <button type="button" className="mc-btn mc-btn-danger" onClick={() => onDelete(item)} title={t('delete')}>✕</button>
        </span>
      </div>
    </article>
  )
}

function newsRelTime(ts, t) {
  const diff = Date.now() - Number(ts || 0)
  if (!Number.isFinite(diff) || diff < 0) return ''
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('newsJustNow')
  if (min < 60) return min + ' ' + t('newsMinutesAgo')
  const h = Math.floor(min / 60)
  if (h < 24) return h + ' ' + t('newsHoursAgo')
  const d = Math.floor(h / 24)
  if (d < 7) return d + ' ' + t('newsDaysAgo')
  return new Date(Number(ts)).toISOString().slice(0, 10)
}

/** 新闻偏好：localStorage 持久化「最近一次搜索」与口味权重（重启浏览器仍生效）。 */
const NEWS_LS_QUERY = 'me.news.lastQuery'
const NEWS_LS_PREFS = 'me.news.prefs'
const NEWS_LS_VIEW = 'me.news.view'
const NEWS_TYPE_GLYPH = { model: '模', product: '品', research: '研', opensource: '源', industry: '业', policy: '策', other: '讯' }
const NEWS_STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'in', 'on', 'is', 'are', 'with', 'how', 'why', 'new', 'its', 'it', 'as', 'at', 'by', 'from'])

function newsReadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    try { return JSON.parse(raw) } catch { return raw }
  } catch { return fallback }
}
function newsWriteLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}
/** 读取后做类型收敛：localStorage 里可能是任何东西（老版本裸字符串、被手改的 JSON）。 */
function newsReadLSString(key, fallback = '') {
  const v = newsReadLS(key, fallback)
  return typeof v === 'string' ? v : fallback
}
function newsReadView() {
  const v = newsReadLS(NEWS_LS_VIEW, null)
  return v && typeof v === 'object' ? v : {}
}
function newsPrefsDefault() { return { types: {}, sources: {}, terms: {}, opens: 0, updatedAt: 0 } }
function newsReadPrefs() {
  const p = newsReadLS(NEWS_LS_PREFS, null)
  if (!p || typeof p !== 'object') return newsPrefsDefault()
  return { ...newsPrefsDefault(), ...p, types: p.types || {}, sources: p.sources || {}, terms: p.terms || {} }
}
function newsTermsOf(text) {
  const out = []
  for (const raw of String(text || '').toLowerCase().split(/[^0-9a-z\u4e00-\u9fff]+/)) {
    if (!raw || raw.length < 2 || NEWS_STOP_WORDS.has(raw)) continue
    out.push(raw)
  }
  return out
}
function newsBump(map, key, amount) {
  if (!key) return
  map[key] = Math.min(60, (Number(map[key]) || 0) + amount)
}
/** 记录一次「喜爱」：点开新闻 → 类型/来源/关键词权重 +4。 */
function newsLearn(item, weight, prefs) {
  const next = { ...prefs, types: { ...prefs.types }, sources: { ...prefs.sources }, terms: { ...prefs.terms } }
  if (item) {
    newsBump(next.types, item.type, weight)
    newsBump(next.sources, item.sourceId, weight)
    newsTermsOf(item.title).slice(0, 6).forEach((tk) => newsBump(next.terms, tk, 1))
    next.opens = (Number(prefs.opens) || 0) + 1
  }
  next.updatedAt = Date.now()
  return next
}
function newsLearnQuery(prefs, q) {
  const next = { ...prefs, terms: { ...prefs.terms } }
  newsTermsOf(q).forEach((tk) => newsBump(next.terms, tk, 3))
  next.updatedAt = Date.now()
  return next
}
function newsHue(seed) {
  let h = 0
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}
function newsMonogram(source) {
  const s = String(source || '新闻')
  if (/^[A-Za-z]/.test(s)) {
    const parts = s.split(/\s+/)
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : s.slice(0, 2)).toUpperCase()
  }
  return s.slice(0, 1)
}
/**
 * 这句话是「指令」还是「关键词」？
 *
 * 现场：「帮我推送github最新热门」被当成搜索词做字面过滤 → 列表显示 0 条命中，
 * 而用户其实是在下指令。指令应该走「关注」，不该影响下面的列表。
 * 判据刻意保守：命中指令词，或者像句子（>=4 个词），才按指令处理。
 */
const NEWS_INTENT_RE = /(帮我|请|麻烦|推送|订阅|关注|跟踪|每天|每日|定时|最新|热门|看看|给我|关于|相关)/
function newsLooksLikeIntent(q) {
  const s = String(q || '').trim()
  if (!s) return false
  return NEWS_INTENT_RE.test(s) || s.split(/\s+/).length >= 4
}

/** 推荐打分：新鲜度 + 口味权重 + 搜索命中。 */
function newsScore(item, prefs, applied) {
  const ageHours = Math.max(0, (Date.now() - Number(item.publishedAt || 0)) / 3600000)
  let score = 100 - Math.min(60, ageHours * 0.28)
  score += (Number(prefs.types[item.type]) || 0) * 1.6
  score += (Number(prefs.sources[item.sourceId]) || 0) * 1.1
  const hay = (item.title + ' ' + (item.summary || '')).toLowerCase()
  for (const [term, weight] of Object.entries(prefs.terms)) {
    if (hay.includes(term)) score += Math.min(8, Number(weight) || 0) * 0.9
  }
  const q = String(applied || '').trim().toLowerCase()
  if (q) {
    for (const term of q.split(/\s+/).filter(Boolean)) {
      if (String(item.title || '').toLowerCase().includes(term)) score += 16
      else if (hay.includes(term)) score += 8
    }
  }
  // 关注命中的条目适度前置：用户主动订阅的东西，如果被通用排序压到第 50 条，
  // 等于"关注了个寂寞"（现场：40 条 GitHub 热门全排在中文资讯之后）。
  // 只加 10 分：能浮到前排，但不会把整屏变成订阅流。
  if (item.followId) score += 10
  return score
}

/** 真实 AI 资讯 / 本月热榜：Hero 搜索栏 + 缩略图卡片网格 + 喜爱偏好定制。 */
function NewsFeedPanel({ t, mode, version }) {
  const [items, setItems] = useState([])
  const [types, setTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchedAt, setFetchedAt] = useState(0)
  const [errors, setErrors] = useState([])
  const [feedError, setFeedError] = useState('')
  const [toast, setToast] = useState(null)
  const [query, setQuery] = useState(() => newsReadLSString(NEWS_LS_QUERY))
  const [applied, setApplied] = useState(() => newsReadLSString(NEWS_LS_QUERY).trim())
  const [type, setType] = useState('')
  const [lang, setLang] = useState(() => { const v = newsReadView(); return typeof v.lang === 'string' ? v.lang : 'zh' })
  const [sort, setSort] = useState(() => (newsReadView().sort === 'time' ? 'time' : 'rec'))
  const [prefs, setPrefs] = useState(newsReadPrefs)
  const [swapping, setSwapping] = useState(false)
  // 关注：draft=解析预览（未落库），follows=已关注列表，followFilter=按关注筛选
  const [follows, setFollows] = useState([])
  const [domainEnum, setDomainEnum] = useState([])
  const [followDraft, setFollowDraft] = useState(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [followFilter, setFollowFilter] = useState('')
  const notify = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3200) }

  // 首次挂载恢复的搜索词只「应用」不「加权」：touched / lastQuery 用 ref 标记。
  // 「是否用户真实输入」在输入侧判定（input 的 onChange 置 touchedRef=true，挂载恢复不触发 onChange），
  // 落盘与加权仍放在防抖 effect 里；lastQueryRef 负责同一关键词不重复加权。
  const touchedRef = useRef(false)
  const lastQueryRef = useRef(newsReadLSString(NEWS_LS_QUERY).trim())

  // 搜索防抖：输入停止 260ms 后应用，并记录「最近一次搜索」到 localStorage。
  useEffect(() => {
    const id = setTimeout(() => {
      const q = query.trim()
      setApplied(q)
      if (!touchedRef.current) return
      newsWriteLS(NEWS_LS_QUERY, q)
      if (!q || q === lastQueryRef.current) return
      lastQueryRef.current = q
      setPrefs((p) => { const next = newsLearnQuery(p, q); newsWriteLS(NEWS_LS_PREFS, next); return next })
    }, 260)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => { newsWriteLS(NEWS_LS_VIEW, { lang, sort }) }, [lang, sort])

  // 分类/语言/搜索切换时的列表过渡动效。
  useEffect(() => {
    setSwapping(true)
    const id = setTimeout(() => setSwapping(false), 170)
    return () => clearTimeout(id)
  }, [type, lang, applied, sort])

  const load = useCallback(async () => {
    setLoading(true)
    setFeedError('')
    try {
      // 只在首次挂载 / 手动刷新 / 切换榜单时拉一次，且固定 lang=all（一次拿全中英条目）；
      // 分类 / 搜索 / 语言 / 排序全部本地完成，切语言不会重新请求。
      const qs = new URLSearchParams({ period: mode === 'month' ? 'month' : 'today', lang: 'all' })
      // follows=1：把关注命中并进主 feed（服务端 30 分钟 TTL，不会每次打外网）
      qs.set('follows', '1')
      const r = await fetch(API + '/news/feed?' + qs.toString()).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || t('newsFeedError'))
      setItems(r.items || [])
      if (Array.isArray(r.follows)) setFollows(r.follows)
      setTypes(r.types || [])
      setFetchedAt(Number(r.fetchedAt) || 0)
      setErrors(r.errors || [])
    } catch (e) {
      const msg = (e && e.message) || t('newsFeedError')
      setFeedError(msg)
      notify(msg, false)
    } finally {
      setLoading(false)
    }
  }, [mode, t])

  useEffect(() => { load() }, [version, load])

  // 关注列表 + 域枚举单独拉：feed 只负责条目，关注元数据不该混在条目响应里。
  const loadFollows = useCallback(async () => {
    try {
      const r = await fetch(API + '/news/follows').then((x) => x.json())
      if (r && r.ok) { setFollows(r.follows || []); setDomainEnum(r.domains || []) }
    } catch { /* 关注列表拉不到不影响主 feed */ }
  }, [])
  useEffect(() => { loadFollows() }, [version, loadFollows])

  const refresh = async () => {
    setLoading(true)
    try {
      const r = await fetch(API + '/news/feed/refresh', { method: 'POST' }).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || t('newsFeedError'))
      await load()
      notify(t('newsUpdatedAt') + ' ' + new Date().toLocaleTimeString())
    } catch (e) {
      const msg = (e && e.message) || t('newsFeedError')
      setFeedError(msg)
      notify(msg, false)
      setLoading(false)
    }
  }

  const typeLabelOf = (id) => (types.find((x) => x.id === id) || {}).label || t('all')
  // 关注命中的条目**不受语言筛选影响**：你主动关注了「GitHub 热门」，
  // 它回来的必然是英文仓库；因为默认视图是"中文优先"就把它全藏起来，等于关注了个寂寞。
  const base = (items || []).filter((x) => !lang || x.lang === lang || x.followId)
  const typeCounts = {}
  for (const x of base) typeCounts[x.type] = (typeCounts[x.type] || 0) + 1

  let visible = type ? base.filter((x) => x.type === type) : base
  const appliedIsIntent = newsLooksLikeIntent(applied)
  if (applied && !appliedIsIntent) {
    const terms = applied.toLowerCase().split(/\s+/).filter(Boolean)
    visible = visible.filter((x) => {
      const hay = [x.title, x.summary, x.source, typeLabelOf(x.type)].join(' ').toLowerCase()
      return terms.every((k) => hay.includes(k))
    })
  }
  // 点击关注 chip = 只看这个主题命中的条目（本地筛选，不再发请求）
  if (followFilter) visible = visible.filter((x) => x.followId === followFilter)
  // 月榜排名只看真实热度数据（HN points/comments），不看请求语言：
  // 「本月 + 英文」有排名徽标与热度；「本月 + 中文」没有热度分数 → 归档视图，不伪造排名。
  const newsHeatOf = (item) => (Number(item.points) || 0) + (Number(item.comments) || 0) * 2
  const isMonth = mode === 'month'
  const heatItems = isMonth ? visible.filter((x) => (x.points || 0) > 0) : []
  const showHeat = isMonth && heatItems.length > 0
  const rankOf = new Map()
  if (showHeat) {
    heatItems.slice()
      .sort((a, b) => (b.points || 0) - (a.points || 0) || (b.comments || 0) - (a.comments || 0))
      .forEach((x, i) => rankOf.set(x.id || x.url || x.title, i + 1))
  }
  visible = visible.slice().sort((a, b) => {
    if (sort === 'time') return (b.publishedAt || 0) - (a.publishedAt || 0)
    if (isMonth && showHeat) {
      return (b.points || 0) - (a.points || 0) || (b.comments || 0) - (a.comments || 0) || (b.publishedAt || 0) - (a.publishedAt || 0)
    }
    return newsScore(b, prefs, applied) - newsScore(a, prefs, applied)
  })

  const topTypes = Object.keys(prefs.types || {}).sort((a, b) => (prefs.types[b] || 0) - (prefs.types[a] || 0)).slice(0, 3)
  const topTerms = Object.keys(prefs.terms || {}).sort((a, b) => (prefs.terms[b] || 0) - (prefs.terms[a] || 0)).slice(0, 4)
  const personalized = !!applied || topTypes.length > 0 || topTerms.length > 0
  const useSearch = (value) => {
    touchedRef.current = true
    const q = String(value == null ? '' : value).trim()
    setApplied(q)
    newsWriteLS(NEWS_LS_QUERY, q)
    if (!q || q === lastQueryRef.current) return
    lastQueryRef.current = q
    setPrefs((p) => { const next = newsLearnQuery(p, q); newsWriteLS(NEWS_LS_PREFS, next); return next })
  }
  // 「清除筛选」：本地筛选没结果时用，不触发任何请求，也不重复加权。
  const clearFilters = () => {
    touchedRef.current = false
    lastQueryRef.current = ''
    setType('')
    setLang('')
    setQuery('')
    setApplied('')
    newsWriteLS(NEWS_LS_QUERY, '')
  }
  const remember = (item) => setPrefs((p) => { const next = newsLearn(item, 4, p); newsWriteLS(NEWS_LS_PREFS, next); return next })
  const resetPrefs = () => {
    const empty = newsPrefsDefault()
    newsWriteLS(NEWS_LS_PREFS, empty)
    newsWriteLS(NEWS_LS_QUERY, '')
    lastQueryRef.current = ''
    touchedRef.current = false
    setPrefs(empty)
    setQuery('')
    setApplied('')
  }

  // —— 关注（Follow）——
  // 流程刻意分成「预览 → 确认」两步：用户能看到系统把他的话理解成了什么，
  // 尤其是「搜人物但只有 AI 资讯域」这种覆盖不到的情况，必须在落库前说清楚。
  const previewFollow = async () => {
    const text = query.trim()
    if (!text) { notify(t('newsFollowNoQuery'), false); return }
    setFollowBusy(true)
    try {
      const r = await fetch(API + '/news/follows/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      }).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || t('newsFollowFail'))
      setDomainEnum(r.domainsEnum || domainEnum)
      setFollowDraft({ text, query: r.parsed.query, label: r.parsed.label, domains: r.parsed.domains, sourceIds: r.parsed.sourceIds || [], notes: r.parsed.notes || [] })
    } catch (e) { notify(String((e && e.message) || e), false) } finally { setFollowBusy(false) }
  }
  const toggleDraftDomain = (id, on) => setFollowDraft((d) => {
    if (!d) return d
    const set = new Set(d.domains)
    if (on) set.add(id); else set.delete(id)
    return { ...d, domains: [...set] }
  })
  const confirmFollow = async () => {
    if (!followDraft) return
    setFollowBusy(true)
    try {
      const r = await fetch(API + '/news/follows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: followDraft.query, domains: followDraft.domains, label: followDraft.label, sourceIds: followDraft.sourceIds || [] }),
      }).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || t('newsFollowFail'))
      const label = followDraft.label
      setFollowDraft(null)
      notify((r.duplicate ? t('newsFollowExists') : t('newsFollowAdded')) + '：' + label)
      await loadFollows(); await load()
    } catch (e) { notify(String((e && e.message) || e), false) } finally { setFollowBusy(false) }
  }
  const dropFollow = async (id) => {
    try {
      const r = await fetch(API + '/news/follows?id=' + encodeURIComponent(id), { method: 'DELETE' }).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || t('newsFollowFail'))
      if (followFilter === id) setFollowFilter('')
      notify(t('newsFollowRemoved'))
      await loadFollows(); await load()
    } catch (e) { notify(String((e && e.message) || e), false) }
  }

  // 卡片渲染抽出来：主网格和「关注」区块共用同一套 DOM，避免两处样式漂移。
  const renderTile = (item, index) => {
    const link = safeNewsUrl(item.url)
    const typeLabel = typeLabelOf(item.type)
    const cover = safeNewsUrl(item.image)
    const rankNo = showHeat ? (rankOf.get(item.id || item.url || item.title) || 0) : 0
    // 只有「本月 + 有真实热度分数」时才用热徽标；归档/今日视图一律只显示类型胶囊。
    const hot = showHeat && rankNo > 0 && rankNo <= 3
    return (
      <a
        key={item.id || item.url || item.title}
        className="mc-news-tile"
        style={{ '--i': Math.min(index, 14) }}
        href={link || undefined}
        target={link ? '_blank' : undefined}
        rel="noopener noreferrer"
        onClick={() => remember(item)}
      >
        <span className="mc-news-tile-cover">
          {cover ? (
            <img
              className="mc-news-tile-img"
              src={cover}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => { const img = e.currentTarget; img.style.display = 'none'; if (img.nextElementSibling) img.nextElementSibling.style.display = 'grid' }}
            />
          ) : null}
          <span className="mc-news-tile-gen" style={{ '--hue': newsHue(item.title), display: cover ? 'none' : 'grid' }}>
            <b>{NEWS_TYPE_GLYPH[item.type] || '讯'}</b>
            <small>{typeLabel}</small>
            <em><i>{newsMonogram(item.source)}</i>{item.source}</em>
          </span>
          <span className={'mc-news-tile-badge' + (hot ? ' hot' : '')}>{rankNo ? '#' + rankNo : typeLabel}</span>
          <span className="mc-news-tile-time">{newsRelTime(item.publishedAt, t)}</span>
        </span>
        <span className="mc-news-tile-body">
          <span className="mc-news-tile-title">{item.title}</span>
          {item.summary ? <span className="mc-news-tile-summary">{item.summary}</span> : null}
          <span className="mc-news-tile-foot">
            <i className="mc-news-tile-dot" />
            <span>{item.source}</span>
            {item.followLabel ? <span className="mc-news-tile-follow">🔔 {item.followLabel}</span> : null}
            {rankNo ? <span>· 🔥 {t('newsHeat')} {newsHeatOf(item)}</span> : null}
            <span className="mc-news-tile-open">{t('newsOriginal')} ↗</span>
          </span>
        </span>
      </a>
    )
  }

  // 关注条目单独成区：它们的"时间"不是新闻发布时间（GitHub 是仓库创建时间），
  // 混进新鲜度排序必然吃亏。与其给假时间调分，不如分成两栏各用各的口径。
  const followVisible = visible.filter((x) => x.followId)
  const followTop = followVisible.slice(0, 4)
  const gridItems = followFilter ? visible : (followTop.length ? visible.filter((x) => !x.followId) : visible)

  return (
    <div className="mc-news">
      <InlineToast toast={toast} />
      <div className="mc-news-hero">
        <div className="mc-news-hero-eye">{t('newsHeroEye')}</div>
        <div className="mc-news-hero-search">
          <span aria-hidden="true" style={{ fontSize: 15, opacity: .75 }}>🔎</span>
          <input
            type="text"
            value={query}
            onChange={(e) => { touchedRef.current = true; setQuery(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') useSearch(query) }}
            placeholder={t('newsSearch')}
            aria-label={t('newsSearch')}
          />
          {query ? <button type="button" className="mc-news-hero-clear" title={t('cancel')} onClick={() => { setQuery(''); useSearch('') }}>✕</button> : null}
          <button type="button" className="mc-news-hero-go" onClick={() => useSearch(query)}>{t('newsSearchGo')}</button>
          {query.trim() ? (
            <button type="button" className="mc-news-hero-follow" disabled={followBusy} onClick={previewFollow} title={t('newsFollowPreview')}>
              ＋ {t('newsFollow')}
            </button>
          ) : null}
        </div>
        <div className="mc-news-hero-hint">{appliedIsIntent ? t('newsIntentHint') : t('newsHeroHint')}</div>
      </div>
      {followDraft ? (
        <div className="mc-news-follow-draft">
          <div className="draft-head">🔔 {t('newsFollowPreview')}</div>
          <div className="draft-body">
            <b>{followDraft.label}</b>
            {followDraft.query ? <span className="draft-q">· 「{followDraft.query}」</span> : null}
            <div className="draft-doms">
              <span className="draft-lbl">{t('newsFollowDomains')}</span>
              {domainEnum.map((d) => (
                <label key={d.id} className="draft-opt" title={d.hint || ''}>
                  <input type="checkbox" checked={followDraft.domains.includes(d.id)} onChange={(e) => toggleDraftDomain(d.id, e.target.checked)} />
                  <span>{d.label}</span>
                </label>
              ))}
            </div>
            {followDraft.notes.map((n, i) => <div key={i} className="draft-note">· {n}</div>)}
          </div>
          <div className="draft-actions">
            <button type="button" className="mc-btn" onClick={() => setFollowDraft(null)}>{t('cancel')}</button>
            <button type="button" className="mc-btn me-on" disabled={followBusy || !followDraft.domains.length} onClick={confirmFollow}>{t('newsFollowConfirm')}</button>
          </div>
        </div>
      ) : null}
      {follows.length > 0 ? (
        <div className="mc-news-follows">
          {follows.map((f) => (
            <span key={f.id} className={'mc-news-follow-chip' + (followFilter === f.id ? ' on' : '')}>
              <button type="button" className="chip-main" onClick={() => setFollowFilter((v) => (v === f.id ? '' : f.id))} title={(f.domains || []).join(' / ')}>
                🔔 {f.label}<i>{f.count || 0}</i>
              </button>
              <button type="button" className="chip-x" title={t('delete')} aria-label={t('delete')} onClick={() => dropFollow(f.id)}>✕</button>
            </span>
          ))}
        </div>
      ) : null}
      {personalized ? (
        <div className="mc-news-pref">
          <span>🎯 {t('newsPersonalized')}</span>
          {applied ? <span>· {t('newsLastQuery')} <b>{applied}</b></span> : null}
          {topTerms.length > 0 ? <span>· {topTerms.join(' / ')}</span> : null}
          {topTypes.length > 0 ? <span>· {topTypes.map(typeLabelOf).join(' / ')}</span> : null}
          <span className="mc-news-pref-actions">
            <button type="button" className="mc-btn" onClick={resetPrefs}>{t('newsResetPrefs')}</button>
          </span>
        </div>
      ) : null}
      <div className="mc-news-feed-toolbar">
        <div className="mc-news-pills">
          <button type="button" className={'mc-news-pill' + (type === '' ? ' on' : '')} onClick={() => setType('')}>{t('all')}<span className="mc-news-pill-count">{base.length}</span></button>
          {types.map((x) => (typeCounts[x.id]
            ? <button key={x.id} type="button" className={'mc-news-pill' + (type === x.id ? ' on' : '')} onClick={() => setType(type === x.id ? '' : x.id)}>{x.label}<span className="mc-news-pill-count">{typeCounts[x.id]}</span></button>
            : null))}
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className={'mc-chip' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>{t('newsLangZh')}</button>
          <button type="button" className={'mc-chip' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>{t('newsLangEn')}</button>
          <button type="button" className={'mc-chip' + (lang === '' ? ' active' : '')} onClick={() => setLang('')}>{t('newsLangAll')}</button>
          <button type="button" className={'mc-chip' + (sort === 'rec' ? ' active' : '')} onClick={() => setSort('rec')}>{t('newsSortRec')}</button>
          <button type="button" className={'mc-chip' + (sort === 'time' ? ' active' : '')} onClick={() => setSort('time')}>{t('newsSortTime')}</button>
          <button type="button" className="mc-btn" disabled={loading} onClick={refresh}>{loading ? t('newsLoading') : t('newsFeedRefresh')}</button>
        </span>
      </div>
      <div className="mc-news-feed-meta" style={{ margin: '0 0 8px' }}>
        {fetchedAt ? t('newsUpdatedAt') + ' ' + new Date(fetchedAt).toLocaleTimeString() : ''}
        {!loading ? ' · ' + visible.length + ' ' + t('newsMatched') : ''}
      </div>
      {mode === 'month' && (
        <div className="mc-news-feed-warn" style={{ color: 'var(--dsw-alias-label-secondary, #6b7280)', background: 'transparent', borderColor: 'var(--dsw-alias-border-l1, #e5e7eb)' }}>
          {showHeat ? t('newsEnRanking') : t('newsZhArchive')}
        </div>
      )}
      {feedError && !loading && (
        <div className="mc-news-feed-warn" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>⚠ {feedError}</span>
          <button type="button" className="mc-btn" onClick={refresh}>{t('newsRetry')}</button>
        </div>
      )}
      {errors.length > 0 && <div className="mc-news-feed-warn">⚠ {t('newsPartialFail')}：{errors.slice(0, 2).join('；')}</div>}
      {loading ? (
        <div className="mc-card mc-news-feed-empty mc-news-loading-card" role="status" aria-live="polite">
          <ProgressBar />
          <span>{t('newsLoading')}</span>
          <small>{t('newsLoadingHint')}</small>
        </div>
      ) : items.length === 0 ? (
        <div className="mc-card mc-news-feed-empty">
          <div>{t('newsFeedEmpty')}</div>
          <button type="button" className="mc-btn me-on" style={{ marginTop: 10 }} onClick={refresh}>{t('newsFeedRefresh')}</button>
        </div>
      ) : visible.length === 0 ? (
        <div className="mc-card mc-news-feed-empty mc-news-nomatch">
          <div>{t('newsNoMatch')}</div>
          <p style={{ margin: '6px 0 0', fontSize: 11.5, lineHeight: 1.6, opacity: .75 }}>{t('newsNoMatchHint')}</p>
          <button type="button" className="mc-btn me-on" style={{ marginTop: 10 }} onClick={clearFilters}>{t('newsClearFilters')}</button>
        </div>
      ) : (
        <>
          {!followFilter && followTop.length > 0 ? (
            <div className="mc-news-follow-sec">
              <div className="mc-news-follow-sec-head">
                <span>🔔 {t('newsFollowing')}</span>
                <em>{followVisible.length}</em>
              </div>
              <div className={'mc-news-grid' + (swapping ? ' is-swapping' : '')}>
                {followTop.map((item, index) => renderTile(item, index))}
              </div>
            </div>
          ) : null}
        <div className={'mc-news-grid' + (swapping ? ' is-swapping' : '')}>
          {gridItems.map((item, index) => renderTile(item, index))}
        </div>
        </>
      )}
    </div>
  )
}

/** 新闻首页：今日新闻 / 本月榜单 / 我的新闻。 */
function NewsHub({ t, version, onUnreadChange }) {
  const [mode, setMode] = useState('daily')
  const sub = mode === 'month' ? 'newsMonthlySub' : mode === 'mine' ? 'newsMineSub' : 'newsDailySub'
  return (
    <div className="mc-news">
      <div className="mc-v5-pagehead">
        <div>
          <div className="mc-v5-eyebrow">NEWSROOM</div>
          <h1>{t('newsTitle')}</h1>
          <p>{t(sub)}</p>
        </div>
      </div>
      <div className="mc-news-modes">
        <button type="button" className={'mc-news-mode' + (mode === 'daily' ? ' active' : '')} onClick={() => setMode('daily')}>{t('newsDaily')}</button>
        <button type="button" className={'mc-news-mode' + (mode === 'month' ? ' active' : '')} onClick={() => setMode('month')}>{t('newsMonthly')}</button>
        <button type="button" className={'mc-news-mode' + (mode === 'mine' ? ' active' : '')} onClick={() => setMode('mine')}>{t('newsMine')}</button>
      </div>
      {mode === 'mine'
        ? <MyNewsPanel t={t} version={version} onUnreadChange={onUnreadChange} />
        : <NewsFeedPanel t={t} mode={mode} version={version} />}
    </div>
  )
}

/** 我的新闻：用户自定义 Markdown，独立于记忆卡。 */
function MyNewsPanel({ t, version, onUnreadChange }) {
  const [items, setItems] = useState([])
  const [categories, setCategories] = useState([])
  const [counts, setCounts] = useState({ all: 0, unread: 0 })
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState(null)
  const [editor, setEditor] = useState(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState(null)
  const notify = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 2600) }

  useEffect(() => {
    const id = setTimeout(() => setQ(query.trim()), 220)
    return () => clearTimeout(id)
  }, [query])

  const load = useCallback(async () => {
    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (category) qs.set('category', category)
    if (unreadOnly) qs.set('unread', '1')
    try {
      const r = await fetch(API + '/news?' + qs.toString()).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || 'load failed')
      setItems(r.items || [])
      setCategories(r.categories || [])
      setCounts(r.counts || { all: 0, unread: 0 })
      if (onUnreadChange) onUnreadChange(Number((r.counts || {}).unread) || 0)
    } catch {
      notify(t('newsSaveFail'), false)
    }
  }, [q, category, unreadOnly, onUnreadChange, t])

  useEffect(() => { load() }, [version, load])

  const openNews = async (item) => {
    setSelectedId(item.id)
    try {
      const r = await fetch(API + '/news/item?id=' + encodeURIComponent(item.id)).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || 'load failed')
      setDetail(r.item)
      if (!r.item.read) await setRead(item.id, true)
    } catch {
      notify(t('newsSaveFail'), false)
    }
  }

  const setRead = async (id, read) => {
    try {
      const r = await fetch(API + '/news/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, read }) }).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || 'read failed')
      setDetail((d) => (d && d.id === id ? { ...d, read: !!read } : d))
      await load()
    } catch {
      notify(t('newsSaveFail'), false)
    }
  }

  const openEditor = async (item) => {
    setPreview(false)
    if (item) {
      let src = item
      // 列表接口不带正文；编辑列表项时先取完整正文，避免保存成空卡。
      if (!src.body) {
        try {
          const r = await fetch(API + '/news/item?id=' + encodeURIComponent(src.id)).then((x) => x.json())
          if (r && r.ok) src = r.item
        } catch { /* 取不到就按空正文打开，用户可重新输入 */ }
      }
      setEditor({
        id: src.id,
        title: src.title || '',
        date: src.date || newsToday(),
        category: src.category || '',
        source: src.source || '',
        url: src.url || '',
        tags: (src.tags || []).join(', '),
        pinned: !!src.pinned,
        body: src.body || '',
        created: src.created || '',
      })
    } else {
      setEditor({ ...NEWS_EMPTY, date: newsToday() })
    }
  }

  const saveEditor = async () => {
    if (!editor) return
    if (!String(editor.title || '').trim() || !String(editor.body || '').trim()) {
      notify(t('newsSaveFail'), false)
      return
    }
    setBusy('save')
    try {
      const payload = {
        id: editor.id || undefined,
        title: editor.title,
        date: editor.date,
        category: editor.category,
        source: editor.source,
        url: editor.url,
        tags: String(editor.tags || '').split(',').map((x) => x.trim()).filter(Boolean),
        pinned: !!editor.pinned,
        body: editor.body,
        created: editor.created,
      }
      const r = await fetch(API + '/news/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || 'save failed')
      setEditor(null)
      setSelectedId(r.item.id)
      setDetail(r.item)
      await load()
      notify(t('newsSaved'))
    } catch (e) {
      notify((e && e.message) || t('newsSaveFail'), false)
    } finally {
      setBusy('')
    }
  }

  const deleteItem = async (item) => {
    if (!window.confirm(t('newsDeleteConfirm'))) return
    setBusy('delete')
    try {
      const r = await fetch(API + '/news/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) }).then((x) => x.json())
      if (!r || !r.ok) throw new Error((r && r.error) || 'delete failed')
      if (selectedId === item.id) { setSelectedId(''); setDetail(null) }
      await load()
      notify(t('newsDeleted'))
    } catch {
      notify(t('newsSaveFail'), false)
    } finally {
      setBusy('')
    }
  }

  const pinned = items.filter((x) => x.pinned)
  const rest = items.filter((x) => !x.pinned)
  const detailLink = detail ? safeNewsUrl(detail.url) : ''
  let lastGroup = ''
  return (
    <div className="mc-news">
      <InlineToast toast={toast} />
      <div className="mc-news-toolbar">
        <span className="mc-news-feed-meta" style={{ marginLeft: 0 }}>{counts.all} {t('newsCountUnit')} · {counts.unread} {t('newsUnread')}</span>
        <button type="button" className="mc-btn me-on" onClick={() => openEditor(null)}>＋ {t('newsNew')}</button>
        <input className="mc-news-search" type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('newsSearch')} aria-label={t('newsSearch')} />
        <button type="button" className={'mc-chip' + (category === '' ? ' active' : '')} onClick={() => setCategory('')}>{t('all')}</button>
        {categories.map((c) => (
          <button key={c} type="button" className={'mc-chip' + (category === c ? ' active' : '')} onClick={() => setCategory((v) => (v === c ? '' : c))}>{c}</button>
        ))}
        <button type="button" className={'mc-chip' + (unreadOnly ? ' active' : '')} onClick={() => setUnreadOnly((v) => !v)}>{t('newsUnreadOnly')}</button>
        <button type="button" className="mc-btn" onClick={() => load()}>{t('refresh')}</button>
      </div>

      <div className="mc-news-main">
        <div className="mc-news-list">
          {items.length === 0 ? (
            <div className="mc-card mc-news-empty">
              {query || category || unreadOnly ? t('newsNoMatch') : t('newsEmpty')}
              {!query && !category && !unreadOnly && <div style={{ marginTop: 10 }}><button type="button" className="mc-btn me-on" onClick={() => openEditor(null)}>＋ {t('newsNew')}</button></div>}
            </div>
          ) : (
            <>
              {pinned.length > 0 && (
                <div className="mc-news-group">
                  <div className="mc-news-group-label">📌 {t('newsPinned')}</div>
                  {pinned.map((item) => <NewsCard key={item.id} item={item} t={t} active={selectedId === item.id} onOpen={openNews} onEdit={(x) => openEditor(x)} onToggleRead={(x) => setRead(x.id, !x.read)} onDelete={deleteItem} />)}
                </div>
              )}
              <div className="mc-news-group">
                {rest.map((item) => {
                  const group = newsDateGroup(item.date, t)
                  const show = group !== lastGroup
                  lastGroup = group
                  return (
                    <React.Fragment key={item.id}>
                      {show && <div className="mc-news-group-label">{group}</div>}
                      <NewsCard item={item} t={t} active={selectedId === item.id} onOpen={openNews} onEdit={(x) => openEditor(x)} onToggleRead={(x) => setRead(x.id, !x.read)} onDelete={deleteItem} />
                    </React.Fragment>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {detail && (
          <aside className="mc-news-reader">
            <div className="mc-news-reader-head">
              <span className="mc-news-cat">{detail.category || t('newsCategoryField')}</span>
              {detail.pinned && <span className="mc-news-pin">📌 {t('newsPinned')}</span>}
              <div style={{ flex: 1 }} />
              <button type="button" className="mc-btn" style={{ padding: '2px 8px' }} onClick={() => { setDetail(null); setSelectedId('') }} title={t('close')}>✕</button>
            </div>
            <h2>{detail.title}</h2>
            <div className="mc-news-reader-meta">
              <span>{detail.date || ''}</span>
              {detail.source && <span>· {detail.source}</span>}
              <span>· {detail.read ? t('newsRead') : t('newsUnread')}</span>
              {(detail.tags || []).map((tag) => <span key={tag}>#{tag}</span>)}
            </div>
            {detailLink && <div style={{ marginTop: 8 }}><a className="mc-btn" style={{ textDecoration: 'none' }} href={detailLink} target="_blank" rel="noopener noreferrer">↗ {t('newsOpenLink')}</a></div>}
            <div className="md-doc" style={{ marginTop: 12 }} dangerouslySetInnerHTML={{ __html: renderMd(stripRepeatedTitle(detail.body || '', detail.title)) }} />
            <div className="mc-news-reader-actions">
              <button type="button" className="mc-btn" onClick={() => openEditor(detail)}>{t('newsEdit')}</button>
              <button type="button" className="mc-btn" onClick={() => setRead(detail.id, !detail.read)}>{detail.read ? t('newsMarkUnread') : t('newsMarkRead')}</button>
              <button type="button" className="mc-btn mc-btn-danger" disabled={busy === 'delete'} onClick={() => deleteItem(detail)}>{t('delete')}</button>
            </div>
          </aside>
        )}
      </div>

      {editor && (
        <div className="me-overlay" onClick={() => setEditor(null)}>
          <div className="me-dialog" style={{ maxWidth: 860, width: '94vw', maxHeight: '90vh' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' }}>
              <b>{editor.id ? t('newsEdit') : t('newsNew')}</b>
              <div style={{ flex: 1 }} />
              <button type="button" className="mc-btn" onClick={() => setEditor(null)}>{t('close')}</button>
            </div>
            <div style={{ padding: 16, overflow: 'auto', maxHeight: 'calc(90vh - 60px)' }}>
              <div className="mc-news-form">
                <label className="full"><span>{t('newsTitleField')}</span><input className="mc-news-input" value={editor.title} onChange={(e) => setEditor((v) => ({ ...v, title: e.target.value }))} placeholder={t('newsTitlePlaceholder')} /></label>
                <label><span>{t('newsDateField')}</span><input className="mc-news-input" type="date" value={editor.date || ''} onChange={(e) => setEditor((v) => ({ ...v, date: e.target.value }))} /></label>
                <label><span>{t('newsCategoryField')}</span><input className="mc-news-input" list="me-news-categories" value={editor.category || ''} onChange={(e) => setEditor((v) => ({ ...v, category: e.target.value }))} /></label>
                <datalist id="me-news-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
                <label><span>{t('newsSourceField')}</span><input className="mc-news-input" value={editor.source || ''} onChange={(e) => setEditor((v) => ({ ...v, source: e.target.value }))} /></label>
                <label><span>{t('newsUrlField')}</span><input className="mc-news-input" value={editor.url || ''} onChange={(e) => setEditor((v) => ({ ...v, url: e.target.value }))} placeholder="https://…" /></label>
                <label><span>{t('newsTagsField')}</span><input className="mc-news-input" value={editor.tags || ''} onChange={(e) => setEditor((v) => ({ ...v, tags: e.target.value }))} /></label>
                <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 18 }}><input type="checkbox" checked={!!editor.pinned} onChange={(e) => setEditor((v) => ({ ...v, pinned: e.target.checked }))} /><span>{t('newsPinField')}</span></label>
                <label className="full"><span>{t('newsBodyField')}</span><textarea className="mc-news-textarea" value={editor.body || ''} onChange={(e) => setEditor((v) => ({ ...v, body: e.target.value }))} placeholder={t('newsBodyPlaceholder')} /></label>
                {preview && <div className="full mc-news-preview"><div className="md-doc" dangerouslySetInnerHTML={{ __html: renderMd(editor.body || '') }} /></div>}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                <button type="button" className="mc-btn" onClick={() => setPreview((v) => !v)}>{preview ? t('newsEditBody') : t('newsPreview')}</button>
                <button type="button" className="mc-btn" onClick={() => setEditor(null)}>{t('cancel')}</button>
                <button type="button" className="mc-btn me-on" disabled={busy === 'save'} onClick={saveEditor}>{busy === 'save' ? t('newsSaving') : t('newsSave')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

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
          {/* issue #57：这里过去有三个叠加缺陷 ——
              ① 文案取错 key（emptyRecycle＝「回收站为空」），按钮本身就在说"空的"；
              ② 调的是 purge-expired?days=0，而服务端 `|| 30` 把 0 吞成 30，只清过期项；
              ③ 无二次确认，也从不显示清掉了几张。
              现在改成显式 purge-all + 确认 + 回显数量。 */}
          <button type="button" className="mc-btn mc-danger" disabled={!!busy || items.length === 0} title={items.length ? t('recyclePurgeAllConfirm').split('{n}').join(String(items.length)) : t('emptyRecycle')} onClick={async () => {
            if (!items.length) return
            if (!window.confirm(t('recyclePurgeAllConfirm').split('{n}').join(String(items.length)))) return
            setBusy('purgeAll')
            try {
              const r = await fetch(API + '/recycle/purge-all', { method: 'POST' })
              const d = await r.json().catch(() => null)
              await load(); if (onReload) onReload()
              if (r.ok && (!d || d.ok !== false)) notify(t('toastPurgeAll').split('{n}').join(String(d && d.purged != null ? d.purged : items.length)), true)
              else notify(t('toastFailed') + '：' + ((d && d.error) || ('HTTP ' + r.status)), false)
            } catch (e) { notify(t('toastFailed') + '：' + String((e && e.message) || e), false) } finally { setBusy('') }
          }}>🗑 {t('recyclePurgeAll')}{items.length ? '（' + items.length + '）' : ''}</button>
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
                    <span>{t(KIND_LABELS[c.kind] || 'kindKnowledge')} · {c.status === 'rejected' ? t('rejected') : t('bucketDeleted')} · {localDateKey(c.deletedAt || c.updated) || '-'}</span>
                  </div>
                  <div className="mc-v5-recycle-actions">
                    <button type="button" className="mc-btn" disabled={!!busy} title={c.status === 'rejected' ? t('restoreToQueue') : t('restore')} onClick={() => action('restore', c.path)}>{c.status === 'rejected' ? t('restoreToQueue') : t('restore')}</button>
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
const CardRow = ({ card, t, onOpen, query, onDelete, onTagClick, pinned, onPin, onCore, links }) => {
  const color = KIND_COLORS[card.kind] || KIND_COLORS.other
  const linkCount = Number(links ?? card.links ?? card.weight ?? 0)
  const tags = tagsOf(card)
  return (
    <article className={`mc-cardrow mc-card mc-v5-card${pinned ? ' pinned' : ''}${card.kind === 'core' ? ' core' : ''}`} style={{ '--card-accent': color }} onClick={() => onOpen(card)}>
      <div className="mc-v5-card-top">
        <span className="mc-v5-card-tile" style={{ color, background: color + '18', borderColor: color + '38' }}>{KIND_EMOJI[card.kind] || '📎'}</span>
        <span className="mc-v5-card-kind-name">{card.kind === 'core' ? '⭐ ' + t('kindCore') : t(KIND_LABELS[card.kind] || 'kindKnowledge')}</span>
        {card.kind === 'core' && <span className="mc-v5-core-badge">⭐ {t('kindCore')}</span>}
        {card.status === 'pending' && <span className="mc-v5-card-status pending">⏳ {t('statusPending')}</span>}
        {card.status === 'rejected' && <span className="mc-v5-card-status rejected">⛔ {t('statusRejected')}</span>}
        {isNewCard(card.updated) && <span className="mc-new">{t('newBadge')}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="mc-v5-card-time">{fmtDate(card.updated)}</span>
        {onCore && card.status !== 'pending' && card.status !== 'rejected' && (
          <button type="button" className={`mc-v5-core${card.kind === 'core' ? ' on' : ''}`} title={t(card.kind === 'core' ? 'unsetCore' : 'setCore')} onClick={(e) => { e.stopPropagation(); onCore(card.path, card.kind === 'core' ? 'knowledge' : 'core') }}>
            {card.kind === 'core' ? '⭐ ' + t('coreShort') : '☆ ' + t('setCoreShort')}
          </button>
        )}
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
  const kinds = FORM_KINDS
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
                        <div key={r.label} className="me-health-row" style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '3px 0', borderTop: '1px solid rgba(127,127,127,0.10)' }}>
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
                        <button type="button" className="mc-btn mc-btn-danger" disabled={!!busy} onClick={async () => {
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
            {FORM_KINDS.map((k) => <option key={k} value={k} style={{ background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #111)' }}>{t(KIND_LABELS[k]) || k}</option>)}
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
                {qr('support/group-qr.jpg', t('supportGroupQQ'))}
                {qr('support/group-wechat.jpg', t('supportGroupWechat'))}
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
                {qr('support/alipay.jpg', t('supportAlipay'))}
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

function CardReader({ t, card, query, onClose, onDelete, onFeedback, onNavigate, onTagClick, allCards, onOpenRelated, onKindChange, onSaved }) {
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
  const status = String(card.status || metaOf('status') || 'approved').toLowerCase()
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

  // 进入编辑：用当前卡片的标题 / 标签 / 正文填草稿（正文取 frontmatter 之后的纯正文）
  const startEdit = () => {
    setETitle(String(card.title || ''))
    setETags((Array.isArray(tags) ? tags : []).join(', '))
    setEBody(String(body || ''))
    setSaveErr('')
    setEditing(true)
  }
  const cancelEdit = () => { setEditing(false); setSaveErr('') }
  const saveEdit = async () => {
    const nextTitle = String(eTitle || '').trim()
    const nextBody = String(eBody || '').trim()
    if (!nextTitle) { setSaveErr(t('editTitleEmpty')); return }
    if (!nextBody) { setSaveErr(t('editBodyEmpty')); return }
    const nextTags = String(eTags || '').split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean)
    setSaving(true); setSaveErr('')
    try {
      const r = await fetch(`${API}/card/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: card.path, title: nextTitle, tags: nextTags, body: nextBody }),
      }).then((x) => x.json())
      if (!r || !r.ok) { setSaveErr((r && r.error) || t('editFail')); return }
      setEditing(false)
      if (onSaved) await onSaved({ path: card.path, status, title: nextTitle })
    } catch (e) {
      setSaveErr(String((e && e.message) || e))
    } finally { setSaving(false) }
  }
  // 默认「全部展开」，可收起（用户要求：打开卡片即读全文，需要时再折起来）。
  const [expanded, setExpanded] = useState(true)
  // 手动编辑：只允许改标题 / 标签 / 正文；状态、类型、来源仍走审核与系统流转（issue: 知识卡可编辑）
  const [editing, setEditing] = useState(false)
  const [eTitle, setETitle] = useState('')
  const [eTags, setETags] = useState('')
  const [eBody, setEBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const readerMainRef = useRef(null)
  const [activeHeading, setActiveHeading] = useState('')
  const scrollToHeading = (id) => {
    const container = readerMainRef.current
    if (!container) return
    const el = document.getElementById(id)
    if (!el || !container.contains(el)) return
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 12
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }
  const jumpToHeading = (id) => {
    if (!expanded) {
      setExpanded(true)
      setTimeout(() => scrollToHeading(id), 80)
      return
    }
    scrollToHeading(id)
  }
  const onReaderScroll = (e) => {
    const el = e.currentTarget
    const max = el.scrollHeight - el.clientHeight
    setProgress(max <= 0 ? 100 : Math.min(100, Math.max(0, (el.scrollTop / max) * 100)))
    const heads = el.querySelectorAll('.md-doc .md-h')
    let active = ''
    const base = el.getBoundingClientRect().top + 28
    for (const h of heads) {
      if (h.getBoundingClientRect().top <= base) active = h.id
      else break
    }
    setActiveHeading(active)
  }
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
            <button type="button" className="mc-btn" title={t('editCard')} onClick={editing ? cancelEdit : startEdit}>{editing ? '✖ ' + t('editCancel') : '✏️ ' + t('editCard')}</button>
            <button type="button" className="mc-btn" title={t('readWidth')} onClick={() => { const order = ['narrow', 'mid', 'wide']; const next = order[(order.indexOf(widthMode) + 1) % order.length]; setWidthMode(next); try { localStorage.setItem('me-read-width', next) } catch { /* 隐私模式忽略 */ } }}>{t('readWidth')} · {t(widthMode === 'narrow' ? 'widthNarrow' : widthMode === 'wide' ? 'widthWide' : 'widthMid')}</button>
            <button type="button" className="mc-btn" onClick={() => onFeedback && onFeedback(true)}>👍 {t('fbUseful')}</button>
            <button type="button" className="mc-btn" onClick={() => onFeedback && onFeedback(false)}>👎 {t('fbIrr')}</button>
            {long && <button type="button" className="mc-btn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>{expanded ? t('collapse') : t('expand')}</button>}
            <button type="button" className="mc-btn mc-btn-danger" onClick={() => { if (window.confirm(t('deleteConfirm'))) onDelete && onDelete(card.path) }}>{t('delete')}</button>
            {onKindChange && status === 'approved' && (kind === 'core'
              ? <button type="button" className="mc-btn" onClick={() => onKindChange(card.path, 'knowledge')}>{t('unsetCore')}</button>
              : <button type="button" className="mc-btn" onClick={() => onKindChange(card.path, 'core')}>⭐ {t('setCore')}</button>)}
            <button type="button" className="mc-btn" onClick={onClose}>{t('close')}</button>
          </div>
        </div>
        {onKindChange && (
          <div className={'me-core-banner' + (kind === 'core' ? ' on' : '')}>
            <div className="me-core-banner-k">⭐ {t('kindCore')}</div>
            <div className="me-core-banner-desc">{kind === 'core' ? t('coreActiveHint') : t('coreInactiveHint')}</div>
            {status === 'approved'
              ? <button type="button" className="mc-btn me-core-btn" onClick={() => onKindChange(card.path, kind === 'core' ? 'knowledge' : 'core')}>
                  {kind === 'core' ? t('unsetCore') : '⭐ ' + t('setCore')}
                </button>
              : <span className="me-core-banner-desc" style={{ flex: 'none', opacity: .6 }}>{t('coreNeedApproval')}</span>}
          </div>
        )}
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
            ref={readerMainRef}
            onScroll={onReaderScroll}
            onClick={expanded ? undefined : (e) => { e.stopPropagation(); setExpanded(true) }}>
            {!editing && !!readerLead && (
              <div className="me-reader-callout">
                <span className="me-reader-callout-k">{t(cardInsightKey(card))}</span>
                <p>{readerLead}</p>
              </div>
            )}
            {editing ? (
              <div className="me-edit-form" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0 14px' }}>
                <div style={{ fontSize: 11.5, opacity: 0.62, lineHeight: 1.6 }}>{t('editHint')}</div>
                <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }} htmlFor="me-edit-title">{t('editTitle')}</label>
                <input id="me-edit-title" value={eTitle} onChange={(e) => setETitle(e.target.value)} maxLength={200} style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, boxSizing: 'border-box' }} />
                <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }} htmlFor="me-edit-tags">{t('editTags')}</label>
                <input id="me-edit-tags" value={eTags} onChange={(e) => setETags(e.target.value)} placeholder={t('editTagsHint')} style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, boxSizing: 'border-box' }} />
                <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }} htmlFor="me-edit-body">{t('editBody')}</label>
                <textarea id="me-edit-body" value={eBody} onChange={(e) => setEBody(e.target.value)} spellCheck={false} rows={18}
                  style={{  width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, boxSizing: 'border-box' , resize: 'vertical', minHeight: 260, lineHeight: 1.7, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
                {saveErr && <div style={{ color: '#f87171', fontSize: 12 }}>{saveErr}</div>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                  <span style={{ marginRight: 'auto', fontSize: 11.5, opacity: 0.55 }}>{card.path}</span>
                  <button type="button" className="mc-btn" onClick={cancelEdit} disabled={saving}>{t('editCancel')}</button>
                  <button type="button" className="mc-btn" onClick={saveEdit} disabled={saving} style={{ borderColor: 'var(--dsw-alias-brand-primary, #3b82f6)', color: 'var(--dsw-alias-brand-primary, #3b82f6)', fontWeight: 600 }}>{saving ? t('editSaving') : t('editSave')}</button>
                </div>
              </div>
            ) : (
              <div className="md-doc" dangerouslySetInnerHTML={{ __html: renderMd(cleanBody) }} />
            )}
          </div>
          <aside className="me-reader-side">
            {toc.length > 0 && (
              <>
                <div className="side-label">{t('contents')}</div>
                <div className="me-reader-toc">
                  {toc.map((h, i) => (
                    <button key={h.id} type="button" className={`lv${h.level}${activeHeading === h.id ? ' active' : ''}`} onClick={() => jumpToHeading(h.id)}>
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

// -- 星球分层图谱 -------------------------------------------------------------
// 与改造前的区别：以前一次性 `GET /graph` 拉全量（2049 节点 / 10106 边）再一次性渲染；
// 现在一次只取「一层」（`GET /graph/level?path=…`）：根层 kind 折叠 → 大类/语义簇 → 卡片层；
// 每个层级都缓存：面包屑返回上层是**零新增请求**。
function GraphView({ t, onOpen, all, onAllChange, onMutate, active, visible, skin }) {
  const [segments, setSegments] = useState([]) // 当前层级路径段（['k:project', 't:ui'] …）
  const [data, setData] = useState(null) // 宿主返回的当前层（{path,crumbs,level,stats}）
  const [error, setError] = useState(null) // { timeout, message }：显式失败，不吞
  const [loading, setLoading] = useState(false)
  // ---- 平铺卡片图（v0.29 实验）：不折叠星球，卡片直接力导向铺开 ----
  // 默认开启：用户反馈「大星球嵌套后不丝滑」，先给一版扁平的、能停下来的图做体验对比。
  // v0.29：星球分层被判定「太丑」，固定为平铺卡片图。
  // 星球代码暂时保留（诊断/回滚用），但界面上不再提供入口。
  const flatMode = true
  const [flatLevel, setFlatLevel] = useState(null)
  // 默认只画「连接数最高的 800 张」：2450 张全量 = tick 6ms + render 10ms（~25fps），
  // 800 张能稳在 50fps 以上且仍能看清热区；要看全部时点「显示全部」。
  const [flatAll, setFlatAll] = useState(false)
  const [flatLoading, setFlatLoading] = useState(false)
  const [flatError, setFlatError] = useState(null)
  const fitTrigger = useRef(0)
  const cacheRef = useRef(null)
  if (!cacheRef.current) cacheRef.current = createLevelCache(96)
  const seqRef = useRef(0)
  // 首屏（第一层）落地时刻：从页面脚本开始执行算起（performance.now 原点），只记第一次
  const firstLevelMsRef = useRef(0)
  const segRef = useRef(segments)
  segRef.current = segments
  const allRef = useRef(all)
  const statsRef = useRef({ requests: 0, cacheHits: 0, errors: 0, timeouts: 0, lastMs: 0, lastBytes: 0 })

  const load = useCallback(async (segs, opts = {}) => {
    const target = Array.isArray(segs) ? segs.filter(Boolean) : []
    const key = (all ? 'all|' : '') + pathKey(target)
    if (!opts.force) {
      const hit = cacheRef.current.get(key)
      if (hit) {
        // 命中缓存：不跑物理、不发请求，直接把这一层换上去（面包屑返回上层的路径）
        statsRef.current.cacheHits += 1
        setData(hit); setSegments(target); setError(null); setLoading(false)
        return hit
      }
    }
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    const ctrl = new AbortController()
    // 超时：abort 掉请求 → catch 里给出「超时 + 可重试」的显式提示，当前层原样保留
    const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 已结束 */ } }, LEVEL_TIMEOUT_MS)
    const started = performance.now()
    statsRef.current.requests += 1
    try {
      const r = await fetch(urlForLevel(API, target, { all }), { signal: ctrl.signal })
      const d = await r.json().catch(() => null)
      if (seq !== seqRef.current) return null // 被更新的请求取代：丢弃旧响应
      if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status))
      const check = validateLevelPayload(d)
      if (!check.ok) {
        // 宿主越界只告警（客户端不静默截断，否则永远发现不了宿主回归）
        try { console.warn('[memory-eternal] 分层响应越界：' + check.problems.join('；')) } catch { /* console 不可用 */ }
      }
      cacheRef.current.set(key, d)
      statsRef.current.lastMs = Math.round(performance.now() - started)
      statsRef.current.lastBytes = check.bytes
      if (!firstLevelMsRef.current) firstLevelMsRef.current = Math.round(performance.now())
      setData(d); setSegments(target); setError(null)
      return d
    } catch (e) {
      if (seq !== seqRef.current) return null
      const info = describeLevelError(e, { timeoutMs: LEVEL_TIMEOUT_MS, elapsedMs: performance.now() - started })
      if (info.timeout) statsRef.current.timeouts += 1
      statsRef.current.errors += 1
      try { console.warn('[memory-eternal] 层级加载失败 @ ' + key + '：' + info.message) } catch { /* console 不可用 */ }
      // 保留 data（当前层照旧可看可点），同时记住「失败的是哪一层」—— 重试点的是它，不是当前层
      setError({ ...info, target: pathKey(target), segments: target.slice() })
      return null
    } finally {
      clearTimeout(timer)
      if (seq === seqRef.current) setLoading(false)
    }
  }, [all])

  // 跨库开关：不同库的层不能混用 → 清缓存 + 回根层重取
  useEffect(() => {
    if (allRef.current === all) return
    allRef.current = all
    cacheRef.current.clear()
    if (active) load([], { force: true })
  }, [all, active, load])

  // 首次激活才拉根层；切走再回来命中缓存（不重复请求）
  useEffect(() => {
    if (!active || data || loading) return
    load([])
  }, [active, data, loading, load])

  // 切换到图谱视图时触发一次 fit，让画布居中适配
  useEffect(() => {
    if (visible && data) fitTrigger.current++
  }, [visible, data])

  const navigate = useCallback((crumb) => {
    const segs = Array.isArray(crumb) ? crumb : segmentsOf(crumb && crumb.path !== undefined ? crumb.path : crumb)
    if (pathKey(segs) === pathKey(segRef.current)) return
    load(segs) // 命中缓存 → 零请求；未命中 → 正常按层取
  }, [load])

  const drill = useCallback((id) => {
    if (!id) return
    load(segRef.current.concat(String(id)))
  }, [load])

  const retry = useCallback(() => {
    cacheRef.current.clear()
    // 重试的是「刚才失败的那一层」（失败时没有切层，所以不能拿当前层当目标）
    const target = error && Array.isArray(error.segments) ? error.segments : segRef.current
    load(target, { force: true })
  }, [load, error])

  const reload = useCallback(async () => {
    // 写操作（删卡/合并）会改变宿主指纹 → 层级缓存全部作废，当前层重取一次
    cacheRef.current.clear()
    return load(segRef.current, { force: true })
  }, [load])

  // 平铺图：一次性拉 /graph（全量卡片 + wikilink/共享标签边），交给同一个 GraphCanvas 渲染。
  // 与分层视图的区别只有一个：没有 type=planet 的折叠节点 → 不跑星球护城河/公转。
  const loadFlat = useCallback(async () => {
    setFlatLoading(true); setFlatError(null)
    try {
      const r = await fetch(`${API}/graph?${all ? 'all=1&' : ''}limit=${flatAll ? 0 : 800}`)
      const d = await r.json().catch(() => null)
      if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status))
      const allNodes = Array.isArray(d.nodes) ? d.nodes : []
      const allEdges = Array.isArray(d.edges) ? d.edges : []
      // 新宿主会直接回裁剪后的子图（shown/total）；老宿主没有这两个字段 → 客户端兜底裁剪。
      const serverLimited = typeof d.shown === 'number'
      const degree = new Map()
      for (const e of allEdges) {
        degree.set(e.source, (degree.get(e.source) || 0) + 1)
        degree.set(e.target, (degree.get(e.target) || 0) + 1)
      }
      const FLAT_LIMIT = 800
      const picked = (flatAll || serverLimited) ? allNodes : allNodes.slice().sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, FLAT_LIMIT)
      const keep = new Set(picked.map((n) => n.id))
      const items = picked.map((n) => ({
        id: n.id,
        label: n.label || n.title || n.id,
        kind: n.kind || 'other',
        tags: Array.isArray(n.tags) ? n.tags : [],
        updated: n.updated || n.updated_at || '',
        count: 0,
        type: 'card',
      }))
      const edges = flatAll ? allEdges : allEdges.filter((e) => keep.has(e.source) && keep.has(e.target))
      setFlatLevel({ id: 'flat', mode: 'flat', total: Number(d.total) || allNodes.length, shown: Number(d.shown) || items.length, items, edges })
    } catch (e) {
      setFlatError({ message: String((e && e.message) || e) })
    } finally { setFlatLoading(false) }
  }, [all, flatAll])

  useEffect(() => { loadFlat() }, [loadFlat])

  const del = useCallback(async (path) => {
    try {
      const r = await fetch(`${API}/delete?path=${encodeURIComponent(path)}`)
      const d = await r.json()
      if (d && d.ok) { await reload(); onMutate && onMutate(); return true }
      return false
    } catch (e) { return false }
  }, [reload, onMutate])

  const merge = useCallback(async (paths) => {
    if (!paths || paths.length < 2) return false
    try {
      const r = await fetch(`${API}/merge?paths=${encodeURIComponent(paths.join(','))}`).then((x) => x.json())
      if (r && r.ok) { await reload(); onMutate && onMutate(); return true }
      return false
    } catch (e) { return false }
  }, [reload, onMutate])

  // 只读运行时探针（CDP 断言用）：层级、请求/缓存计数、画布资源账本、图元屏幕坐标
  useEffect(() => {
    const probe = () => {
      const runtime = typeof globalThis.__meGraphRuntime === 'function' ? globalThis.__meGraphRuntime() : null
      return {
        path: pathKey(segRef.current),
        crumbs: data && Array.isArray(data.crumbs)
          ? data.crumbs.map((c) => ({ path: c.path, label: c.label, labelKey: c.labelKey, count: c.count }))
          : [],
        level: data && data.level
          ? { mode: data.level.mode, total: data.level.total, items: data.level.items.length, edges: data.level.edges.length }
          : null,
        loading: !!loading,
        error: error ? { timeout: !!error.timeout, message: error.message, target: error.target || '' } : null,
        requests: statsRef.current.requests,
        cacheHits: statsRef.current.cacheHits,
        errors: statsRef.current.errors,
        timeouts: statsRef.current.timeouts,
        lastMs: statsRef.current.lastMs,
        lastBytes: statsRef.current.lastBytes,
        firstLevelMs: firstLevelMsRef.current,
        cacheSize: cacheRef.current.size,
        timeoutMs: LEVEL_TIMEOUT_MS,
        runtime,
      }
    }
    globalThis.__meGraphProbe = probe
    return () => {
      if (globalThis.__meGraphProbe === probe) { try { delete globalThis.__meGraphProbe } catch { globalThis.__meGraphProbe = undefined } }
    }
  }, [data, loading, error])

  const level = flatMode ? flatLevel : (data && data.level ? data.level : null)
  const itemCount = level ? level.items.length : 0
  const cardTotal = level ? level.total : 0
  const edgeCount = level ? level.edges.length : 0
  // 平铺模式下不显示层级加载/错误；它有自己的 loading/error
  const showLoading = flatMode ? flatLoading : (!data && !error)
  const showError = flatMode ? flatError : (!data && error)
  const viewError = flatMode ? flatError : (data ? error : null)

  return (
    <div className="me-graph me-v5-graph">
      <style>{CSS}</style>
      <div className="mc-v5-pagehead mc-v5-graphhead">
        <div>
          <div className="mc-v5-eyebrow">KNOWLEDGE GRAPH</div>
          <h1>{t('graphTab')}</h1>
          <p>{t('graphHint')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="mc-btn" onClick={() => setFlatAll((v) => !v)}>
            {flatAll ? t('graphFlatOnly') : t('graphFlatAll')}
          </button>
          <span className="mc-v5-pagecount">{(flatMode ? flatLevel : data) ? `${itemCount} ${t('graphItems')} · ${cardTotal} ${t('graphCardsUnit')} · ${edgeCount} ${t('edges')}` : ''}</span>
        </div>
      </div>
      {showLoading && <LoadingNote text={t('loadingGraph')} />}
      {showError && (
        <div className="mc-empty" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          <span>{viewError && viewError.timeout ? t('graphLevelTimeout').replace('{ms}', String(LEVEL_TIMEOUT_MS)) : t('graphLevelError')}：{viewError && viewError.message}</span>
          <button type="button" className="mc-btn" onClick={flatMode ? loadFlat : retry}>{t('graphRetry')}</button>
        </div>
      )}
      {(flatMode ? flatLevel : data) && itemCount === 0 && <div className="mc-empty">{t('graphEmptyLevel')}</div>}
      {level && itemCount > 0 && (
        <GraphCanvas
          skin={skin}
          level={level}
          crumbs={flatMode ? [] : (data && data.crumbs ? data.crumbs : [])}
          onOpen={onOpen}
          onDelete={del}
          onMerge={merge}
          onDrill={flatMode ? () => {} : drill}
          onNavigate={navigate}
          onRetry={flatMode ? loadFlat : retry}
          error={viewError}
          loading={flatMode ? flatLoading : loading}
          t={t}
          all={all}
          onAllChange={onAllChange}
          fitTrigger={fitTrigger.current}
        />
      )}
    </div>
  )
}

// agentmemory 式图谱：canvas 力导向 + 按 kind 聚合 + 分型节点 + 暗玻璃星球 + 点阵底 + 卡片药丸标签。
const KG = {
  // 配色按「同一亮度带」重挑：比 Tailwind-500 再柔一档，暗底上不刺眼，
  // 与 v5 皮肤的炭灰底 + 橙色强调（#ff7a45）属于同一套视觉语言。
  colors: { core:'#FF7A45', skill:'#A78BFA', project:'#60A5FA', knowledge:'#34D399', content:'#FBBF24', prompt:'#C084FC', business:'#F472B6', tool:'#22B8CF', mistake:'#FB7185', other:'#8CA0B3' },
  // 星球球体用「深色宝石」版本：比节点色低一档明度，白字对比更稳，也不会显得糖果。
  deep: { core:'#E8590C', skill:'#7C3AED', project:'#2563EB', knowledge:'#059669', content:'#D97706', prompt:'#9333EA', business:'#DB2777', tool:'#0891B2', mistake:'#E11D48', other:'#64748B' },
  shapes: { core:'diamond', skill:'hexagon', project:'circle', knowledge:'circle', content:'rect', prompt:'diamond', business:'hexagon', tool:'circle', mistake:'diamond', other:'circle' },
}

// 星球层打的大数字：≤5 位直接写，上万用 Intl 紧凑写法（中文「万」/ 英文 K/M），
// 保证球心字不会撑破球体。实现见 graph-planet.js 的 formatCount（纯函数、可单测）。

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

// 图元 → 归一化「域对象」：卡片层是卡片（title/kind/tags/updated），星球层是聚合体（count）。
// 画布渲染、搜索、图例、右侧邻居列表都读这个域，所以「这一层是什么」不影响交互代码。
const EMPTY_ITEMS = []

function GraphBreadcrumb({ crumbs, t, onPick, busy }) {
  const list = Array.isArray(crumbs) && crumbs.length ? crumbs : [{ path: '', labelKey: 'graphAllCrumb', label: '全部' }]
  return (
    <nav className="me-graph-crumbs" aria-label={t('graphBreadcrumbAria')} data-level-depth={list.length}>
      {list.map((c, i) => {
        // labelKey 有译文才用（宿主可能给一个客户端还没收录的 key：退回宿主给的 label，不显示原始 key）
        const translated = c.labelKey ? t(c.labelKey) : ''
        const label = translated && translated !== c.labelKey ? translated : (c.label || c.path || '—')
        const current = i === list.length - 1
        return (
          <span key={c.path || 'root'} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            {i > 0 && <span className="sep" aria-hidden="true">›</span>}
            <button
              type="button"
              className={(i === 0 ? 'home' : '') + (current ? ' current' : '')}
              aria-current={current ? 'page' : undefined}
              title={label}
              disabled={current || busy}
              onClick={() => { if (!current) onPick(c) }}
            >{label}</button>
          </span>
        )
      })}
    </nav>
  )
}

function GraphCanvas({ level, crumbs, onOpen, onDelete, onMerge, onDrill, onNavigate, onRetry, error, loading, t, all, onAllChange, fitTrigger, skin }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const simRef = useRef(null)
  const fitRef = useRef(null)
  const resetRef = useRef(null)
  // 图谱数据换成「一层图元」：items/edges 都来自 GraphView 的层响应（缓存复用同一份对象）
  const items = (level && Array.isArray(level.items)) ? level.items : EMPTY_ITEMS
  const rawEdges = (level && Array.isArray(level.edges)) ? level.edges : EMPTY_ITEMS
  const levelId = (level && level.id) || ''
  // 归一化：id/title/kind/tags/updated 到处都要用；星球额外带 count/type=planet
  const nodes = useMemo(() => items.map((it) => ({
    id: it.id,
    title: it.label || it.id,
    name: it.label || it.id,
    kind: it.kind || 'other',
    tags: Array.isArray(it.tags) ? it.tags : [],
    updated: it.updated || '',
    count: Number(it.count) || 0,
    type: it.type || 'card',
  })), [items])
  // 层内边统一成 {source,target}（宿主层边不带 tag 名，减 payload）
  const edges = useMemo(() => rawEdges.map((e) => ({ source: e.source, target: e.target, type: e.type || 'tag', weight: Number(e.weight) || 1 })), [rawEdges])
  // GraphCanvas 自己的 tRef：hover tooltip 在 render() 闭包里读 tRef.current，
  // 而 render 只随 [items, edges] 重建 —— 语言切换时必须是 ref 才能拿到新文案。
  const tRef = useRef(t)
  tRef.current = t
  const onOpenRef = useRef(onOpen)
  useEffect(() => { onOpenRef.current = onOpen }, [onOpen])
  const onDeleteRef = useRef(onDelete)
  useEffect(() => { onDeleteRef.current = onDelete }, [onDelete])
  const onMergeRef = useRef(onMerge)
  useEffect(() => { onMergeRef.current = onMerge }, [onMerge])
  const onDrillRef = useRef(onDrill)
  useEffect(() => { onDrillRef.current = onDrill }, [onDrill])
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
    // 图例口径 = 卡片数：大星球本身占 1 个图元，但它代表 count 张卡
    const m = {}
    for (const n of nodes) m[n.kind || 'other'] = (m[n.kind || 'other'] || 0) + (n.type === 'planet' ? Math.max(1, n.count || 0) : 1)
    return m
  }, [nodes])
  const noMatch = (() => { const q = search.trim().toLowerCase(); return !!q && !nodes.some((n) => (n.title || n.name || '').toLowerCase().includes(q) || String(n.kind || '').toLowerCase().includes(q) || String(KIND_LABELS[n.kind] || '').toLowerCase().includes(q)) })()
  // 搜索变化时唤醒重绘（搜索只改高亮/居中，不重启布局）
  useEffect(() => { const s = simRef.current; if (s && s.requestRender) s.requestRender() }, [search])
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
    const deg = {}
    edges.forEach((e) => { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1 })
    const maxDeg = Math.max(1, ...Object.values(deg))
    // 资源账本：本层实例申请的所有 rAF / 定时器 / 监听器都记在这里，卸载时一次性归还。
    // 20 轮下钻/返回后 snapshot() 的三个数必须回到同一个值（见 probes + REPORT 的泄漏断言）。
    const tracker = createResourceTracker()
    const planetLayer = items.some((it) => it && it.type === 'planet')
    // 主题化画布：pop/light 用浅底 + 深色点阵，暗色默认保持观测底片。
    const activeSkin = skin || (typeof document !== 'undefined' && document.querySelector('.memory-eternal-root') ? document.querySelector('.memory-eternal-root').dataset.skin : '') || 'default'
    const skinPop = activeSkin === 'pop'
    const skinLight = activeSkin === 'light'
    const skinResident = activeSkin === 'resident'
    const skinSpider = activeSkin === 'spider'
    const GP = skinPop ? {
      grid: 'rgba(23,19,11,0.16)',
      labelBg: 'rgba(255,252,244,0.97)', labelBorder: 'rgba(23,19,11,0.45)',
      labelMuted: '#3a3226', labelStrong: '#1a140b',
      planetInner: 'rgba(255,252,244,0.94)', planetHighlight: 'rgba(23,19,11,0.12)',
      nodeRing: 'rgba(23,19,11,0.35)', selection: '#ff3b2f', search: '#ff3b2f', multi: '#0f766e',
      marqueeStroke: 'rgba(15,118,110,0.9)', marqueeFill: 'rgba(15,118,110,0.12)',
    } : skinLight ? {
      grid: 'rgba(80,65,45,0.12)',
      labelBg: 'rgba(255,255,252,0.98)', labelBorder: 'rgba(38,34,28,0.26)',
      labelMuted: '#544a3c', labelStrong: '#26221c',
      planetInner: 'rgba(255,253,249,0.95)', planetHighlight: 'rgba(38,34,28,0.10)',
      nodeRing: 'rgba(38,34,28,0.25)', selection: '#e36a36', search: '#e36a36', multi: '#0f766e',
      marqueeStroke: 'rgba(15,118,110,0.9)', marqueeFill: 'rgba(15,118,110,0.10)',
    } : skinResident ? {
      grid: 'rgba(124,255,63,0.10)',
      labelBg: 'rgba(5,9,6,0.88)', labelBorder: 'rgba(124,255,63,0.28)',
      labelMuted: '#9fe8a8', labelStrong: '#d6ffd9',
      planetInner: 'rgba(4,8,5,0.95)', planetHighlight: 'rgba(124,255,63,0.18)',
      nodeRing: 'rgba(124,255,63,0.28)', selection: '#ff3b3b', search: '#7cff3f', multi: '#ff5a5a',
      marqueeStroke: 'rgba(124,255,63,0.9)', marqueeFill: 'rgba(124,255,63,0.10)',
    } : skinSpider ? {
      grid: 'rgba(27,59,139,0.12)',
      labelBg: 'rgba(255,255,255,0.96)', labelBorder: 'rgba(11,11,15,0.35)',
      labelMuted: '#1b3b8b', labelStrong: '#0b0b0f',
      planetInner: 'rgba(255,255,255,0.94)', planetHighlight: 'rgba(230,36,41,0.18)',
      nodeRing: 'rgba(11,11,15,0.35)', selection: '#e62429', search: '#e62429', multi: '#1b3b8b',
      marqueeStroke: 'rgba(230,36,41,0.9)', marqueeFill: 'rgba(230,36,41,0.10)',
    } : {
      grid: 'rgba(255,255,255,0.055)',
      labelBg: 'rgba(20,24,30,0.78)', labelBorder: 'rgba(255,255,255,0.07)',
      labelMuted: '#aeb6c2', labelStrong: '#f2f5f8',
      planetInner: 'rgba(13,16,21,0.92)', planetHighlight: 'rgba(255,255,255,0.14)',
      nodeRing: 'rgba(255,255,255,0.16)', selection: 'rgba(255,122,69,0.9)', search: '#ffa06b', multi: '#60a5fa',
      marqueeStroke: 'rgba(96,165,250,0.9)', marqueeFill: 'rgba(96,165,250,0.12)',
    }
    const skinLightCanvas = skinPop || skinLight || skinSpider

    // 绘制/命中顺序：卡片先画、星球后画（星球永远压在卡片上面，不会被小圆点啃掉）
    const drawItems = items.filter((it) => it && it.type !== 'planet').concat(items.filter((it) => it && it.type === 'planet'))
    const sim = {
      // 图元 → 画布节点：大星球半径随卡数（对数），卡片沿用「按度数放大」的老规则。
      // 注意：必须从**原始图元**（带 label）构节点 —— 归一化域对象用的是 title/name。
      nodes: drawItems.map((it) => levelItemToNode(it, { degree: deg[it.id] || 0, maxDegree: maxDeg })),
      // 每颗大球拿到自己的方向/速度/相位：不能整盘同向，否则又变成刚体旋转
      // 层内边统一成 {source,target}：保留宿主的聚合权重（星球层 = 共享标签数），
      // 渲染时用它区分粗细 —— 旧版图谱的「关系强弱」视觉不能少。
      edges: edges.map((e) => ({ sourceNodeId: e.source, targetNodeId: e.target, weight: Math.max(1, Number(e.weight) || 1) })),
      panX: 0, panY: 0, zoom: 1, running: true, raf: 0, tickCount: 0, quietTicks: 0, dragNode: null, selectedId: null, mouseX: 0, mouseY: 0, w: 0, h: 0, dpr, ctx, multi: [], marquee: null,
      planetLayer, levelId,
    }
    sim.domain = nodes
    sim.domainById = nodes.reduce((m, n) => (m[n.id] = n, m), {})
    // 边弹簧每 tick 都要按 id 找两端：预先把边转成节点下标（Int32Array），
    // 单 tick 的万级边从「Map.get × 2」降到纯数组下标访问。
    sim.nodeById = new Map(sim.nodes.map((n) => [n.id, n]))
    sim.edgePairs = (() => {
      const index = new Map(sim.nodes.map((n, i) => [n.id, i]))
      const pairs = new Int32Array(sim.edges.length * 2)
      let w = 0
      for (const edge of sim.edges) {
        const a = index.get(edge.sourceNodeId)
        const b = index.get(edge.targetNodeId)
        if (a === undefined || b === undefined) continue
        pairs[w] = a
        pairs[w + 1] = b
        w += 2
      }
      return pairs.subarray(0, w)
    })()
    sim.alpha = 1
    // 星球层：大圆必须分得开 → 换一套更大的斥力/更弱的重力（内核公式不变，只换参数）
    sim.forceParams = planetLayer ? planetLayerParams(forceParamsFor(sim.nodes.length)) : forceParamsFor(sim.nodes.length)
    sim.lastTickMs = 0
    sim.lastRenderMs = 0
    // 初始位形：黄金角螺旋（半径 ∝ √i）。原来是「半径 60 的圆等分」——上千个节点全挤在
    // 一个小圆上，首帧就是一团墨点；螺旋铺开后首帧是一盘散点，预热过程也更自然。
    // 统一从黄金角螺旋起步：大星球和卡片一起参与力导向，散乱地漂，而不是被钉在固定环槽上。
    // （旧版把星球钉在「专属引力槽」里，看着整齐但像一张图表；用户要的是「跟以前一样散乱会动」。）
    sim.nodes.forEach((n, i) => {
      const a = i * 2.399963229728653
      const r = 12 * Math.sqrt(i)
      n.x = Math.cos(a) * r
      n.y = Math.sin(a) * r
    })
    const types = [...new Set(sim.nodes.map((n) => n.type))]
    // 星球层不做 type 聚类（每个大 kind 各占一个中心会又回到「绕圈排排坐」），改用中心重力 + 斥力。
    sim.clustered = !planetLayer && types.length > 1
    sim.typeCenters = sim.typeCenters || {}
    const typeSpread = planetLayer ? 0 : 160
    types.forEach((ty, i) => {
      if (sim.typeCenters[ty]) return
      const a = (i / types.length) * Math.PI * 2 - Math.PI / 2
      sim.typeCenters[ty] = { x: Math.cos(a) * typeSpread, y: Math.sin(a) * typeSpread }
    })
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
        tracker.raf(() => fit())
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
        // 原来中心直接 +70 提亮 → 小圆点看起来像糖果珠。现在只在左上带一点点体积感，
        // 主体保持本色、边缘略压暗，放大后才像「宝石」，缩小后仍是一颗干净的色点。
        g = ctx.createRadialGradient(-r * 0.32, -r * 0.38, 0, 0, 0, r * 1.15)
        g.addColorStop(0, mixColor(color, '#ffffff', 0.20))
        g.addColorStop(0.62, color)
        g.addColorStop(1, mixColor(color, '#000000', 0.22))
        gradCache.set(key, g)
      }
      return g
    }
    // '#rrggbb' + 透明度 → rgba()：星球的光晕/环/描边都要半透明同色
    const hexA = (hex, a) => {
      const cr = parseInt(hex.slice(1,3),16), cg = parseInt(hex.slice(3,5),16), cb = parseInt(hex.slice(5,7),16)
      return 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a + ')'
    }
    // 颜色混合（用于球体的高光/暗面），into 只接受 #ffffff / #000000
    const mixColor = (hex, into, t) => {
      const p = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]
      const a = p(hex)
      const b = p(into)
      const k = Math.max(0, Math.min(1, Number(t) || 0))
      return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',') + ')'
    }
    // 大星球的柔光/球体渐变按「颜色+半径」缓存（星球 ≤ 20 颗，每帧不重建渐变对象）
    const planetGlowCache = new Map()
    const planetBodyCache = new Map()
    // 混合两色并带 alpha：暗玻璃球体用（把本色压到半透明，背景暗部透出来）
    const rgbaMix = (hex, into, t, a) => {
      const p2 = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]
      const x = p2(hex), y2 = p2(into)
      const k = Math.max(0, Math.min(1, Number(t) || 0))
      return 'rgba(' + x.map((v, i) => Math.round(v + (y2[i] - v) * k)).join(',') + ',' + a + ')'
    }

    // 滚轮/初始视图共用同一个「度」：一格 = ×ZOOM_STEP（滚轮、放大/缩小按钮、初始 fit 一致）。
    const ZOOM_STEP = 1.1
    // 初始化总览的最小视图（与滚轮下限一致）：用户要求「打开就缩到最小」，也最省渲染
    const MIN_VIEW_ZOOM = 0.3
    // 初始视图比「刚好铺满」再**缩小三度**：节点不再挤到边缘，四周留出可拖拽/框选的余量。
    // 用户反馈：卡数量多时默认视图偏大、放大容易卡；再缩小一度，默认先看全局。
    const INITIAL_ZOOM_OUT_STEPS = 3
    const fit = () => {
      if (!sim.nodes.length) return
      let minX = 1/0, maxX = -1/0, minY = 1/0, maxY = -1/0
      // 边界按「圆心 ± 半径」算：星球很大时只算圆心会把大圆裁到画布外；
      // 星球的行星环画到 1.82r，边界再放大一点，别让环被画布边缘切掉。
      sim.nodes.forEach((n) => {
        const base = Number(n.r) || 0
        // 星球之前按 1.75r 留白（旧版光晕画到 1.9r）；光晕已收到 1.36r，留到 1.45r 就够，
        // 否则 fit 会多缩一圈，四周全是空白、球也被缩得很小。
        const r = n.planet ? base * 1.32 : base
        if (n.x - r < minX) minX = n.x - r
        if (n.x + r > maxX) maxX = n.x + r
        if (n.y - r < minY) minY = n.y - r
        if (n.y + r > maxY) maxY = n.y + r
      })
      const pad = 28
      const spanX = (maxX - minX) + pad * 2, spanY = (maxY - minY) + pad * 2
      const z = Math.min(sim.w / spanX, sim.h / spanY)
      // 展示全部：按边界精确缩放（不放大裁剪），让所有节点一屏可见、无滚动。
      // 再叠一个「初始视图缩小三度」的系数（重置视图按钮也走这里，行为与首次打开一致）。
      const initialZoomOut = Math.pow(1 / ZOOM_STEP, INITIAL_ZOOM_OUT_STEPS)
      sim.zoom = Math.max(0.35, Math.min(1.8, z * initialZoomOut))
      // 根层初始化：直接给最小视图（0.3）—— 用户要求「打开就缩到最小」，全览也最省渲染；
      // 下钻后的层级仍按 fit 铺满，方便看这一层的结构。
      const rootLevel = !(Array.isArray(crumbs) && crumbs.length > 1)
      if (sim.planetLayer && rootLevel) {
        sim.zoom = Math.max(0.12, Math.min(MIN_VIEW_ZOOM, z))
      } else if (sim.planetLayer) {
        sim.zoom = Math.max(0.12, z * Math.pow(1 / ZOOM_STEP, INITIAL_ZOOM_OUT_STEPS - 2))
      }
      sim.panX = sim.w / 2 - ((minX + maxX) / 2) * sim.zoom
      sim.panY = sim.h / 2 - ((minY + maxY) / 2) * sim.zoom
    }
    fitRef.current = fit

    const render = () => {
      sim.renderFrames = (sim.renderFrames | 0) + 1
      // 放大后图例会压住球体：超过 1.2× 自动淡出，缩回去再出现（类名切换而非每帧写 DOM）
      const zState = sim.zoom >= 1.2 ? 'in' : 'out'
      if (wrapRef.current && wrapRef.current.dataset.zoom !== zState) wrapRef.current.dataset.zoom = zState
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
      // 点阵（不是方格）：星图应该像「观测底片」而不是坐标纸；一次 fill 画完，不额外增加绘制调用。
      if (!gridPath || gridKey !== gk) {
        gridPath = new Path2D()
        const step = 26
        for (let gx = step / 2; gx < sim.w; gx += step) {
          for (let gy = step / 2; gy < sim.h; gy += step) {
            gridPath.moveTo(gx + 1, gy)
            gridPath.arc(gx, gy, 1, 0, Math.PI * 2)
          }
        }
        gridKey = gk
      }
      ctx.fillStyle = GP.grid
      ctx.fill(gridPath)
      ctx.restore()
      ctx.save()
      ctx.translate(sim.panX, sim.panY); ctx.scale(sim.zoom, sim.zoom)
      const nodeMap = {}
      sim.nodes.forEach((n) => (nodeMap[n.id] = n))
      // 运动期 LOD：拖拽 / 平移 / 缩放 / 自移动时，边画直线、标签只留焦点，
      // 松手 140ms 后再补一帧完整细节（视觉只在「动的时候」降级，静置后恢复）。
      const motion = performance.now() < (sim.motionUntil || 0)
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
      const quality = sim.quality | 0
      // 度数排序缓存：pickLabelIds 原来每帧都对全部节点排序（2049 节点 = 每帧一次 O(n log n) + 数组分配）。
      if (!sim.labelOrder || sim.labelOrder.src !== sim.nodes) {
        sim.labelOrder = {
          src: sim.nodes,
          ids: sim.nodes.slice().sort((a, b) => (Number(deg[b.id]) || 0) - (Number(deg[a.id]) || 0)).map((n) => n.id),
        }
      }
      const labelIds = pickLabelIds(sim.nodes, { limit: labelBudget(sim.nodes.length, quality), focusId, hoverId: sim.hoverId, searchHits, degree: deg, order: sim.labelOrder.ids })
      // 全景时给「度数最高的 12 个」也画标签：否则整图只是一盘圆点，认不出是什么。
      // 只有 12 个，measureText/fillText 的开销可以忽略。
      const overviewLabelIds = sim.zoom <= labelThreshold
        ? new Set((sim.labelOrder && sim.labelOrder.ids ? sim.labelOrder.ids : []).slice(0, 12))
        : null
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
      // 放大观察时的连线 LOD：小视野里 872 条曲线会把光栅化吃满。
      // 先按步长抽样（边本来就是 0.2 alpha 的底噪），聚焦时反过来只画焦点相关的边。
      const zoomedIn = sim.zoom >= 0.6
      // 视觉细节只在最差档位降级：能跑满帧的机器保留渐变/描边/光晕，
      // 掉帧的机器才逐档变朴素（0→1→2→3）。
      const closeUp = quality >= 3
      const edgeStride = quality <= 0 ? 1 : quality === 1 ? 2 : quality === 2 ? 4 : 8
      sim.edges.forEach((e, ei) => {
        if (skipEdges) return
        // 聚焦时反过来：只画焦点相关的边（全部），其余不画 —— 既看清关系又省光栅化
        const focused = focusId && (e.sourceNodeId === focusId || e.targetNodeId === focusId)
        if (focusId) { if (!focused) return }
        else if (edgeStride > 1 && ei % edgeStride !== 0) return
        const s = nodeMap[e.sourceNodeId], t = nodeMap[e.targetNodeId]
        if (!s || !t) return
        // 视口剔除：两端都在屏幕外就不画（放大后大部分边都被剔掉）
        if (!inRect(s.x, s.y, 10, viewRect) && !inRect(t.x, t.y, 10, viewRect)) return
        if (kf !== 'all') { const sK = sim.domainById[e.sourceNodeId] && sim.domainById[e.sourceNodeId].kind; const tK = sim.domainById[e.targetNodeId] && sim.domainById[e.targetNodeId].kind; if (sK !== kf && tK !== kf) return }
        if (kfTag) { const sT = sim.domainById[e.sourceNodeId] && (sim.domainById[e.sourceNodeId].tags || []).includes(kfTag); const tT = sim.domainById[e.targetNodeId] && (sim.domainById[e.targetNodeId].tags || []).includes(kfTag); if (!sT && !tT) return }
        let dr = t.x - s.x, dy = t.y - s.y
        const len = Math.sqrt(dr * dr + dy * dy) || 1
        // 放大观察时连线改直线：二次曲线在小视野里占满屏幕，光栅化成本是直线的数倍
        const curve = (motion || zoomedIn || quality >= 2) ? 0 : (dense ? 10 : 16)
        const ox = -dy / len * curve, oy = dr / len * curve
        const cpx = (s.x + t.x) / 2 + ox, cpy = (s.y + t.y) / 2 + oy
        const color = KG.colors[sim.domainById[s.id] ? (sim.domainById[s.id].kind || 'other') : 'other'] || KG.colors.other
        // 连线比旧版更暗更细：星图的「关系」应该是底噪，不是彩色意面。
        const alpha = skinLightCanvas ? (focusId ? (focused ? 0.85 : 0.1) : (sim.planetLayer ? 0.34 : 0.3)) : (focusId ? (focused ? 0.72 : 0.06) : (sim.planetLayer ? 0.22 : (dense ? 0.16 : 0.2)))
        const cr = parseInt(color.slice(1,3),16), cg = parseInt(color.slice(3,5),16), cb = parseInt(color.slice(5,7),16)
        const w = Math.max(1, Number(e.weight) || 1)
        // 线宽量化到 0.5：减少 Path2D 分桶数量（每多一个桶就多一次 stroke）
        const rawWidth = focused ? 1.6 + Math.min(3.2, w * 0.8) : 0.7 + Math.min(2.4, (w - 1) * 0.35)
        const width = Math.min((zoomedIn || quality >= 1) ? 1.2 : Infinity, Math.round(rawWidth * 2) / 2)
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
      // 卡片药丸标签：深底降到 0.78、描边更淡，避免一圈小黑块抢走星球的重量。
      const drawLabelPill = (n, opts = {}) => {
        const label = truncate(n.name, opts.maxChars || 16)
        const zi = 1 / sim.zoom
        // 标签自己接管 alpha：避免受节点 dim 的 globalAlpha 影响，浅色画布上整块发灰。
        ctx.save()
        ctx.globalAlpha = 1
        const font = (skinLightCanvas ? '600 ' : '500 ') + (11.5 * zi).toFixed(1) + 'px -apple-system,Segoe UI,sans-serif'
        ctx.font = font
        const tw = measureText(font, label)
        const lw = tw + 14 * zi, lh = 17 * zi
        const ly = n.y + n.r + (opts.gap === undefined ? 8 : opts.gap) * zi
        let fits = true
        for (const r of drawn) { if (n.x - lw/2 < r.x + r.w && n.x + lw/2 > r.x && ly < r.y + r.h && ly + lh > r.y) { fits = false; break } }
        if (!fits && !opts.force) { ctx.restore(); return false }
        drawn.push({ x: n.x - lw/2, y: ly, w: lw, h: lh })
        ctx.fillStyle = GP.labelBg
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(n.x - lw/2, ly, lw, lh, 4*zi); else ctx.rect(n.x - lw/2, ly, lw, lh); ctx.fill()
        ctx.strokeStyle = GP.labelBorder
        ctx.lineWidth = 1 * zi; ctx.stroke()
        ctx.fillStyle = skinLightCanvas ? (opts.strong ? '#14100a' : '#2f281e') : (opts.strong ? GP.labelStrong : GP.labelMuted)
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        ctx.fillText(label, n.x, ly + 4.6 * zi)
        ctx.restore()
        return true
      }

      // 大星球：低对比体积球 + 发丝外圈 + 克制的柔光。
      // 去掉了白色高光斑、土星环和 shadowBlur —— 那套「玻璃弹珠」质感是旧版最显廉价的地方；
      // 现在星球只承担「层级入口」的语义，把亮度让给卡片和连线。
      const drawPlanet = (n, color, flags) => {
        const zi = 1 / sim.zoom
        const { isSel, isHov, dimmed } = flags
        const screenR = n.r * sim.zoom
        ctx.save()
        ctx.globalAlpha = dimmed ? 0.16 : 1
        // 大气柔光：一圈很淡的同色光晕
        const gkey = 'g|' + color + '|' + Math.round(n.r)
        let glow = planetGlowCache.get(gkey)
        if (!glow) {
          glow = ctx.createRadialGradient(0, 0, n.r * 0.8, 0, 0, n.r * 1.24)
          glow.addColorStop(0, hexA(color, 0.18))
          glow.addColorStop(0.58, hexA(color, 0.06))
          glow.addColorStop(1, hexA(color, 0))
          planetGlowCache.set(gkey, glow)
        }
        ctx.save()
        ctx.translate(n.x, n.y)
        // 放大观察时跳过整块径向光晕：几颗大球的渐变填充占掉大量像素，是小视野下掉帧的主因之一。
        if (!closeUp && (sim.quality | 0) < 2) {
          ctx.fillStyle = glow
          ctx.beginPath(); ctx.arc(0, 0, n.r * 1.24, 0, Math.PI * 2); ctx.fill()
        }
        // 暗玻璃球体：先铺一层近黑底色，再叠半透明本色 —— 颜色仍在，但不再是糖果色圆盘；
        // 白字在任意色相上都够对比（黄/青球也不用换深色字）。
        const deep = sim.timeMode ? color : (KG.deep[n.type] || color)
        const bkey = 'b|' + deep + '|' + Math.round(n.r)
        let body = planetBodyCache.get(bkey)
        if (!body) {
          body = ctx.createRadialGradient(-n.r * 0.26, -n.r * 0.32, n.r * 0.12, 0, 0, n.r * 1.1)
          body.addColorStop(0, rgbaMix(deep, '#ffffff', 0.24, 0.9))
          body.addColorStop(0.58, hexA(deep, 0.86))
          body.addColorStop(1, rgbaMix(deep, '#000000', 0.34, 0.9))
          planetBodyCache.set(bkey, body)
        }
        ctx.beginPath(); ctx.arc(0, 0, n.r, 0, Math.PI * 2); ctx.fillStyle = GP.planetInner; ctx.fill()
        ctx.beginPath(); ctx.arc(0, 0, n.r, 0, Math.PI * 2); ctx.fillStyle = body; ctx.fill()
        // 上沿一道薄高光（弧线，不是圆斑）
        ctx.beginPath(); ctx.arc(0, 0, n.r - Math.max(0.6, 1.1 * zi), Math.PI * 1.06, Math.PI * 1.94)
        ctx.strokeStyle = GP.planetHighlight
        ctx.lineWidth = Math.max(0.7, 1.2 * zi)
        ctx.stroke()
        // 发丝外圈：给球体一个干净的边界
        ctx.beginPath(); ctx.arc(0, 0, n.r, 0, Math.PI * 2)
        ctx.strokeStyle = hexA(color, isSel || isHov ? 0.95 : 0.58)
        ctx.lineWidth = Math.max(0.8, 1.1 * zi)
        ctx.stroke()
        ctx.restore()
        if (isSel || isHov) {
          ctx.save()
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (isSel ? 7 : 5) * zi, 0, Math.PI * 2)
          ctx.strokeStyle = isSel ? GP.selection : hexA(color, 0.7)
          ctx.lineWidth = Math.max(1, 1.2 * zi)
          if (isSel) ctx.setLineDash([5 * zi, 4 * zi])
          ctx.stroke()
          ctx.restore()
        }
        ctx.restore()
        // 球内排版：簇名（小）/ 卡数（大）/ 单位（小）。
        // 名字放进球里，原来的浮动标签就不会再压到隔壁的球和卡片上。
        if (isSel || isHov || screenR >= 11) {
          const fs = Math.max(9, Math.min(21, screenR * 0.42)) * zi
          const big = screenR >= 30
          ctx.save()
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = (sim.quality | 0) >= 2 ? 0 : 5 * zi
          if (big) {
            ctx.font = '600 ' + (fs * 0.48).toFixed(1) + 'px -apple-system,Segoe UI,sans-serif'
            ctx.fillStyle = skinLightCanvas ? 'rgba(26,20,11,0.72)' : 'rgba(255,255,255,0.72)'
            ctx.fillText(truncate(n.name, 12), n.x, n.y - fs * 1.02)
          }
          ctx.font = '700 ' + fs.toFixed(1) + 'px -apple-system,Segoe UI,sans-serif'
          ctx.fillStyle = skinLightCanvas ? 'rgba(26,20,11,0.96)' : 'rgba(255,255,255,0.96)'
          // 紧凑单位跟着界面语言走（中文「万」/ 英文 K/M）；<1 万原样，2049/10k 的显示不变
          ctx.fillText(formatCount(n.count, {
            unit: tRef.current('graphCountWan'),
            locale: tRef.current('graphCountLocale'),
          }), n.x, n.y + (big ? fs * 0.06 : 0))
          if (big) {
            ctx.font = '500 ' + (fs * 0.38).toFixed(1) + 'px -apple-system,Segoe UI,sans-serif'
            ctx.fillStyle = skinLightCanvas ? 'rgba(26,20,11,0.55)' : 'rgba(255,255,255,0.5)'
            ctx.fillText(tRef.current('graphCardsUnit'), n.x, n.y + fs * 0.92)
          }
          ctx.restore()
        }
      }
      // nodes
      const drawn = []
      const planetDraws = []
      sim.nodes.forEach((n) => {
        // 视口剔除：屏幕外的节点连渐变/形状/标签都不必画
        if (!inRect(n.x, n.y, n.r + 2, viewRect)) return
        const info = sim.domainById[n.id] || {}
        const kind = info.kind || 'other'
        // kind 兜底：未知类型（历史卡/外部导入）以前会让 KG.colors[kind] 变成 undefined，
        // 随后 gradientFor 里 color.slice() 直接 TypeError —— 现在统一落到 other 的配色/圆点，
        // 坏数据最多画得朴素一点，不会再抛异常（并在兜底处告警一次）。
        // 时间维：只有带 updated 的图元才按新旧染色；星球是聚合体没有 updated，
        // 之前会统一退成灰色（整层看点全灰、也看不出类别），现在保持类别色。
        const color = (sim.timeMode && info.updated) ? recencyColor(info.updated) : (KG.colors[kind] || KG.colors.other)
        const shape = KG.shapes[kind] || 'circle'
        const isSel = sim.selectedId === n.id, isHov = sim.hoverId === n.id
        const searchTerm = sim.searchTerm || ''
        const searchHit = !searchTerm || (n.name || '').toLowerCase().includes(searchTerm) || String(KIND_LABELS[kind] || '').toLowerCase().includes(searchTerm) || String(kind).toLowerCase().includes(searchTerm)
        const kindOk = kf === 'all' || kind === kf
        const tagOk = !kfTag || ((info.tags || []).includes(kfTag))
        const dimmed = (focusId && n.id !== focusId && !(focusNeighbors && focusNeighbors.has(n.id))) || (searchTerm && !searchHit) || !kindOk || !tagOk
        if (n.planet) {
          // 星球先只登记，等所有球画完再统一画名字（否则后画的球会盖住前一颗的标签）
          planetDraws.push({ n, color, isSel, isHov, dimmed, ok: kindOk && tagOk })
          return
        }
        ctx.save()
        ctx.globalAlpha = dimmed ? 0.08 : 1
        if ((isSel || isHov) && paintShadows) { ctx.shadowColor = color; ctx.shadowBlur = isSel ? 16 : 11 }
        ctx.translate(n.x, n.y) // 局部坐标 → 渐变可跨节点复用
        drawShape(0, 0, n.r, shape)
        // 放大后改用纯色填充：节点在屏幕上已经很大，逐像素径向渐变在软件光栅/弱 GPU 上很贵
        ctx.fillStyle = closeUp ? color : gradientFor(color, n.r); ctx.fill()
        // 极细的浅色内描边：让六边形/菱形/圆在深底上有「切面」而不是色块。
        // 放大后节点已经很大，逐节点描边在弱 GPU 上是纯浪费，只在选中/悬停时保留。
        if (!closeUp || isSel || isHov) {
          ctx.strokeStyle = GP.nodeRing
          ctx.lineWidth = Math.max(0.6, 0.8 * (1 / sim.zoom))
          ctx.stroke()
        }
        if (kind === 'core') {
          ctx.fillStyle = '#1b120e'
          ctx.font = '700 ' + Math.max(10, Math.round(n.r * 0.95)) + 'px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText('★', 0, 0)
        }
        ctx.restore()
        if (isSel) { ctx.save(); drawShape(n.x, n.y, n.r+3, shape); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.stroke(); ctx.restore() }
        else if (isHov) { ctx.save(); drawShape(n.x, n.y, n.r+2, shape); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); ctx.restore() }
        else if (searchTerm && searchHit) { ctx.save(); drawShape(n.x, n.y, n.r+2, shape); ctx.strokeStyle = GP.search; ctx.lineWidth = 2; ctx.stroke(); ctx.restore() }
        else if (sim.multi.indexOf(n.id) >= 0) { ctx.save(); drawShape(n.x, n.y, n.r+2, shape); ctx.strokeStyle = GP.multi; ctx.lineWidth = 2; ctx.shadowColor = GP.multi; ctx.shadowBlur = 8; ctx.stroke(); ctx.restore() }
        // 标签预算：大图只画「焦点/悬停/搜索命中/度数最高」的若干节点。
        // 原来 zoom > labelThreshold 时上千个标签全画（每个都要 measureText + 圆角矩形 + fillText），
        // 这正是「放大后卡顿、缩小正常」的原因。
        const showLab = (isSel || isHov || (!motion && ((labelIds.has(n.id) && sim.zoom > labelThreshold) || (!dense && sim.zoom > 0.6) || (overviewLabelIds && overviewLabelIds.has(n.id))))) && kindOk && tagOk
        if (showLab) drawLabelPill(n, { force: isSel || isHov })
      })
      // 星球最后画（球压卡片）。名字/卡数都排在球内，不再需要额外的标签层，
      // 也就不会出现「名字飘到隔壁球上」的错位。
      planetDraws.forEach((p) => drawPlanet(p.n, p.color, p))
      ctx.restore()
      // Marquee 框选矩形（屏幕坐标）
      if (sim.marquee) {
        const m = sim.marquee
        const mx = Math.min(m.sx, m.ex), my = Math.min(m.sy, m.ey), mw = Math.abs(m.ex - m.sx), mh = Math.abs(m.ey - m.sy)
        ctx.save()
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = GP.marqueeStroke; ctx.lineWidth = 1
        ctx.fillStyle = GP.marqueeFill
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
          const meta = sn.planet
            ? tRef.current('graphPlanetCards').replace('{n}', String(sn.count)) + ' · ' + tRef.current('graphEnter')
            : tRef.current('connCount').replace('{n}', conn)
          const kindLabel = tRef.current(KIND_LABELS[hn.kind] || 'kindKnowledge')
          tooltipRef.current.innerHTML = '<b>' + esc(hn.title || hn.name || '') + '</b><br/><span style="opacity:.8">' + esc(kindLabel) + ' · ' + esc(meta) + '</span>'
        }
      } else if (tooltipRef.current) tooltipRef.current.style.display = 'none'
    }

    // 预热期间不启动常规 rAF 循环（预热自己驱动 rAF），避免同一帧里跑两遍 tick。
    let warmLeft = 0
    // 重绘与模拟解耦：
    //   - requestRender() 只画一帧（rAF 合并），不推进物理 —— 点击/悬停/选中/筛选/缩放/平移都走它；
    //   - wake() 才推进物理 —— 只给「拖拽节点 / 松手收敛 / 预热结束」这类真的会改变布局的动作。
    // 这是「点击即渲染卡死」的第二半根因：原来点一下会唤醒 30+ 次 O(n²) tick。
    let renderRaf = 0
    let motionTimer = 0
    const markMotion = () => {
      sim.lastInputAt = performance.now()
      sim.motionUntil = performance.now() + 140
      if (motionTimer) tracker.clearTimeout(motionTimer)
      motionTimer = tracker.setTimeout(() => {
        motionTimer = 0
        requestRender()
      }, 160)
    }
    const requestRender = () => {
      if (renderRaf) return
      renderRaf = tracker.raf(() => {
        renderRaf = 0
        const t0 = performance.now()
        try { render() } catch (e) { warnGraphDrawError(e, 'render') }
        sim.lastRenderMs = performance.now() - t0
      })
    }
    sim.requestRender = requestRender
    const wake = () => {
      if (warmLeft > 0) return
      // 重新加热：拖拽/松手后要给自组织留出「力」的时间，冷却到 0 的布局才会重新响应。
      sim.alpha = Math.max(sim.alpha || 0, 0.35)
      sim.running = true
      if (!sim.raf) sim.raf = tracker.raf(step)
    }
    sim.wake = wake
    sim.render = render

    // 星球层的碰撞分离：BH 斥力是「点斥力」，不考虑球体半径 —— 大球之间、大球与卡片必须显式推开，
    // 否则散乱漂移几步就叠在一起。只处理星球层（≤20 颗球 + ≤1000 个卡片），每 tick O(P×N)。
    //
    // 0.26 起按「大球排斥小球」重写：
    //   ① 星球之间留的缝随半径增长（大球之间更宽，不再挤成串）；
    //   ② 大球对卡片有一圈「护城河」：硬边界绝不叠球，外侧再用软推力把小卡片赶开，
    //      越大的球推得越远 —— 用户原话「小的球数量多紧贴着大的丑」就是这里来的。
    const separateCollisions = () => {
      if (!planetLayer) return
      // 缓存星球列表：原来每 tick 都 filter 一遍全部节点（60fps 下是纯浪费）
      if (sim.planetsSrc !== sim.nodes) {
        sim.planets = sim.nodes.filter((n) => n.planet)
        sim.planetsSrc = sim.nodes
      }
      const planets = sim.planets
      if (!planets || !planets.length) return
      for (let a = 0; a < planets.length; a++) {
        for (let b = a + 1; b < planets.length; b++) {
          const pa = planets[a]
          const pb = planets[b]
          const dx = pb.x - pa.x
          const dy = pb.y - pa.y
          const d = Math.sqrt(dx * dx + dy * dy) || 1
          const gap = 24 + Math.min(pa.r, pb.r) * 0.18
          const min = pa.r + pb.r + gap
          if (d >= min) continue
          const pen = min - d
          const ux = dx / d
          const uy = dy / d
          // 大球排斥小球：按「面积当质量」分配位移 —— 大球几乎不动，小球被推得更远
          const ma = pa.r * pa.r
          const mb = pb.r * pb.r
          const mt = ma + mb
          const pushA = pen * (mb / mt)
          const pushB = pen * (ma / mt)
          pa.x -= ux * pushA; pa.y -= uy * pushA
          pb.x += ux * pushB; pb.y += uy * pushB
          // 只做部分阻尼：把速度按住会让大球看起来「钉死」，只留一点惯性即可
          pa.vx *= 0.55; pa.vy *= 0.55; pb.vx *= 0.55; pb.vy *= 0.55
        }
      }
      for (const p of planets) {
        const moat = 12
        for (const c of sim.nodes) {
          if (c.planet || c === sim.dragNode) continue
          const dx = c.x - p.x
          const dy = c.y - p.y
          const d = Math.sqrt(dx * dx + dy * dy) || 1
          const ux = dx / d
          const uy = dy / d
          const hard = p.r + c.r + 30
          const zone = hard + moat
          if (d >= zone) continue
          let dist = d
          if (d < hard) {
            // 硬边界：不允许视觉重叠；只去掉朝内的径向速度，保留切向滑动
            c.x = p.x + ux * hard
            c.y = p.y + uy * hard
            const vr0 = c.vx * ux + c.vy * uy
            if (vr0 < 0) { c.vx -= ux * vr0; c.vy -= uy * vr0 }
            dist = hard
          }
          // 软护城河：越靠近球面推力越强，最大推力随球半径增长
          const depth = Math.min(1, (zone - dist) / moat)
          const want = (0.28 + p.r * 0.009) * depth * depth
          const vr = c.vx * ux + c.vy * uy
          if (vr < want) {
            const add = (want - vr) * 0.5
            c.vx += ux * add
            c.vy += uy * add
          }
        }
      }
    }

    // 单步物理：Barnes–Hut 四叉树斥力（O(n log n)），力常数/阻尼/边弹簧与改造前逐项一致。
    // 2049 节点实测单 tick 从 20–40ms（O(n²)）降到 ≈3–4ms（见 tests/graph-force.test.mjs）。
    const tick = () => {
      const t0 = performance.now()
      const result = stepSimulation(sim, { params: sim.forceParams, alphaFloor: sim.drift ? 1 : 0, damping: sim.drift ? 0.8 : undefined })
      // 大球是否在动不能依赖 quietTicks（护城河会持续给小球速度，可能永远等不到静置）。
      separateCollisions()
      sim.lastTickMs = performance.now() - t0
      sim.lastRms = result.rms
      if (sim.autoFitPending && sim.tickCount > 45) { sim.autoFitPending = false; fit() }
    }

    const step = () => {
      if (!sim.running) return
      // 自适应画质：放大后逐帧采样 rAF 间隔；持续掉到 50fps 以下就逐档降细节
      // （只降不升，避免画质在阈值附近来回抖动）。缩回全景时恢复最高画质。
      const now = performance.now()
      let dt = 0
      if (sim.lastStepAt && now - sim.lastStepAt > 0 && now - sim.lastStepAt < 120) {
        dt = now - sim.lastStepAt
        sim.frameEma = sim.frameEma ? sim.frameEma * 0.8 + dt * 0.2 : dt
      }
      sim.lastStepAt = now
      if (sim.tickCount > 30 && dt > 0) {
        // 只在「持续掉帧」时降档：滚轮缩放本身会有几帧抖动，不能因此把画质永久打低。
        if (sim.frameEma > 17.8) sim.perfBad = (sim.perfBad || 0) + dt
        else sim.perfBad = Math.max(0, (sim.perfBad || 0) - dt * 0.5)
        if (sim.perfBad > 500 && (sim.quality | 0) < 3) {
          sim.quality = (sim.quality | 0) + 1
          sim.perfBad = 0
          sim.frameEma = 16.7
        }
        // 反向恢复：连续 4s 跑得很稳就回升一档。
        // 没有这条，一次瞬时卡顿会把画质永久钉在低档（并连带触发静置停车），
        // 用户看到的就是「明明不卡了却一直很糙/不动」。
        if (sim.frameEma && sim.frameEma < 13.5) sim.goodMs = (sim.goodMs || 0) + dt
        else sim.goodMs = 0
        if ((sim.goodMs || 0) > 4000 && (sim.quality | 0) > 0) {
          sim.quality = (sim.quality | 0) - 1
          sim.goodMs = 0
        }
      }
      // 性能不够时，别让「常驻自移动」把机器烧满：
      // 画质已降到 1 档以上、且 1.2s 没有输入 → 停车（跑满帧也救不回来，不如把 CPU 还给用户）。
      // 任何交互都会走 wake() 重新点火。
      const idleMs = performance.now() - (sim.lastInputAt || 0)
      // 两种停车条件：
      //   ① 画质已降档（机器本来就吃力）→ 1.2s 无输入就停；
      //   ② 即使跑得动 → 静置 4s 也停。常驻漂移会让整张图一直在轻微抖动，
      //      帧率再高也显得「不丝滑」，而且平白占用 CPU/GPU。
      // 任何交互都会 wake() 重新点火。
      if (sim.drift && (idleMs > 4000 || ((sim.quality | 0) >= 1 && idleMs > 1200))) {
        sim.drift = false
        sim.running = false
        sim.raf = 0
        return
      }
      // 常驻自移动：预热结束后不再彻底停车，而是进入 60fps 的低速漂移 ——
      // 用户要的是「跟改造前一样 散乱会动」，一张静止的图体验很差。
      // 掉帧由自适应画质降档处理，而不是降低更新频率（30fps 在大球移动时看起来会发顿）。
      // 触发常驻漂移：正常是「连续静置」；但护城河会持续推动小球，rms 可能永远降不到阈值，
      if (!sim.drift && (sim.quietTicks > QUIET_TICKS || (sim.alpha === 0 && sim.tickCount > 120))) {
        sim.quietTicks = 0
        sim.drift = true
        sim.alpha = Math.max(sim.alpha || 0, 1)
        sim.motionUntil = 0 // 常驻运动也保留完整细节（标签/曲线边）
        if (!sim.userTouched) fit()
      }
      // 60fps；真的跑不动由上面的自适应画质降档，而不是靠降低更新频率（那会明显发顿）。
      try {
        // 帧预算：拖拽时必须跟手（每帧 1 tick）；自组织阶段在 18ms 内多跑几步，
        // 让大图在 ~2s 内铺开，而不是每帧 1 tick 磨很久。漂移期每帧 1 tick。
        const frameStart = performance.now()
        const maxTicks = sim.dragNode || sim.drift ? 1 : 6
        let ticks = 0
        do {
          tick()
          ticks += 1
        } while (!sim.dragNode && !sim.drift && ticks < maxTicks && performance.now() - frameStart < 18 && sim.quietTicks <= QUIET_TICKS)
        if (!sim.drift) sim.motionUntil = performance.now() + 60
        const r0 = performance.now()
        render()
        sim.lastRenderMs = performance.now() - r0
      } catch (er) { warnGraphDrawError(er, 'step') }
      sim.raf = tracker.raf(step)
    }

    // 只读运行时诊断（性能回归时用 CDP 探针读取）：不改变任何渲染/交互行为。
    const graphStats = () => ({
      nodes: sim.nodes.length,
      edges: sim.edges.length,
      planets: sim.nodes.filter((n) => n.planet).length,
      level: sim.levelId || '',
      tickCount: sim.tickCount,
      quietTicks: sim.quietTicks,
      running: !!sim.running,
      dragging: !!sim.dragNode,
      lastTickMs: Math.round((sim.lastTickMs || 0) * 100) / 100,
      lastRenderMs: Math.round((sim.lastRenderMs || 0) * 100) / 100,
      rms: Math.round((sim.lastRms || 0) * 1000) / 1000,
      alpha: Math.round((sim.alpha || 0) * 1000) / 1000,
      drift: !!sim.drift,
      frames: sim.renderFrames | 0,
      quality: sim.quality | 0,
      frameEma: Math.round((sim.frameEma || 0) * 10) / 10,
    })
    sim.stats = graphStats
    globalThis.__meGraphStats = graphStats
    // 交互/泄漏探针：图元的**屏幕坐标**（CDP 据此精确点击星球）+ 本层资源账本快照
    const runtimeProbe = () => {
      const rect = canvas.getBoundingClientRect()
      const sx = rect.width ? canvas.clientWidth / rect.width : 1
      const sy = rect.height ? canvas.clientHeight / rect.height : 1
      return {
        level: sim.levelId || '',
        planetLayer: !!sim.planetLayer,
        nodes: sim.nodes.length,
        planets: sim.nodes.filter((n) => n.planet).length,
        edges: sim.edges.length,
        running: !!sim.running,
        quietTicks: sim.quietTicks,
        zoom: Math.round(sim.zoom * 1000) / 1000,
        panX: Math.round(sim.panX), panY: Math.round(sim.panY),
        selected: sim.selectedId || null,
        multi: Array.isArray(sim.multi) ? sim.multi.length : 0,
        drift: !!sim.drift,
        frames: sim.renderFrames | 0,
        resources: tracker.snapshot(),
        screen: sim.nodes.map((n) => ({
          id: n.id,
          label: n.name,
          planet: !!n.planet,
          count: n.count || 0,
          dir: n.orbitDir || 0,
          scale: n.orbitScale ? Math.round(n.orbitScale * 100) / 100 : 0,
          // 屏幕坐标（CSS 像素）：r.left + 局部位移*scale
          x: rect.left + (n.x * sim.zoom + sim.panX) / sx,
          y: rect.top + (n.y * sim.zoom + sim.panY) / sy,
          r: Math.max(4, (n.r * sim.zoom) / sx),
        })),
      }
    }
    sim.runtime = runtimeProbe
    globalThis.__meGraphRuntime = runtimeProbe

    // interactions
    // 注意：根节点有 CSS zoom（布局大小配置）。getBoundingClientRect 返回视觉尺寸，
    // 而 canvas 内部坐标是布局尺寸；不换算会让点击命中整体偏移（uiScale=large 时尤其明显）。
    const toLocal = (cx, cy) => {
      const r = canvas.getBoundingClientRect()
      const sx = r.width ? canvas.clientWidth / r.width : 1
      const sy = r.height ? canvas.clientHeight / r.height : 1
      return { x: (cx - r.left) * sx, y: (cy - r.top) * sy }
    }
    const toWorld = (cx, cy) => { const p = toLocal(cx, cy); return { x: (p.x - sim.panX) / sim.zoom, y: (p.y - sim.panY) / sim.zoom } }
    const nodeVisible = (id) => { const info = sim.domainById[id]; if (!info) return false; if (filterRef.current !== 'all' && info.kind !== filterRef.current) return false; if (tagRef.current && !(info.tags || []).includes(tagRef.current)) return false; return true }
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
    const onMove = (e) => { sim.mouseX = e.clientX; sim.mouseY = e.clientY; const w = toWorld(e.clientX, e.clientY); let hov = null; for (let i = sim.nodes.length-1; i>=0; i--) { const n = sim.nodes[i]; if (!nodeVisible(n.id)) continue; const dx = n.x - w.x, dy = n.y - w.y; if (dx*dx + dy*dy < n.r*n.r + 36) { hov = n.id; break } } if (hov !== sim.hoverId) { sim.hoverId = hov; sim.motionUntil = performance.now() + 140; requestRender() } }
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
      if (sim.marquee) { sim.marquee.ex = e.clientX; sim.marquee.ey = e.clientY; markMotion(); requestRender(); return }
      if (!sim.dragStart) return
      const dx = e.clientX - sim.dragStart.x, dy = e.clientY - sim.dragStart.y
      if (Math.abs(dx) + Math.abs(dy) > 3 && !sim.dragging) {
        sim.dragging = true
        // 真的开始拖节点才重新加热；单纯点击（没有位移）绝不能让物理复活
        if (sim.dragNode) sim.alpha = Math.max(sim.alpha || 0, 0.35)
      }
      // 拖拽节点要真的带动布局（物理），拖拽画布只是平移（只重绘）
      if (sim.dragNode) { const w = toWorld(e.clientX, e.clientY); sim.dragNode.x = w.x + sim.dragOffset.dx; sim.dragNode.y = w.y + sim.dragOffset.dy; markMotion(); wake() }
      else if (sim.dragging) { sim.panX = clamp(sim.dragStart.px + dx, -1e5, 1e5); sim.panY = clamp(sim.dragStart.py + dy, -1e5, 1e5); markMotion(); requestRender() }
    }
    const onUp = (e) => {
      if (sim.marquee) {
        const m = sim.marquee; sim.marquee = null
        const p1 = toLocal(m.sx, m.sy), p2 = toLocal(m.ex, m.ey)
        const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x)
        const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y)
        // 框选只收卡片（大星球是层级入口，不能参与合并/批量删除）
        const ids = sim.nodes.filter((n) => !n.planet && nodeVisible(n.id)).filter((n) => { const wx = n.x * sim.zoom + sim.panX, wy = n.y * sim.zoom + sim.panY; return wx >= x1 && wx <= x2 && wy >= y1 && wy <= y2 }).map((n) => n.id)
        sim.multi = ids; setMulti(ids)
        markMotion(); requestRender(); return
      }
      const wasClick = sim.dragStart && !sim.dragging
      const draggedNode = !!sim.dragNode && !!sim.dragging
      if (sim.shiftClick) {
        // shift 单点凸显：卡片并入 multi（累积选择）；大星球只做单选（没有可合并的实体）
        const id = sim.shiftClick; sim.shiftClick = null
        const target = sim.nodeById.get(id)
        if (target && target.planet) { sim.selectedId = id; setSel(id); requestRender(); return }
        const cur = Array.isArray(sim.multi) ? sim.multi.slice() : []
        if (!cur.includes(id)) cur.push(id)
        sim.multi = cur; setMulti(cur); requestRender(); return
      }
      if (wasClick) {
        const w = toWorld(e.clientX, e.clientY); let hit = null
        for (let i = sim.nodes.length-1; i>=0; i--) { const n = sim.nodes[i]; if (!nodeVisible(n.id)) continue; const dx = n.x - w.x, dy = n.y - w.y; if (dx*dx + dy*dy < n.r*n.r + 20) { hit = n; break } }
        if (hit && hit.planet) {
          // 点大星球 = 进入它那一层（唯一入口手势；拖拽不会触发，因为 dragging 走的是上面那条分支）
          sim.selectedId = null; setSel(null); requestRender()
          sim.dragStart = null; sim.dragging = false; sim.dragNode = null
          if (onDrillRef.current) onDrillRef.current(hit.id)
          return
        }
        // 选中/取消只改视觉：重绘一帧即可，不唤醒物理（这是「点击即卡死」的关键解耦点）。
        // 再点一次同一张卡 = 取消选中（「点击选中/取消」两态都在这一个手势里）。
        if (hit) {
          if (sim.selectedId === hit.id) { sim.selectedId = null; setSel(null); requestRender() }
          else { sim.selectedId = hit.id; setSel(hit.id); requestRender() }
        }
        else { sim.selectedId = null; sim.hoverId = null; if (!e.shiftKey) { sim.multi = []; setMulti([]) } setSel(null); requestRender() }
      }
      sim.dragStart = null; sim.dragging = false; sim.dragNode = null
      // 拖拽结束：让被拖动的节点带动邻居重新自组织（收敛到静止后自动停车）
      if (draggedNode) wake()
    }
    const onCtx = (e) => {
      e.preventDefault()
      const w = toWorld(e.clientX, e.clientY); let hit = null
      for (let i = sim.nodes.length-1; i>=0; i--) { const n = sim.nodes[i]; if (!nodeVisible(n.id)) continue; const dx = n.x - w.x, dy = n.y - w.y; if (dx*dx + dy*dy < n.r*n.r + 25) { hit = n; break } }
      if (hit) { const d = sim.domainById[hit.id]; if (d) setCtx({ x: e.clientX, y: e.clientY, id: hit.id, path: d.id, title: d.title, planet: !!hit.planet, count: hit.count || 0 }) }
      else setCtx(null)
    }
    const onWheel = (e) => {
      e.preventDefault()
      const p = toLocal(e.clientX, e.clientY)
      const wx = (p.x - sim.panX) / sim.zoom
      const wy = (p.y - sim.panY) / sim.zoom
      const newZoom = Math.max(MIN_VIEW_ZOOM, Math.min(3, sim.zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)))
      sim.panX = clamp(sim.panX + wx * (sim.zoom - newZoom), -1e5, 1e5)
      sim.panY = clamp(sim.panY + wy * (sim.zoom - newZoom), -1e5, 1e5)
      sim.zoom = newZoom
      sim.userTouched = true
      // 不再每次滚轮都把画质重置为 0：一次缩放是连续几十个 wheel 事件，
      // 重置等于「整个手势期间强制最高画质」——这正是缩放/放大时掉帧的主因之一。
      // 画质改为运行期只降不升；进入新层级时由初始化重置。
      markMotion()
      requestRender()
    }
    // 所有监听器都过 tracker：卸载时 releaseAll() 一次归还，20 轮下钻不会积累
    tracker.listen(canvas, 'mousemove', onMove)
    tracker.listen(canvas, 'mousedown', onDown)
    tracker.listen(window, 'mousemove', onDrag)
    tracker.listen(window, 'mouseup', onUp)
    tracker.listen(canvas, 'wheel', onWheel, { passive: false })
    tracker.listen(canvas, 'contextmenu', onCtx)

    resetRef.current = () => { sim.selectedId = null; sim.hoverId = null; sim.multi = []; setMulti([]); sim.userTouched = false; fit(); markMotion(); requestRender() }
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
        sim.warmRaf = tracker.raf(warmStep)
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
    if (warmLeft > 0) sim.warmRaf = tracker.raf(warmStep)
    else { setWarming(0); wake() }

    const onDocMouseDown = () => setFilterOpen(false)
    tracker.listen(window, 'mousedown', onDocMouseDown)

    return () => {
      sim.running = false
      // 一次归还：rAF / 定时器 / 监听器全部由账本统一取消（20 轮下钻/返回不增长）
      tracker.releaseAll()
      if (globalThis.__meGraphStats === graphStats) { try { delete globalThis.__meGraphStats } catch (e) { globalThis.__meGraphStats = undefined } }
      if (globalThis.__meGraphRuntime === runtimeProbe) { try { delete globalThis.__meGraphRuntime } catch (e) { globalThis.__meGraphRuntime = undefined } }
      try { ro.disconnect() } catch { /* 已断开 */ }
    }
  }, [items, edges, levelId, skin])

  // 换层时清空选中/框选：上一层的图元 id 在新层里不存在，留着会显示成一条「孤儿」侧栏
  useEffect(() => {
    setSel(null)
    setMulti([])
    setCtx(null)
    const s = simRef.current
    if (s) { s.selectedId = null; s.multi = [] }
  }, [levelId])

  // 切换到图谱视图时重新 fit，让画布居中适配当前容器尺寸
  useEffect(() => {
    if (fitTrigger !== undefined && fitRef.current) {
      requestAnimationFrame(() => { try { fitRef.current() } catch (e) { warnGraphDrawError(e, 'fit') } })
    }
  }, [fitTrigger])

  return (
    <div className="me-graph" ref={wrapRef}>
      <div className="me-graph-toolbar">
        <label className="me-graph-search">
          <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.4" /><path d="m10.4 10.4 3.2 3.2" strokeLinecap="round" /></svg>
          <input type="text" placeholder={t('search')} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('search')} />
        </label>
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <button type="button" className={'me-gtool' + (filterKind !== 'all' || timeMode || filterTag ? ' on' : '')} onClick={() => setFilterOpen((v) => !v)} aria-expanded={filterOpen} title={t('filterLabel')}>
            {t('filterLabel')}
            {filterKind !== 'all' || timeMode || filterTag ? <span className="badge" aria-hidden="true" /> : <span className="caret" aria-hidden="true">▾</span>}
          </button>
          {filterOpen && <div className="me-graph-legend-pop" onMouseDown={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 50, background: 'rgba(24,28,34,0.97)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', color: '#e5e9ef', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 11, padding: 8, minWidth: 236, boxShadow: '0 18px 44px rgba(0,0,0,.5)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button type="button" className={`lg${filterKind === 'all' && !timeMode ? ' active' : ''}`} onClick={() => { setFilterKind('all'); setTimeMode(false) }}>{t('all')}</button>
              {Object.keys(KIND_COLORS).map((k) => (
                <button key={k} type="button" className={`lg${filterKind === k ? ' active' : ''}`} onClick={() => setFilterKind((f) => (f === k ? 'all' : k))}>
                  <span className="mc-kind" style={{ background: KG.colors[k] || KIND_COLORS[k] }} />{t(KIND_LABELS[k])}
                </button>
              ))}
              <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '5px 0' }} />
              <button type="button" className={`lg${timeMode ? ' active' : ''}`} onClick={() => setTimeMode((v) => !v)}>⏱ {t('timeDim')}</button>
              {allTags.length > 0 && (
                <>
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '5px 0' }} />
                  <div style={{ maxHeight: 130, overflow: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4, padding: '1px 1px 2px' }}>
                    {allTags.map((o) => (
                      <button key={o.tag} type="button" className={`lg${filterTag === o.tag ? ' active' : ''}`} style={{ width: 'auto', color: '#b9c0ca', padding: '2px 7px', fontSize: 10.5, border: '1px solid rgba(255,255,255,.07)' }} onClick={() => setFilterTag((f) => (f === o.tag ? '' : o.tag))} title={o.tag}>
                        #{o.tag} <span style={{ opacity: 0.55 }}>{o.n}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {(filterKind !== 'all' || timeMode || filterTag) && <button type="button" className="lg lg-clear" style={{ color: '#f87171' }} onClick={() => { setFilterKind('all'); setTimeMode(false); setFilterTag('') }}>{t('clearFilter')} ✕</button>}
            </div>
          </div>}
        </span>
        <label className={'me-gswitch' + (all ? ' on' : '')} title={t('crossVault')}>
          <input type="checkbox" checked={!!all} onChange={(e) => onAllChange && onAllChange(e.target.checked)} />
          <span className="track" aria-hidden="true" />
          <span>{t('crossVault')}</span>
        </label>
        <button type="button" className={'me-gtool' + (timeMode ? ' on' : '')} aria-pressed={timeMode} onClick={() => setTimeMode((v) => !v)}>{t('timeDim')}</button>
        <span className="me-gdiv" aria-hidden="true" />
        <button type="button" className="me-gtool" onClick={() => { const c = canvasRef.current; if (!c) return; try { c.toBlob((blob) => { if (!blob) return; setExportData({ url: URL.createObjectURL(blob), blob }) }, 'image/png') } catch (e) { /* 预览兜底 */ } }}>{t('exportGraph')}</button>
        <button type="button" className="me-gtool" onClick={() => fitRef.current && fitRef.current()}>{t('fit')}</button>
        <button type="button" className="me-gtool" onClick={() => { setSel(null); setFilterKind('all'); resetRef.current && resetRef.current() }}>{t('reset')}</button>
      </div>
      <div className="me-graph-canvas" style={{ position: 'relative', overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />
        {/* 图内面包屑：任意一级都能点回去（命中层级缓存 → 零新增请求） */}
        <GraphBreadcrumb crumbs={crumbs} t={t} onPick={onNavigate} busy={loading} />
        {error && (
          <div className="me-graph-levelerr" role="alert">
            <span style={{ flex: 'none', fontWeight: 800 }}>{error.timeout ? '⏱' : '✕'}</span>
            <span className="msg">{(error.timeout ? t('graphLevelTimeout').replace('{ms}', String(LEVEL_TIMEOUT_MS)) : t('graphLevelError')) + '：' + error.message}</span>
            <button type="button" onClick={() => onRetry && onRetry()}>{t('graphRetry')}</button>
          </div>
        )}
        {!error && loading && (
          <div className="me-graph-levelbusy" role="status" aria-live="polite"><ProgressBar small />{t('graphLevelLoading')}</div>
        )}
{warming !== null && <div role="status" aria-live="polite" style={{ position: 'absolute', left: '50%', top: 14, transform: 'translateX(-50%)', zIndex: 3, display: 'flex', alignItems: 'center', gap: 9, padding: '6px 12px', borderRadius: 999, background: 'rgba(23,27,33,0.9)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', color: '#e8ebf0', fontSize: 11, fontWeight: 500, letterSpacing: '.01em', pointerEvents: 'none', border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 10px 26px rgba(0,0,0,.3)' }}><ProgressBar value={warming} small /><span>{t('graphWarming').replace('{n}', nodes.length)} · {Math.round(warming)}%</span></div>}
        <div className="mc-v5-graph-legend">
          <div className="mc-v5-graph-legend-title">{t('graphLegendTitle')}</div>
          {Object.keys(KG.colors).filter((k) => kindStats[k]).map((k) => (
            <div key={k} className="mc-v5-graph-legend-row"><i style={{ background: KG.colors[k], boxShadow: '0 0 0 3px ' + KG.colors[k] + '24' }} /><span>{t(KIND_LABELS[k] || 'kindKnowledge')}</span><b>{kindStats[k]}</b></div>
          ))}
        </div>
        <div className="me-graph-tooltip" ref={tooltipRef} style={{ display: 'none', position: 'absolute', zIndex: 4, pointerEvents: 'none', background: 'rgba(24,28,34,0.94)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', color: '#e6eaf0', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 9, padding: '8px 10px', fontSize: 11.5, maxWidth: 220, boxShadow: '0 12px 30px rgba(0,0,0,.34)' }} />
        {noMatch && <div className="mc-empty" style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)' }}>{t('noMatch')}</div>}
        {ctx && <div className="me-graph-ctx-back" style={{ position: 'fixed', inset: 0, zIndex: 30 }} onMouseDown={() => setCtx(null)} />}
        {ctx && (
          <div className="me-graph-ctxmenu" style={{ position: 'fixed', left: ctx.x, top: ctx.y, zIndex: 31 }} onMouseDown={(e) => e.stopPropagation()}>
            {ctx.planet && <button type="button" onClick={() => { const id = ctx.id; setCtx(null); if (onDrillRef.current) onDrillRef.current(id) }}>{t('graphEnter')} ›</button>}
            {ctx.planet && <div style={{ padding: '4px 10px 6px', fontSize: 11, opacity: 0.7 }}>{t('graphPlanetCards').replace('{n}', String(ctx.count || 0))}</div>}
            {!ctx.planet && <button type="button" onClick={() => { onOpenRef.current({ path: ctx.path, title: ctx.title }); setCtx(null) }}>{t('openCard')}</button>}
            {!ctx.planet && <button type="button" onClick={() => { if (ctx.id) { simRef.current.selectedId = ctx.id; setSel(ctx.id) } setCtx(null); const s = simRef.current; if (s && s.requestRender) s.requestRender() }}>{t('focusNeighbors')}</button>}
            <button type="button" onClick={() => { try { if (navigator.clipboard) navigator.clipboard.writeText(ctx.title || '') } catch (e) {} setCtx(null); notify(t('copied')) }}>{t('copyName')}</button>
            {!ctx.planet && <button type="button" onClick={() => { const s = simRef.current; const ps = (s && Array.isArray(s.multi) ? s.multi.slice() : []); const id = ctx.id; if (id && !ps.includes(id)) ps.push(id); setCtx(null); if (ps.length < 2) { notify(t('mergeNeed'), false); return } if (!window.confirm(t('mergeConfirm'))) return; const pr = onMergeRef.current && onMergeRef.current(ps); if (pr && pr.then) pr.then((ok) => ok ? notify(t('merged')) : notify(t('mergeFail'), false)).catch(() => notify(t('mergeFail'), false)); else if (pr) notify(t('merged')); }}>{t('merge')}</button>}
            {!ctx.planet && <button type="button" style={{ color: '#f87171' }} onClick={() => { const p = ctx.path; setCtx(null); if (window.confirm(t('deleteConfirm'))) { (async () => { try { const ok = onDeleteRef.current ? await onDeleteRef.current(p) : false; if (ok) { notify(t('deleted')) } else { notify(t('deleteFail'), false) } } catch (e) { notify(t('deleteFail'), false) } })() } }}>{t('delete')}</button>}
          </div>
        )}
        {multi.length > 0 && (
          <div style={{ position: 'absolute', left: '50%', bottom: 52, transform: 'translateX(-50%)', zIndex: 3, display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(24,28,34,0.94)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', color: '#e6eaf0', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 11, padding: '7px 11px', fontSize: 11.5, boxShadow: '0 14px 34px rgba(0,0,0,.4)' }}>
            <span style={{ fontWeight: 700 }}>{multi.length} {t('nodes')}</span>
            <button type="button" className="mc-btn" onClick={() => { const ns = multi.map((id) => nodeById[id]).filter(Boolean); const txt = ns.map((n) => n.title || n.name).join('\n'); const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'memory-selected.txt'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000); notify(multi.length + t('exportedSel')) }}>{t('exportSel')}</button>
            <button type="button" className="mc-btn" onClick={() => { if (multi.length < 2) { notify(t('mergeNeed'), false); return } const paths = multi.map((id) => (nodeById[id] ? nodeById[id].id : id)); if (!window.confirm(t('mergeConfirm'))) return; setMulti([]); const st = simRef.current; if (st) { st.multi = [] } fetch(`${API}/merge?paths=${encodeURIComponent(paths.join(','))}`).then((r) => r.json()).then((d) => { if (d && d.ok) { notify(t('merged')) } else { notify(t('mergeFail'), false) } }).catch(() => notify(t('mergeFail'), false)) }}>{t('merge')}</button>
            <button type="button" className="mc-btn mc-btn-danger" onClick={() => { if (!window.confirm(t('deleteConfirm'))) return; const paths = multi.map((id) => (nodeById[id] ? nodeById[id].id : id)); setMulti([]); const s = simRef.current; if (s) { s.multi = [] } (async () => { let n = 0; for (const p of paths) { try { const ok = onDeleteRef.current ? await onDeleteRef.current(p) : false; if (ok) n++ } catch (e) {} } notify(n + t('deletedSelected'), n > 0) })() }}>{t('deleteSelected')}</button>
            <button type="button" className="mc-btn" onClick={() => { const s = simRef.current; if (s) { s.multi = [] } setMulti([]); const s2 = simRef.current; if (s2 && s2.render) s2.render() }}>{t('clearSelection')}</button>
          </div>
        )}
        {sel && nodeById[sel] && <div className="me-graph-sidebar" style={{ position: 'absolute', right: 14, top: 14, zIndex: 3, maxWidth: 248, background: 'rgba(24,28,34,0.94)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', color: '#e6eaf0', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 11, padding: 13, fontSize: 11.5, boxShadow: '0 14px 34px rgba(0,0,0,.38)' }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{nodeById[sel] ? (nodeById[sel].title || nodeById[sel].name) : sel}</div>
          <div style={{ opacity: .8, marginBottom: 8 }}>
            {nodeById[sel] ? t(KIND_LABELS[nodeById[sel].kind] || 'kindKnowledge') : '—'}
            {nodeById[sel] && nodeById[sel].type === 'planet' ? ' · ' + t('graphPlanetCards').replace('{n}', String(nodeById[sel].count || 0)) : ''}
          </div>
          {nodeById[sel] && nodeById[sel].type === 'planet' && (
            <button type="button" className="mc-btn" style={{ width: '100%', marginBottom: 8 }} onClick={() => { const id = sel; setSel(null); if (onDrillRef.current) onDrillRef.current(id) }}>{t('graphEnter')} ›</button>
          )}
          <div style={{ fontSize: 11, opacity: .65, letterSpacing: '.04em', marginBottom: 6 }}>{t('graphLevelHint')}</div>
          {(edges.filter((e) => e.source === sel || e.target === sel) || []).slice(0, 8).map((e, i) => {
            const o = e.source === sel ? e.target : e.source
            const nn = nodeById[o]
            return <div key={i} style={{ padding: '4px 6px', cursor: 'pointer', borderRadius: 6 }} onMouseDown={(ev) => { ev.preventDefault(); const s = simRef.current; if (s) { s.selectedId = o; s.hoverId = o; if (s.requestRender) s.requestRender() } setSel(o) }}>{nn ? (nn.title || nn.name).slice(0, 28) : o}</div>
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
  if (days < 3) return '#34D399'
  if (days < 14) return '#FBBF24'
  if (days < 30) return '#FF7A45'
  return '#8CA0B3'
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
    // 用 div 而不是 label：里面还有一组「勾选型」label（每个自带宽 input），
    // 嵌套 label 既不合法，也会让外层点击落到第一个可关联控件上（误触发第一个复选框）。
    <div className="mc-field">
      <span className="mc-field-label">{label}</span>
      <div ref={boxRef} style={{ position: 'relative', minWidth: 0 }}>
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text || placeholder || '—'}</span>
          <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
        </button>
        {open && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: z, marginTop: 2, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', boxShadow: '0 6px 20px rgba(0,0,0,0.14)', maxHeight: 180, overflow: 'auto' }}>
            {allOpt && (
              <label onClick={(e) => e.stopPropagation()} className="mc-dd-opt" style={{ borderBottom: '1px solid rgba(127,127,127,0.12)' }}>
                <input type="checkbox" checked={hasAll} onChange={(e) => setSelected(allOpt, e.target.checked)} />
                <span>{allOpt.label}</span>
              </label>
            )}
            {normalOpts.map((o) => (
              <label key={o.value} onClick={(e) => e.stopPropagation()} className="mc-dd-opt">
                <input type="checkbox" checked={val.includes(o.value)} onChange={(e) => setSelected(o, e.target.checked)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
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
  const d = toLocalDate(iso)
  if (!d) return ''
  const sameDay = d.toDateString() === new Date().toDateString()
  const hm = localClock(d)
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}
