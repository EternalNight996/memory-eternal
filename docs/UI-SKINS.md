# 界面皮肤与可读性基线（UI-SKINS）

面板有五套皮肤：`default`（默认暗色）/ `pop`（波普撞色）/ `light`（暖纸面）/ `resident`（生化危机 · 绿扫描线）/ `spider`（蜘蛛侠 · 红蓝漫画）。
全部通过 `[data-skin="..."]` 作用域切换，配置项 `theme` 存在 `memory-eternal-config.json`。

本文件记录「可读性基线」与「蜘蛛侠皮肤这一轮加强了什么」，避免下次改样式把对比度改回看不清。

## 1. 可读性基线（五皮肤计算色实测）

搜索命中/摘要/片段三个位置的可读性最容易翻车（浅底浅字、深底灰字）。实测计算色（CDP 读取）：

| 皮肤 | 卡片底 | 摘要 `.mc-v5-card-lead` | 片段 `.mc-snippet` |
|---|---|---|---|
| default | `#262b33` | `#dfe3ea`（12px） | `#c6ccd6`（opacity 1） |
| light | `#fff` | `#1c1c1e` | `#46403a` |
| pop | `#fffcf4` | `#141414` | `#453a29` |
| resident | `#0c130e` | `#c3e2c7` | `#b6d6ba` |
| spider | `#fffdf7` | `#23232b` | `#2f2f39` |

口径：小字（11–12px）按 WCAG AA（≥4.5:1）取；`mark` 高亮在浅底用实色 `#fde68a` 底 + `#3b2f00` 字（原先是 `rgba(245,158,11,.35)`，浅底上几乎看不见），深底（resident）改用 `#7cff3f` 底 + 深墨字。

同时把 `.mc-snippet` 的 `opacity:.72` 去掉（它继承 `.mc-cardrow p { opacity:.7 }`，两级叠加后基本糊成一片）；`.mc-v5-insight-k` 字号 8.5→9px、底色浓度 .09→.18。

## 2. 蜘蛛侠皮肤（`[data-skin="spider"]`，本轮加强）

**卡片阅读器**（重点，用户说的「图1」）：
- 弹窗：3px 墨边 + `9px 9px 0` 红蓝双层硬阴影；
- 标题栏：`linear-gradient(112deg,#C8102E 0 46%,#0B3D91 46% 100%)` 红蓝对角 + 白色半调网点（radial-gradient）；
- 标题：Impact / 'Arial Black' 900 + `skewX(-7deg)` 斜切 + 2px 墨色描边阴影；
- 章节标题 `.md-h`：蓝底 + 半调网点 + **内联 SVG 蛛网 data URI**（不引外部资源）+ 5px 红色左条（h1 反色）；
- 正文/列表/引用 `.md-callout`/代码 `.md-code`/`mark`/`.mc-hl`/`.md-kv`/分割线/列表符号/折叠提示统一红蓝；
- 右侧目录 active 蓝底白字，相关卡红阴影。

**列表卡片**：红蓝双层描边 `0 0 0 2px #1B3B8B, 0 0 0 4px #C8102E` + 4px 硬投影；hover 内外环互换 + `translateY(-2px)`，右下浮出蛛网线（`::after` + 内联 SVG，opacity .45）。
**踩坑**：一开始给卡加了 `overflow:hidden`，实测内容被裁 8px（scrollHeight 326 vs clientHeight 318）；改成不裁剪、蛛网 `::after` 内缩，复核差值全为 0。

**按钮/芯片**：次按钮白底 + 2px 蓝描边蓝字（hover 加深 + 硬阴影）；主按钮（`.me-on`/`.me-core-btn`）红底白字 + 蓝投影；danger 红描边；芯片蓝描边 + hover `translateY(-1px) rotate(-1.4deg)`，active 蓝底白字红边（原先被 `.me-v5 .mc-chip.active` 的橙边盖住，已补 `border-color`）。

**边界**：只写 `[data-skin="spider"]` 作用域，其余四套皮肤未被带跑（计算色逐一复核，见上表）。

## 3. 搜索结果的状态区分（配合 `_match`）

| 状态 | 表现 |
|---|---|
| 字面命中 | 蓝色徽标 `命中 · 标题/标签/摘要/正文`；标题与摘要用 `highlightMatches` 高亮；片段优先用后端 `_match.snippet` |
| 语义命中（`where=semantic`） | 橙色徽标 `✨ 语义相关`（title 说明「卡片正文里没有这个字面词，按意思相近被召回」）；**不做任何高亮**、不给片段 |
| 相关性分数 | 角落 9px 灰字（一位小数），仅搜索态显示 |

深链：`?tab=cards&q=火绒` 直接打开即是一份搜索结果（`q` 与 `tab` 都在初始化时读取）。

## 4. 校验方式

```powershell
# 静态：DOM 里能否看到徽标/高亮类名
$chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'
Start-Process -FilePath $chrome -ArgumentList @('--headless=new','--disable-gpu','--no-first-run',"--user-data-dir=$env:TEMP\ui",'--virtual-time-budget=15000','--dump-dom','http://127.0.0.1:7999/?tab=cards&q=%E7%81%AB%E7%BB%92') -RedirectStandardOutput $env:TEMP\ui.html -Wait -NoNewWindow

# 动态：CDP 真输入搜索词、读计算样式（首屏引导弹窗会挡住静态 dump，实点才准）
```

实测（CDP 实点，搜「火绒」）：4 张卡、徽标 `命中 · 摘要`×2 + `命中 · 正文`×2、`mark.mc-hl` 6 个、片段 4 个、分数 17.1/16.8/17.0/17.0；注入一条 `semantic` 命中后，恰好 1 张卡出现「✨ 语义相关」且 `mark` 数为 0、无片段 —— 「不给语义结果造高亮」这条守住了。
