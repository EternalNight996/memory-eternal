# dsh-TUI plugin — `/memory`

在 dsh-TUI 里增加一个用户命令：

```text
/memory
```

执行后确保 `memory-eternal` 的本地 Web 服务存活，并打开同一套 Memory Atlas Web UI。

另一个命令：

```text
/audit
```

在 dsh-tui 内直接打开**原生审核场景**：读取真实待审队列、`s` 全选、`a` 批准、`r` 驳回、`Esc` 退出。它不打开浏览器，也不复制 Web UI。

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
- `a` 批准，`r` 驳回
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

## 要求

- `memory-eternal` 已安装在当前机器
- 终端能执行 `dsh-memory`（否则走 URL 兜底）
- dsh-TUI >= 0.9.0（commands seam）
