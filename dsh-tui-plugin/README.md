# dsh-TUI plugin — `/memory` 与 `/audit`

在 dsh-TUI 里增加一个用户命令：

```text
/memory
```

执行后确保 `memory-eternal` 的本地 Web 服务存活，并打开同一套 Memory Atlas Web UI。

另一个命令：

```text
/audit
```

在 dsh-tui 内直接打开**原生审核场景**：读取真实待审队列，判词面板显示卡片来源与 `reason`（区分「蒸馏兜底原文卡」和真正值得审的内容）、`severity`；`s` 全选、`a` 批准、`r` 驳回（批准/驳回都先进入二次确认，驳回可顺手填理由），`Esc` 取消/退出。它不打开浏览器，也不复制 Web UI。详见下文 [「`/audit` 审核闭环」](#audit-审核闭环issue-50)。

## 先看效果（不需要 dsh-tui）

完整 TUI 原型：

```bash
node dsh-tui-plugin/demo.mjs
```

包含：

- `1` 记忆库：搜索、类型、今日回看、读卡
- `2` 待审：类型、全选、批量批准/驳回、判词
- `3` 知识星图：连接簇、相关卡
- `4` 运行状态：知识库/备份/沉淀日志
- `5` 回收站：恢复、彻底删除
- `6` 设置：开关、主题
- `Enter` 读卡器
- `/` 搜索
- `?` 帮助

静态预览单页：

```bash
node dsh-tui-plugin/demo.mjs --once --no-color
node dsh-tui-plugin/demo.mjs --once --no-color --screen=library
node dsh-tui-plugin/demo.mjs --once --no-color --screen=settings
node dsh-tui-plugin/demo.mjs --once --no-color --screen=audit --select-all
node dsh-tui-plugin/demo.mjs --once --no-color --screen=reader
node dsh-tui-plugin/demo.mjs --once --no-color --screen=reader --scroll=60
```

按键：

- `1–6` 切换页面
- `Tab` 循环页面
- `↑↓` / `j k` 移动
- `←→` / `t` 切换类型
- `Enter` 读卡 / 切换设置
- `L` 直接打开长文读卡器；`j/k` 滚动，`PgUp/PgDn` 翻页，`g/G` 首尾

实时数据模式：

```bash
# 只读：读取真实待审卡和正文
node dsh-tui-plugin/demo.mjs --live

# 写入：允许真实批准 / 驳回，谨慎使用
node dsh-tui-plugin/demo.mjs --live --write
```

实时模式默认走 `http://127.0.0.1:7999/memory-eternal/api`，可用
`MEMORY_ETERNAL_API` 覆盖。API 不可用时自动回退到示例数据。
- `Space` 多选 / 切换设置
- `s` 或 `Ctrl+A` 全选 / 反选
- `a` 批准，`r` 驳回（都先进入二次确认：`Enter` 才提交，`Esc` 取消；驳回确认态里可直接输入理由）
- 回收站：`r` 恢复，`d` 彻底删除
- `/` 搜索，`Esc` 返回 / 清空
- `?` 帮助，`q` 退出

每个页面的底部快捷键会随当前页面更新，例如待审页显示全选/批驳，设置页显示切换，回收站显示恢复/删除。

`demo-audit.mjs` 保留为纯审核页备份。

## 安装

在 `memory-eternal` 仓库根目录：

```bash
# 本地 profile（推荐先用这个验证）
dsh plugin --profile dsh-tui add ./dsh-tui-plugin
```

或手动：

1. 把本目录复制到 dsh-TUI profile 的 node_modules；
2. 在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: memory-eternal-tui
      name: 'memory-eternal-tui'
```

3. 重启 dsh-TUI。

## 使用

```text
/memory
```

- 优先执行 `dsh-memory open`（确保 7999 存活 + 打开浏览器）
- 找不到 CLI 时直接打开 `http://127.0.0.1:7999/`
- 不会在 TUI 内嵌 WebView，也不复制第二套 UI
- 审批仍在 Web 里由人完成，不新增 agent 工具

## `/audit` 审核闭环（issue #50）

装到 dsh-tui 之后，输入 `/audit` 打开原生审核场景（或 `/memory` 打开 Web 版）。
两者用的是**同一份数据**：待审队列来自 `GET /cards?status=pending&limit=300`，批准/驳回走
`POST /audit/approve`、`POST /audit/reject`，最终都落到 `setCardStatus()` + `audit_log`，
不新增 agent 工具、不绕过审核守卫。

### 判词面板：先看 `reason`

右侧面板按顺序显示：`kind · 时间 · 来源 · 严重度` → `依据：<reason>` → 兜底标记 → 标题/摘要。
`reason` 由卡片 DB 的 `reason` 字段带出（`/cards` 已返回），常见值：

| reason | 含义 | 审核建议 |
| --- | --- | --- |
| `AI 自动沉淀（蒸馏卡）` | LLM 蒸馏出的知识卡 | 正常审 |
| `AI 自动沉淀（原文卡）` | **蒸馏失败/不可用时的降级原文卡** | 优先复核，多数可驳回 |
| `手动创建` | `/write` 手动写入 | 正常审 |
| `多卡合并` | 优化合并产生 | 正常审 |

- 兜底原文卡额外显示 `⚠ 蒸馏兜底原文卡（无 LLM 精炼，优先复核）`；
- 没有 `reason` 的卡片不显示该行（不留空行）；
- `severity` 为默认值 `info` 时不显示，非默认值（如 `warning`）才出现在第一行。

### 键位

| 键 | 作用 |
| --- | --- |
| `↑` / `↓` | 移动选中项（列表窗口跟着走，标题显示当前屏 `起-止/总数`） |
| `Space` | 多选 / 取消选中当前卡 |
| `s` / `Ctrl+A` | 全选 / 全不选 |
| `a` | 进入**批准确认态**（底栏：`确认批准 N 张？Enter 确认 / Esc 取消`） |
| `r` | 进入**驳回确认态**并输入理由（底栏：`驳回 N 张 · 理由（可空）：… Enter 确认 / Esc 取消`） |
| `Enter` | 确认态下提交（驳回时把输入的理由一起提交，批量驳回共用同一理由） |
| `Esc` | 确认态：取消回列表；列表：退出场景 |
| 其他可见字符 | 仅驳回确认态：拼进理由（可空；上限 120 字） |

确认目标在进入确认态时**冻结**：确认期间列表/选择变化不会改变这次提交的对象；
提交失败会留在确认态，排好网络/权限后可直接 `Enter` 重试。

### 驳回理由写到哪

`POST /audit/reject` 现在接受可选 `reason`（JSON body 或 query）：

```js
// body: { path, reason? }   或   GET /audit/reject?path=...&reason=...
await setCardStatus(vaultRoot, rel, 'rejected', { changedBy: 'user', reason })
```

- 有理由 → 写进 `audit_log.reason`（`changed_by='user'`）；
- 不传理由 → `reason` 仍是空串，状态流转与以前一致（唯一区别是 `changed_by` 从默认
  `'system'` 变成 `'user'`，因为这是人点的）；
- 响应里回显 `reason`，方便调用方自检。

### 本机没有 dsh-tui 宿主时

本插件只做 dsh-tui 宿主注册（`tuiPluginHost` / `tuiScenes`）。没有宿主时 `/audit` 不会被加载，
能用的是仓库里的 TUI 原型（`node dsh-tui-plugin/demo.mjs --live`）。
纯函数（`cardMeta` / `reasonLine` / `reasonFlag` / `positionLabel` / `confirmLabel` / `auditPayload`）
可以在没有宿主的环境里直接被 `tests/tui-audit-scene.test.mjs` 验证。

## 要求

- `memory-eternal` 已安装在当前机器
- 终端能执行 `dsh-memory`（否则走 URL 兜底）
- dsh-TUI >= 0.9.0（commands seam）
