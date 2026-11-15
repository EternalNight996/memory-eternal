## 🎨 v0.48.2 — 知识卡片 hover 不再变红（看着像"这张卡出错了"）

### 安装 / 升级

```bash
npm i -g memory-eternal@0.48.2
cd ~/.dsh/profiles/desktop && pnpm update memory-eternal   # 桌面版
cd ~/.dsh/profiles/web     && pnpm add memory-eternal@0.48.2
```

> 升级后**重启一次 DSH**（宿主侧会在启动时加载新的页面脚本），然后刷新面板即可看到效果。

### 修的是什么

卡片标题的 hover 规则原来这样写：

```css
/* 旧：鼠标一划过，标题文字换成品牌色 */
.mc-cardrow:hover .mc-v5-card-title { color: var(--dsw-alias-brand-primary, #ff7a45); }
```

而 `--dsw-alias-brand-primary` 在几套皮肤里是**高饱和状态色** —— 蜘蛛侠 `#e62429`（报错红）、波普 `#ff2e63`（玫红）、生化 `#7cff3f`（毒绿）。于是白卡面上的黑标题，鼠标一划过就整行变红，看着像"这张卡出问题了"（用户实测反馈，云端库里尤其明显）。

### 改成什么

```css
/* 新：文字颜色保持卡面墨色，只加一条品牌色下划线表示"可点开" */
.mc-cardrow:hover .mc-v5-card-title {
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
  text-decoration-color: var(--dsw-alias-brand-primary, #ff7a45);
}
```

波普皮肤同步改成「ink 文字 + pop-red 下划线」（原来是把文字染成 pop-red）。

### 实测（CDP 强制 `:hover`，逐皮肤验证）

| 皮肤 | 标题颜色（normal → hover） | 下划线 | 结论 |
|---|---|---|---|
| 默认暗色 | `rgb(243,245,248)` → 同 | `#ff7a45` | ✅ 文字不变 |
| 蜘蛛侠 | `rgb(11,11,15)` → 同 | `#e62429` | ✅ 不再变红 |
| 波普 | `rgb(20,20,20)` → `rgb(23,19,11)`（都是墨色） | `#ff3b2f` | ✅ |
| 明亮 | `rgb(28,28,30)` → 同 | `#e36a36` | ✅ |
| 生化危机 | `rgb(214,255,217)` → 同 | `#7cff3f` | ✅ |

新增守卫测试 `tests/card-hover-color.test.mjs`（3 例）：源码里 hover 规则不许设 `color`、皮肤里只许用墨色类变量、构建产物里同样成立。
