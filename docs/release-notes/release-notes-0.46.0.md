## 🧪 v0.46.0 — 热切换记忆库 + 上传断点续传 + 沉淀自检（清空后不再静默停工）

### 安装 / 升级

```bash
npm i -g memory-eternal@0.46.0
# 或桌面版 / web profile（profile 是 pnpm workspace，别用 npm install）
cd ~/.dsh/profiles/desktop && pnpm update memory-eternal
```

> 升级后**重启一次 DSH**：补丁里有宿主侧（index.js / lib/db.js）的改动，只换磁盘文件不会生效。

### 本次改动

- ① **热切换记忆库（不重启客户端）**：新增 `POST /memory-eternal/api/vaults/switch`
  - 服务端先确认目标库能打开（建表 + 写探针）再改 `vaultRoot` 指向，同时写共享偏好与配置（`vaultDir` / `activeVault`，命中已有 profile 就写 profile 名），然后 SSE 广播；
  - 前端收到事件后**整棵面板重挂载**：知识卡、知识图谱、待审、回收站、统计一次性换成新库，**不刷新页面**；
  - `GET /vaults` 增加 `hotSwitch` 能力位；进程里还是旧 API（老宿主）时自动降级成「写偏好 + 写配置」（宿主 `vaultDir()` 每请求重算，同样当场生效），并如实提示。
- ② **上传断点续传 + 可取消**：每片成功即落断点，关页面/断网/崩溃后重开面板会显示「上次上传中断：已传 d / t」+ **继续上传 / 取消**；传输中也能取消；单分片失败重试 3 次（1s/2s 退避）。
- ③ **云端面板收口**：删掉「运行模式」下拉（**登录了就是云端，没登录就是本地**），未登录只显示登录入口；云↔本地/本机各库的切换统一走「下拉只选中 → **立即切换** → 弹窗确认」，切到本机库**不会注销云端账号**。
- ④ **恢复出厂不再清发号器**（真实事故修复）：原来清表把 `card_sequence` 也 DELETE 了却只重建 `schema_version`，之后**所有写卡**都抛 `card_sequence 未初始化` —— 自动沉淀、审核通过、新建卡全挂，界面上只是安静地没有新卡。现在清表跳过发号器，`nextCardId()` 发现缺失会按 `cards`/`quarantine` 最大 id 就地自愈。
- ⑤ **沉淀自检**：`GET /overview` 新增 `capture` 字段（发号器 seq / 是否缺失 / 最近一次蒸馏失败原因 / 最近一次成功时间 / 自动沉淀开关），运行状态页「🩺 健康概览」多一行「沉淀自检」，一眼看出卡在哪一环（发号器 / 鉴权 AUTH / 噪声门）。
- ⑥ **修 `POST /restart-self` 500**：路由里引用了作用域外的 `loaded`，导致「重启常驻实例」必报 `loaded is not defined`。
- ⑦ **修「Web 版」一次点击弹两个标签页**：带 `noopener` 的 `window.open` 按规范返回 `null`，旧代码把它当失败又补了一次 `<a>.click()`。现在兜底统一走单个 `<a target=_blank rel=noopener>`，并加 1.2s 防连击。
- ⑧ **看门狗不再死守启动参数**：每次拉起 web 用共享偏好重新解析库（`pickSpawnVault`），web 崩掉被重新拉起时不会静默跳回旧库；坏偏好（目录已删）不采信。
- ⑨ **测试**：新增 `vault-switch`(18) / `card-sequence`(4) / `capture-selfcheck`(4)；同时修掉三处早已失效的守卫 —— `csrf-origin`（loopback 放行后的过期断言）、`import-roundtrip`（重复导入算 duplicate 不算 failed）、`web-entry`（双开断言）。整套 `npm test` 恢复全绿。

- ⑩ **修「启用定时自动体检」开关保存后弹回关**（同批反馈）：这块配置存在独立文件 `memory-eternal-junk-auto.json`（DSH settings schema 里没有 `junkAuto*`，走主保存会被静默过滤），而旧界面的开关绑在 `/config` 的 form 上 —— 保存其实成功了，界面回读 `/config` 永远拿不到这个字段，于是开关立刻弹回「关」。现在控件**只认 `GET /junk/auto` 的 config**，保存后以服务端回读渲染，刷新也不会回弹。
- ⑪ **修 issue #65（多库区块最下方/右侧控件被裁）**：粘性保存条 `position: sticky; bottom: 0` 会盖住最后一屏内容。给所有配置区块包了一层 `.mc-cfg-sections` 并留出与保存条等高的底部空白（窄屏 104px），滚到底时最后一块（多库 / 恢复出厂）能完整露出；同时给 `.mc-cfg-tools` 的 label/select 加 `max-width`，窄屏不再撑破卡片、右侧控件不再错位。

### 重点
- **换库不用重启**：本机库 / 云端库都能在运行中切换，知识卡与图谱一起换
- **清空库不再把沉淀打死**：发号器自愈 + 恢复出厂保护
- **「为什么没有新卡片」可自证**：运行状态页一行「沉淀自检」
- **上传可中断可续传**，进度与取消都看得见