## ☁️ v0.48.0 — 云端记忆首发：密钥三条路、换库热生效、连不上自动回本地

> 这是 **v0.45.0 之后的第一个正式发布版**：`0.46.0` / `0.47.0` 均未发布，其内容全部并入本版。

### 安装 / 升级

```bash
npm i -g memory-eternal@0.48.0
# 桌面版 / web profile（profile 是 pnpm workspace，别用 npm install）
cd ~/.dsh/profiles/desktop && pnpm update memory-eternal
```

> 升级后**重启一次 DSH**：宿主侧（`index.js` / `lib/*.js`）有改动，只换磁盘文件不生效；
> 面板脚本版本号已写入 0.48.0，刷新面板会提示「页面脚本已更新」。

### 本次改动

- ① **云端记忆成为主推能力**
  - 登录：**MengBot 账号**（扫码 / 邮箱 OTP）或**访问密钥**（`me_…`）；
  - **一人一库**：`cloud-vaults/{owner}/memory-eternal.db`，物理隔离；
  - **热切换**：本地库 ↔ 云端库不重启；**云端实例内的租户多库切换同样是热的**（当前库记在 `cloud-vaults/{owner}/.active`，0600；重启保持、坏标记回落默认库，隔离边界恒为租户根）；
  - **整库上传 / 下载**：分片 + 断点续传 + 中途取消 + 单分片重试 3 次 + 重复跳过；
  - **离线优先**：云端不可达自动熔断回退本地（首屏最多等 3 秒）。
- ② **密钥管理三处入口（不再只能 curl）**
  - **CLI**：`dsh-memory cloud info | token | keys ls | keys issue | keys revoke | whoami`；
    本地台账模式**不需要管理令牌**（能在这台机跑命令 = 管理员），签发/吊销对运行中的服务**立即生效、不用重启**；
    不在同机时 `--url` + `--admin-token` 走管理面 HTTP；
  - **面板**：设置 → 🧪 实验性 → 云端连接 → 「🔑 服务端密钥管理」：填令牌 → 列表 / 新建（**明文只显示一次**，可复制）/ 吊销；
  - **自动生成管理令牌**：首次 `MEMORY_CLOUD=1` 启动自动生成并写 `$DSH_HOME/cloud-admin-token`（0600，日志打印一次）；`MEMORY_CLOUD_ADMIN_TOKEN` 优先。
- ③ **安全加固**（发版前审计扫出来的一批，全部带回归测试）
  - **多租户越权（最严重）**：`/vaults/{export,import-into,transfer,switch}` 原来接受任意绝对路径 → 统一 `guardPath`，云端只认本租户库根，越界 `403 path-not-allowed`；
  - **云端管理面**：未配令牌时只允许 `127.0.0.1`/`::1`（去掉 `10.x`/`172.16-31`/`192.168.x` 的"本机"兜底），带 `x-forwarded-for` 不算本机；
  - **任意可执行文件执行**：`/embedding/install-ollama` 的 `run` 不再执行请求给的 `path`（只认 `MEMORY_OLLAMA_SETUP` + 后缀/解释器校验）；
  - **DNS rebinding**：写请求补 Host 白名单（域名部署需配 `MEMORY_PUBLIC_HOST`）；
  - **请求体上限**：统一 `readBody`（默认 2MB / 导入 256MB / 分片 16MB，超限 413 + 断连），收敛 14 处自写读取；
  - **临时文件**：`/backup/import` 改 `mkdtemp` + `wx` + 0600 + 用完即删；
  - **密钥台账**：串行写入 + `wx` 独占（吊销不再被在途请求"复活"），`lastUsedAt` 60s 节流；
  - `tenantVault` 拒绝 `.`/`..`；热切库不再对请求路径 `mkdir`；
  - 全站 `nosniff` / `no-referrer` / CSP（`frame-ancestors` 放行 `dsh-app:` 保住 DSH 内嵌面板）。
- ④ **日志**
  - 自动沉淀日志新增**「卡片」列**：新建/追加行显示卡片标题（点一下直接开那张卡），跳过行显示内容摘要 —— 一眼知道"刚才操作了哪张卡"；
  - 操作日志页：动作胶囊化、行 hover、IP 中间省略（长 IPv6 不再挤歪列）、≤720px 退化成两行卡片。
- ⑤ **顶栏收口**：运行位置 + 版本号 + 帮助合并成**一颗胶囊**（头像独立），宿主内嵌/窄屏自动隐藏版本号。
- ⑥ **体积**
  - `build.mjs` 补 `process.env.NODE_ENV=production`：`web/app.js` **2,725KB → 1,840KB**（此前一直把 react-dom **开发版**打进产物）；
  - 删 12 张零引用截图（含 2.8MB `demo.gif`）+ `docs/screenshots` + site 生成物（素材 **−12.1MB**），15 张常用图无损重压（−1.24MB）；
  - `files` 补全私有组件排除清单（`subscription-sync/audit` 之前"半发货"，装包用户开云端会 `ERR_MODULE_NOT_FOUND`）；
  - 删零引用 `playwright-core`（**−13.3MB**）。
- ⑦ **README**：云端置顶当主卖点（含密钥三入口）、同类对比表上移并换成 **GitHub API 实测星标**（新增 Dify / RAGFlow / AnythingLLM / Khoj / LlamaIndex 等知识库类；标注 Mem0「托管平台口径」、`getzep/zep` 非产品本体、`letta-ai/letta` 主仓已归档）、两张架构图合一置底、截图 9 → 4。
- ⑧ **仓库卫生**：`.gitignore` 修成 UTF-8 并补 `.env` / `deploy/.env` 忽略；清掉 `.panel-*.log` / `p21.tgz` / `preview/` / `.panel/` / 过期 `dist/*.tgz`（本地 −18.5MB）；`git gc` 后 `.git` **87.3MB → 41.9MB**。

### 重点

- **密钥三条路**：CLI 一条命令签发、面板点点签发、curl 兜底；没有 `me_…` 进不去业务面
- **换库不用重启**：本地 ↔ 云端、云端内多库都热生效，重启后仍在刚切过去的库
- **云端挂了不影响本机**：熔断回退，记忆库一分不丢
- **包小了 12MB、产物小了 0.9MB**：安装更快，面板不再带 React 开发版
- **日志能自证**：每条自动沉淀都写清"哪张卡、什么动作、为什么"
