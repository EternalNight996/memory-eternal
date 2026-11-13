// 设计令牌（Design Tokens）
//
// 为什么要有这层：`src/client/index.tsx` 里现在有 527 处 inline style、1467 处硬编码十六进制色、
// 377 处硬编码 padding、220 处硬编码字号 —— 同一件事（间距 8px、次文字色、卡片圆角）在十几个地方
// 各写一遍，于是「摘要太淡」「按钮等级分不清」「这个页面和那个页面不像一套东西」会反复出现。
//
// 这一层不是要一次把 11150 行全改掉（那是高风险改造），而是**给新写/正在改的代码一个唯一口径**：
//   · 尺寸、字号、圆角、颜色、动效一律从这里取；
//   · 组件（ui/components.jsx）只认这些令牌；
//   · 旧代码在原处继续跑，遇到就顺手换，不做大面积重排。
//
// 约定：`space(n)` 是 4 的倍数档；字号只允许 6 档；颜色只允许语义名，不写死色值。

/** 间距档（4px 基准）。除了 0，只允许这些值 —— 目的就是不让 7px / 9px / 11px 这种随意值再出现。 */
export const SPACE = [0, 2, 4, 6, 8, 12, 16, 24, 32]
export const space = (i) => SPACE[Math.max(0, Math.min(SPACE.length - 1, Number(i) || 0))]

/** 字号档：10（极小标注）/11（次要）/12（正文小）/13（正文）/14（小标题）/16（标题）/20（大标题）。 */
export const FONT = { xxs: 10, xs: 11, sm: 12, md: 13, lg: 14, xl: 16, xxl: 20 }
export const LINE = { tight: 1.35, normal: 1.55, loose: 1.7 }

/** 圆角。 */
export const RADIUS = { sm: 6, md: 10, lg: 14, pill: 999 }

/** 动效时长（毫秒）与曲线。 */
export const MOTION = { fast: 120, base: 180, slow: 260, ease: 'cubic-bezier(.2,.7,.3,1)' }

/**
 * 语义色。这里是**唯一写死色值的地方**；组件里只按名字取。
 * 每套皮肤通过 `[data-skin]` 覆盖 CSS 变量即可，不必改组件。
 */
export const COLOR = {
  // 中性层
  text: '#e8ebf0',
  textDim: '#c3c9d4',
  textMuted: '#8f97a6',
  panel: '#1f242c',
  panelAlt: '#262c36',
  border: '#39424f',
  borderStrong: '#4c5766',
  // 语义层
  accent: '#3b82f6',
  accentSoft: 'rgba(59,130,246,.16)',
  success: '#10b981',
  successSoft: 'rgba(16,185,129,.16)',
  warn: '#f59e0b',
  warnSoft: 'rgba(245,158,11,.16)',
  danger: '#ef4444',
  dangerSoft: 'rgba(239,68,68,.16)',
  info: '#38bdf8',
  infoSoft: 'rgba(56,189,248,.16)',
  // 高亮（搜索命中）
  mark: '#fde68a',
  markText: '#3b2f00',
}

/**
 * 把令牌铺成 CSS 变量（挂在 `:root` 上，皮肤只需覆盖同名变量）。
 * 组件优先用 `var(--me-xxx)`，这样换皮肤不用改组件代码。
 */
export const TOKENS_CSS = `
:root{
  --me-sp-0:${SPACE[0]}px; --me-sp-1:${SPACE[1]}px; --me-sp-2:${SPACE[2]}px; --me-sp-3:${SPACE[3]}px;
  --me-sp-4:${SPACE[4]}px; --me-sp-5:${SPACE[5]}px; --me-sp-6:${SPACE[6]}px; --me-sp-7:${SPACE[7]}px; --me-sp-8:${SPACE[8]}px;
  --me-fs-xxs:${FONT.xxs}px; --me-fs-xs:${FONT.xs}px; --me-fs-sm:${FONT.sm}px; --me-fs-md:${FONT.md}px;
  --me-fs-lg:${FONT.lg}px; --me-fs-xl:${FONT.xl}px; --me-fs-xxl:${FONT.xxl}px;
  --me-lh-tight:${LINE.tight}; --me-lh-normal:${LINE.normal}; --me-lh-loose:${LINE.loose};
  --me-r-sm:${RADIUS.sm}px; --me-r-md:${RADIUS.md}px; --me-r-lg:${RADIUS.lg}px; --me-r-pill:${RADIUS.pill}px;
  --me-mo-fast:${MOTION.fast}ms; --me-mo-base:${MOTION.base}ms; --me-mo-slow:${MOTION.slow}ms; --me-mo-ease:${MOTION.ease};
  --me-c-text:${COLOR.text}; --me-c-text-dim:${COLOR.textDim}; --me-c-text-muted:${COLOR.textMuted};
  --me-c-panel:${COLOR.panel}; --me-c-panel-alt:${COLOR.panelAlt}; --me-c-border:${COLOR.border}; --me-c-border-strong:${COLOR.borderStrong};
  --me-c-accent:${COLOR.accent}; --me-c-accent-soft:${COLOR.accentSoft};
  --me-c-success:${COLOR.success}; --me-c-success-soft:${COLOR.successSoft};
  --me-c-warn:${COLOR.warn}; --me-c-warn-soft:${COLOR.warnSoft};
  --me-c-danger:${COLOR.danger}; --me-c-danger-soft:${COLOR.dangerSoft};
  --me-c-info:${COLOR.info}; --me-c-info-soft:${COLOR.infoSoft};
  --me-c-mark:${COLOR.mark}; --me-c-mark-text:${COLOR.markText};
}
`

