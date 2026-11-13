// 统一组件层（最小集合）
//
// 目标不是再造一套 UI 库，而是把面板里重复了上百次的三件事收敛成**有语义的组件**：
//   ① 按钮等级：原来只有 `mc-btn`（普通）与 `me-on`（看起来像主按钮）两种，一个屏幕上经常
//      同时出现四五个"主按钮"，用户不知道该点哪个；
//   ② 状态呈现：服务/备份/索引这些"有健康度"的东西，红绿点与文案散落在各处；
//   ③ 空态 / 错误：87 处空态文案、159 处 toast + 30 处 setNote，两套提示机制并存。
//
// 约定：组件只吃 design-tokens 的令牌与 CSS 类（`ui/design-tokens.js` 里的 COMPONENTS_CSS），
// 不写内联颜色与尺寸。皮肤换色只改变量。

import React from 'react'
import { space, FONT, RADIUS } from './design-tokens.js'

const cx = (...xs) => xs.filter(Boolean).join(' ')

/**
 * 按钮。**一个屏幕最多一个 primary**（这条由测试守）。
 * @param {{variant?:'primary'|'secondary'|'ghost'|'danger', size?:'sm'|'md', loading?:boolean,
 *   icon?:string, title?:string, onClick?:Function, disabled?:boolean, children?:any}} props
 */
export function Btn({ variant = 'secondary', size = 'md', loading = false, icon = '', children, className = '', disabled, ...rest }) {
  // 注意：children 不能做字符串拼接。
  // 旧实现是 (icon || '') + children —— 当 children 是多段文案的数组时（例如 icon + {t(...)}、
  // 或 {t('pending')}（{n}）），会走 Array#toString：各段被 join(',') 拼成一串，
  // 于是文案里凭空多出逗号、内嵌 <span> 变成 "[object Object]"。
  // 用户报的「所有按钮都不要增加这种字符串」「待审核，（4，）」「● ，自动备份」都是这一处造成的。
  // 现在用 Fragment 原样挂 children，图标与文案的间距交给 .me-btn 的 gap。
  return React.createElement('button', {
    type: 'button',
    className: cx('me-btn', 'me-btn--' + variant, size === 'sm' && 'me-btn--sm', className),
    disabled: disabled || loading,
    ...rest,
  }, loading ? '…' : React.createElement(React.Fragment, null, icon ? icon : null, children))
}

/**
 * 状态点 + 文案。**文字也跟着着色**：只靠一个小圆点区分「启动/未启动」在密集面板里看不清，
 * 绿=正常、琥珀=需要注意、红=不可用、灰=未知/未安装。
 * @param {{tone:'ok'|'warn'|'bad'|'idle', text:string, sub?:string}} props
 */
export function Status({ tone = 'idle', text = '', sub = '' }) {
  return React.createElement('span', { className: 'me-status me-status--' + tone, title: sub || text },
    React.createElement('i', { className: 'me-dot me-dot--' + tone }),
    text,
    sub ? React.createElement('span', { className: 'me-status__sub' }, sub) : null)
}

/**
 * 空态。**必须带一句"下一步做什么"**（hint），能给主操作就给。
 * @param {{icon?:string, title:string, hint?:string, action?:any}} props
 */
export function EmptyState({ icon = '🗂', title = '', hint = '', action = null }) {
  return React.createElement('div', { className: 'me-empty' },
    React.createElement('div', { className: 'me-empty__icon' }, icon),
    React.createElement('div', { className: 'me-empty__title' }, title),
    hint ? React.createElement('div', { className: 'me-empty__hint' }, hint) : null,
    action)
}

/**
 * 错误条。**必须可重试或给下一步**，不然用户只能刷新页面。
 * @param {{error:string, onRetry?:Function, retryText?:string, extra?:any}} props
 */
export function ErrorBar({ error = '', onRetry = null, retryText = '重试', extra = null }) {
  if (!error) return null
  return React.createElement('div', { className: 'me-error' },
    React.createElement('span', null, '⚠'),
    React.createElement('div', { className: 'me-error__body' }, error),
    extra,
    onRetry ? React.createElement(Btn, { variant: 'sm', size: 'sm', onClick: onRetry }, retryText) : null)
}

/**
 * 步骤条。多步任务（语义召回、首次引导、备份恢复）统一用它，让用户知道"我在第几步、下一步点哪"。
 * @param {{steps:string[], current:number, done:number[]}} props current 从 0 开始
 */
export function StepFlow({ steps = [], current = 0, done = [] }) {
  return React.createElement('div', { className: 'me-steps' },
    steps.map((label, i) => [
      i > 0 ? React.createElement('span', { key: 'sep' + i, className: 'me-steps__sep' }, '→') : null,
      React.createElement('span', {
        key: 's' + i,
        className: cx('me-steps__item', done.includes(i) && 'me-steps__item--done', i === current && 'me-steps__item--now'),
      },
        React.createElement('span', { className: 'me-steps__num' }, done.includes(i) ? '✓' : String(i + 1)),
        label),
    ]))
}

/** 骨架屏（加载态用它，别再用一行"加载中…"）。 */
export function Skeleton({ h = 14, w = '100%', style = null }) {
  return React.createElement('div', { className: 'me-skel', style: { height: h, width: w, ...(style || {}) } })
}

/** 区块（标题 + 说明 + 右侧操作）。 */
export function Section({ title = '', desc = '', actions = null, children = null, style = null }) {
  return React.createElement('section', { style: { display: 'flex', flexDirection: 'column', gap: space(3), ...(style || {}) } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: space(3), flexWrap: 'wrap' } },
      React.createElement('div', { style: { flex: 1, minWidth: 160 } },
        React.createElement('div', { style: { fontSize: FONT.lg, fontWeight: 700 } }, title),
        desc ? React.createElement('div', { style: { fontSize: FONT.sm, color: 'var(--me-c-text-dim)', marginTop: 2, lineHeight: 1.55 } }, desc) : null),
      actions),
    children)
}

/** 一行提示（替代散落的 setNote 小字）。 */
export function Hint({ tone = 'info', children }) {
  const map = { info: ['var(--me-c-info)', 'var(--me-c-info-soft)'], ok: ['var(--me-c-success)', 'var(--me-c-success-soft)'], warn: ['var(--me-c-warn)', 'var(--me-c-warn-soft)'], bad: ['var(--me-c-danger)', 'var(--me-c-danger-soft)'] }
  const [fg, bg] = map[tone] || map.info
  return React.createElement('div', {
    style: { color: fg, background: bg, border: '1px solid ' + fg, borderRadius: RADIUS.md, padding: '6px 10px', fontSize: FONT.sm, lineHeight: 1.55 },
  }, children)
}