/** 组件基础样式（按钮等级 / 状态点 / 空态 / 错误条 / 步骤条）。皮肤覆盖只改变量。 */
export const COMPONENTS_CSS = `
.me-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid transparent;
  border-radius:var(--me-r-md);font-size:var(--me-fs-sm);line-height:1;cursor:pointer;
  transition:background var(--me-mo-fast),border-color var(--me-mo-fast),transform var(--me-mo-fast);padding:7px 12px}
.me-btn[disabled]{opacity:.5;cursor:not-allowed}
.me-btn:active:not([disabled]){transform:translateY(1px)}
.me-btn--primary{background:var(--me-c-accent);border-color:var(--me-c-accent);color:#fff;font-weight:600}
.me-btn--primary:hover:not([disabled]){filter:brightness(1.08)}
.me-btn--secondary{background:transparent;border-color:var(--me-c-border-strong);color:var(--me-c-text)}
.me-btn--secondary:hover:not([disabled]){border-color:var(--me-c-accent);color:var(--me-c-accent)}
.me-btn--ghost{background:transparent;border-color:transparent;color:var(--me-c-text-dim);padding:6px 8px}
.me-btn--ghost:hover:not([disabled]){color:var(--me-c-text);background:rgba(127,127,127,.10)}
.me-btn--danger{background:transparent;border-color:var(--me-c-danger);color:var(--me-c-danger)}
.me-btn--danger:hover:not([disabled]){background:var(--me-c-danger-soft)}
.me-btn--sm{padding:4px 9px;font-size:var(--me-fs-xs);border-radius:var(--me-r-sm)}
.me-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px rgba(127,127,127,.12)}
.me-dot--ok{background:var(--me-c-success)} .me-dot--warn{background:var(--me-c-warn)}
.me-dot--bad{background:var(--me-c-danger)} .me-dot--idle{background:var(--me-c-text-muted)}
.me-status{display:inline-flex;align-items:center;gap:6px;font-size:var(--me-fs-sm);font-weight:600}
/* 文字跟着状态点一起着色：只靠小圆点区分「启动 / 未启动」，在密集面板里根本看不清 */
.me-status--ok{color:var(--me-c-success)}
.me-status--warn{color:var(--me-c-warn)}
.me-status--bad{color:var(--me-c-danger)}
.me-status--idle{color:var(--me-c-text-muted)}
.me-status__sub{color:var(--me-c-text-muted);font-size:var(--me-fs-xs)}
.me-empty{display:flex;flex-direction:column;align-items:center;gap:var(--me-sp-3);padding:var(--me-sp-8) var(--me-sp-5);
  text-align:center;color:var(--me-c-text-dim);border:1px dashed var(--me-c-border);border-radius:var(--me-r-lg);background:rgba(127,127,127,.04)}
.me-empty__icon{font-size:26px;line-height:1}
.me-empty__title{font-size:var(--me-fs-md);color:var(--me-c-text);font-weight:600}
.me-empty__hint{font-size:var(--me-fs-sm);line-height:var(--me-lh-normal);max-width:46ch}
.me-error{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:var(--me-r-md);
  background:var(--me-c-danger-soft);border:1px solid var(--me-c-danger);color:var(--me-c-text);font-size:var(--me-fs-sm)}
.me-error__body{flex:1;line-height:var(--me-lh-normal);word-break:break-word}
.me-steps{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:var(--me-fs-xs);color:var(--me-c-text-muted)}
.me-steps__item{display:inline-flex;align-items:center;gap:5px}
.me-steps__num{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;
  border:1px solid currentColor;font-size:9px}
.me-steps__item--done{color:var(--me-c-success)}
.me-steps__item--done .me-steps__num{background:var(--me-c-success-soft);border-color:var(--me-c-success)}
.me-steps__item--now{color:var(--me-c-accent);font-weight:600}
.me-steps__item--now .me-steps__num{background:var(--me-c-accent-soft);border-color:var(--me-c-accent)}
.me-steps__sep{opacity:.45}
.me-skel{border-radius:var(--me-r-sm);background:linear-gradient(90deg,rgba(127,127,127,.10),rgba(127,127,127,.18),rgba(127,127,127,.10));
  background-size:200% 100%;animation:me-skel 1.2s ease-in-out infinite}
@keyframes me-skel{0%{background-position:200% 0}100%{background-position:-200% 0}}
`
